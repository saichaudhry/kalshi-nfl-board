#!/usr/bin/env python3
"""
Build a snapshot of every open NFL market on Kalshi.

Kalshi's API is organised for the exchange: ~340 separate "series", each holding
events, each holding markets. Nobody wants to browse that. This script walks all
of it, re-groups the markets by game / bet type / player, and writes a single
JSON file that the static front-end can load instantly.

Run:  python3 fetch_nfl.py
Out:  data/snapshot.json

No API key required -- Kalshi's market-data endpoints are public.
"""

import argparse
import datetime as dt
import json
import os
import sys
import time

import classify
from kalshi_api import KalshiError, KalshiUnavailable, list_open_events, list_series

# Series whose tickers start with one of these belong to pro football.
NFL_PREFIXES = ("KXNFL", "KXLEADERNFL", "KXSTARTINGQB", "KXNEXTNFL")

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


def collect(days_ahead, verbose=True):
    """Walk every NFL series and return (games, futures, problems)."""
    all_series = list_series("Sports")
    nfl_series = [s for s in all_series
                  if s["ticker"].upper().startswith(NFL_PREFIXES)]

    if verbose:
        print(f"  {len(all_series)} sports series -> "
              f"{len(nfl_series)} pro football series", file=sys.stderr)

    cutoff = dt.date.today() + dt.timedelta(days=days_ahead)
    games, futures, problems = {}, {}, []

    for index, series in enumerate(sorted(nfl_series, key=lambda s: s["ticker"]), 1):
        ticker = series["ticker"]
        title = series.get("title", "")
        bet_type, segment, segment_label, type_label = classify.classify_series(
            ticker, title)

        try:
            events = list_open_events(ticker)
        except KalshiUnavailable:
            # Network died mid-run: stop rather than write a half-empty snapshot
            # that would look like "the NFL season ended".
            raise
        except KalshiError as exc:
            # One bad series should not kill a run over 340 of them.
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
                    continue  # too far out to count as "upcoming"

                away, home = classify.parse_matchup(event.get("sub_title"))
                game = games.setdefault(game_key, {
                    "key": game_key,
                    "date": game_date.isoformat() if game_date else None,
                    "away": away, "home": home,
                    "title": None, "markets": [],
                })
                # Fill in team codes / a human title from whichever event has them.
                if away and not game["away"]:
                    game["away"], game["home"] = away, home
                # Only the full-game moneyline series carries a clean
                # "DET Lions vs BUF Bills" title; the 1st-half winner series
                # would otherwise win the race and title the card "... 1st Half".
                if bet_type == "moneyline" and segment == "full":
                    game["title"] = event.get("title")
                game["markets"].extend(trimmed)
            else:
                bucket = futures.setdefault(ticker, {
                    "series": ticker, "title": title, "markets": [],
                })
                bucket["markets"].extend(trimmed)

        if verbose and index % 25 == 0:
            print(f"  ...{index}/{len(nfl_series)} series", file=sys.stderr)
        time.sleep(0.08)  # stay well under the public rate limit

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


def build_snapshot(days_ahead, verbose=True):
    games, futures, problems = collect(days_ahead, verbose)

    game_list = sorted(games.values(), key=lambda g: (g["date"] or "9999", g["key"]))
    for game in game_list:
        attach_player_teams(game)
        # Most interesting markets first: real trading activity, then price.
        game["markets"].sort(key=lambda m: (-m["volume"], m["label"]))
        if not game["title"] and game["away"]:
            game["title"] = f"{game['away']} vs {game['home']}"

    futures_list = sorted(futures.values(), key=lambda f: -len(f["markets"]))

    players = {}
    for game in game_list:
        for market in game["markets"]:
            if market["player"]:
                players.setdefault(market["player"], 0)
                players[market["player"]] += 1

    total_markets = (sum(len(g["markets"]) for g in game_list)
                     + sum(len(f["markets"]) for f in futures_list))

    return {
        "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "daysAhead": days_ahead,
        "stats": {
            "markets": total_markets,
            "games": len(game_list),
            "players": len(players),
            "futures": len(futures_list),
        },
        "games": game_list,
        "futures": futures_list,
        "problems": problems,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=10,
                        help="how far ahead a game counts as upcoming (default 10)")
    parser.add_argument("--out", default="data/snapshot.json",
                        help="where to write the snapshot")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    verbose = not args.quiet
    if verbose:
        print("Fetching NFL markets from Kalshi (no API key needed)...",
              file=sys.stderr)

    try:
        snapshot = build_snapshot(args.days, verbose)
    except KalshiUnavailable as exc:
        # The most common real-world failure: no wifi. Say so in English and
        # leave any existing snapshot untouched so the site still renders.
        print(f"\nCould not reach Kalshi: {exc}", file=sys.stderr)
        print("Check your internet connection and try again. "
              "The previous snapshot (if any) was left in place.", file=sys.stderr)
        return 1

    if not snapshot["games"] and not snapshot["futures"]:
        print("\nKalshi returned no open NFL markets. This is normal in the "
              "off-season (February - August).", file=sys.stderr)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    # Write to a temp file then move it, so an interrupted run can never leave
    # the site pointed at a truncated JSON file.
    temp_path = args.out + ".tmp"
    with open(temp_path, "w") as handle:
        json.dump(snapshot, handle, separators=(",", ":"))
    os.replace(temp_path, args.out)

    stats = snapshot["stats"]
    size_mb = os.path.getsize(args.out) / 1_000_000
    print(f"\nWrote {args.out}  ({size_mb:.2f} MB)", file=sys.stderr)
    print(f"  {stats['markets']:,} markets | {stats['games']} games | "
          f"{stats['players']} players | {stats['futures']} futures groups",
          file=sys.stderr)
    if snapshot["problems"]:
        print(f"  {len(snapshot['problems'])} series skipped after errors",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
