# Gridiron Board

Live prices for **every upcoming NFL market on Kalshi**, re-organised the way a
bettor actually thinks: by game, by bet type, by period, and by player.

Kalshi lists pro football across **342 separate market series**. Browsing that
on the exchange means clicking through hundreds of pages. This project pulls all
of it in one pass — **12,600+ open markets across 17 upcoming games and 150+
players** — and renders it as a single searchable board.

![Gridiron Board](docs/screenshot.png)

---

## How the API is called

The app talks to Kalshi's **public market-data API** (`https://api.elections.kalshi.com/trade-api/v2`)
using nothing but the Python standard library — `urllib.request` to make the
HTTP GET and `json` to decode it, wrapped in `kalshi_api.py`. Three endpoints do
the work: `GET /series?category=Sports` lists every market family (from which the
342 pro-football ones are filtered by ticker prefix), and
`GET /events?series_ticker=…&status=open&with_nested_markets=true` returns each
series' open events **with their child markets and live prices inlined** — that
last parameter is the important one, because it collapses what would be
thousands of requests into one per series. Responses are JSON objects whose
`markets[]` entries carry prices as **strings in dollars** (`"yes_bid_dollars": "0.6700"`),
which the code converts to the integer cents Kalshi's own UI displays (`67¢`);
pagination is handled by following the opaque `cursor` string each response
returns until it comes back empty.

### No API key required

**This project needs no API key, no account, and no authentication.** Kalshi's
market-data endpoints are fully public. That is a deliberate design choice: it
means there is no secret to leak, and the page can be hosted anywhere.

If you later extend this to *authenticated* endpoints (balances, orders), those
need an RSA key pair from Kalshi → Settings → API Keys. Put the key ID in a
`.env` file and the `.pem` outside the repo, and read them via environment
variables — `.gitignore` already blocks `.env` and `*.pem`. Never commit either.

### Why the browser doesn't call Kalshi directly

Kalshi's API returns **HTTP 403 to any request carrying an `Origin` header**, so
browser JavaScript cannot call it — there is no CORS access:

```
$ curl -s -o /dev/null -w "%{http_code}\n" \
    -H "Origin: https://example.com" \
    "https://api.elections.kalshi.com/trade-api/v2/markets?limit=1"
403

$ curl -s -o /dev/null -w "%{http_code}\n" \
    "https://api.elections.kalshi.com/trade-api/v2/markets?limit=1"
200
```

So the architecture is **Python fetches → JSON snapshot → static page renders**.
`fetch_nfl.py` writes `data/snapshot.json`; `js/app.js` reads that file. This
also keeps the live site keyless and free of any backend.

---

## Running it

Requires **Python 3.8+**. There is nothing to `pip install` — standard library only.

```bash
git clone https://github.com/saichaudhry/kalshi-nfl-board.git
cd kalshi-nfl-board

# 1. Pull current markets from Kalshi (~12 minutes, ~1,100 requests)
python3 fetch_markets.py

# 2. Serve the folder and open it
python3 -m http.server 8000
#    then visit http://localhost:8000
```

Step 2 matters: opening `index.html` straight off the filesystem will **not**
work, because browsers block `fetch()` on `file://` URLs. The page says so if
you try.

Options:

```bash
python3 fetch_markets.py --sports nfl,mlb   # just these leagues
python3 fetch_markets.py --days 3           # only games within 3 days
python3 fetch_markets.py --scores-only      # refresh scores only (seconds)
python3 fetch_markets.py --teams-only       # refresh crests only
```

### Live scores

Scores come from ESPN's public API, which needs no key. They are collected by
the fetcher rather than the browser: ESPN advertises
`access-control-allow-origin: *` and honours it for `curl`, but rejects
browser-shaped requests, and the rejection carries no CORS headers — so a page
fetch fails with a misleading CORS error. The front-end still attempts a live
call and upgrades if it ever succeeds. A game that has already finished is
usually absent, because Kalshi delists a market once it settles.

### Your own trades (local only)

