/* ============================================================
   My Trades — local only.

   Rendered from data/private.local.json, which is gitignored and absent from
   the deployed site. Nothing here is ever published.
   ============================================================ */

const money = (c) => {
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c) / 100;
  return `${sign}$${abs.toLocaleString(undefined, {
    minimumFractionDigits: abs < 100 ? 2 : 0,
    maximumFractionDigits: abs < 100 ? 2 : 0,
  })}`;
};

function statTile(key, value, note, dir) {
  const tone = dir === undefined ? '' : (dir > 0 ? ' up' : dir < 0 ? ' down' : '');
  return `
    <div class="stat">
      <div class="stat-k">${escapeHtml(key)}</div>
      <div class="stat-v${tone}">${escapeHtml(value)}</div>
      ${note ? `<div class="stat-note">${escapeHtml(note)}</div>` : ''}
    </div>`;
}

/* Cumulative cash flow over time.

   One series, so no legend — the title names it. The line is drawn in the
   status colour for its end state (profit / loss) rather than a categorical
   hue, because the thing being encoded is polarity, not identity. */
function pnlChart(points) {
  if (points.length < 2) {
    return `<div class="chart-card"><div class="chart-title">Realised P&amp;L</div>
            <div class="chart-sub">Not enough settled markets to plot.</div></div>`;
  }

  const W = 720, H = 220;
  const pad = { t: 12, r: 12, b: 22, l: 52 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  const values = points.map((p) => p.value);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const span = (hi - lo) || 1;

  const x = (i) => pad.l + (i / (points.length - 1)) * plotW;
  const y = (v) => pad.t + plotH - ((v - lo) / span) * plotH;

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const area = `${line}L${x(points.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;

  const end = values[values.length - 1];
  const stroke = end >= 0 ? 'var(--yes)' : 'var(--no)';

  // Four gridlines is enough to read a level without competing with the data.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + f * span);
  const grid = ticks.map((v) => `
    <line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
    <text class="axis-text" x="${pad.l - 7}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${money(v)}</text>`).join('');

  const firstDay = (points[0].ts || '').slice(0, 10);
  const lastDay = (points[points.length - 1].ts || '').slice(0, 10);

  return `
    <div class="chart-card">
      <div class="chart-title">Realised P&amp;L</div>
      <div class="chart-sub">${points.length.toLocaleString()} settled markets · ${firstDay} to ${lastDay} · net of fees</div>
      <div class="chart-wrap" id="pnlWrap">
        <svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
             aria-label="Realised P and L across ${points.length} settled markets, ending at ${money(end)}">
          ${grid}
          <line class="zero-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>
          <path class="pnl-area" d="${area}" fill="${stroke}"/>
          <path class="pnl-line" d="${line}" stroke="${stroke}"/>
          <text class="axis-text" x="${pad.l}" y="${H - 6}">${firstDay}</text>
          <text class="axis-text" x="${W - pad.r}" y="${H - 6}" text-anchor="end">${lastDay}</text>
          <g id="pnlCursor" hidden>
            <line class="cursor-line" y1="${pad.t}" y2="${pad.t + plotH}"/>
            <circle class="cursor-dot" r="4.5" fill="${stroke}"/>
          </g>
          <rect id="pnlHit" x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}" fill="transparent"/>
        </svg>
        <div class="chart-tip" id="pnlTip" hidden></div>
      </div>
    </div>`;
}

/* Hover layer. An SVG chart in a browser is interactive by default; a line
   chart without a readout makes you estimate values off the axis. */
function wirePnlChart(points) {
  const wrap = document.getElementById('pnlWrap');
  if (!wrap || points.length < 2) return;

  const svg = wrap.querySelector('svg');
  const hit = document.getElementById('pnlHit');
  const cursor = document.getElementById('pnlCursor');
  const tip = document.getElementById('pnlTip');
  const line = cursor.querySelector('line');
  const dot = cursor.querySelector('circle');

  const W = 720, pad = { t: 12, r: 12, b: 22, l: 52 };
  const plotW = W - pad.l - pad.r;
  const H = 220, plotH = H - pad.t - pad.b;
  const values = points.map((p) => p.value);
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  const span = (hi - lo) || 1;

  function show(clientX) {
    const box = svg.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, ((clientX - box.left) / box.width * W - pad.l) / plotW));
    const i = Math.round(ratio * (points.length - 1));
    const point = points[i];

    const px = pad.l + (i / (points.length - 1)) * plotW;
    const py = pad.t + plotH - ((point.value - lo) / span) * plotH;

    line.setAttribute('x1', px); line.setAttribute('x2', px);
    dot.setAttribute('cx', px);  dot.setAttribute('cy', py);
    cursor.hidden = false;

    tip.innerHTML = `<b>${money(point.value)}</b> `
      + `<span style="color:var(--${point.pnl >= 0 ? 'yes' : 'no'})">`
      + `${point.pnl >= 0 ? '+' : ''}${money(point.pnl)}</span><br>`
      + `${(point.ts || '').slice(0, 10)} · ${escapeHtml(point.ticker || '')}`;
    tip.hidden = false;
    tip.style.left = `${(px / W) * box.width}px`;
    tip.style.top = `${(py / H) * box.height}px`;
  }

  hit.addEventListener('pointermove', (e) => show(e.clientX));
  hit.addEventListener('pointerdown', (e) => show(e.clientX));
  hit.addEventListener('pointerleave', () => { cursor.hidden = true; tip.hidden = true; });
}

