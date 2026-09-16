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
  data: null,
  view: 'games',
  query: '',
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

/* ---------- panel shapes ---------- */

/* Moneyline: the headline market, so it gets a real head-to-head box
   rather than two rows that look like everything else. */
function h2hPanel(title, markets) {
  const ranked = [...markets].sort((a, b) => b.volume - a.volume);
  const pair = ranked.slice(0, 2);
  const rest = ranked.slice(2);

  const side = (m) => {
    const mid = midpoint(m);
    return `
      <div class="h2h-side">
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
    ${rest.length ? `<div class="tiles">${rest.map(tile).join('')}</div>` : ''}`);
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

function ladderPanel(title, markets, suppressSide) {
  let sides = splitLadder(markets);

  // Inside a player's own card every side is that player's name, which the
  // card header already says. Drop the heading rather than repeat it.
  if (suppressSide) {
    sides = sides.map(([side, rungs]) =>
      [side === suppressSide ? '' : side, rungs]);
  }

  // A single unnamed side means the stem carried no information; render it
  // flat rather than adding a heading that just repeats the panel title.
  const body = (sides.length === 1 && !sides[0][0])
    ? `<div class="ladder">${sides[0][1].map((r) => rung(r.market, r.line)).join('')}</div>`
    : sides.map(([side, rungs]) => `
        <div class="stat-row">
          ${side ? `<div class="stat-name">${escapeHtml(side)}</div>` : ''}
          <div class="ladder">${rungs.map((r) => rung(r.market, r.line)).join('')}</div>
        </div>`).join('');

  return panelShell(title, sumVolume(markets), body);
}

function tilePanel(title, markets) {
  const sorted = [...markets].sort((a, b) => b.volume - a.volume);
  return panelShell(title, sumVolume(markets),
    `<div class="tiles">${sorted.map(tile).join('')}</div>`);
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

/* Render a ladder's sides. Sides are only labelled when there is more than
   one, and never when the label just repeats the box it sits in. */
function ladderSides(markets, suppress) {
  const sides = splitLadder(markets);
  const multiple = sides.length > 1;
  return sides.map(([side, rungs]) => {
    const show = multiple && side && side !== suppress;
    return `
      ${show ? `<div class="side-name">${escapeHtml(side)}</div>` : ''}
      <div class="ladder">${rungs.map((r) => rung(r.market, r.line)).join('')}</div>`;
  }).join('');
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
        <span class="player-box-name">${escapeHtml(name)}</span>
        ${team ? `<span class="player-box-team">${escapeHtml(team)}</span>` : ''}
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

function panelShell(title, vol, inner, subOverride) {
  const sub = subOverride ?? (vol ? volume(vol) : '');
  return `
    <section class="panel">
      <header class="panel-head">
        <span class="panel-title">${escapeHtml(title)}</span>
        ${sub ? `<span class="panel-sub">${escapeHtml(sub)}</span>` : ''}
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
function renderGroup(label, group) {
  const { betType, segment, rows } = group;

  if (betType === 'moneyline' && segment === 'full' && rows.length >= 2) {
    return h2hPanel(label, rows);
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
    body = groupMarkets(shown)
      .map(([label, group]) => renderGroup(label, group))
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
function card(id, title, meta, count, markets) {
  const open = state.openCards.has(id);
  return `
    <section class="card ${open ? 'open' : ''}" data-id="${escapeHtml(id)}">
      <button class="card-head" data-toggle="${escapeHtml(id)}" aria-expanded="${open}">
        <svg class="chev" width="9" height="14" viewBox="0 0 9 14" fill="none" aria-hidden="true">
          <path d="M1.5 1L7 7l-5.5 6" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
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

function viewGames() {
  const games = state.data.games.filter((g) =>
    matches(g.title) || matches(g.away) || matches(g.home)
    || (state.query && g.markets.some((m) => matches(m.label))));

  if (!games.length) return emptyState('No games match', 'Try a team name like “Bills” or clear the search.');

  return games.map((g) => {
    // When searching, narrow the rows inside the card too, so a player
    // search surfaces that player's lines rather than the whole game.
    const markets = state.query
      ? g.markets.filter((m) => matches(m.label) || matches(m.player)
          || matches(g.title) || matches(g.away) || matches(g.home))
      : g.markets;
    return card(
      g.key,
      g.title || `${g.away} vs ${g.home}`,
      `${gameDay(g.date)} · ${new Set(markets.map((m) => m.typeLabel)).size} market types`,
      markets.length,
      markets,
    );
  }).join('');
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

function viewPlayers() {
  const players = buildPlayers().filter((p) =>
    matches(p.name) || (state.query && p.markets.some((m) => matches(m.label))));

  if (!players.length) {
    return emptyState('No players match',
      'Player props are usually posted a few days before kickoff.');
  }

  return players.map((p) => {
    // The team comes from the market ticker, so it stays correct through
    // trades in a way a hardcoded roster would not.
    const team = p.markets.find((m) => m.team)?.team;
    const title = team ? `${p.name}  ·  ${team}` : p.name;
    return card(
      `player:${p.name}`,
      title,
      `${p.game.title || p.game.key} · ${gameDay(p.game.date)}`,
      p.markets.length,
      p.markets,
    );
  }).join('');
}

function viewFutures() {
  const groups = state.data.futures.filter((f) =>
    matches(f.title) || (state.query && f.markets.some((m) => matches(m.label))));

  if (!groups.length) return emptyState('No futures match', 'Clear the search to see season-long markets.');

  return groups.map((f) => {
    const markets = state.query
      ? f.markets.filter((m) => matches(m.label) || matches(f.title))
      : f.markets;
    return card(f.series, f.title, 'Season-long market', markets.length, markets);
  }).join('');
}

function emptyState(title, body) {
  return `<div class="notice"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p></div>`;
}

function render() {
  if (!state.data) return;
  const views = { games: viewGames, players: viewPlayers, futures: viewFutures };
  main.innerHTML = (views[state.view] || viewGames)();
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
    `<span class="dot ${stale ? 'stale' : ''}"></span>${relativeTime(fetchedAt)}`;

  $('#subhead').textContent =
    `${stats.markets.toLocaleString()} open markets · ${stats.games} upcoming games · `
    + `${stats.players} players · ${stats.futures} season futures`;

  if (stale) {
    // A visitor on the hosted site cannot run the fetcher, so only show the
    // "re-run it" hint to someone actually developing locally.
    const local = ['localhost', '127.0.0.1', ''].includes(location.hostname);
    const advice = local
      ? 'Re-run <code>python3 fetch_nfl.py</code> for current numbers.'
      : 'Prices move fast — check <a href="https://kalshi.com" target="_blank" '
        + 'rel="noopener">kalshi.com</a> for the live book.';

    main.insertAdjacentHTML('beforebegin', `
      <div class="wrap"><div class="banner">
        <span>⏱</span>
        <span>This snapshot was taken ${relativeTime(fetchedAt)}. ${advice}</span>
      </div></div>`);
  }
}

/* ---------- events ---------- */

/* One delegated listener rather than a listener per row: with ~12,000
   markets on the page, per-row handlers would be the slowest thing here. */
document.addEventListener('click', (e) => {
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
      // Next frame, so the grid-row transition has a 0fr start to animate from.
      requestAnimationFrame(() => {
        section.classList.add('open');
        toggle.setAttribute('aria-expanded', 'true');
      });
    }
    return;
  }

  const filter = e.target.closest('[data-filter]');
  if (filter) {
    const id = filter.dataset.card;
    state.cardFilter.set(id, filter.dataset.filter || null);
    const host = document.querySelector(`.card[data-id="${CSS.escape(id)}"] .card-body > div`);
    if (host) host.innerHTML = cardBody(id, currentMarketsFor(id), modeFor(id));
  }
});

/* Re-derive a card's markets on demand so filtering and searching
   always read from the single source of truth. */
function currentMarketsFor(id) {
  if (id.startsWith('player:')) {
    const name = id.slice(7);
    const p = buildPlayers().find((x) => x.name === name);
    return p ? p.markets : [];
  }
  const game = state.data.games.find((g) => g.key === id);
  if (game) {
    return state.query
      ? game.markets.filter((m) => matches(m.label) || matches(m.player)
          || matches(game.title) || matches(game.away) || matches(game.home))
      : game.markets;
  }
  const fut = state.data.futures.find((f) => f.series === id);
  return fut ? fut.markets : [];
}

$('#tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-view]');
  if (!tab) return;
  for (const b of $('#tabs').querySelectorAll('[data-view]')) {
    b.setAttribute('aria-selected', String(b === tab));
  }
  state.view = tab.dataset.view;
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
    render();
  }, 120);
});

window.addEventListener('resize', moveThumb);

/* ---------- boot ---------- */

async function boot() {
  try {
    const response = await fetch(SNAPSHOT_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
  } catch (err) {
    main.innerHTML = emptyState(
      'Could not load the market snapshot',
      'Run "python3 fetch_nfl.py" to create data/snapshot.json, then serve the '
      + 'folder with "python3 -m http.server". Opening index.html directly from '
      + 'the filesystem will not work, because browsers block fetch() on file:// URLs.',
    );
    $('#subhead').textContent = 'Snapshot unavailable';
    console.error(err);
    return;
  }

  if (!state.data.games?.length && !state.data.futures?.length) {
    paintHeader();
    main.innerHTML = emptyState('No open NFL markets',
      'Kalshi lists no NFL markets right now. This is normal between February and August.');
    return;
  }

  paintHeader();
  $('#built').textContent = `snapshot ${new Date(state.data.fetchedAt).toLocaleString()}`;
  moveThumb();
  render();
}

boot();
