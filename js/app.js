/* ============================================================
   Gridiron Board
   Reads the snapshot written by fetch_nfl.py and renders it.

   Kalshi's API refuses cross-origin browser requests (it returns
   403 whenever an Origin header is present), so the page never
   calls the API directly -- the Python fetcher does, and commits
   its output as data/snapshot.json.
   ============================================================ */

const SNAPSHOT_URL = 'data/snapshot.json';

/* Which bet types appear as filters inside a game card, in the order
   a bettor scans them. `null` means "everything". */
const BET_FILTERS = [
  { key: null,         label: 'All' },
  { key: 'moneyline',  label: 'Moneyline' },
  { key: 'spread',     label: 'Spread' },
  { key: 'total',      label: 'Total' },
  { key: 'team_total', label: 'Team Total' },
  { key: 'prop',       label: 'Props' },
  { key: 'other',      label: 'Other' },
];

const state = {
  index: null,           // data/index.json — the list of sports
  data: null,            // the active sport's snapshot
  sport: null,           // active sport key
  private: null,         // your fills, local only; null on the public site
  mine: new Set(),       // sports you have traded
  scores: new Map(),     // live ESPN scores for the active sport
  sportPrefixes: {},     // sport key -> Kalshi ticker prefixes
  view: 'games',
  detail: null,          // {view, key} when one game / player / group is open
  tradedOnly: true,      // Kalshi quotes strikes nobody has traded; hide those
  tradeRange: 30,        // days of trading history to summarise; null = all
  query: '',
  notice: null,          // one-shot message shown above the next board
  openCards: new Set(),
  cardFilter: new Map(),   // card id -> active bet type
};

const $ = (sel) => document.querySelector(sel);
const main = $('#main');

/* ---------- formatting helpers ---------- */

/* Kalshi quotes in cents: a 67¢ Yes is the market saying 67%. */
const cents = (v) => (v === null || v === undefined ? '—' : `${v}¢`);

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function relativeTime(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins)) return 'unknown';
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)  return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

function gameDay(iso) {
  if (!iso) return '';
  // Parse as local noon so a date-only string never slips a day backwards
  // in timezones west of UTC.
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString(undefined,
    { weekday: 'short', month: 'short', day: 'numeric' });
}

function volume(n) {
  if (!n) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M vol`;
  if (n >= 1_000)     return `${Math.round(n / 1000)}K vol`;
  return `${n} vol`;
}

/* ---------- rendering ---------- */

/* A market's Yes/No pair. Kalshi quotes both sides, and the spread
   between them is the real cost of getting in, so both are shown. */
function pricePair(m) {
  if (m.bid === null && m.ask === null) {
    return '<span class="price empty"><span class="side">NO BOOK</span>—</span>';
  }
  return `<span class="price yes"><span class="side">YES</span>${cents(m.ask ?? m.bid)}</span>
          <span class="price no"><span class="side">NO</span>${cents(m.bid === null ? null : 100 - m.bid)}</span>`;
}

function midpoint(m) {
  if (m.bid !== null && m.ask !== null) return Math.round((m.bid + m.ask) / 2);
  return m.last ?? m.bid ?? m.ask ?? null;
}

function probBar(m) {
  const mid = midpoint(m);
  if (mid === null) return '';
  return `<div class="prob"><i style="width:${Math.max(0, Math.min(100, mid))}%"></i></div>`;
}

function deltaTag(m) {
  if (m.prev === null || m.last === null || m.prev === m.last) return '';
  const diff = m.last - m.prev;
  return `<span class="delta ${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '▲' : '▼'}${Math.abs(diff)}</span>`;
}

/* Most labels repeat the player or stat that the surrounding box already
   names. Stripping that leaves just the number you are scanning for. */
function strikeOf(m) {
  const label = m.label || '';
  const afterColon = label.includes(':') ? label.split(':').slice(1).join(':').trim() : label;
  return afterColon
    .replace(/\b(passing|rushing|receiving|fantasy)\s+(yards|points|tds?)\b/gi, '')
    .replace(/\bpoints scored\b/gi, '')
    .replace(/\byards\b/gi, '')
    .trim() || label;
}


/* Kalshi quotes every strike it lists, including ones that have never traded
   -- about half the board. Those quotes are real but indicative: the median
   bid-ask spread on an untraded market is 14c against roughly 1c on an active
   one. Hiding them by default keeps the board to prices someone has actually
   paid. */
function traded(markets) {
  return state.tradedOnly ? markets.filter((m) => m.volume > 0) : markets;
}

/* The series is the ticker up to the first hyphen: KXNFLSPREAD-26SEP17DETBUF-BUF
   belongs to KXNFLSPREAD. */
const seriesOf = (market) => (market.ticker || '').split('-')[0];

/* Kalshi documents series-level pages only -- "https://kalshi.com/markets/kxhighny"
   in their own quick-start guide -- and no per-contract URL is published, so a
   link is offered exactly where a block of markets shares one series. */
function kalshiLink(markets) {
  const all = new Set(markets.map(seriesOf));
  if (all.size !== 1) return '';
  const series = [...all][0];
  if (!series) return '';
  return `<a class="klink" href="https://kalshi.com/markets/${encodeURIComponent(series.toLowerCase())}"
             target="_blank" rel="noopener" title="Open ${escapeHtml(series)} on Kalshi">Kalshi ↗</a>`;
}

/* ---------- panel shapes ---------- */

/* Moneyline: the headline market, so it gets a real head-to-head box
   rather than two rows that look like everything else. */
function h2hPanel(title, markets, order) {
  const ranked = [...markets].sort((a, b) => b.volume - a.volume);
  let pair = ranked.slice(0, 2);
  const rest = ranked.slice(2);

  // Show the clubs in the same order as the card title and its crests.
  // Volume order would put the favourite first and silently disagree with
  // the header, which makes the two read as different matchups.
  if (order && pair.length === 2) {
    const position = (m) => {
      const index = order.indexOf(teamCodeFromLabel(m.label));
      return index === -1 ? 99 : index;
    };
    pair = [...pair].sort((a, b) => position(a) - position(b));
  }

  const side = (m) => {
    const mid = midpoint(m);
    // The ticker names the club exactly; prose is the fallback.
    const code = teamCodeFromTicker(m.ticker) || teamCodeFromLabel(m.label);
    return `
      <div class="h2h-side">
        ${code ? `<div class="h2h-crest">${teamLogo(code, 40)}</div>` : ''}
        <div class="h2h-team">${escapeHtml(m.label)}</div>
        <div class="h2h-price">${mid === null ? '—' : mid}<small>¢</small></div>
        <div class="h2h-imp">${mid === null ? 'no book' : `${mid}% implied`} ${deltaTag(m)}</div>
        ${probBar(m)}
      </div>`;
  };

  return panelShell(title, sumVolume(markets), `
    <div class="h2h">
      ${side(pair[0])}
      <div class="h2h-vs">VS</div>
      ${pair[1] ? side(pair[1]) : '<div></div>'}
    </div>
    ${rest.length ? `<div class="tiles">${rest.map(tile).join('')}</div>` : ''}`,
    undefined, markets);
}

