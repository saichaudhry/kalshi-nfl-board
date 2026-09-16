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
