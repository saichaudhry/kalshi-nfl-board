"""
Turning 12,000+ raw Kalshi markets into something a human can navigate.

Kalshi organises markets as series -> events -> markets. That structure is built
for the exchange, not for someone asking "what are tonight's Josh Allen lines?".
This module re-shapes it along the axes a bettor actually thinks in: which game,
which bet type, which period of play, and which player.
"""

import re

import sports

# An event that belongs to a specific game encodes it in the ticker as
# KXNFLSPREAD-26SEP17DETBUF -> date 26SEP17, teams DETBUF. Anything without this
# shape is a season-long future (division winners, MVP, season win totals).
# Baseball tickers carry a first-pitch time that football's do not:
# KXMLBGAME-26SEP161840ATHTB is 26SEP16 + 1840 + ATHTB. The time is optional
# so the same pattern reads both, and team codes run from 2 letters (TB) to 4.
GAME_KEY_RE = re.compile(r"-(\d{2}[A-Z]{3}\d{2}(?:\d{4})?[A-Z]{3,12})$")

# Event sub_titles read "DET vs BUF (Sep 17)" across every game series, which is
# a more reliable away/home split than slicing the 6-10 char team blob (team
# codes vary from 2 to 3 letters, so "KCLAC" is genuinely ambiguous).
MATCHUP_RE = re.compile(r"\b([A-Z]{2,4})\s+vs\.?\s+([A-Z]{2,4})\b")

# Player prop titles are "Josh Allen: 175+ passing yards". The prefix before the
# colon is the player -- except when it is a team defense or a "no touchdown"
# style escape hatch, which these patterns exclude.
PLAYER_TITLE_RE = re.compile(r"^(.{2,40}?):\s")
NOT_A_PLAYER_RE = re.compile(
    r"(D/ST|DST|Defense|No Touchdown|No TD|Any Other|Neither|Either|"
    r"Under|Over|Yes|No\b)",
    re.IGNORECASE,
)

# Kalshi writes team entries as "<CODE> <Nickname>" -- "BUF Bills", "DET Lions".
# A shape rule alone cannot separate those from a player whose first name is
# initials ("DJ Moore", "CJ Stroud", "TJ Watt" all match "[A-Z]{2,4} [A-Z][a-z]"),
# so the nickname is checked against the actual league instead of guessed at.
TEAM_NICKNAMES = {
    # NFL
    "Cardinals", "Falcons", "Ravens", "Bills", "Panthers", "Bears", "Bengals",
    "Browns", "Cowboys", "Broncos", "Lions", "Packers", "Texans", "Colts",
    "Jaguars", "Chiefs", "Raiders", "Chargers", "Rams", "Dolphins", "Vikings",
    "Patriots", "Saints", "Giants", "Jets", "Eagles", "Steelers", "49ers",
    "Seahawks", "Buccaneers", "Titans", "Commanders",
    # MLB
    "Diamondbacks", "Braves", "Orioles", "Red Sox", "Cubs", "White Sox", "Reds",
    "Guardians", "Rockies", "Tigers", "Astros", "Royals", "Angels", "Dodgers",
    "Marlins", "Brewers", "Twins", "Mets", "Yankees", "Athletics", "Phillies",
    "Pirates", "Padres", "Mariners", "Cardinals", "Rays", "Rangers", "Blue Jays",
    "Nationals",
    # NBA / WNBA
    "Hawks", "Celtics", "Nets", "Hornets", "Bulls", "Cavaliers", "Mavericks",
    "Nuggets", "Pistons", "Warriors", "Rockets", "Pacers", "Clippers", "Lakers",
    "Grizzlies", "Heat", "Bucks", "Timberwolves", "Pelicans", "Knicks",
    "Thunder", "Magic", "76ers", "Suns", "Trail Blazers", "Kings", "Spurs",
    "Raptors", "Jazz", "Wizards",
    "Dream", "Sky", "Sun", "Wings", "Fever", "Aces", "Sparks", "Lynx",
    "Liberty", "Mercury", "Storm", "Mystics", "Valkyries",
    # NHL
    "Ducks", "Coyotes", "Bruins", "Sabres", "Flames", "Hurricanes", "Blackhawks",
    "Avalanche", "Blue Jackets", "Stars", "Oilers", "Panthers", "Kraken",
    "Wild", "Canadiens", "Predators", "Devils", "Islanders", "Senators",
    "Flyers", "Penguins", "Sharks", "Blues", "Lightning", "Maple Leafs",
    "Canucks", "Golden Knights", "Capitals", "Jets",
}
TEAM_NAME_RE = re.compile(r"^[A-Z0-9]{2,4}\s+(\w+)$")