/* A ladder of strikes on one line — spreads, totals, team totals.
   Every label in a spread market repeats the same stem ("Buffalo wins by
   over 4.5 points"), so the stem is lifted out into a sub-heading and each
   rung shows only the number that actually varies. That turns a wall of
   wrapped sentences into a line you can read across. */
const LINE_RE = /(-?\d+(?:\.\d+)?)/;

function splitLadder(markets) {
  const sides = new Map();
  for (const m of markets) {
    const label = m.label || '';
    const hit = label.match(LINE_RE);
    if (!hit) {
      if (!sides.has('')) sides.set('', []);
      sides.get('').push({ market: m, line: null });
      continue;
    }
    // Everything before the number is the stem; everything after is a unit
    // ("points scored") that the panel heading already implies.
    const raw = label.slice(0, hit.index).replace(/[:,]\s*$/, '').trim();
    // "Buffalo wins by over" -> "Buffalo", "Buffalo over" -> "Buffalo".
    // A bare "Over" has nothing in front of it, so it stays as the side name.
    const stripped = raw
      .replace(/\b(wins\s+by\s+)?(over|under)\b\s*$/i, '')
      .replace(/[:,]\s*$/, '')   // again: stripping "over" can re-expose one
      .trim();
    const key = stripped || raw || 'Line';
    if (!sides.has(key)) sides.set(key, []);
    sides.get(key).push({ market: m, line: parseFloat(hit[1]) });
  }
  // Busiest side first, and each side's rungs ordered by their line.
  return [...sides.entries()]
    .sort((a, b) => sumVolume(b[1].map((r) => r.market))
                  - sumVolume(a[1].map((r) => r.market)))
    .map(([side, rungs]) => [side, rungs.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))]);
}

/* Inside a player's own card every side is that player's name, which the card
   header already says; suppressSide drops that repeated heading. */
function ladderPanel(title, markets, suppressSide) {
  return panelShell(title, sumVolume(markets), ladderSides(markets, suppressSide),
                    undefined, markets);
}

function tilePanel(title, markets) {
  const sorted = [...markets].sort((a, b) => b.volume - a.volume);
  return panelShell(title, sumVolume(markets),
    `<div class="tiles">${sorted.map(tile).join('')}</div>`, undefined, markets);
}

/* Props belong to a person before they belong to a stat, so each
   player gets their own box holding all of their ladders. */
function propsPanel(markets) {
  const LEFTOVER = 'Team & other';
  const byPlayer = new Map();
  for (const m of markets) {
    const key = m.player || LEFTOVER;
    if (!byPlayer.has(key)) byPlayer.set(key, []);
    byPlayer.get(key).push(m);
  }

  const boxes = [...byPlayer.entries()]
    .sort((a, b) => {
      // The catch-all bucket is the biggest but the least interesting, so it
      // sorts last regardless of size.
      if (a[0] === LEFTOVER) return 1;
      if (b[0] === LEFTOVER) return -1;
      return b[1].length - a[1].length;
    })
    .map(([name, rows]) => playerBox(name, rows))
    .join('');

  return panelShell('Player props', sumVolume(markets), boxes, `${byPlayer.size} players`);
}

/* Below this many strikes a line is not worth a slider -- two or three
   boxes are easier to read at a glance than a track you have to drag. */
const SLIDER_MIN_POINTS = 4;

/* Render a ladder's sides. A long ladder becomes one number line; a short
   one stays as boxes. Sides are only labelled when there is more than one,
   and never when the label just repeats the box it sits in. */
function ladderSides(markets, suppress) {
  const sides = splitLadder(markets);
  const multiple = sides.length > 1;

  return sides.map(([side, rungs]) => {
    const name = (multiple && side && side !== suppress) ? side : '';
    const points = rungs.filter((r) => r.line !== null && midpoint(r.market) !== null);

    if (points.length >= SLIDER_MIN_POINTS) return numberLine(name, points);

    return `
      ${name ? `<div class="side-name">${escapeHtml(name)}</div>` : ''}
      <div class="ladder">${rungs.map((r) => rung(r.market, r.line)).join('')}</div>`;
  }).join('');
}

/* One number line for a whole ladder.

   Strikes are placed by value, not by index, so the gaps between them are
   true to the numbers -- a jump from 40 to 90 yards looks like a jump.
   The payload rides on the element as JSON and the interaction is wired up
   afterwards by initNumberLines(), which lets dragging mutate the DOM
   directly instead of re-rendering the page on every pointer move. */
function numberLine(name, points) {
  const sorted = [...points].sort((a, b) => a.line - b.line);
  const data = sorted.map((r) => ({
    v: r.line,
    p: midpoint(r.market),
    bid: r.market.bid,
    ask: r.market.ask,
    vol: r.market.volume,
    label: r.market.label,
  }));

  const min = data[0].v;
  const max = data[data.length - 1].v;
  const span = (max - min) || 1;
  const at = (v) => ((v - min) / span) * 100;

  // Open on the strike trading nearest 50c: the line the book is actually
  // undecided about, and the most informative single point on the ladder.
  let start = 0;
  let gap = Infinity;
  data.forEach((d, i) => {
    const g = Math.abs(d.p - 50);
    if (g < gap) { gap = g; start = i; }
  });

  const ticks = data
    .map((d) => `<span class="nline-tick" style="left:${at(d.v)}%"></span>`)
    .join('');

  const current = data[start];
  return `
    <div class="nline" data-nl="${escapeHtml(JSON.stringify(data))}" data-i="${start}">
      <div class="nline-top">
        ${name ? `<span class="nline-name">${escapeHtml(name)}</span>` : ''}
        <span class="nline-out">
          <b class="nline-v">${current.v}</b>
          <span class="nline-p">${current.p}¢</span>
        </span>
      </div>
      <div class="nline-track" role="slider" tabindex="0"
           aria-label="${escapeHtml(name || 'Line')}"
           aria-valuemin="${min}" aria-valuemax="${max}"
           aria-valuenow="${current.v}"
           aria-valuetext="${escapeHtml(`${current.v}, ${current.p} cents`)}">
        <span class="nline-fill" style="width:${at(current.v)}%"></span>
        ${ticks}
        <span class="nline-knob" style="left:${at(current.v)}%"></span>
      </div>
      <div class="nline-axis">
        <span>${min}</span>
        <span class="nline-meta">${data.length} lines</span>
        <span>${max}</span>
      </div>
    </div>`;
}

