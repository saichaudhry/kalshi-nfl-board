#!/usr/bin/env python3
"""
Pull your own Kalshi trading history into a LOCAL-ONLY file.

    python3 fetch_private.py        ->  data/private.local.json

Everything this writes is private: fills, positions, realised P&L. The output
path is in .gitignore and must stay there. The public site never loads it --
the Trades tab simply does not appear when the file is missing, which is the
case for anyone visiting the deployed page.

Credentials come from the environment, never from the repo:

    export KALSHI_KEY_ID=<the key id from kalshi.com -> Settings -> API Keys>
    export KALSHI_KEY_FILE=~/.kalshi/kalshi_key.pem

Read-only: this script only ever issues GETs against /portfolio.
"""

import argparse
import base64
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://api.elections.kalshi.com"
PREFIX = "/trade-api/v2"


def load_key():
    key_id = os.environ.get("KALSHI_KEY_ID")
    key_file = os.environ.get("KALSHI_KEY_FILE", "~/.kalshi/kalshi_key.pem")
    if not key_id:
        print("KALSHI_KEY_ID is not set. See the docstring at the top of this "
              "file for how to provide credentials.", file=sys.stderr)
        raise SystemExit(2)

    path = os.path.expanduser(key_file)
    if not os.path.exists(path):
        print(f"Private key not found at {path}. Set KALSHI_KEY_FILE.", file=sys.stderr)
        raise SystemExit(2)

    try:
        from cryptography.hazmat.primitives import serialization
    except ImportError:
        print("This script needs the 'cryptography' package:\n"
              "    python3 -m pip install cryptography", file=sys.stderr)
        raise SystemExit(2)

    with open(path, "rb") as handle:
        return key_id, serialization.load_pem_private_key(handle.read(), password=None)


def signed_get(key_id, key, path, params=None):
    """GET an authenticated endpoint.

    Kalshi signs `timestamp + METHOD + path` -- the path WITHOUT its query
    string. Including the query is the easy mistake and returns a confusing
    INCORRECT_API_KEY_SIGNATURE rather than a hint about what is wrong.
    """
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding

    full_path = PREFIX + path
    timestamp = str(int(time.time() * 1000))
    signature = key.sign(
        (timestamp + "GET" + full_path).encode(),
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()),
                    salt_length=padding.PSS.DIGEST_LENGTH),
        hashes.SHA256(),
    )

    url = BASE + full_path
    if params:
        url += "?" + urllib.parse.urlencode({k: v for k, v in params.items()
                                             if v is not None})

    request = urllib.request.Request(url, headers={
        "KALSHI-ACCESS-KEY": key_id,
        "KALSHI-ACCESS-SIGNATURE": base64.b64encode(signature).decode(),
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
        "User-Agent": "gridiron-board/local",
    })

    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        body = exc.read()[:200].decode(errors="replace")
        if exc.code == 401:
            print("Kalshi rejected the credentials. If you regenerated the key, "
                  "update KALSHI_KEY_ID and KALSHI_KEY_FILE.", file=sys.stderr)
        raise SystemExit(f"HTTP {exc.code} on {path}: {body}")
    except urllib.error.URLError as exc:
        raise SystemExit(f"Cannot reach Kalshi: {exc.reason}")


def paginate(key_id, key, path, collection, limit=1000, max_pages=40):
    out, cursor = [], None
    for _ in range(max_pages):
        payload = signed_get(key_id, key, path,
                             {"limit": limit, "cursor": cursor})
        page = payload.get(collection) or []
        out.extend(page)
        cursor = payload.get("cursor")
        if not cursor or not page:
            break
        time.sleep(0.1)
    return out


def cents(value):
    """Kalshi returns money as dollar strings; cents keep the arithmetic exact."""
    try:
        return int(round(float(value) * 100))
    except (TypeError, ValueError):
        return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="data/private.local.json")
    args = parser.parse_args()

    if ".local." not in os.path.basename(args.out):
        print("Refusing to write private data to a path without '.local.' in "
              "the name -- that is what keeps it out of git.", file=sys.stderr)
        return 2

    key_id, key = load_key()
    print("Pulling your fills and positions (read-only)...", file=sys.stderr)

    fills = paginate(key_id, key, "/portfolio/fills", "fills")
    positions = paginate(key_id, key, "/portfolio/positions", "market_positions")
    # /positions only carries what is still open, so realised P&L has to come
    # from /settlements -- which is where a finished market reports what it
    # actually paid out.
    settlements = paginate(key_id, key, "/portfolio/settlements", "settlements")

    trades = []
    for fill in fills:
        price = cents(fill.get("yes_price_dollars") if fill.get("side") == "yes"
                      else fill.get("no_price_dollars"))
        count = int(float(fill.get("count_fp") or 0))
        trades.append({
            "id": fill.get("fill_id"),
            "ticker": fill.get("ticker") or fill.get("market_ticker"),
            "series": (fill.get("ticker") or "").split("-")[0],
            "side": fill.get("side"),
            "action": fill.get("action"),
            "isTaker": fill.get("is_taker"),
            "count": count,
            "price": price,
            "cost": price * count,
            "fee": cents(fill.get("fee_cost")),
            "ts": fill.get("created_time") or fill.get("ts"),
        })
    trades.sort(key=lambda t: t["ts"] or "")

    book = []
    for position in positions:
        book.append({
            "ticker": position.get("ticker"),
            "series": (position.get("ticker") or "").split("-")[0],
            # The count field is position_fp, not position -- reading the wrong
            # one silently reports every holding as flat.
            "position": int(float(position.get("position_fp") or 0)),
            "realized": cents(position.get("realized_pnl_dollars")),
            "exposure": cents(position.get("market_exposure_dollars")),
            "fees": cents(position.get("fees_paid_dollars")),
        })

    settled = []
    for s in settlements:
        # revenue is already in cents; the cost and fee fields are dollar
        # strings. Mixing the two up turns a profit into a 100x loss.
        revenue = int(s.get("revenue") or 0)
        cost = cents(s.get("yes_total_cost_dollars")) + cents(s.get("no_total_cost_dollars"))
        fee = cents(s.get("fee_cost"))
        settled.append({
            "ticker": s.get("ticker"),
            "series": (s.get("ticker") or "").split("-")[0],
            "result": s.get("market_result"),
            "yes": int(float(s.get("yes_count_fp") or 0)),
            "no": int(float(s.get("no_count_fp") or 0)),
            "revenue": revenue,
            "cost": cost,
            "fee": fee,
            "pnl": revenue - cost - fee,
            "ts": s.get("settled_time"),
        })
    settled.sort(key=lambda x: x["ts"] or "")

    snapshot = {
        "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "private": True,
        "trades": trades,
        "positions": book,
        "settlements": settled,
    }

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    temp = args.out + ".tmp"
    with open(temp, "w") as handle:
        json.dump(snapshot, handle, separators=(",", ":"))
    os.replace(temp, args.out)
    os.chmod(args.out, 0o600)   # your book is nobody else's business

    pnl = sum(x["pnl"] for x in settled)
    print(f"\nWrote {args.out} ({len(trades)} fills, {len(settled)} settlements, "
          f"{len(book)} positions)", file=sys.stderr)
    print(f"  realised P&L across settled markets: ${pnl / 100:,.2f}", file=sys.stderr)
    print("This file is gitignored. Do not commit it.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