def is_team_label(name):
    """True for 'BUF Bills' / 'DET Lions', false for 'DJ Moore'."""
    match = TEAM_NAME_RE.match(name)
    return bool(match) and match.group(1) in TEAM_NICKNAMES

# Totals markets are titled "Full Game: Over 53.5 points scored", so the same
# "prefix before the colon" rule that finds players also finds period names.
# These are periods, not people.
SEGMENT_PHRASE_RE = re.compile(
    r"^(Full Game|Regulation|Overtime|\d(?:st|nd|rd|th)\s+(?:Half|Quarter))$",
    re.IGNORECASE,
)

# Which period of the game a series covers. Order matters: "1HTEAMTOTAL" must
# match 1H before anything else grabs it.
SEGMENTS = [
    ("1Q", "1st Quarter"), ("2Q", "2nd Quarter"),
    ("3Q", "3rd Quarter"), ("4Q", "4th Quarter"),
    ("1H", "1st Half"),    ("2H", "2nd Half"),
    ("OT", "Overtime"),
]

# Bet-type keywords, longest/most specific first so TEAMTOTAL beats TOTAL.
BET_TYPES = [
    ("TEAMTOTAL",  "team_total", "Team Total"),
    ("SPREAD",     "spread",     "Spread"),
    ("WINMARGIN",  "spread",     "Win Margin"),
    ("TOTAL",      "total",      "Total Points"),
    ("BTTS",       "total",      "Both Teams Score"),
    ("BOTH",       "total",      "Both Teams Score"),
    ("RACE",       "total",      "Race to Points"),
    ("HIGHSCORE",  "total",      "Scoring"),
    ("BLOWOUT",    "spread",     "Blowout"),
]

# Series whose markets are per-player statistics. Matched on the part of the
# ticker after the league prefix. Football stats first, then the stats the
# other covered sports price -- a "STRIKEOUTS" market is a player prop in
# exactly the same way a "PASSYDS" one is.
PROP_KEYS = [
    # Baseball
    ("STRIKEOUT", "Strikeouts"), ("HOMERUN", "Home Runs"), ("HR", "Home Runs"),
    ("HITS", "Hits"), ("RBI", "RBIs"), ("BASES", "Total Bases"),
    ("EARNEDRUN", "Earned Runs"), ("WALKS", "Walks"), ("STOLEN", "Stolen Bases"),
    # Basketball
    ("POINTS", "Points"), ("REBOUND", "Rebounds"), ("ASSIST", "Assists"),
    ("THREES", "Three Pointers"), ("BLOCKS", "Blocks"), ("STEALS", "Steals"),
    ("DOUBLEDOUBLE", "Double Double"), ("TRIPLEDOUBLE", "Triple Double"),
    # Hockey
    ("GOALS", "Goals"), ("SAVES", "Saves"), ("SHOTS", "Shots"),
    # Tennis
    ("ACES", "Aces"), ("SETS", "Sets"), ("GAMESWON", "Games Won"),

    ("PASSYDS", "Passing Yards"), ("PASSTD", "Passing TDs"),
    ("PASSATT", "Pass Attempts"), ("PASSCOMP", "Completions"),
    ("PASSINT", "Interceptions Thrown"),
    ("RECYDS", "Receiving Yards"), ("RECTD", "Receiving TDs"),
    ("RRYDS", "Rush + Rec Yards"),
    ("RUSHYDS", "Rushing Yards"), ("RSHYDS", "Rushing Yards"),
    ("RUSHTD", "Rushing TDs"), ("RSHTD", "Rushing TDs"),
    ("RSHATT", "Rush Attempts"),
    ("LONGREC", "Longest Reception"), ("LONGRSH", "Longest Rush"),
    ("FIRSTTD", "First Touchdown"), ("ANYTD", "Anytime TD"),
    ("TOTALTD", "Total Touchdowns"),
    ("FFPTS", "Fantasy Points"), ("FFHIGHSCORE", "Fantasy High Score"),
    ("FFLEADER", "Fantasy Leader"),
    ("SACK", "Sacks"), ("INT", "Interceptions"),
    ("REC", "Receptions"), ("TD", "Touchdowns"),
    ("FG", "Field Goals"), ("KICK", "Kicking"),
]