/* Wire up every number line that is currently on the page. */
function initNumberLines(root = document) {
  root.querySelectorAll('.nline').forEach(setupNumberLine);
}

function setupNumberLine(el) {
  if (el.dataset.ready) return;          // idempotent: safe to call after any render
  el.dataset.ready = '1';

  const data = JSON.parse(el.dataset.nl);
  const track = el.querySelector('.nline-track');
  const fill  = el.querySelector('.nline-fill');
  const knob  = el.querySelector('.nline-knob');
  const vOut  = el.querySelector('.nline-v');
  const pOut  = el.querySelector('.nline-p');

  const min = data[0].v;
  const max = data[data.length - 1].v;
  const span = (max - min) || 1;

  let index = Number(el.dataset.i) || 0;

  function paint(next) {
    index = Math.max(0, Math.min(data.length - 1, next));
    const d = data[index];
    const pct = ((d.v - min) / span) * 100;

    fill.style.width = `${pct}%`;
    knob.style.left = `${pct}%`;
    vOut.textContent = d.v;
    pOut.textContent = `${d.p}¢`;
    pOut.classList.toggle('cold', d.p < 10);

    track.setAttribute('aria-valuenow', d.v);
    track.setAttribute('aria-valuetext', `${d.v}, ${d.p} cents`);
    track.title = `${d.label} — ${d.bid ?? '—'}¢ bid / ${d.ask ?? '—'}¢ ask`;
  }

  /* Snap to the strike nearest the finger by VALUE, not by slot, so a
     ladder with uneven gaps still selects whatever is actually closest. */
  function nearest(clientX) {
    const box = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - box.left) / box.width));
    const value = min + ratio * span;
    let best = 0;
    let gap = Infinity;
    data.forEach((d, i) => {
      const g = Math.abs(d.v - value);
      if (g < gap) { gap = g; best = i; }
    });
    return best;
  }

  track.addEventListener('pointerdown', (e) => {
    // Respond on the press itself, not on release.
    track.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    paint(nearest(e.clientX));
    e.preventDefault();
  });

  track.addEventListener('pointermove', (e) => {
    if (!el.classList.contains('dragging')) return;
    paint(nearest(e.clientX));
  });

  const release = () => el.classList.remove('dragging');
  track.addEventListener('pointerup', release);
  track.addEventListener('pointercancel', release);

  track.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (step) { paint(index + step); e.preventDefault(); return; }
    if (e.key === 'Home') { paint(0); e.preventDefault(); }
    if (e.key === 'End')  { paint(data.length - 1); e.preventDefault(); }
  });

  paint(index);
}

function playerBox(name, markets) {
  const team = markets.find((m) => m.team)?.team;
  const byStat = new Map();
  for (const m of markets) {
    if (!byStat.has(m.typeLabel)) byStat.set(m.typeLabel, []);
    byStat.get(m.typeLabel).push(m);
  }

  const stats = [...byStat.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([stat, rows]) => `
      <div class="stat-row">
        <div class="stat-name">${escapeHtml(stat)}</div>
        ${ladderSides(rows, name)}
      </div>`).join('');

  return `
    <div class="player-box">
      <div class="player-box-head">
        ${team ? teamLogo(team, 20) : ''}
        <span class="player-box-name">${escapeHtml(name)}</span>
        <span class="player-box-count">${markets.length} markets</span>
      </div>
      ${stats}
    </div>`;
}

/* ---------- pieces ---------- */

function rung(m, line) {
  const mid = midpoint(m);
  // A long-shot price is dimmed so the live part of the ladder stands out.
  const cold = mid !== null && mid < 10 ? ' cold' : '';
  // The full sentence stays in the tooltip; the rung shows only the line.
  const face = (line === null || line === undefined) ? strikeOf(m) : line;
  return `
    <div class="rung" title="${escapeHtml(m.label)}">
      <div class="rung-strike">${escapeHtml(face)}</div>
      <div class="rung-price${cold}">${mid === null ? '—' : `${mid}¢`}</div>
      ${probBar(m)}
    </div>`;
}

function tile(m) {
  return `
    <div class="tile">
      <div class="tile-label">${escapeHtml(m.label)}</div>
      <div class="tile-prices">${pricePair(m)}</div>
      ${probBar(m)}
      <div class="tile-foot">
        <span>${volume(m.volume) || 'no volume'}</span>
        ${deltaTag(m)}
      </div>
    </div>`;
}

function panelShell(title, vol, inner, subOverride, markets) {
  const sub = subOverride ?? (vol ? volume(vol) : '');
  return `
    <section class="panel">
      <header class="panel-head">
        <span class="panel-title">${escapeHtml(title)}</span>
        ${sub ? `<span class="panel-sub">${escapeHtml(sub)}</span>` : ''}
        ${markets ? kalshiLink(markets) : ''}
      </header>
      <div class="panel-body">${inner || '<div class="panel-empty">Nothing here.</div>'}</div>
    </section>`;
}

const sumVolume = (markets) => markets.reduce((total, m) => total + m.volume, 0);

const modeFor = (id) => (id.startsWith('player:') ? 'player' : 'game');

/* ---------- assembling a card ---------- */

/* Group by period first, then by market type: "1st Half · Spread" is a
   different question from "Spread", and mixing them would be misleading. */
function groupMarkets(markets) {
  const groups = new Map();
  for (const m of markets) {
    const key = m.segment === 'full' ? m.typeLabel : `${m.segmentLabel} · ${m.typeLabel}`;
    if (!groups.has(key)) groups.set(key, { betType: m.betType, segment: m.segment, rows: [] });
    groups.get(key).rows.push(m);
  }
  return [...groups.entries()].sort((a, b) => sumVolume(b[1].rows) - sumVolume(a[1].rows));
}

/* Each bet type is rendered in the shape that suits it. */
function renderGroup(label, group, order) {
  const { betType, segment, rows } = group;

  if (betType === 'moneyline' && segment === 'full' && rows.length >= 2) {
    return h2hPanel(label, rows, order);
  }
  if (betType === 'spread' || betType === 'total' || betType === 'team_total') {
    return ladderPanel(label, rows);
  }
  if (betType === 'prop') return null;   // props are pooled into one panel
  return tilePanel(label, rows);
}

