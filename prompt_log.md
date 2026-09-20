# Prompt log

**AI tool used:** Claude Opus 5 via Claude Code (CLI), September 2026.

> **Note:** this is a draft record produced at the end of the session. Edit it
> into your own voice and add prompts from any other AI tools you used.

---

## Prompts I gave

**1. The opening ask**

> "i want you to hlep me do this we will use my kalshi api to track the pricing
> of every single upcoming sports market for nfl, we will sort it by players,
> player props, each match, over under, spread and everything i wnat to copy a
> ui in between kalshi and the apple instructions"

Pasted alongside it: Apple's interface-design guidelines (springs,
interruptibility, translucent materials, size-specific typography) and the HW3
assignment spec. This set the three goals — **complete coverage** of NFL
markets, **grouping along the axes a bettor thinks in**, and a **Kalshi × Apple**
interface.

**2. Supplying credentials**

> "here is api key make sure to follow how instructions instructed or simply a
> .env" *(followed by my Kalshi key ID and RSA private key)*

**3. Restructuring the market display**

> "good but let's have them all be different boxes instead of just the squares,
> more ui like that"

> "lets impraove futures and players similar to how we did the games, also some
> boxes show a market obut nio option / volume why is that"

> "instead of havinga box for each which is very odd and takes up a lot of
> space let's just do a slider for each market, same for like if we are showing
> market for ravens over under wins we dont need to seee each one just a number
> line is good"

**4. Team identity**

> "these dont work when i press on a market … can we also start linknig
> multiple predicttion market prices or if it is easier can we have every
> marekt we press on takes us to tht market on kalshi"

> "can we have it that it updates every hour?"

**5. Scope expansion**

> "you have read only access to my account so yoou are able to also pull all the
> trades I have made work on that as well and put those in in a traded section,
> can we also now do this for every sport, and highlight the sports that I am
> trading, then we can connect espn public api … a live scoreboard of all of my
> trades and picks"

**6. Correcting a misleading number**

> "the -1999 isnt the current model"

**7. Standing instruction**

> "keep pushign any improvmeents/bugs/edge cases"

---

## How the session actually went

Most of the implementation came from the assistant working against the live API
rather than from further prompting by me. The exchanges that changed the design:

### It refused the key and found a better path

The assistant would not write the key to any file, and pushed back with two
points:

- **Rotate it.** Pasting it into the chat put it in the transcript and shell
  history, so it needed regenerating at Kalshi → Settings → API Keys.
- **The project doesn't need it.** It had already probed the endpoints and found
  Kalshi's market-data API is fully public:

  ```
  GET /trade-api/v2/series?category=Sports  → 200 (no auth)
  GET /trade-api/v2/events?series_ticker=…  → 200 (no auth, live prices)
  ```

This reshaped the project. Going keyless removed the assignment's biggest risk
(committing a secret) and let the page be hosted anywhere. **The most useful
thing the tool did was decline the approach I handed it and verify a simpler one
first.**

### It checked the raw response before writing code

The assignment tips say to do this, and it mattered immediately. The obvious
field names — `yes_bid`, `last_price`, `volume` — all return `None`. The API
actually returns:

```json
{ "yes_bid_dollars": "0.6700", "last_price_dollars": "0.6800", "volume_fp": 663964.55 }
```

Prices are **strings in dollars**, not integer cents. Code written from memory
would have rendered an entire page of `—` without erroring.

### It found the join key by reading ticker structure

```
KXNFLGAME-26SEP17DETBUF          ← moneyline
KXNFLSPREAD-26SEP17DETBUF        ← spread
KXNFLPASSYDS-26SEP17DETBUF       ← player props
                └─ shared key: 26SEP17DETBUF
```

Everything joins on the event-ticker suffix. That one observation is what lets a
single game card hold 683 markets drawn from a dozen separate series.

### Two silent bugs it caught by inspecting its own output

1. Player-name extraction used `re.IGNORECASE` on the pattern meant to exclude
   team names, which made `[A-Z]{2,4}` match lowercase — so **"Josh Allen" was
   classified as a team** and every player disappeared. Fixed by making that
   check case-sensitive on purpose (`BUF Bills` is a team, `Josh Allen` is a
   person).
2. `Full Game: Over 53.5 points scored` was being read as a player named "Full
   Game", because totals markets share the "prefix before the colon" shape.

Both versions ran without raising anything. They were only caught because the
extracted names were printed and read.

### It tested the CORS assumption instead of assuming

```bash
curl -H "Origin: https://example.com" …/markets?limit=1   # → 403
curl …/markets?limit=1                                     # → 200
```

Kalshi rejects any request carrying an `Origin` header, so a browser cannot call
it at all. This forced the architecture: **Python fetches → JSON snapshot →
static page renders.** (The assignment warns against putting a key in front-end
code; here the API refuses front-end access outright, key or not.)

### UI direction it was given

Kalshi's conventions with Apple's interaction behaviour, specifically:

