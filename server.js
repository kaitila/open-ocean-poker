// Open Ocean Poker — just-for-fun prediction market. Zero dependencies.
//   node server.js            (PORT=3000, ADMIN_TOKEN=..., DB_PATH=state/db.json)
// On Vercel, api/index.js reuses handle() and keeps state in Upstash Redis
// (KV_REST_API_URL / KV_REST_API_TOKEN, set by Vercel's Upstash integration).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const LMSR = require('./public/lmsr');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me';
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'state', 'db.json');
const HISTORY_CAP = 250;

if (ADMIN_TOKEN === 'change-me') console.warn('⚠️  ADMIN_TOKEN not set — using "change-me".');

// ---------------------------------------------------------------- data files
let event, tables, players, customMarkets, defs; // defs: market definitions

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch (e) { if (fallback !== undefined) return fallback; throw e; }
}

function loadData() {
  event = readJson('event.json');
  tables = readJson('tables.json', []);
  players = readJson('players.json', []);
  customMarkets = readJson('markets.json', []);
  defs = buildMarketDefs();
}

function buildMarketDefs() {
  const list = [];
  const liq = { winner: 1500, table: 500, props: 400, ...(event.liquidity || {}) };
  const playerOutcomes = (ps) => ps.map((p) => ({ id: p.id, label: p.name, playerId: p.id }));
  if (players.length >= 2) {
    list.push({
      id: 'winner', question: 'Who wins the tournament?', category: 'Tournament', kind: 'players',
      b: liq.winner, outcomes: playerOutcomes(players), featured: true,
      description: 'The last player standing. Busted players drop out of the market and their shares go to zero.',
    });
  }
  for (const t of tables) {
    const ps = players.filter((p) => p.table === t.id);
    if (ps.length < 2) continue;
    list.push({
      id: `table-${t.id}`, question: `Who goes deepest from ${t.name}?`, category: 'Tables', kind: 'players',
      b: liq.table, tableId: t.id, outcomes: playerOutcomes(ps),
      description: `Resolves to the ${t.name} starter who finishes highest in the tournament. Resolves automatically when only one of them is left.`,
    });
  }
  for (const m of customMarkets) {
    let outcomes = m.outcomes;
    if (m.kind === 'binary') outcomes = [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }];
    if (m.kind === 'tables') outcomes = tables.map((t) => ({ id: t.id, label: t.name }));
    if (!outcomes || outcomes.length < 2) continue;
    list.push({ b: liq.props, category: 'Props', ...m, outcomes });
  }
  return list;
}

// ---------------------------------------------------------------- database
const emptyDb = () => ({ users: {}, markets: {}, busted: {}, trades: [] });
let db = emptyDb();
let dirty = false;
function saveDb() { dirty = true; }

// Storage: a JSON file locally, Upstash Redis (REST) when configured.
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_KEY = process.env.REDIS_KEY || 'oop:db';

const fileStore = {
  cache: null,
  queue: Promise.resolve(),
  async load() {
    if (!this.cache) { try { this.cache = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch { this.cache = emptyDb(); } }
    return this.cache;
  },
  async save(d) {
    this.cache = d;
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH + '.tmp', JSON.stringify(d));
    fs.renameSync(DB_PATH + '.tmp', DB_PATH);
  },
  withLock(fn) { const run = this.queue.then(fn, fn); this.queue = run.catch(() => {}); return run; },
};

async function redis(...cmd) {
  const r = await fetch(REDIS_URL, { method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(`Storage error: ${j.error}`);
  return j.result;
}
const redisStore = {
  async load() { const v = await redis('GET', REDIS_KEY); return v ? JSON.parse(v) : emptyDb(); },
  async save(d) { await redis('SET', REDIS_KEY, JSON.stringify(d)); },
  async withLock(fn) {
    const id = crypto.randomBytes(8).toString('hex');
    const lock = REDIS_KEY + ':lock';
    for (let i = 0; ; i++) {
      if (await redis('SET', lock, id, 'NX', 'PX', '8000')) break;
      if (i > 80) throw new Error('Busy, try again');
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 50));
    }
    try { return await fn(); }
    finally { await redis('EVAL', "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", '1', lock, id).catch(() => {}); }
  },
};
const store = REDIS_URL && REDIS_TOKEN ? redisStore : fileStore;

