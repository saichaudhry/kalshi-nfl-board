# Prompt log

**Model / tool used:** Claude Opus 5 via Claude Code (CLI), September 2026.

These are the prompts and exchanges that actually shaped the project, not the
full transcript.

---

### 1. The opening ask

> "I want you to help me do this — we will use my Kalshi API to track the pricing
> of every single upcoming sports market for NFL. We will sort it by players,
> player props, each match, over/under, spread and everything. I want to copy a UI
> in between Kalshi and the Apple [HIG] instructions."

Attached alongside this: Apple's `apple-design` interaction guidelines (springs,
interruptibility, translucent materials, size-specific typography) and the
HW3 assignment spec.

This set the three goals: **complete coverage** of NFL markets, **grouping along
the axes a bettor thinks in**, and a **Kalshi × Apple** interface.

---

### 2. Handing over an API key — and being told not to use it

I pasted my Kalshi key ID and RSA private key into the chat.

The assistant refused to write it anywhere and pushed back with two things:

- **Rotate it.** It was now in the chat transcript and shell history, so it had
  to be regenerated at Kalshi → Settings → API Keys.
- **You don't need it.** It had already tested the endpoints and found that
  Kalshi's market-data API is fully public:

  ```
  GET /trade-api/v2/series?category=Sports  → 200 (no auth)
  GET /trade-api/v2/events?series_ticker=…  → 200 (no auth, live prices)
  ```

This changed the design. Going keyless removed the assignment's biggest risk
(committing a secret) and meant the site could be hosted anywhere.

**Lesson:** the most useful thing the model did here was decline the approach I
handed it and verify a simpler one first.

---

### 3. "Check the raw response before writing any code"

Early instruction, straight out of the assignment tips. It paid off immediately.

The obvious field names — `yes_bid`, `last_price`, `volume` — all come back
`None`. The API actually returns:

```json
{ "yes_bid_dollars": "0.6700", "last_price_dollars": "0.6800", "volume_fp": 663964.55 }
```

Prices are **strings in dollars**, not integer cents. A plausible-looking
implementation written from memory would have rendered an entire page of `—`.

---

### 4. "How do I join spreads, totals and props to the same game?"

The answer came from reading ticker structure rather than guessing:

```
KXNFLGAME-26SEP17DETBUF          ← moneyline
KXNFLSPREAD-26SEP17DETBUF        ← spread
KXNFLPASSYDS-26SEP17DETBUF       ← player props
                └─ shared key: 26SEP17DETBUF
```

Everything joins on the event-ticker suffix. That single observation is what
makes one game card able to hold 683 markets from a dozen different series.

---

### 5. "Extract the player name from each prop market"

First attempt used `re.IGNORECASE` on the pattern excluding team names —
which made `[A-Z]{2,4}` match lowercase, so **"Josh Allen" was classified as a
team** and every player vanished.

Fixed by making the team check case-sensitive on purpose (`BUF Bills` is a team,
`Josh Allen` is a person). A second pass caught `Full Game: Over 53.5 points`
being read as a player named "Full Game".

**Lesson:** I only caught both because I printed the extracted names and looked
at them. The code ran without errors in both broken states.

---

### 6. "Why can't the browser just call Kalshi directly?"

Tested rather than assumed:

```bash
curl -H "Origin: https://example.com" …/markets?limit=1   # → 403
curl …/markets?limit=1                                     # → 200
```

Kalshi rejects any request with an `Origin` header, so there is no CORS access
from a browser. This forced the architecture: **Python fetches → JSON snapshot →
static page renders.** Worth noting the assignment warns against putting a key
in front-end code; here the API refuses front-end access outright.

---

### 7. "Now build the UI — Kalshi's conventions, Apple's behaviour"

Specific direction given, rather than "make it look nice":

- Prices in cents (`67¢` = a 67% market), YES and NO both quoted, green/red.
- Feedback on **pointer-down**, not release (`:active`, no waiting for `click`).
- Disclosure animated with `grid-template-rows: 0fr → 1fr` on Apple's
  critically-damped `cubic-bezier(0.32, 0.72, 0, 1)` — opens to true content
  height at any width, with no overshoot.
- Translucent `backdrop-filter` header that content scrolls *under*.
- Size-specific tracking: `-0.024em` on the heading, `+0.055em` on small caps.
- Tabular figures so prices don't reflow as they tick.
- `prefers-reduced-motion`, `prefers-reduced-transparency`, `prefers-contrast`.

---

### 8. "Try to break it"

Explicitly asked for the failure cases the assignment requires. Each was run,
not just written:

- Wifi off → clean message, exit 1, **existing snapshot left intact**
- Bad series ticker → skipped, run continues across the other 341
- Rate limit / 5xx → three retries with exponential backoff
- Malformed JSON → named error
- Off-season (0 markets) → "normal between February and August" empty state
- Missing snapshot → explains that `file://` blocks `fetch()`
- Interrupted write → `.tmp` + atomic `os.replace`

---

### 9. A correction worth recording

I flagged that "Kenneth Walker" was showing under Colts vs Chiefs and assumed a
join bug. Checking the raw ticker — `KXNFLRSHYDS-26SEP20INDKC-KCKWALKER9-80` —
showed Kalshi has him on **KC**. The data was right and my roster knowledge was
out of date. That ticker structure then became the source for the team tag shown
next to each player, which is more durable than a hardcoded roster.