- Prices in cents (`67¢` = a 67% market), YES and NO both quoted, green/red
- Feedback on **pointer-down**, not release
- Disclosure via `grid-template-rows: 0fr → 1fr` on Apple's critically-damped
  `cubic-bezier(0.32, 0.72, 0, 1)` — true content height, no overshoot
- Translucent `backdrop-filter` header that content scrolls *under*
- Size-specific tracking: `-0.024em` on the heading, `+0.055em` on small caps
- Tabular figures so prices don't reflow as they tick
- `prefers-reduced-motion`, `prefers-reduced-transparency`, `prefers-contrast`

### Failure cases were run, not just written

Per the assignment's "try to break it": wifi off (clean message, exit 1,
existing snapshot left intact), bad series ticker (skipped, other 341 continue),
rate limit / 5xx (three retries, exponential backoff), malformed JSON (named
error), off-season with zero markets (friendly empty state), missing snapshot
(explains that `file://` blocks `fetch()`), interrupted write (`.tmp` + atomic
`os.replace`).

### A wrong assumption it corrected against the data

It flagged "Kenneth Walker" appearing under Colts vs Chiefs as a probable join
bug. Checking the raw ticker — `KXNFLRSHYDS-26SEP20INDKC-KCKWALKER9-80` — showed
Kalshi has him on **KC**; the pipeline was right and the roster assumption was
stale. That ticker structure then became the source for the team tag shown next
to each player, which is more durable than a hardcoded roster.


---

## Later sessions: what the expansion turned up

The project grew from one league to eight, plus live scores and a private
trades dashboard. Most of the work was the assistant probing the two APIs;
these are the exchanges that changed the design.

### Publishing my own trades was the wrong instinct

I asked for my Kalshi fills in the app. The assistant pushed back before
writing anything: `kalshi-nfl-board` is a **public** repo on GitHub Pages with
a cron republishing it, so putting fills or P&L in the snapshot would have
published my whole book permanently, recoverable from git history even after
deletion. The design that shipped keeps trades in `data/private.local.json`,
gitignored, with the "My Trades" tab appearing only when that file exists. The
deployed site returns `404` for it — verified.

### Realised P&L read exactly zero, and the reason was subtle

`/portfolio/positions` only reports positions that are still **open**, so a
fully settled book sums to nothing through it. Realised P&L lives in
`/portfolio/settlements`. Two neighbouring traps: Kalshi signs the request path
**without** its query string (including it returns a misleading
`INCORRECT_API_KEY_SIGNATURE` rather than anything about the query), and
settlement `revenue` is in **cents** while the cost fields are **dollar
strings** — mixing them turns a profit into a 100× loss.

### A CORS header that lies

ESPN advertises `access-control-allow-origin: *` and honours it for `curl` from
any origin, so live scores looked like a browser job. In a browser every call
failed as a CORS error. The cause was ESPN rejecting browser-shaped requests
and returning an error page, which carries no CORS headers — the browser then
reports the missing header, not the block. Scores are collected by the fetcher
instead.

### One trade was defining the headline

Lifetime P&L showed **-$1,199**, which I said was not the current model. It was
one market: `KXWNBAGAME-26AUG06LAMIN-LA` lost **-$1,422.79**, more than the
entire net loss. The trades view now takes a 7/30/90-day window (30 by
default), and where a single market still exceeds the net result it is named
along with what the period looks like without it. The same book reads **+$375
at +14.5%** over 30 days.

### Bugs that only appeared once the data got wider

- **MLB had zero games.** Baseball tickers embed a first-pitch time
  (`26SEP16` + `1840` + `ATHTB`) that the game-key pattern rejected, so every
  game was filed as a season future.
- **Scores landed on the wrong fixture.** The join keyed on the two team
  abbreviations with no date, and 15 of 35 MLB pairs play on consecutive days
  (one twice in a day), so today's live score appeared on tomorrow's game. The
  join moved into the fetcher and now matches on date, converting ESPN's UTC
  timestamps to Eastern first.
- **"DJ Moore" was classified as a team.** The team test matched the shape
  `[A-Z]{2,4} [A-Z][a-z]`, which cannot separate `DET Lions` from `DJ Moore`.
  Checking the nickname against the real league list recovered seven players.
- **Tennis had no competitors on screen.** There are no club abbreviations for
  two people or two pairs, so tiles read "— vs —"; the sides now come from the
  busiest opposing markets.
- **Team identity now comes from the ticker, not the label.** Kalshi writes
  `A's` for a club ESPN only ever calls `Athletics`.

### What I asked it to keep doing

> "keep pushign any improvmeents/bugs/edge cases"

Working that way found the score mis-attribution, the sport-switch race
condition, and the delisted-game dead end — none of which I had noticed.

**Lesson across the whole project:** almost every real bug was found by
printing the actual data and reading it, not by reasoning about what the API
*should* return. The ones that hurt most looked completely fine in code.
