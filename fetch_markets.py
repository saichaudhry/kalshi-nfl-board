#!/usr/bin/env python3
"""
Build a snapshot of every open market on Kalshi, for every sport we cover.

Kalshi's API is organised for the exchange: thousands of separate "series", each
holding events, each holding markets. Nobody wants to browse that. This script
walks the series belonging to the sports in sports.py, re-groups the markets by
game / bet type / player, and writes one JSON file per sport plus an index.

Team crests and colours come from ESPN's public teams endpoint rather than a
hand-written table, so a new sport needs no new data.

Run:  python3 fetch_markets.py
Out:  data/index.json, data/sport-<key>.json

No API key required -- both APIs used here are public.
"""

import argparse
import datetime as dt
import json
import os
import sys
import time

import classify
import sports
from kalshi_api import KalshiError, KalshiUnavailable, list_open_events, list_series

ESPN_TEAMS = "https://site.api.espn.com/apis/site/v2/sports/{path}/teams?limit=1000"
ESPN_SCORES = "https://site.api.espn.com/apis/site/v2/sports/{path}/scoreboard"

# Kalshi writes game dates as 26SEP17 (YY MON DD).
MONTHS = {m: i for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
     "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], start=1)}


def parse_game_date(game_key):
    """'26SEP17DETBUF' -> date(2026, 9, 17). None if it does not parse."""
    try:
        year = 2000 + int(game_key[:2])
        month = MONTHS[game_key[2:5]]
        day = int(game_key[5:7])
        return dt.date(year, month, day)
    except (ValueError, KeyError, IndexError):
        return None


def trim_market(market, bet_type, segment, segment_label, type_label):
    """Keep only the fields the UI actually renders.

    The raw market object has ~40 fields; shipping all of them for 12,000
    markets would make the snapshot an order of magnitude larger than the page
    that reads it.
    """
    player = classify.extract_player(
        market.get("title"), market.get("yes_sub_title"))

    return {
        "ticker": market.get("ticker"),
        "label": (market.get("yes_sub_title") or market.get("title") or "").strip(),
        "bid": classify.to_cents(market.get("yes_bid_dollars")),
        "ask": classify.to_cents(market.get("yes_ask_dollars")),
        "last": classify.to_cents(market.get("last_price_dollars")),
        "prev": classify.to_cents(market.get("previous_price_dollars")),
        "volume": int(float(market.get("volume_fp") or 0)),
        "volume24h": int(float(market.get("volume_24h_fp") or 0)),
        "openInterest": int(float(market.get("open_interest_fp") or 0)),
        "betType": bet_type,
        "segment": segment,
        "segmentLabel": segment_label,
        "typeLabel": type_label,
        "player": player,
        "closeTime": market.get("close_time"),
    }


def espn_teams(path):
    """Abbreviation -> {name, colour, logo} for one league, straight from ESPN.

    Using ESPN's own registry means crests and colours exist for every sport
    without maintaining a table per league, and it stays right through
    relocations and rebrands.
    """
    import urllib.request

    # ESPN rate-limits bursts with a 403, which is transient. Without a retry
    # a whole sport silently loses its crests, so back off and try again.
    payload = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(ESPN_TEAMS.format(path=path))
            with urllib.request.urlopen(req, timeout=20) as response:
                payload = json.load(response)
            break
        except Exception:
            if attempt == 2:
                return {}   # crests are a nicety; never fail a run over them
            time.sleep(1.5 * (attempt + 1))
    if payload is None:
        return {}

    out = {}
    for entry in payload.get("sports", [{}])[0].get("leagues", [{}])[0].get("teams", []):
        team = entry.get("team", {})
        abbr = (team.get("abbreviation") or "").upper()
        if not abbr:
            continue
        logos = team.get("logos") or []
        out[abbr] = {
            "name": team.get("displayName") or abbr,
            # Kalshi names clubs in several ways across market labels -- "Tampa
            # Bay", "Rays", "A's" -- so every name ESPN knows is kept and the
            # browser indexes all of them.
            "location": team.get("location") or "",
            "nick": team.get("name") or "",
            "short": team.get("shortDisplayName") or "",
            "color": f"#{team['color']}" if team.get("color") else None,
            "logo": logos[0].get("href") if logos else None,
        }
    return out


# Kalshi and ESPN abbreviate a few clubs differently. Mapping ESPN's code to
# Kalshi's alternatives lets a score be found under either spelling. College
# football has a much longer tail of these and is left unmatched rather than
# guessed at -- a wrong score is worse than no score.
SCORE_ALIASES = {
    "ARI": ["AZ"], "CHW": ["CWS"],          # baseball
    "JAX": ["JAC"], "WSH": ["WAS"],         # football / baseball share WSH
    "CON": ["CONN"], "POR": ["PDX"],        # basketball
}


def espn_scores(path):
    """Current scores for one league, keyed by the two team abbreviations.

    ESPN advertises access-control-allow-origin: * but rejects browser-shaped
    requests, and a rejection carries no CORS headers -- so the page cannot
    fetch this itself and the scores are collected here instead. The front-end
    still tries a live call and upgrades if it succeeds.
    """
    import urllib.request

    payload = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(ESPN_SCORES.format(path=path), timeout=20) as r:
                payload = json.load(r)
            break
        except Exception:
            if attempt == 2:
                return {}
            time.sleep(1.5 * (attempt + 1))

    out = {}
    for event in (payload or {}).get("events", []):
        competition = (event.get("competitions") or [{}])[0]
        sides = []
        for c in competition.get("competitors", []):
            sides.append({
                "abbr": (c.get("team", {}).get("abbreviation") or "").upper(),
                "score": int(c["score"]) if str(c.get("score", "")).isdigit() else None,
                "home": c.get("homeAway") == "home",
                "winner": bool(c.get("winner")),
            })
        if len(sides) != 2 or not all(s["abbr"] for s in sides):
            continue

        status = (event.get("status") or {}).get("type") or {}
        record = {
            "state": status.get("state"),
            "detail": status.get("shortDetail") or status.get("description") or "",
            "completed": bool(status.get("completed")),
            "sides": sides,
        }
        # Register every spelling of both clubs, in both orders, so a lookup
        # never depends on which side Kalshi lists first or which code it uses.
        names_a = [sides[0]["abbr"], *SCORE_ALIASES.get(sides[0]["abbr"], [])]
        names_b = [sides[1]["abbr"], *SCORE_ALIASES.get(sides[1]["abbr"], [])]
        for x in names_a:
            for y in names_b:
                out[f"{x}|{y}"] = record
                out[f"{y}|{x}"] = record
    return out


def collect(sport_key, days_ahead, verbose=True, all_series=None):
    """Walk one sport's series and return (games, futures, problems)."""
    catalogue = all_series if all_series is not None else list_series("Sports")
    sport_series = [s for s in catalogue if sports.sport_of(s["ticker"]) == sport_key]

    if verbose:
        print(f"  {sport_key}: {len(sport_series)} series", file=sys.stderr)

    cutoff = dt.date.today() + dt.timedelta(days=days_ahead)
    games, futures, problems = {}, {}, []

    for series in sorted(sport_series, key=lambda s: s["ticker"]):
        ticker = series["ticker"]
        title = series.get("title", "")
        bet_type, segment, segment_label, type_label = classify.classify_series(
            ticker, title)

        try:
            events = list_open_events(ticker)
        except KalshiUnavailable:
            raise
        except KalshiError as exc:
            problems.append(f"{ticker}: {exc}")
            continue

        for event in events:
            markets = [m for m in event.get("markets", [])
                       if m.get("status") in ("active", "open", None)]
            if not markets:
                continue

            trimmed = [trim_market(m, bet_type, segment, segment_label, type_label)
                       for m in markets]
            game_key = classify.parse_game_key(event["event_ticker"])

            if game_key:
                game_date = parse_game_date(game_key)
                if game_date and game_date > cutoff:
                    continue

                away, home = classify.parse_matchup(event.get("sub_title"))
                game = games.setdefault(game_key, {
                    "key": game_key,
                    "date": game_date.isoformat() if game_date else None,
                    "away": away, "home": home,
                    "title": None, "markets": [],
                })
                if away and not game["away"]:
                    game["away"], game["home"] = away, home
                if bet_type == "moneyline" and segment == "full":
                    game["title"] = event.get("title")
                game["markets"].extend(trimmed)
            else:
                key = event["event_ticker"]
                bucket = futures.setdefault(key, {
                    "event": key,
                    "series": ticker,
                    "title": event.get("title") or title,
                    "subtitle": event.get("sub_title") or "",
                    "markets": [],
                })
                bucket["markets"].extend(trimmed)

        time.sleep(0.08)

    return games, futures, problems


def attach_player_teams(game):
    """Tag each player market with the team code baked into its ticker.

    A prop ticker looks like KXNFLRSHYDS-26SEP20INDKC-KCKWALKER9-80: the third
    segment starts with the player's team. Matching it against the two teams in
    this game is safer than guessing from a roster, which goes stale every time
    somebody is traded.
    """
    candidates = [t for t in (game.get("away"), game.get("home")) if t]
    # Longest first so "KC" never shadows a hypothetical "KCX".
    candidates.sort(key=len, reverse=True)

    for market in game["markets"]:
        if not market.get("player"):
            continue
        parts = (market.get("ticker") or "").split("-")
        if len(parts) < 3:
            continue
        for team in candidates:
            if parts[2].startswith(team):
                market["team"] = team
                break


def build_sport(sport, days_ahead, verbose=True, all_series=None):
    games, futures, problems = collect(sport["key"], days_ahead, verbose, all_series)

    game_list = sorted(games.values(), key=lambda g: (g["date"] or "9999", g["key"]))
    for game in game_list:
        attach_player_teams(game)
        game["markets"].sort(key=lambda m: (-m["volume"], m["label"]))
        if not game["title"] and game["away"]:
            game["title"] = f"{game['away']} vs {game['home']}"

    futures_list = sorted(
        futures.values(),
        key=lambda f: (-sum(m["volume"] for m in f["markets"]), f["title"]))

    players = {m["player"] for g in game_list for m in g["markets"] if m["player"]}
    total = (sum(len(g["markets"]) for g in game_list)
             + sum(len(f["markets"]) for f in futures_list))

    return {
        "sport": sport["key"],
        "label": sport["label"],
        "espn": sport["espn"],
        "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "stats": {
            "markets": total, "games": len(game_list),
            "players": len(players), "futures": len(futures_list),
        },
        "teams": espn_teams(sport["espn"]),
        "scores": espn_scores(sport["espn"]),
        "games": game_list,
        "futures": futures_list,
        "problems": problems,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=10,
                        help="how far ahead a game counts as upcoming (default 10)")
    parser.add_argument("--sports", default="",
                        help="comma-separated sport keys (default: all covered)")
    parser.add_argument("--out", default="data", help="directory to write into")
    parser.add_argument("--teams-only", action="store_true",
                        help="refresh only the ESPN crest registry (no Kalshi calls)")
    parser.add_argument("--scores-only", action="store_true",
                        help="refresh only live scores (fast; no Kalshi calls)")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    verbose = not args.quiet
    wanted = [s.strip().lower() for s in args.sports.split(",") if s.strip()]
    chosen = [s for s in sports.SPORTS if not wanted or s["key"] in wanted]
    if not chosen:
        print(f"No sport matches {args.sports!r}. "
              f"Known: {', '.join(s['key'] for s in sports.SPORTS)}", file=sys.stderr)
        return 2

    if verbose:
        print(f"Fetching {len(chosen)} sports from Kalshi (no API key needed)...",
              file=sys.stderr)

    try:
        # One catalogue fetch shared by every sport, rather than one per sport.
        catalogue = [] if (args.teams_only or args.scores_only) else list_series("Sports")
    except KalshiUnavailable as exc:
        print(f"\nCould not reach Kalshi: {exc}", file=sys.stderr)
        print("Check your internet connection and try again. "
              "Any previous snapshot was left in place.", file=sys.stderr)
        return 1

    os.makedirs(args.out, exist_ok=True)
    index = {
        "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "daysAhead": args.days,
        "sports": [],
    }

    if args.teams_only or args.scores_only:
        for sport in chosen:
            path = os.path.join(args.out, f"sport-{sport['key']}.json")
            if not os.path.exists(path):
                continue
            with open(path) as handle:
                snapshot = json.load(handle)
            if args.teams_only:
                snapshot["teams"] = espn_teams(sport["espn"]) or snapshot.get("teams", {})
            if args.scores_only:
                snapshot["scores"] = espn_scores(sport["espn"])
                snapshot["scoresAt"] = dt.datetime.now(dt.timezone.utc).isoformat(
                    timespec="seconds")
            write_atomic(path, snapshot)
            if verbose:
                what = "teams" if args.teams_only else "scores"
                print(f"  {sport['key']}: {len(snapshot.get(what) or {})} {what} refreshed",
                      file=sys.stderr)
        return 0

    for sport in chosen:
        try:
            snapshot = build_sport(sport, args.days, verbose, catalogue)
        except KalshiUnavailable as exc:
            print(f"\nLost the connection during {sport['key']}: {exc}", file=sys.stderr)
            return 1

        path = os.path.join(args.out, f"sport-{sport['key']}.json")
        write_atomic(path, snapshot)

        stats = snapshot["stats"]
        index["sports"].append({
            "key": sport["key"], "label": sport["label"], "name": sport["name"],
            "espn": sport["espn"], "file": f"sport-{sport['key']}.json",
            "stats": stats,
        })
        if verbose:
            print(f"    -> {stats['markets']:,} markets, {stats['games']} games, "
                  f"{stats['players']} players", file=sys.stderr)

    # A partial run (--sports mlb) must not drop the sports it did not fetch.
    # Rebuild their index entries from the files already on disk, so the index
    # always describes everything present rather than only this run.
    fetched = {entry["key"] for entry in index["sports"]}
    for sport in sports.SPORTS:
        if sport["key"] in fetched:
            continue
        path = os.path.join(args.out, f"sport-{sport['key']}.json")
        if not os.path.exists(path):
            continue
        try:
            with open(path) as handle:
                existing = json.load(handle)
        except (OSError, json.JSONDecodeError):
            continue
        index["sports"].append({
            "key": sport["key"], "label": sport["label"], "name": sport["name"],
            "espn": sport["espn"], "file": f"sport-{sport['key']}.json",
            "stats": existing.get("stats", {}),
        })

    order = {sport["key"]: i for i, sport in enumerate(sports.SPORTS)}
    index["sports"].sort(key=lambda entry: order.get(entry["key"], 99))

    write_atomic(os.path.join(args.out, "index.json"), index)

    total = sum(s["stats"]["markets"] for s in index["sports"])
    print(f"\nWrote {len(index['sports'])} sports to {args.out}/ "
          f"({total:,} markets total)", file=sys.stderr)
    return 0


def write_atomic(path, payload):
    """Write via a temp file and rename, so an interrupted run never leaves
    the site pointing at truncated JSON."""
    temp = path + ".tmp"
    with open(temp, "w") as handle:
        json.dump(payload, handle, separators=(",", ":"))
    os.replace(temp, path)


if __name__ == "__main__":
    sys.exit(main())