function cardBody(id, markets, mode = 'game') {
  const active = state.cardFilter.get(id) ?? null;
  const available = new Set(markets.map((m) => m.betType));

  const chips = BET_FILTERS
    .filter((f) => f.key === null || available.has(f.key))
    .map((f) => {
      const n = f.key === null ? markets.length
        : markets.filter((m) => m.betType === f.key).length;
      return `<button role="tab" aria-selected="${active === f.key}"
                data-card="${escapeHtml(id)}" data-filter="${f.key ?? ''}">${f.label} ${n}</button>`;
    }).join('');

  const shown = active ? markets.filter((m) => m.betType === active) : markets;

  let body;
  if (mode === 'player') {
    // A player card is already about one person; grouping by stat is
    // the only split left that means anything.
    body = playerStatPanels(shown);
  } else {
    const props = shown.filter((m) => m.betType === 'prop');
    const game = state.data.games.find((g) => g.key === id);
    const order = game && game.away ? [game.away, game.home] : null;
    body = groupMarkets(shown)
      .map(([label, group]) => renderGroup(label, group, order))
      .filter(Boolean)
      .join('');
    if (props.length) body += propsPanel(props);
  }

  // "All 45 / Props 45" is not a choice. Only show the bar when it filters.
  const showChips = available.size > 1;

  return `
    <div class="body-inner">
      ${showChips ? `<div class="segmented" role="tablist">${chips}</div>` : ''}
      ${body || '<div class="notice"><p>No markets in this filter.</p></div>'}
    </div>`;
}

function playerStatPanels(markets) {
  const playerName = markets.find((m) => m.player)?.player;
  const byStat = new Map();
  for (const m of markets) {
    const key = m.segment === 'full' ? m.typeLabel : `${m.segmentLabel} · ${m.typeLabel}`;
    if (!byStat.has(key)) byStat.set(key, []);
    byStat.get(key).push(m);
  }
  return [...byStat.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([stat, rows]) => ladderPanel(stat, rows, playerName))
    .join('');
}

/* The collapsible shell every game, player and futures group shares.
   Its body is rendered lazily on open: building 12,000 markets of
   markup up front would cost seconds for content nobody has asked to see. */
function card(id, title, meta, count, markets, crests = '') {
  const open = state.openCards.has(id);
  return `
    <section class="card ${open ? 'open' : ''}" data-id="${escapeHtml(id)}">
      <button class="card-head" data-toggle="${escapeHtml(id)}" aria-expanded="${open}">
        <svg class="chev" width="9" height="14" viewBox="0 0 9 14" fill="none" aria-hidden="true">
          <path d="M1.5 1L7 7l-5.5 6" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        ${crests}
        <span class="matchup">
          <span class="teams">${escapeHtml(title)}</span>
          <span class="meta">${escapeHtml(meta)}</span>
        </span>
        <span class="count">${count}</span>
      </button>
      <div class="card-body"><div>${open ? cardBody(id, markets, modeFor(id)) : ''}</div></div>
    </section>`;
}

/* ---------- views ---------- */

function matches(text) {
  return !state.query || String(text).toLowerCase().includes(state.query);
}

/* The headline numbers for a game, derived from its own markets rather
   than stored: the book is the source of truth, so the summary can never
   drift from the prices shown inside. */
function gameSummary(game, pool) {
  const source = pool || game.markets;
  const full = (type) => source.filter(
    (m) => m.betType === type && m.segment === 'full');

  // Which club a moneyline market is for. The ticker's last segment names it
  // exactly; the prose label is only a fallback for markets that lack one.
  const sides = [game.away, game.home].filter(Boolean);
  const codeOf = (m) => teamCodeFromTicker(m.ticker, sides) || teamCodeFromLabel(m.label);

  const money = full('moneyline')
    .filter((m) => codeOf(m))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 2);

  const priceFor = (code) => {
    const hit = money.find((m) => codeOf(m) === code);
    return hit ? midpoint(hit) : null;
  };

  // The market trading nearest 50c is the one the book considers the line —
  // the same reasoning a sportsbook uses to publish a single number.
  const nearestEven = (markets) => {
    let best = null;
    let bestGap = Infinity;
    for (const m of markets) {
      const mid = midpoint(m);
      if (mid === null) continue;
      const gap = Math.abs(mid - 50);
      if (gap < bestGap) { best = m; bestGap = gap; }
    }
    return best;
  };

  const spreadMarket = nearestEven(full('spread'));
  const totalMarket  = nearestEven(full('total'));

  let spread = null;
  if (spreadMarket) {
    const line = (spreadMarket.label.match(/(\d+(?:\.\d+)?)/) || [])[1];
    const code = teamCodeFromTicker(spreadMarket.ticker, sides)
      || teamCodeFromLabel(spreadMarket.label);
    if (line) spread = code ? `${code} -${line}` : `-${line}`;
  }

  const totalLine = totalMarket
    ? (totalMarket.label.match(/(\d+(?:\.\d+)?)/) || [])[1]
    : null;

  const away = priceFor(game.away);
  const home = priceFor(game.home);

  return {
    away, home,
    favourite: (away !== null && home !== null)
      ? (away > home ? game.away : game.home)
      : null,
    spread,
    total: totalLine ? `o/u ${totalLine}` : null,
  };
}

/* Tennis has no clubs: a singles match is two people and a doubles match is
   two pairs, so there are no abbreviations to key on. When a game carries no
   team codes, the two sides are taken from its busiest opposing markets
   instead, which is what the moneyline pair always is. */
function derivedSides(markets) {
  const pair = markets
    .filter((m) => m.betType === 'moneyline' || m.segment === 'full')
    .filter((m) => midpoint(m) !== null)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 2);
  return pair.length === 2 ? pair : null;
}

