"""
Which sports the board covers, and how each one maps onto the two APIs.

Kalshi identifies a sport by the prefix of its series tickers; ESPN identifies
the same sport by a path segment. Keeping both in one table means adding a
sport is a single entry rather than a change in four files.
"""

SPORTS = [
    {
        "key": "nfl", "label": "NFL", "name": "Pro Football",
        "prefixes": ("KXNFL", "KXLEADERNFL", "KXSTARTINGQB", "KXNEXTNFL"),
        "espn": "football/nfl",
    },
    {
        "key": "ncaaf", "label": "NCAAF", "name": "College Football",
        "prefixes": ("KXNCAAF",),
        "espn": "football/college-football",
    },
    {
        "key": "mlb", "label": "MLB", "name": "Baseball",
        "prefixes": ("KXMLB", "KXLEADERMLB"),
        "espn": "baseball/mlb",
    },
    {
        "key": "wnba", "label": "WNBA", "name": "Women's Basketball",
        "prefixes": ("KXWNBA", "KXLEADERWNBA"),
        "espn": "basketball/wnba",
    },
    {
        "key": "nba", "label": "NBA", "name": "Basketball",
        "prefixes": ("KXNBA", "KXLEADERNBA"),
        "espn": "basketball/nba",
    },
    {
        "key": "nhl", "label": "NHL", "name": "Hockey",
        "prefixes": ("KXNHL", "KXLEADERNHL"),
        "espn": "hockey/nhl",
    },
    {
        "key": "atp", "label": "ATP", "name": "Men's Tennis",
        "prefixes": ("KXATP",),
        "espn": "tennis/atp",
    },
    {
        "key": "wta", "label": "WTA", "name": "Women's Tennis",
        "prefixes": ("KXWTA",),
        "espn": "tennis/wta",
    },
]

BY_KEY = {s["key"]: s for s in SPORTS}

# Longest prefix first, so KXWNBA is never swallowed by a shorter match and
# KXLEADERNFL is not mistaken for something else.
_LOOKUP = sorted(
    ((prefix, sport["key"]) for sport in SPORTS for prefix in sport["prefixes"]),
    key=lambda pair: -len(pair[0]),
)


def sport_of(series_ticker):
    """Which sport a Kalshi series belongs to, or None if it is not covered."""
    ticker = (series_ticker or "").upper()
    for prefix, key in _LOOKUP:
        if ticker.startswith(prefix):
            return key
    return None
