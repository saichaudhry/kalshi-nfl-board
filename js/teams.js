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
   "Bills" point at BUF. Los Angeles and New York are deliberately left
   out as bare cities: they are ambiguous, and the nickname disambiguates. */
const TEAM_BY_NAME = (() => {
  const index = new Map();
  const ambiguousCities = new Set(['Los Angeles', 'New York']);
  for (const [code, team] of Object.entries(TEAMS)) {
    index.set(team.nick.toLowerCase(), code);
    if (!ambiguousCities.has(team.city)) index.set(team.city.toLowerCase(), code);
  }
  return index;
})();

function teamCodeFromLabel(label) {
  if (!label) return null;
  const key = String(label).trim().toLowerCase();
  if (TEAM_BY_NAME.has(key)) return TEAM_BY_NAME.get(key);
  // Fall back to a contained nickname, so "Buffalo wins 1st Half" still resolves.
  for (const [name, code] of TEAM_BY_NAME) {
    if (key.startsWith(`${name} `)) return code;
  }
  return null;
}

/* The logo, with the club's monogram underneath it. If the image loads it
   covers the monogram; if the CDN is unreachable the monogram is what you
   see, so a team is never rendered as a broken-image icon. */
function teamLogo(code, size = 26) {
  const team = TEAMS[code];
  if (!team) return '';
  const label = `${team.city} ${team.nick}`;
  return `<span class="logo" style="--team:${team.color};--logo-size:${size}px" title="${label}">
    <span class="logo-mark">${code}</span>
    <img src="https://a.espncdn.com/i/teamlogos/nfl/500/${team.slug}.png"
         alt="${label}" loading="lazy" decoding="async"
         onload="this.previousElementSibling.hidden = true"
         onerror="this.remove()">
  </span>`;
}