function gameTile(game, markets) {
  const s = gameSummary(game, markets);
  const teams = TEAMS;

  // No club codes: render the two competitors by name.
  if (!game.away || !game.home) {
    const sides = derivedSides(markets);
    const lead = sides
      ? Math.max(...sides.map((m) => midpoint(m)))
      : null;
    const rows = (sides || []).map((m) => {
      const mid = midpoint(m);
      return `
        <div class="gteam${mid === lead ? ' fav' : ''}">
          <span class="gteam-name">${escapeHtml(m.label)}</span>
          <span class="gteam-price">${mid === null ? '—' : `${mid}¢`}</span>
        </div>`;
    }).join('');

    return `
      <button class="gcard" data-open="games" data-key="${escapeHtml(game.key)}">
        <div class="gcard-top">
          <span class="gcard-when">${escapeHtml(gameDay(game.date))}</span>
          <span class="gcard-count">${markets.length}</span>
        </div>
        ${rows || '<div class="gteam"><span class="gteam-name">No priced outcomes</span></div>'}
        <div class="gcard-lines">
          ${['Total', s.total]
            .filter(() => true)
            .length ? `<div class="gline">
              <span class="gline-k">Total</span>
              <span class="gline-v${s.total ? '' : ' none'}">${escapeHtml(s.total || '—')}</span>
            </div>` : ''}
        </div>
      </button>`;
  }

  // ESPN is matched on the two team abbreviations, the only field it and
  // Kalshi reliably share.
  const live = Board.scoreFor(state.scores, game.away, game.home);
  const scoreOf = (code) => live?.sides.find((x) => x.abbr === String(code).toUpperCase());

  const row = (code, price) => {
    const registry = state.data.teams || {};
    const nfl = teams[code];
    const name = registry[code]?.name
      || (nfl ? `${nfl.city} ${nfl.nick}` : (code || '—'));
    const fav = s.favourite === code ? ' fav' : '';
    const side = scoreOf(code);
    const winning = side && live.state !== 'pre'
      && live.sides.every((o) => o === side || (side.score ?? 0) >= (o.score ?? 0));

    return `
      <div class="gteam${fav}${winning ? ' winning' : ''}">
        ${teamLogo(code, 26)}
        <span class="gteam-name">${escapeHtml(name)}</span>
        ${side && side.score !== null && live.state !== 'pre'
          ? `<span class="gteam-score">${side.score}</span>` : ''}
        <span class="gteam-price">${price === null ? '—' : `${price}¢`}</span>
      </div>`;
  };

  // A game in progress says so; a finished one says so quietly.
  let status = '';
  if (live && live.state === 'in') {
    status = `<span class="score"><span class="score-live">${escapeHtml(live.detail || 'Live')}</span></span>`;
  } else if (live && live.completed) {
    status = `<span class="score"><span class="score-final">Final</span></span>`;
  }

  const line = (key, value) => `
    <div class="gline">
      <span class="gline-k">${key}</span>
      <span class="gline-v${value ? '' : ' none'}">${escapeHtml(value || '—')}</span>
    </div>`;

  return `
    <button class="gcard" data-open="games" data-key="${escapeHtml(game.key)}">
      <div class="gcard-top">
        <span class="gcard-when">${escapeHtml(gameDay(game.date))}</span>
        ${status}
        <span class="gcard-count">${markets.length}</span>
      </div>
      ${row(game.away, s.away)}
      ${row(game.home, s.home)}
      <div class="gcard-lines">
        ${line('Spread', s.spread)}
        ${line('Total', s.total)}
      </div>
    </button>`;
}

function visibleGames() {
  return state.data.games
    .filter((g) => matches(g.title) || matches(g.away) || matches(g.home)
      || (state.query && g.markets.some((m) => matches(m.label) || matches(m.player))))
    .map((g) => [g, marketsForGame(g)])
    .filter(([, markets]) => markets.length);
}

function marketsForGame(game) {
  const pool = traded(game.markets);
  if (!state.query) return pool;
  // A search narrows the markets inside a game too, so looking for a player
  // surfaces their lines rather than the game's full book.
  if (matches(game.title) || matches(game.away) || matches(game.home)) return pool;
  return pool.filter((m) => matches(m.label) || matches(m.player));
}

/* Clear a detail view whose target no longer exists, and scrub the URL so a
   reload does not land back on the same dead end. The message is shown once,
   above the board. */
function dropDeadDetail(message) {
  state.detail = null;
  state.notice = message;
  if (location.hash) {
    history.replaceState({}, '', location.pathname + location.search);
  }
}

/* A one-shot banner: shown on the next render, then forgotten. */
function takeNotice() {
  if (!state.notice) return '';
  const text = state.notice;
  state.notice = null;
  return `<div class="private-note"><span>ℹ️</span><span>${escapeHtml(text)}</span></div>`;
}

/* Why a list is empty matters. A league that is out of season is not the same
   as a filter hiding everything, and blaming the filter for the off-season
   sends you hunting for a setting that will not help. */
function noGames(kind) {
  const sport = (state.index?.sports || []).find((x) => x.key === state.sport);
  const label = sport?.label || 'This sport';
  const scheduled = state.data?.games?.length || 0;
  const days = state.index?.daysAhead ?? 10;

  if (kind === 'games' && !scheduled) {
    return emptyState(`No ${label} games scheduled`,
      `Kalshi lists no ${label} games in the next ${days} days. `
      + 'Season-long markets are still under Futures.');
  }
  if (state.query) {
    return emptyState('Nothing matches that search',
      'Try a team or player name, or clear the search.');
  }
  if (state.tradedOnly) {
    return emptyState('Nothing traded yet',
      `${label} markets are quoted but none have traded. `
      + 'Turn off "Traded only" to see the quoted lines.');
  }
  return emptyState(`No ${label} ${kind} right now`, 'Try another sport.');
}

function viewGames() {
  if (state.detail?.view === 'games') {
    const game = state.data.games.find((g) => g.key === state.detail.key);
    if (game) return gameDetail(state.detail.key);
    // Kalshi delists a market once it settles, so an old link -- a bookmark,
    // the back button, or a game that finished while open -- points at
    // nothing. Fall back to the board rather than stranding the page.
    dropDeadDetail('That game has finished and is no longer listed.');
  }

  const games = visibleGames();
  if (!games.length) return noGames('games');
  return takeNotice() + `<div class="grid">${games.map(([g, m]) => gameTile(g, m)).join('')}</div>`;
}

function gameDetail(key) {
  const game = state.data.games.find((g) => g.key === key);
  if (!game) return emptyState('Game not found', 'It may have closed since this snapshot.');

  const markets = marketsForGame(game);

  // Kalshi lists a moneyline as soon as a fixture exists but only posts
  // spreads, totals and props in the days before kickoff, so a game a week
  // out legitimately has nothing else. Say so rather than look broken.
  const onlyMoneyline = markets.length > 0
    && markets.every((m) => m.betType === 'moneyline');
  const note = onlyMoneyline
    ? `<div class="private-note"><span>🗓</span><span>Only the moneyline is
       listed so far. Kalshi posts spreads, totals and player props in the
       days before kickoff.</span></div>`
    : '';

  const sides = (!game.away || !game.home) ? derivedSides(markets) : null;
  const heading = game.title
    || (sides ? sides.map((m) => m.label).join('  vs  ') : key);

  return detailShell(
    `${game.away ? teamLogo(game.away, 26) : ''}${game.home ? teamLogo(game.home, 26) : ''}`,
    heading,
    `${gameDay(game.date)} · ${markets.length} markets`,
    note + cardBody(key, markets, 'game'),
  );
}

