/* ============================================================
   Sports, live scores, and your own trades.

   Three data sources meet here:
     - data/index.json + data/sport-<key>.json   public, committed
     - ESPN's scoreboard API                     public, called live from the
                                                 browser (it sends
                                                 access-control-allow-origin: *,
                                                 which Kalshi does not)
     - data/private.local.json                   YOUR fills. Gitignored, absent
                                                 from the deployed site, so the
                                                 Trades tab only exists locally.
   ============================================================ */

const ESPN_SCOREBOARD =
  'https://site.api.espn.com/apis/site/v2/sports/{path}/scoreboard';

/* ---------- live scores ---------- */

/* Scores ship inside the snapshot, because ESPN rejects browser-shaped
   requests: it advertises access-control-allow-origin: * and honours it for
   curl, but a browser request comes back as an error page that carries no CORS
   headers at all. The fetcher collects them instead.

   A live call is still attempted, since it costs nothing and would be fresher
   if ESPN ever allows it; failure just leaves the snapshot's scores in place. */
function scoresFromSnapshot(data) {
  return new Map(Object.entries(data?.scores || {}));
}

async function refreshScores(espnPath, fallback) {
  try {
    const response = await fetch(ESPN_SCOREBOARD.replace('{path}', espnPath),
      { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const live = indexScores(payload.events || []);
    return live.size ? live : fallback;
  } catch {
    // Expected in a browser. The board is fully usable on snapshot scores.
    return fallback;
  }
}

/* Key each game by its two team abbreviations, which is the only field
   Kalshi and ESPN reliably share. */
function indexScores(events) {
  const byPair = new Map();

  for (const event of events) {
    const comp = (event.competitions || [])[0];
    if (!comp) continue;

    const sides = (comp.competitors || []).map((c) => ({
      abbr: (c.team?.abbreviation || '').toUpperCase(),
      score: c.score === undefined ? null : Number(c.score),
      home: c.homeAway === 'home',
      winner: !!c.winner,
    }));
    if (sides.length !== 2) continue;

    const status = event.status?.type || {};
    const record = {
      state: status.state,                     // pre | in | post
      detail: status.shortDetail || status.description || '',
      completed: !!status.completed,
      sides,
    };

    // Store under both orderings so a lookup never depends on which side
    // Kalshi happens to list first.
    const [a, b] = sides.map((s) => s.abbr);
    byPair.set(`${a}|${b}`, record);
    byPair.set(`${b}|${a}`, record);
  }
  return byPair;
}

function scoreFor(scores, away, home) {
  if (!scores || !away || !home) return null;
  return scores.get(`${away.toUpperCase()}|${home.toUpperCase()}`) || null;
}

/* ---------- your trades ---------- */

/* Absent on the deployed site, which is the point: a 404 here is the normal,
   expected result for anyone who is not you running this locally. */
async function loadPrivate() {
  try {
    const response = await fetch('data/private.local.json', { cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json();
    return data && data.private ? data : null;
  } catch {
    return null;
  }
}

/* Which sports you have actually traded, so they can be marked in the
   switcher. Derived from fill tickers, not configured by hand. */
function tradedSports(priv, sportOf) {
  const keys = new Set();
  for (const trade of priv?.trades || []) {
    const key = sportOf(trade.series);
    if (key) keys.add(key);
  }
  return keys;
}

/* Realised P&L over time, plus the headline figures.

   The curve is built from SETTLEMENTS, not fills: a fill is a cash movement,
   but only a settled market tells you whether the position was right. Each
   settlement's P&L is its payout minus what the contracts cost minus fees. */
function tradeMetrics(priv) {
  const settled = [...(priv.settlements || [])].sort(
    (a, b) => (a.ts || '').localeCompare(b.ts || ''));

  let running = 0;
  let wins = 0;
  const bySeries = new Map();
  const points = [];

  for (const s of settled) {
    running += s.pnl;
    if (s.pnl > 0) wins += 1;
    bySeries.set(s.series, (bySeries.get(s.series) || 0) + s.pnl);
    points.push({ ts: s.ts, value: running, ticker: s.ticker, pnl: s.pnl });
  }

  const trades = priv.trades || [];
  const fees = trades.reduce((sum, t) => sum + t.fee, 0)
    + settled.reduce((sum, s) => sum + s.fee, 0);
  const contracts = trades.reduce((sum, t) => sum + t.count, 0);
  const staked = settled.reduce((sum, s) => sum + s.cost, 0);

  return {
    trades, settled, points,
    realised: running,
    wins,
    winRate: settled.length ? wins / settled.length : 0,
    fees,
    contracts,
    staked,
    open: (priv.positions || []).filter((p) => p.position).length,
    series: bySeries,
  };
}

window.Board = {
  scoresFromSnapshot, refreshScores, scoreFor,
  loadPrivate, tradedSports, tradeMetrics,
};