function mstate(id) {
  if (!db.markets[id]) db.markets[id] = { q: {}, status: 'open', resolution: null, history: [], volume: 0 };
  return db.markets[id];
}

// Outcomes that can still win (busted players excluded).
function activeOutcomes(def) {
  if (def.kind !== 'players') return def.outcomes.map((o) => o.id);
  return def.outcomes.filter((o) => !db.busted[o.playerId]).map((o) => o.id);
}

function currentPrices(def) {
  const st = mstate(def.id);
  if (st.status === 'resolved') {
    const p = {};
    for (const o of def.outcomes) p[o.id] = o.id === st.resolution ? 1 : 0;
    return p;
  }
  const act = activeOutcomes(def);
  const p = LMSR.prices(st.q, act, def.b);
  for (const o of def.outcomes) if (!(o.id in p)) p[o.id] = 0;
  return p;
}

function snapshot(def) {
  const st = mstate(def.id);
  const p = currentPrices(def);
  const rounded = {};
  for (const k in p) rounded[k] = Math.round(p[k] * 10000) / 10000;
  st.history.push({ t: Date.now(), p: rounded });
  if (st.history.length > HISTORY_CAP) st.history.splice(0, st.history.length - HISTORY_CAP);
}

function ensureMarkets() {
  for (const def of defs) { const st = mstate(def.id); if (!st.history.length) snapshot(def); }
}

// ---------------------------------------------------------------- resolution
function resolveMarket(def, outcomeId, reason) {
  const st = mstate(def.id);
  if (st.status === 'resolved') return;
  if (!def.outcomes.some((o) => o.id === outcomeId)) throw new Error('Unknown outcome');
  st.status = 'resolved';
  st.resolution = outcomeId;
  st.resolvedAt = Date.now();
  st.resolvedReason = reason || 'Resolved by the organisers';
  for (const u of Object.values(db.users)) {
    const pos = u.positions[def.id];
    if (!pos) continue;
    const payout = pos[outcomeId] || 0;
    if (payout > 0) u.balance += payout;
    u.settled = u.settled || {};
    u.settled[def.id] = { payout, outcome: outcomeId };
  }
  snapshot(def);
  runAutoResolvers();
}

function runAutoResolvers() {
  const winnerState = db.markets.winner;
  const winner = winnerState && winnerState.status === 'resolved'
    ? players.find((p) => p.id === winnerState.resolution) : null;
  for (const def of defs) {
    const st = mstate(def.id);
    if (st.status === 'resolved') continue;
    if (def.kind === 'players') {
      const act = activeOutcomes(def);
      if (act.length === 1) resolveMarket(def, act[0], 'Last player standing');
      continue;
    }
    if (def.autoResolve === 'firstBustTable') {
      const first = Object.entries(db.busted).sort((a, b) => a[1].order - b[1].order)[0];
      const p = first && players.find((x) => x.id === first[0]);
      if (p && def.outcomes.some((o) => o.id === p.table)) resolveMarket(def, p.table, `${p.name} busted first`);
    }
    if (!winner) continue;
    if (def.autoResolve === 'winnerRole') {
      const id = def.outcomes.some((o) => o.id === winner.role) ? winner.role : def.outcomes[def.outcomes.length - 1].id;
      resolveMarket(def, id, `${winner.name} won`);
    }
    if (def.autoResolve === 'winnerFirstTimer') resolveMarket(def, winner.firstTimer ? 'yes' : 'no', `${winner.name} won`);
  }
}