/* Players are derived in the browser rather than precomputed, so the
   same market objects back both views and can never disagree. */
function buildPlayers() {
  const byPlayer = new Map();
  for (const g of state.data.games) {
    for (const m of g.markets) {
      if (!m.player) continue;
      if (!byPlayer.has(m.player)) {
        byPlayer.set(m.player, { name: m.player, game: g, markets: [] });
      }
      byPlayer.get(m.player).markets.push(m);
    }
  }
  return [...byPlayer.values()].sort((a, b) => b.markets.length - a.markets.length);
}

function visiblePlayers() {
  return buildPlayers()
    .map((p) => ({ ...p, markets: traded(p.markets) }))
    .filter((p) => p.markets.length)
    .filter((p) => matches(p.name)
      || (state.query && p.markets.some((m) => matches(m.label)))
      || (state.query && (matches(p.game.title) || matches(p.game.away) || matches(p.game.home))));
}

/* A player's headline lines: the busiest stats, each shown at the strike
   trading nearest 50c, so the tile says something before it is opened. */
function playerHeadlines(markets, limit = 3) {
  const byStat = new Map();
  for (const m of markets) {
    if (!byStat.has(m.typeLabel)) byStat.set(m.typeLabel, []);
    byStat.get(m.typeLabel).push(m);
  }

  return [...byStat.entries()]
    .sort((a, b) => sumVolume(b[1]) - sumVolume(a[1]))
    .slice(0, limit)
    .map(([stat, rows]) => {
      let pick = null;
      let gap = Infinity;
      for (const m of rows) {
        const mid = midpoint(m);
        if (mid === null) continue;
        if (Math.abs(mid - 50) < gap) { gap = Math.abs(mid - 50); pick = m; }
      }
      if (!pick) return null;
      const line = (pick.label.match(/(\d+(?:\.\d+)?)/) || [])[1];
      return { stat, line, price: midpoint(pick) };
    })
    .filter(Boolean);
}

function playerTile(player) {
  const team = player.markets.find((m) => m.team)?.team;
  const lines = playerHeadlines(player.markets);

  return `
    <button class="gcard" data-open="players" data-key="${escapeHtml(player.name)}">
      <div class="ptile-head">
        ${team ? teamLogo(team, 26) : ''}
        <span class="ptile-name">${escapeHtml(player.name)}</span>
        <span class="gcard-count">${player.markets.length}</span>
      </div>
      <div class="ptile-sub">${escapeHtml(player.game.title || player.game.key)} · ${escapeHtml(gameDay(player.game.date))}</div>
      <div class="ptile-lines">
        ${lines.map((l) => `
          <span class="ptile-line">
            <span class="ptile-stat">${escapeHtml(l.stat)}</span>
            <span class="ptile-val">${escapeHtml(l.line ?? '')}</span>
            <span class="ptile-price">${l.price}¢</span>
          </span>`).join('') || '<span class="ptile-line"><span class="ptile-stat">No priced lines</span></span>'}
      </div>
    </button>`;
}

function viewPlayers() {
  if (state.detail?.view === 'players') {
    if (buildPlayers().some((p) => p.name === state.detail.key)) {
      return playerDetail(state.detail.key);
    }
    dropDeadDetail('That player has no open markets any more.');
  }

  const players = visiblePlayers();
  if (!players.length) {
    const any = state.data?.games?.some((g) => g.markets.some((m) => m.player));
    if (!any) {
      return emptyState('No player props listed',
        'Kalshi has not posted player markets for this league yet. '
        + 'They usually appear a few days before a game.');
    }
    return noGames('players');
  }
  return takeNotice() + `<div class="grid">${players.map(playerTile).join('')}</div>`;
}

function playerDetail(name) {
  const player = buildPlayers().find((p) => p.name === name);
  if (!player) return emptyState('Player not found', 'They may have no open markets in this snapshot.');

  const markets = traded(player.markets);
  const team = markets.find((m) => m.team)?.team;
  return detailShell(
    `${team ? teamLogo(team, 26) : ''}`,
    name,
    `${player.game.title || player.game.key} · ${gameDay(player.game.date)} · ${markets.length} markets`,
    cardBody(`player:${name}`, markets, 'player'),
  );
}

/* ---- Futures ---- */

function visibleFutures() {
  return state.data.futures
    .map((f) => ({ ...f, markets: traded(f.markets) }))
    .filter((f) => f.markets.length)
    .filter((f) => matches(f.title) || matches(f.subtitle)
      || (state.query && f.markets.some((m) => matches(m.label))));
}

function futuresTile(group) {
  // Lead with what people actually trade. Sorting by price alone fills the
  // preview with 100c near-certainties, which say nothing about the market.
  const top = [...group.markets]
    .filter((m) => midpoint(m) !== null)
    .sort((a, b) => (b.volume - a.volume) || (midpoint(b) - midpoint(a)))
    .slice(0, 3);

  const rows = top.map((m) => {
    const code = teamCodeFromLabel(m.label);
    return `
      <span class="ftile-row">
        ${code ? teamLogo(code, 20) : ''}
        <span class="ftile-name">${escapeHtml(m.label)}</span>
        <span class="ftile-price">${midpoint(m)}¢</span>
      </span>`;
  }).join('');

  const more = group.markets.length - top.length;
  return `
    <button class="gcard" data-open="futures" data-key="${escapeHtml(group.event)}">
      <div class="gcard-top">
        <span class="gcard-when">Season</span>
        <span class="gcard-count">${group.markets.length}</span>
      </div>
      <div class="ftile-title">${escapeHtml(group.title)}</div>
      <div class="ftile-sub">${escapeHtml(group.subtitle || group.series)}</div>
      <div class="ftile-rows">${rows || '<span class="ftile-row"><span class="ftile-name">No priced outcomes</span></span>'}</div>
      ${more > 0 ? `<div class="ftile-more">+${more} more</div>` : ''}
    </button>`;
}