`fetch_private.py` pulls your Kalshi fills, positions and settlements into
`data/private.local.json`, which is **gitignored and never published**. The
"My Trades" tab appears only when that file is present, so it simply does not
exist on the deployed site.

```bash
export KALSHI_KEY_ID=...                      # kalshi.com -> Settings -> API Keys
export KALSHI_KEY_FILE=~/.kalshi/kalshi_key.pem
python3 fetch_private.py
```

Read-only: it issues GETs against `/portfolio` and nothing else. Realised P&L
comes from `/portfolio/settlements`, not `/positions` — `/positions` only
reports what is still open, so a settled book reads as zero P&L if you use it.
Two details that are easy to get wrong: Kalshi signs the request path **without**
its query string, and settlement `revenue` is in cents while the cost fields are
dollar strings.

---

## What it does with the data

Raw Kalshi structure is series → events → markets, which is built for the
exchange, not for a person. `classify.py` re-shapes it:

- **Join games across series.** `KXNFLSPREAD-26SEP17DETBUF`,
  `KXNFLTOTAL-26SEP17DETBUF` and `KXNFLPASSYDS-26SEP17DETBUF` all share the key
  `26SEP17DETBUF`, so spreads, totals and props collapse onto one game card.
- **Classify the bet.** Series tickers are parsed into a bet type (moneyline /
  spread / total / team total / player prop) and a period (full game, 1st half,
  3rd quarter, overtime), so `KXNFL1HSPREAD` becomes "Spread · 1st Half".
- **Find the players.** Prop titles read `Josh Allen: 175+ passing yards`, so the
  name is the prefix before the colon — filtered so that team defenses
  (`BUF Bills D/ST`), period labels (`Full Game: Over 53.5`) and escape options
  (`No Touchdown`) don't get mistaken for people. Each player's team is read out
  of the market ticker (`…-KCKWALKER9-80` → `KC`) rather than a hardcoded roster,
  so it survives trades.
- **Trim hard.** Raw markets carry ~40 fields each; only the 14 the UI renders
  are kept, which is the difference between a 40 MB and a 3.8 MB snapshot
  (≈270 KB gzipped over the wire).

The interface shows Kalshi's own conventions — prices in cents, where `67¢`
means the market thinks it's 67% likely, with YES/NO both quoted — plus a
probability bar and the price change since the previous close.

**Games, players and futures are all grids.** Every game is a box laid out
left-to-right and top-to-bottom, showing its headline numbers on the face: both
clubs with their moneyline price, which side is favoured, the spread and the
total. Nothing has to be opened to compare the slate. The spread and total shown
are whichever market is trading nearest 50¢ — the same reasoning a sportsbook
uses to publish one number out of a ladder. Opening a game pushes a history
entry, so the browser and the phone's back gesture leave the game rather than
the site, and every game has a shareable `#26SEP17DETBUF` deep link.

**A ladder of strikes is one number line, not twenty boxes.** A spread or a
total is the same question asked at twenty prices, so it renders as a single
track you drag: the strikes sit along it by value (so a jump from 40 to 90 yards
looks like a jump), and the readout shows the line and its price as you move.
It opens on whichever strike trades nearest 50¢ — the one the book is genuinely
undecided about. Dragging tracks the pointer 1:1 with no transition, so the knob
never lags behind the finger, and the track is a real `role="slider"` that
responds to arrow keys, Home and End. Ladders shorter than four strikes stay as
boxes, where a slider would be more work than just reading them.

A player tile carries their club crest and their three busiest stats, each at
the strike trading nearest 50¢, so you can read a quarterback's passing line off
the grid. A futures tile leads with the outcomes people actually trade — sorting
by price alone fills the preview with 100¢ near-certainties that say nothing.

**Only traded markets are shown by default.** Kalshi quotes every strike it
lists, and about half have never traded; those quotes are real but indicative,
with a median bid-ask spread of 14¢ against roughly 1¢ on an active market.
The "Traded only" switch turns them back on.