// ---------------------------------------------------------------- trading
function trade(user, { marketId, outcomeId, side, amount, shares }) {
  const def = defs.find((d) => d.id === marketId);
  if (!def) throw new Error('Unknown market');
  const st = mstate(def.id);
  if (st.status !== 'open') throw new Error('Trading is closed on this market');
  const act = activeOutcomes(def);
  if (!act.includes(outcomeId)) throw new Error('That outcome is no longer tradable');
  const pos = (user.positions[def.id] = user.positions[def.id] || {});

  let cost, qty;
  if (side === 'buy') {
    cost = Math.floor(Number(amount));
    if (!(cost >= 1)) throw new Error('Spend at least 1 chip');
    if (cost > user.balance + 1e-9) throw new Error('Not enough chips');
    qty = LMSR.sharesForAmount(st.q, act, def.b, outcomeId, cost);
    st.q[outcomeId] = (st.q[outcomeId] || 0) + qty;
    pos[outcomeId] = (pos[outcomeId] || 0) + qty;
    user.balance -= cost;
  } else if (side === 'sell') {
    qty = Number(shares);
    const held = pos[outcomeId] || 0;
    if (!(qty > 0)) throw new Error('Nothing to sell');
    if (qty > held + 1e-6) throw new Error('You do not hold that many shares');
    qty = Math.min(qty, held);
    cost = LMSR.amountForShares(st.q, act, def.b, outcomeId, qty);
    st.q[outcomeId] -= qty;
    pos[outcomeId] = held - qty;
    if (pos[outcomeId] < 1e-6) delete pos[outcomeId];
    user.balance += cost;
  } else throw new Error('Bad side');

  st.volume += cost;
  snapshot(def);
  db.trades.unshift({ t: Date.now(), user: user.name, userId: user.id, marketId, outcomeId, side, chips: cost, shares: qty });
  db.trades.length = Math.min(db.trades.length, 200);
  saveDb();
  return { shares: qty, chips: cost };
}

// ---------------------------------------------------------------- views
function netWorth(u) {
  let v = u.balance;
  for (const [mid, pos] of Object.entries(u.positions)) {
    const def = defs.find((d) => d.id === mid);
    if (!def || mstate(mid).status === 'resolved') continue;
    const p = currentPrices(def);
    for (const [oid, s] of Object.entries(pos)) v += s * (p[oid] || 0);
  }
  return v;
}

function publicState(token, historyFor) {
  const markets = defs.map((def) => {
    const st = mstate(def.id);
    const act = new Set(activeOutcomes(def));
    const p = currentPrices(def);
    return {
      ...def,
      outcomes: def.outcomes.map((o) => ({ ...o, price: p[o.id] || 0, active: st.status !== 'resolved' && act.has(o.id) })),
      q: st.q, status: st.status, resolution: st.resolution, resolvedReason: st.resolvedReason,
      volume: Math.round(st.volume), history: def.id === historyFor ? st.history : undefined,
    };
  });
  const leaderboard = Object.values(db.users)
    .map((u) => ({ id: u.id, name: u.name, netWorth: Math.round(netWorth(u)), cash: Math.round(u.balance) }))
    .sort((a, b) => b.netWorth - a.netWorth);
  const u = token && db.users[token];
  return {
    event, tables, players, markets, leaderboard,
    busted: db.busted,
    trades: db.trades.slice(0, 40),
    me: u ? { id: u.id, name: u.name, balance: u.balance, positions: u.positions, settled: u.settled || {}, netWorth: netWorth(u), token } : null,
    serverTime: Date.now(),
  };
}