function viewFutures() {
  if (state.detail?.view === 'futures') {
    if (state.data.futures.some((f) => f.event === state.detail.key)) {
      return futuresDetail(state.detail.key);
    }
    dropDeadDetail('That market has settled and is no longer listed.');
  }

  const groups = visibleFutures();
  if (!groups.length) return noGames('futures');
  return takeNotice() + `<div class="grid">${groups.map(futuresTile).join('')}</div>`;
}

function futuresDetail(eventTicker) {
  const group = state.data.futures.find((f) => f.event === eventTicker);
  if (!group) return emptyState('Market not found', 'It may have settled since this snapshot.');

  const markets = traded(group.markets);
  return detailShell('', group.title,
    `${group.subtitle || group.series} · ${markets.length} markets`,
    cardBody(eventTicker, markets, 'futures'));
}

/* The bar every detail view shares: back out, say what you are looking at. */
function detailShell(crests, title, meta, body) {
  return `
    <div class="detail-bar">
      <button class="back" data-back="1">
        <svg width="8" height="13" viewBox="0 0 9 14" fill="none" aria-hidden="true">
          <path d="M7.5 1L2 7l5.5 6" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round"/>
        </svg>Back
      </button>
      <span class="detail-title">
        ${crests}
        <span class="detail-name">${escapeHtml(title)}</span>
      </span>
      <span class="detail-when" style="margin-inline-start:auto">${escapeHtml(meta)}</span>
    </div>
    ${body}`;
}

function emptyState(title, body) {
  return `<div class="notice"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p></div>`;
}

function render() {
  if (!state.data) return;
  const views = { games: viewGames, players: viewPlayers,
                  futures: viewFutures, trades: viewTrades };
  main.innerHTML = (views[state.view] || viewGames)();
  initNumberLines();
  paintCounts();
}

/* ---------- chrome ---------- */

function moveThumb() {
  const tabs = $('#tabs');
  const active = tabs.querySelector('[aria-selected="true"]');
  const thumb = $('#thumb');
  if (!active || !thumb) return;
  thumb.style.width = `${active.offsetWidth}px`;
  thumb.style.transform = `translateX(${active.offsetLeft - 2}px)`;
}

function paintHeader() {
  const { stats, fetchedAt } = state.data;
  const ageMin = (Date.now() - new Date(fetchedAt).getTime()) / 60000;
  const stale = ageMin > 60;

  $('#freshness').innerHTML =
    `<span class="dot ${stale ? 'stale' : ''}"></span>Updated ${relativeTime(fetchedAt)}`;

  paintCounts();

  const built = $('#built');
  if (built) {
    built.textContent = `data as of ${new Date(fetchedAt).toLocaleString()}`;
  }

}


/* The subhead describes what is actually on screen. With "Traded only" on it
   would otherwise advertise counts far larger than the board shows. */
function paintCounts() {
  if (!state.data) return;
  const { stats } = state.data;

  if (!state.tradedOnly) {
    $('#subhead').textContent =
      `${stats.markets.toLocaleString()} open markets · ${stats.games} upcoming games · `
      + `${stats.players} players · ${stats.futures} season futures`;
    return;
  }

  const games = state.data.games.filter((g) => g.markets.some((m) => m.volume > 0)).length;
  const marketCount = state.data.games.reduce((n, g) => n + traded(g.markets).length, 0)
    + state.data.futures.reduce((n, f) => n + traded(f.markets).length, 0);
  const players = new Set(state.data.games
    .flatMap((g) => traded(g.markets))
    .map((m) => m.player).filter(Boolean)).size;
  const futures = state.data.futures.filter((f) => f.markets.some((m) => m.volume > 0)).length;

  $('#subhead').textContent =
    `${marketCount.toLocaleString()} traded markets · ${games} upcoming games · `
    + `${players} players · ${futures} season futures`;
}

/* ---------- events ---------- */

/* Opening a game pushes a history entry, so the browser and the phone's
   back gesture leave the detail instead of leaving the site. */
function openDetail(view, key) {
  state.detail = { view, key };
  state.cardFilter.delete(key);
  history.pushState({ detail: { view, key } }, '', `#${view}/${encodeURIComponent(key)}`);
  render();
  window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

function closeDetail() {
  if (!state.detail) return;
  state.detail = null;
  history.pushState({}, '', location.pathname + location.search);
  render();
}

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

window.addEventListener('popstate', (e) => {
  state.detail = e.state?.detail ?? null;
  render();
});

/* "#games/26SEP17DETBUF" and "#players/Josh%20Allen" open straight into a
   detail view, so any game or player can be linked to directly. */
function detailFromHash() {
  const raw = location.hash.slice(1);
  if (!raw.includes('/')) return null;
  const [view, ...rest] = raw.split('/');
  const key = decodeURIComponent(rest.join('/'));
  return ['games', 'players', 'futures'].includes(view) ? { view, key } : null;
}



/* One delegated listener rather than a listener per row: with ~12,000
   markets on the page, per-row handlers would be the slowest thing here. */
document.addEventListener('click', (e) => {
  const tile = e.target.closest('[data-open]');
  if (tile) {
    openDetail(tile.dataset.open, tile.dataset.key);
    return;
  }

  if (e.target.closest('[data-back]')) {
    closeDetail();
    return;
  }

  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    const id = toggle.dataset.toggle;
    const section = toggle.closest('.card');
    if (state.openCards.has(id)) {
      state.openCards.delete(id);
      section.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      // Let the collapse animation play out before emptying the node.
      setTimeout(() => {
        if (!state.openCards.has(id)) section.querySelector('.card-body > div').innerHTML = '';
      }, 400);
    } else {
      state.openCards.add(id);
      section.querySelector('.card-body > div').innerHTML =
        cardBody(id, currentMarketsFor(id), modeFor(id));
      initNumberLines(section);
      // Next frame, so the grid-row transition has a 0fr start to animate from.
      requestAnimationFrame(() => {
        section.classList.add('open');
        toggle.setAttribute('aria-expanded', 'true');
      });
    }
    return;
  }

  const retry = e.target.closest('[data-retry]');
  if (retry) {
    selectSport(retry.dataset.retry);
    return;
  }

  const range = e.target.closest('[data-range]');
  if (range) {
    state.tradeRange = range.dataset.range ? Number(range.dataset.range) : null;
    render();
    return;
  }

  const filter = e.target.closest('[data-filter]');
  if (filter) {
    const id = filter.dataset.card;
    state.cardFilter.set(id, filter.dataset.filter || null);
    // Replace the body the chip actually lives in. Looking the card up by id
    // only worked inside an accordion; in the detail view there is no .card
    // wrapper, so the lookup returned null and pressing a chip did nothing.
    const shell = filter.closest('.body-inner');
    if (shell) {
      shell.outerHTML = cardBody(id, currentMarketsFor(id), modeFor(id));
      initNumberLines();
    }
  }
});