/* Cash flow by sport. Diverging by sign, so profit and loss read apart
   at a glance rather than by reading the numbers. */
function sportBars(series, sportOf, labelOf) {
  const bySport = new Map();
  for (const [ticker, flow] of series) {
    const key = sportOf(ticker) || 'other';
    bySport.set(key, (bySport.get(key) || 0) + flow);
  }

  const rows = [...bySport.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  if (!rows.length) return '';
  const max = Math.max(...rows.map(([, v]) => Math.abs(v))) || 1;

  return `
    <div class="chart-card">
      <div class="chart-title">Realised P&amp;L by sport</div>
      <div class="chart-sub">Settled markets only, net of fees.</div>
      <div class="bars">
        ${rows.map(([key, value]) => {
          const dir = value >= 0 ? 'up' : 'down';
          return `
            <div class="bar-row">
              <span class="bar-name">${escapeHtml(labelOf(key))}</span>
              <span class="bar-track">
                <span class="bar-fill ${dir}" style="width:${(Math.abs(value) / max * 100).toFixed(1)}%"></span>
              </span>
              <span class="bar-val ${dir}">${money(value)}</span>
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

function viewTrades() {
  const priv = state.private;
  if (!priv) {
    return emptyState('No local trade data',
      'Run "python3 fetch_private.py" with your Kalshi credentials to load your fills. '
      + 'The file it writes is gitignored and never reaches the deployed site.');
  }

  const m = Board.tradeMetrics(priv);
  const sportOf = (ticker) => {
    const entry = (state.index?.sports || []).find((s) =>
      (state.sportPrefixes[s.key] || []).some((p) => (ticker || '').toUpperCase().startsWith(p)));
    return entry ? entry.key : null;
  };
  const labelOf = (key) => (state.index?.sports || []).find((s) => s.key === key)?.label
    || key.toUpperCase();

  const sports = new Set([...m.series.keys()].map(sportOf).filter(Boolean));
  const roi = m.staked ? (m.realised / m.staked) * 100 : 0;

  const body = `
    <div class="private-note">
      <span>🔒</span>
      <span>Local only. This tab is rendered from <code>data/private.local.json</code>,
      which is gitignored and absent from the published site — nobody visiting your
      portfolio can see any of it.</span>
    </div>

    <div class="stats">
      ${statTile('Realised P&L', money(m.realised),
                 `${m.settled.length} settled markets`, m.realised)}
      ${statTile('Return on stake', `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`,
                 `${money(m.staked)} staked`, m.realised)}
      ${statTile('Win rate', `${(m.winRate * 100).toFixed(0)}%`,
                 `${m.wins} of ${m.settled.length} markets`)}
      ${statTile('Fills', m.trades.length.toLocaleString(),
                 `${m.contracts.toLocaleString()} contracts`)}
      ${statTile('Fees paid', money(-m.fees), 'trading and settlement', -1)}
      ${statTile('Sports traded', String(sports.size),
                 [...sports].map(labelOf).join(', ') || '—')}
    </div>

    ${pnlChart(m.points)}
    ${sportBars(m.series, sportOf, labelOf)}`;

  // The chart's hover layer has to be attached after the markup is in the DOM.
  queueMicrotask(() => wirePnlChart(m.points));
  return body;
}