**Futures are grouped by event, not series.** `KXNFLWINS` holds one event per
club and every one of them labels its outcomes the same way ("1+ wins", "2+
wins"), so grouping by series produced a list in which nothing identified the
team. Grouping by event gives "Pro Football: Dallas Total Wins" its own ladder.

Each block of markets links out to its family on Kalshi. Kalshi documents
series-level pages only — `https://kalshi.com/markets/kxhighny` in their own
quick-start guide — and publishes no per-contract URL, so the link appears
exactly where a block of markets shares one series, and nowhere that it would
be a guess.

Inside a game, **each market type is drawn in the shape that suits it**, rather
than as one uniform list of rows. A moneyline becomes a head-to-head box with both teams'
implied probability set large. Spreads, totals and team totals become ladders
split by side, where the repeated stem ("Buffalo wins by over …") is lifted into
a heading so each rung shows only the line that actually varies — turning a wall
of wrapped sentences into a row you can read across. Player props become one box
per person, holding that player's ladders for every stat they're priced on.
Everything else falls back to tiles.

**Team crests** appear on every matchup row, in the head-to-head box, and beside
each player, so a game is identifiable before you read it. The images are loaded
from ESPN's public logo CDN (`a.espncdn.com/i/teamlogos/nfl/500/<slug>.png`) —
Kalshi's team codes mostly match ESPN's slugs but not always, so `js/teams.js`
stores the slug per club rather than lowercasing the code and hoping. Underneath
every logo sits a monogram in that club's primary colour; if the CDN is
unreachable the monogram is what you see, so a team never renders as a broken
image. (Logos are NFL trademarks, referenced from their origin to identify the
clubs, not redistributed in this repo.)

---

## When things go wrong

Deliberately tested failure modes:

| What breaks | What happens |
| --- | --- |
| No internet | Fetcher prints `Could not reach Kalshi: …`, exits `1`, and **leaves the existing snapshot in place** so the site still renders |
| Kalshi rate-limits (429) or 5xx | Retried three times with exponential backoff |
| One series 404s or errors | Skipped and recorded in `problems[]`; the other 341 still finish |
| Malformed JSON | Raises a clear `KalshiError` naming the URL |
| Off-season, no NFL markets | Page shows "No open NFL markets — this is normal between February and August" instead of a blank screen |
| Snapshot missing | Page explains how to generate it and why `file://` fails |
| Search matches nothing | Friendly empty state per tab, not an empty page |
| Interrupted mid-write | Snapshot is written to a `.tmp` file and atomically moved, so it is never half-written |

---

## Design notes

The interface follows Apple's interaction guidance: feedback fires on
*pointer-down* rather than release; the translucent header is a real material
(`backdrop-filter`) that content scrolls beneath rather than an opaque bar;
disclosure uses a `grid-template-rows` transition on Apple's critically-damped
`cubic-bezier(0.32, 0.72, 0, 1)` curve so cards open to their true height with no
overshoot; type uses size-specific tracking (tightened to `-0.024em` on the
heading, opened to `+0.055em` on small uppercase labels); and prices are set in
tabular figures so they don't reflow as they tick. `prefers-reduced-motion`,
`prefers-reduced-transparency` and `prefers-contrast` are all honoured, and the
whole palette is token-driven so light and dark are defined once each.

## Files

```
fetch_markets.py  entry point: walks every covered series, writes the snapshots
fetch_private.py  YOUR fills/settlements -> data/private.local.json (gitignored)
sports.py         the leagues covered, and how each maps onto Kalshi and ESPN
kalshi_api.py     HTTP client — pagination, retries, offline vs. server errors
classify.py       game keys, bet types, periods, player-name extraction
index.html      page shell
css/app.css     design tokens + layout
js/teams.js     crests, colours and name lookup, per league
js/sportbar.js  sport switcher, live scores, private-data loading
js/trades.js    the local-only trades dashboard
js/app.js       rendering, filtering, search
data/index.json + data/sport-*.json   generated; commit so the site works
data/private.local.json               generated; NEVER commit
```

---

Prices from the Kalshi public market-data API. Not affiliated with Kalshi.
Built for CMU 15-113; for coursework, not for trading.