/* Re-derive a card's markets on demand so filtering and searching
   always read from the single source of truth. */
function currentMarketsFor(id) {
  if (id.startsWith('player:')) {
    const name = id.slice(7);
    const p = buildPlayers().find((x) => x.name === name);
    return p ? traded(p.markets) : [];
  }
  const game = state.data.games.find((g) => g.key === id);
  if (game) {
    return state.query
      ? game.markets.filter((m) => matches(m.label) || matches(m.player)
          || matches(game.title) || matches(game.away) || matches(game.home))
      : game.markets;
  }
  const fut = state.data.futures.find((f) => f.event === id);
  return fut ? traded(fut.markets) : [];
}

$('#tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-view]');
  if (!tab) return;
  for (const b of $('#tabs').querySelectorAll('[data-view]')) {
    b.setAttribute('aria-selected', String(b === tab));
  }
  state.view = tab.dataset.view;
  state.detail = null;
  state.openCards.clear();
  moveThumb();
  render();
});

let searchTimer;
$('#search').addEventListener('input', (e) => {
  // Debounced only enough to avoid re-rendering 12,000 rows on every
  // keystroke; short enough that typing still feels live.
  clearTimeout(searchTimer);
  const value = e.target.value.trim().toLowerCase();
  searchTimer = setTimeout(() => {
    state.query = value;
    if (value) state.detail = null;
    render();
  }, 120);
});

$('#sports').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-sport]');
  if (chip && chip.dataset.sport !== state.sport) selectSport(chip.dataset.sport);
});

$('#traded').addEventListener('click', () => {
  state.tradedOnly = !state.tradedOnly;
  $('#traded').setAttribute('aria-checked', String(state.tradedOnly));
  render();
});

window.addEventListener('resize', moveThumb);

/* ---------- boot ---------- */

/* Kalshi ticker prefixes per sport, mirroring sports.py so the browser can
   attribute a fill to a league without another round trip. */
const SPORT_PREFIXES = {
  nfl:   ['KXNFL', 'KXLEADERNFL', 'KXSTARTINGQB', 'KXNEXTNFL'],
  ncaaf: ['KXNCAAF'],
  mlb:   ['KXMLB', 'KXLEADERMLB'],
  wnba:  ['KXWNBA', 'KXLEADERWNBA'],
  nba:   ['KXNBA', 'KXLEADERNBA'],
  nhl:   ['KXNHL', 'KXLEADERNHL'],
  atp:   ['KXATP'],
  wta:   ['KXWTA'],
};

/* Longest prefix wins, so KXWNBA is never read as KXNBA. */
function sportOfTicker(ticker) {
  const t = (ticker || '').toUpperCase();
  let best = null;
  let len = 0;
  for (const [key, prefixes] of Object.entries(SPORT_PREFIXES)) {
    for (const prefix of prefixes) {
      if (t.startsWith(prefix) && prefix.length > len) { best = key; len = prefix.length; }
    }
  }
  return best;
}

function paintSportBar() {
  const bar = $('#sports');
  if (!bar || !state.index) return;

  bar.innerHTML = state.index.sports.map((sport) => {
    const mine = state.mine.has(sport.key);
    return `<button class="sport${mine ? ' sport-mine' : ''}" role="tab"
              aria-selected="${sport.key === state.sport}" data-sport="${sport.key}"
              title="${escapeHtml(sport.name)}${mine ? ' — you have traded this' : ''}">
              ${escapeHtml(sport.label)}
              <span class="sport-count">${sport.stats.games}</span>
            </button>`;
  }).join('');
}

/* Increments on every sport switch. Clicking three sports quickly starts
   three fetches, and without this the slowest reply wins and the board ends
   up showing a different sport from the one highlighted. */
let sportToken = 0;

async function selectSport(key) {
  const entry = state.index.sports.find((s) => s.key === key);
  if (!entry) return;

  const token = ++sportToken;
  state.sport = key;
  state.detail = null;
  state.openCards.clear();
  paintSportBar();

  main.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';

  let data;
  try {
    const response = await fetch(`data/${entry.file}`, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
  } catch (err) {
    if (token !== sportToken) return;   // a newer switch already took over
    console.error(`Could not load ${entry.file}:`, err);
    main.innerHTML = emptyState(
      `Could not load ${entry.label}`,
      'The data file did not load. Check your connection, then try again — '
      + 'the other sports are unaffected.',
    ) + `<div style="text-align:center"><button class="back" data-retry="${escapeHtml(key)}"
           style="margin:0 auto">Try again</button></div>`;
    return;
  }

  if (token !== sportToken) return;     // a newer switch resolved first

  state.data = data;
  setTeamRegistry(state.data.teams);

  // Snapshot scores render immediately; a live attempt may upgrade them.
  state.scores = Board.scoresFromSnapshot(state.data);

  paintHeader();
  render();

  Board.refreshScores(entry.espn, state.scores).then((scores) => {
    // Ignore a late reply for a sport the user has already navigated away from.
    if (token !== sportToken || scores === state.scores) return;
    state.scores = scores;
    render();
  });
}

async function boot() {
  try {
    const response = await fetch('data/index.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.index = await response.json();
  } catch (err) {
    main.innerHTML = emptyState(
      'Could not load the market snapshot',
      'Run "python3 fetch_markets.py" to create the data files, then serve the '
      + 'folder with "python3 -m http.server". Opening index.html directly from '
      + 'the filesystem will not work, because browsers block fetch() on file:// URLs.',
    );
    $('#subhead').textContent = 'Snapshot unavailable';
    console.error(err);
    return;
  }

  state.sportPrefixes = SPORT_PREFIXES;

  // Your fills, if this is your machine. A 404 is the normal case elsewhere.
  state.private = await Board.loadPrivate();
  if (state.private) {
    state.mine = Board.tradedSports(state.private, sportOfTicker);
    $('#tradesTab').hidden = false;
  }

  const deep = detailFromHash();
  // Prefer a sport you trade, so the board opens on something you care about.
  const preferred = state.index.sports.find((s) => state.mine.has(s.key))
    || state.index.sports[0];

  await selectSport(preferred.key);

  if (deep) {
    state.detail = deep;
    state.view = deep.view;
    for (const b of $('#tabs').querySelectorAll('[data-view]')) {
      b.setAttribute('aria-selected', String(b.dataset.view === deep.view));
    }
    moveThumb();
    render();
  }
}

boot();