def parse_game_key(event_ticker):
    """Return the shared '26SEP17DETBUF' join key, or None for a season future."""
    match = GAME_KEY_RE.search(event_ticker)
    return match.group(1) if match else None


def parse_matchup(sub_title):
    """Pull ('DET', 'BUF') out of 'DET vs BUF (Sep 17)'. Away team first."""
    match = MATCHUP_RE.search(sub_title or "")
    return (match.group(1), match.group(2)) if match else (None, None)


# Every league prefix across every covered sport, longest first, so
# "KXLEADERNFL" is stripped before "KXNFL" and "KXWNBA" before "KXNBA".
_PREFIXES = sorted(
    {prefix for sport in sports.SPORTS for prefix in sport["prefixes"]} | {"KX"},
    key=len, reverse=True,
)


def series_suffix(series_ticker):
    """Strip the league prefix so 'KXNFL1HSPREAD' becomes '1HSPREAD' and
    'KXMLBSTRIKEOUTS' becomes 'STRIKEOUTS'."""
    ticker = (series_ticker or "").upper()
    for prefix in _PREFIXES:
        if ticker.startswith(prefix):
            return ticker[len(prefix):]
    return ticker


def classify_series(series_ticker, series_title=""):
    """Map a series onto (bet_type, segment, label) for the UI's filters."""
    suffix = series_suffix(series_ticker)

    segment = "full"
    segment_label = "Full Game"
    for code, label in SEGMENTS:
        if suffix.startswith(code):
            segment, segment_label = code, label
            suffix = suffix[len(code):]
            break

    # Player props win over generic bet types: a "1H passing yards" market is a
    # prop first and a period market second.
    for key, label in PROP_KEYS:
        if suffix.startswith(key) or suffix == key:
            return "prop", segment, segment_label, label

    if suffix in ("GAME", "WINNER", "MATCH", "MATCHWINNER", ""):
        return "moneyline", segment, segment_label, "Moneyline"

    for key, bet_type, label in BET_TYPES:
        if key in suffix:
            return bet_type, segment, segment_label, label

    return "other", segment, segment_label, (series_title or suffix).strip()


def extract_player(market_title, yes_sub_title=""):
    """Get 'Josh Allen' from 'Josh Allen: 175+ passing yards'.

    Returns None when the prefix is a team defense, a 'No Touchdown' option, or
    anything else that is not a person -- those belong on the game card, not in
    the players index.
    """
    for text in (market_title or "", yes_sub_title or ""):
        match = PLAYER_TITLE_RE.match(text.strip())
        if not match:
            continue
        name = match.group(1).strip()
        if (NOT_A_PLAYER_RE.search(name)
                or is_team_label(name)
                or SEGMENT_PHRASE_RE.match(name)
                or any(ch.isdigit() for ch in name)):
            return None
        # A real name has a space and at least one lowercase letter; this
        # rejects ticker-ish fragments like "BUF" or "OVER 30".
        if " " in name and any(c.islower() for c in name):
            return name
    return None


def to_cents(dollar_string):
    """Kalshi returns prices as strings like '0.6700'. Cents are what the UI shows."""
    if dollar_string in (None, ""):
        return None
    try:
        return int(round(float(dollar_string) * 100))
    except (TypeError, ValueError):
        return None
