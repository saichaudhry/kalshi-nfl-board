/* ============================================================
   NFL team identity.

   Kalshi refers to teams by its own short codes ("JAC", "WAS");
   ESPN's logo CDN mostly agrees but not always, so the slug is
   stored per team rather than lowercasing the code and hoping.

   `city` and `nick` exist because market labels name teams in
   prose -- a moneyline market is labelled "Buffalo", not "BUF" --
   so a logo can still be resolved from the text.

   Colours are each club's primary, used for the monogram shown
   when a logo does not load.
   ============================================================ */

const TEAMS = {
  ARI: { slug: 'ari', city: 'Arizona',      nick: 'Cardinals',  color: '#97233F' },
  ATL: { slug: 'atl', city: 'Atlanta',      nick: 'Falcons',    color: '#A71930' },
  BAL: { slug: 'bal', city: 'Baltimore',    nick: 'Ravens',     color: '#241773' },
  BUF: { slug: 'buf', city: 'Buffalo',      nick: 'Bills',      color: '#00338D' },
  CAR: { slug: 'car', city: 'Carolina',     nick: 'Panthers',   color: '#0085CA' },
  CHI: { slug: 'chi', city: 'Chicago',      nick: 'Bears',      color: '#0B162A' },
  CIN: { slug: 'cin', city: 'Cincinnati',   nick: 'Bengals',    color: '#FB4F14' },
  CLE: { slug: 'cle', city: 'Cleveland',    nick: 'Browns',     color: '#311D00' },
  DAL: { slug: 'dal', city: 'Dallas',       nick: 'Cowboys',    color: '#041E42' },
  DEN: { slug: 'den', city: 'Denver',       nick: 'Broncos',    color: '#FB4F14' },
  DET: { slug: 'det', city: 'Detroit',      nick: 'Lions',      color: '#0076B6' },
  GB:  { slug: 'gb',  city: 'Green Bay',    nick: 'Packers',    color: '#203731' },
  HOU: { slug: 'hou', city: 'Houston',      nick: 'Texans',     color: '#03202F' },
  IND: { slug: 'ind', city: 'Indianapolis', nick: 'Colts',      color: '#002C5F' },
  JAC: { slug: 'jac', city: 'Jacksonville', nick: 'Jaguars',    color: '#006778' },
  KC:  { slug: 'kc',  city: 'Kansas City',  nick: 'Chiefs',     color: '#E31837' },
  LAC: { slug: 'lac', city: 'Los Angeles',  nick: 'Chargers',   color: '#0080C6' },
  LAR: { slug: 'lar', city: 'Los Angeles',  nick: 'Rams',       color: '#003594' },
  LV:  { slug: 'lv',  city: 'Las Vegas',    nick: 'Raiders',    color: '#111111' },
  MIA: { slug: 'mia', city: 'Miami',        nick: 'Dolphins',   color: '#008E97' },
  MIN: { slug: 'min', city: 'Minnesota',    nick: 'Vikings',    color: '#4F2683' },
  NE:  { slug: 'ne',  city: 'New England',  nick: 'Patriots',   color: '#002244' },
  NO:  { slug: 'no',  city: 'New Orleans',  nick: 'Saints',     color: '#9F8958' },
  NYG: { slug: 'nyg', city: 'New York',     nick: 'Giants',     color: '#0B2265' },
  NYJ: { slug: 'nyj', city: 'New York',     nick: 'Jets',       color: '#125740' },
  PHI: { slug: 'phi', city: 'Philadelphia', nick: 'Eagles',     color: '#004C54' },
  PIT: { slug: 'pit', city: 'Pittsburgh',   nick: 'Steelers',   color: '#FFB612' },
  SEA: { slug: 'sea', city: 'Seattle',      nick: 'Seahawks',   color: '#002244' },
  SF:  { slug: 'sf',  city: 'San Francisco',nick: '49ers',      color: '#AA0000' },
  TB:  { slug: 'tb',  city: 'Tampa Bay',    nick: 'Buccaneers', color: '#D50A0A' },
  TEN: { slug: 'ten', city: 'Tennessee',    nick: 'Titans',     color: '#0C2340' },
  WAS: { slug: 'was', city: 'Washington',   nick: 'Commanders', color: '#5A1414' },
};

/* Reverse index so prose labels resolve to a code. Both "Buffalo" and
   "Bills" point at BUF.

   Two cities host two clubs each, and Kalshi separates them by appending the
   nickname's first letter -- "New York J" and "New York G", "Los Angeles C"
   and "Los Angeles R". Those forms are generated here; the bare city is left
   out, because on its own it genuinely does not identify a club. */
