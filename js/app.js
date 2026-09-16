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

function marketRow(m) {
  const mid = (m.bid !== null && m.ask !== null)
    ? Math.round((m.bid + m.ask) / 2)
    : (m.last ?? m.bid ?? m.ask);

  // Price change since the previous close, which is what the arrow means.
  let delta = '';
  if (m.prev !== null && m.last !== null && m.prev !== m.last) {
    const diff = m.last - m.prev;
    const dir = diff > 0 ? 'up' : 'down';
    delta = `<span class="delta ${dir}">${diff > 0 ? '▲' : '▼'}${Math.abs(diff)}</span>`;
  }

  const hasBook = m.bid !== null || m.ask !== null;
  const prices = hasBook
    ? `<span class="price yes"><span class="side">YES</span>${cents(m.ask ?? m.bid)}</span>
       <span class="price no"><span class="side">NO</span>${cents(m.bid === null ? null : 100 - m.bid)}</span>`
    : `<span class="price empty"><span class="side">NO BOOK</span>—</span>`;

  const bar = mid !== null && mid !== undefined
    ? `<div class="prob"><i style="width:${Math.max(0, Math.min(100, mid))}%"></i></div>` : '';

  return `
    <div class="row">
      <div class="row-label">
        ${escapeHtml(m.label)}
        ${bar}
      </div>
      ${delta}
      <span class="row-vol">${volume(m.volume)}</span>
      <div class="prices">${prices}</div>
    </div>`;
}

/* Markets inside a card are grouped by period (Full Game, 1st Half, …)
   and then by the stat, so a player's whole ladder stays together. */
function groupMarkets(markets) {
  const groups = new Map();
  for (const m of markets) {
    const key = m.segment === 'full'
      ? m.typeLabel
      : `${m.segmentLabel} · ${m.typeLabel}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  // Busiest group first, so the headline markets lead.
  return [...groups.entries()].sort((a, b) => {
    const av = a[1].reduce((s, m) => s + m.volume, 0);
    const bv = b[1].reduce((s, m) => s + m.volume, 0);
    return bv - av;
  });
}

function cardBody(id, markets) {
  const active = state.cardFilter.get(id) ?? null;
  const available = new Set(markets.map((m) => m.betType));

  const chips = BET_FILTERS
    .filter((f) => f.key === null || available.has(f.key))
    .map((f) => {
      const n = f.key === null
        ? markets.length
        : markets.filter((m) => m.betType === f.key).length;
      const sel = (active === f.key) ? 'true' : 'false';
      return `<button role="tab" aria-selected="${sel}"
                data-card="${id}" data-filter="${f.key ?? ''}">${f.label} ${n}</button>`;
    }).join('');

  const shown = active ? markets.filter((m) => m.betType === active) : markets;
  const body = groupMarkets(shown)
    .map(([label, rows]) => `
      <div class="group-label">${escapeHtml(label)}</div>
      ${rows.map(marketRow).join('')}`)
    .join('');

  return `
    <div class="body-inner">
      <div class="segmented" role="tablist">${chips}</div>
      ${body || '<div class="notice"><p>No markets in this filter.</p></div>'}
    </div>`;
}

function card(id, title, meta, count, markets) {
  const open = state.openCards.has(id);
  return `
    <section class="card ${open ? 'open' : ''}" data-id="${id}">
      <button class="card-head" data-toggle="${id}" aria-expanded="${open}">
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
      <div class="card-body"><div>${open ? cardBody(id, markets) : ''}</div></div>
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
    main.insertAdjacentHTML('beforebegin', `
      <div class="wrap"><div class="banner">
        <span>⏱</span>
        <span>This snapshot is ${relativeTime(fetchedAt)}. Prices move fast —
        re-run <code>python3 fetch_nfl.py</code> for current numbers.</span>
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
        cardBody(id, currentMarketsFor(id));
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
    if (host) host.innerHTML = cardBody(id, currentMarketsFor(id));
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