// ---------------------------------------------------------------- http
function send(res, code, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
  res.writeHead(code, { 'Content-Type': isBuf ? 'text/plain' : 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(isBuf ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Bad JSON')); } });
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.ico': 'image/x-icon' };

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  const allowed = file.startsWith(PUBLIC_DIR);
  if (!allowed || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

function isAdmin(req) {
  const t = req.headers['x-admin-token'] || '';
  const a = Buffer.from(String(t)); const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const routes = {
  // NOTE: handlers must stay synchronous (see handle()).
  'GET /api/state': (req, res, body, url) => send(res, 200, publicState(url.searchParams.get('token'), url.searchParams.get('history'))),

  'POST /api/join': (req, res, body) => {
    const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (name.length < 2) throw new Error('Pick a name with at least 2 characters');
    if (Object.values(db.users).some((u) => u.name.toLowerCase() === name.toLowerCase())) throw new Error('That name is taken — try adding an initial');
    const token = crypto.randomBytes(16).toString('hex');
    db.users[token] = { id: crypto.randomBytes(6).toString('hex'), name, balance: event.startingChips || 1000, positions: {}, createdAt: Date.now() };
    saveDb();
    send(res, 200, { token });
  },

  'POST /api/trade': (req, res, body) => {
    const u = db.users[body.token];
    if (!u) return send(res, 401, { error: 'Join the market first' });
    send(res, 200, trade(u, body));
  },

  'POST /api/admin/check': (req, res) => send(res, 200, { ok: true }),

  'POST /api/admin/bust': (req, res, body) => {
    const p = players.find((x) => x.id === body.playerId);
    if (!p) throw new Error('Unknown player');
    if (body.busted) {
      if (!db.busted[p.id]) {
        const order = Object.keys(db.busted).length + 1;
        db.busted[p.id] = { at: Date.now(), order };
      }
    } else delete db.busted[p.id];
    for (const def of defs) if (def.kind === 'players' && def.outcomes.some((o) => o.playerId === p.id)) snapshot(def);
    runAutoResolvers();
    saveDb();
    send(res, 200, { ok: true });
  },

  'POST /api/admin/market': (req, res, body) => {
    const def = defs.find((d) => d.id === body.marketId);
    if (!def) throw new Error('Unknown market');
    const st = mstate(def.id);
    if (body.action === 'close' && st.status === 'open') st.status = 'closed';
    else if (body.action === 'open' && st.status === 'closed') st.status = 'open';
    else if (body.action === 'resolve') resolveMarket(def, body.outcomeId, body.reason);
    else throw new Error('Nothing to do');
    saveDb();
    send(res, 200, { ok: true });
  },

  'POST /api/admin/reload': (req, res) => { loadData(); ensureMarkets(); saveDb(); send(res, 200, { ok: true, players: players.length, tables: tables.length, markets: defs.length }); },

  'POST /api/admin/grant': (req, res, body) => {
    const amount = Number(body.amount) || 0;
    for (const u of Object.values(db.users)) u.balance += amount;
    saveDb();
    send(res, 200, { ok: true, users: Object.keys(db.users).length });
  },
};

// Runs one API request against freshly loaded state; writes are serialised by a lock
// and the response is only sent after the new state is stored.
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) {
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    return serveStatic(req, res, decodeURIComponent(url.pathname));
  }
  if (url.pathname.startsWith('/api/admin/') && !isAdmin(req)) return send(res, 403, { error: 'Wrong admin token' });
  const out = { code: 200, headers: {}, body: '' };
  const shim = { writeHead(c, h) { out.code = c; out.headers = h; }, end(b) { out.body = b; } };
  try {
    const body = req.method === 'POST' ? (req.body && typeof req.body === 'object' ? req.body : await readBody(req)) : {};
    const run = async () => {
      db = { ...emptyDb(), ...(await store.load()) };
      dirty = false;
      ensureMarkets();
      runAutoResolvers();
      handler(req, shim, body, url); // synchronous, so `db` can't be swapped by another request mid-way
      const mine = db, changed = dirty;
      if (changed && req.method === 'POST') await store.save(mine);
    };
    if (req.method === 'POST') await store.withLock(run); else await run();
  } catch (e) {
    out.code = 400; out.headers = { 'Content-Type': 'application/json' }; out.body = JSON.stringify({ error: e.message });
  }
  res.writeHead(out.code, out.headers);
  res.end(out.body);
}

loadData();
module.exports = { handle };

if (require.main === module) {
  http.createServer(handle).listen(PORT, () => console.log(`♠️  Open Ocean Poker market on http://localhost:${PORT} (${store === redisStore ? 'redis' : 'file'} storage)`));
}