const TEAM_BY_NAME = (() => {
  const index = new Map();
  const shared = new Set(['Los Angeles', 'New York']);
  for (const [code, team] of Object.entries(TEAMS)) {
    index.set(team.nick.toLowerCase(), code);
    if (shared.has(team.city)) {
      index.set(`${team.city} ${team.nick[0]}`.toLowerCase(), code);
    } else {
      index.set(team.city.toLowerCase(), code);
    }
  }
  return index;
})();

/* A market's ticker ends in the team it refers to:
   KXMLBGAME-26SEP161840ATHTB-ATH. That is exact, language-free and works in
   every sport, so it beats reading the prose label -- which says "A's" for a
   club ESPN only ever calls "Athletics". */
function teamCodeFromTicker(ticker, allowed) {
  const parts = String(ticker || '').split('-');
  if (parts.length < 3) return null;
  const tail = parts[parts.length - 1].toUpperCase();
  if (allowed && allowed.length) {
    return allowed.map(String).find((c) => c.toUpperCase() === tail) || null;
  }
  return REGISTRY[tail] ? tail : null;
}

function teamCodeFromLabel(label) {
  if (!label) return null;
  const key = String(label).trim().toLowerCase();
  if (REGISTRY_BY_NAME.has(key)) return REGISTRY_BY_NAME.get(key);
  if (TEAM_BY_NAME.has(key)) return TEAM_BY_NAME.get(key);
  // Fall back to a contained nickname, so "Buffalo wins 1st Half" still resolves.
  for (const index of [REGISTRY_BY_NAME, TEAM_BY_NAME]) {
    for (const [name, code] of index) {
      if (key.startsWith(`${name} `)) return code;
    }
  }
  return null;
}

/* The active sport's team registry, straight from ESPN (abbreviation -> name,
   colour, logo URL). Swapped on every sport change, which is why crests work
   for baseball and hockey without a hand-written table per league. */
let REGISTRY = {};
let REGISTRY_BY_NAME = new Map();

function setTeamRegistry(teams) {
  REGISTRY = teams || {};
  REGISTRY_BY_NAME = new Map();

  // Kalshi names a club differently depending on the market: "Tampa Bay",
  // "Rays", "A's", "Los Angeles D". Index every form ESPN knows, then add
  // Kalshi's own convention for cities that host two clubs.
  const cityCount = new Map();
  for (const team of Object.values(REGISTRY)) {
    const city = (team.location || '').toLowerCase();
    if (city) cityCount.set(city, (cityCount.get(city) || 0) + 1);
  }

  const add = (name, abbr) => {
    const key = (name || '').trim().toLowerCase();
    if (key && !REGISTRY_BY_NAME.has(key)) REGISTRY_BY_NAME.set(key, abbr);
  };

  for (const [abbr, team] of Object.entries(REGISTRY)) {
    add(team.name, abbr);
    add(team.nick, abbr);
    add(team.short, abbr);
    add(abbr, abbr);

    const city = (team.location || '').toLowerCase();
    if (!city) continue;
    if ((cityCount.get(city) || 0) > 1) {
      // Two clubs share this city, so Kalshi appends initials from the
      // nickname: "Los Angeles D" for the Dodgers, "Chicago WS" for the
      // White Sox -- one letter per word, hence both forms.
      const nick = (team.nick || team.name || '').trim();
      const initials = nick.split(/\s+/).map((w) => w[0]).join('');
      if (nick[0]) add(`${city} ${nick[0]}`, abbr);
      if (initials.length > 1) add(`${city} ${initials}`, abbr);
    } else {
      add(city, abbr);
    }
  }
}

/* The logo, with the club's monogram underneath it. If the image loads it
   covers the monogram; if it cannot be fetched the monogram is what you see,
   so a team is never rendered as a broken-image icon. */
function teamLogo(code, size = 26) {
  if (!code) return '';
  const key = String(code).toUpperCase();
  const espn = REGISTRY[key];
  const nfl = TEAMS[key];

  const label = espn?.name || (nfl ? `${nfl.city} ${nfl.nick}` : key);
  const color = espn?.color || nfl?.color || null;
  const src = espn?.logo
    || (nfl ? `https://a.espncdn.com/i/teamlogos/nfl/500/${nfl.slug}.png` : null);

  const style = `--logo-size:${size}px${color ? `;--team:${color}` : ''}`;
  if (!src) {
    return `<span class="logo" style="${style}" title="${escapeAttr(label)}">
      <span class="logo-mark">${escapeAttr(key.slice(0, 3))}</span></span>`;
  }

  return `<span class="logo" style="${style}" title="${escapeAttr(label)}">
    <span class="logo-mark">${escapeAttr(key.slice(0, 3))}</span>
    <img src="${escapeAttr(src)}" alt="${escapeAttr(label)}" loading="lazy" decoding="async"
         onload="this.previousElementSibling.hidden = true"
         onerror="this.remove()">
  </span>`;
}

const escapeAttr = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
