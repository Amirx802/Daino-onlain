// Dino game server: accounts + saves + leaderboard + remote gifts + multiplayer (WebSocket)
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || './data';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const DINOS = ['rex', 'croc', 'indo', 'spino', 'ptero', 'brachio', 'tric', 'pkrex'];
const MAX_CURRENCY = 1_000_000;
const MAP_LIMIT = 5000;          // players can't report positions outside +-5000
const ROOM_MAX = 30;
const TICK_MS = 100;             // multiplayer broadcast rate (10/s)

// ---------- tiny JSON database (atomic writes) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { players: {}, gifts: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { /* first run */ }
db.players ||= {}; db.gifts ||= {};
let dirty = false;
const persist = () => { dirty = true; };
setInterval(() => {
  if (!dirty) return; dirty = false;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}, 3000);
const flushNow = () => { try { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); } catch {} };
process.on('SIGTERM', () => { flushNow(); process.exit(0); });
process.on('SIGINT', () => { flushNow(); process.exit(0); });

// ---------- helpers ----------
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const isId = v => typeof v === 'string' && /^\d{6,12}$/.test(v);
const int = (v, max = MAX_CURRENCY) => { v = Math.floor(Number(v)); return Number.isFinite(v) ? Math.min(Math.max(v, 0), max) : 0; };
const cleanName = v => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
function newId() { for (;;) { const id = String(1_000_000_000 + crypto.randomInt(0, 999_999_999)); if (!db.players[id]) return id; } }

// ---------- express ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-player-id,x-token,x-admin-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// rate limit: 120 requests / minute / IP
const hits = new Map();
setInterval(() => hits.clear(), 60_000);
app.use((req, res, next) => {
  const ip = req.ip; const n = (hits.get(ip) || 0) + 1; hits.set(ip, n);
  if (n > 120) return res.status(429).json({ error: 'too_many_requests' });
  next();
});

app.get('/health', (_, res) => res.json({ ok: true, players: Object.keys(db.players).length, online }));

// register: no id -> server makes one. With id -> only if it's still free.
app.post('/api/register', (req, res) => {
  let id = req.body?.id;
  if (id !== undefined && id !== null && id !== '') {
    id = String(id);
    if (!isId(id)) return res.status(400).json({ error: 'bad_id' });
    if (db.players[id]) return res.status(409).json({ error: 'id_taken' });
  } else id = newId();
  const token = crypto.randomBytes(24).toString('hex');
  db.players[id] = {
    tokenHash: sha(token), name: cleanName(req.body?.name), genes: 0, coins: 0,
    unlocked: [], best: 0, created: Date.now(), updated: Date.now(),
  };
  persist();
  res.json({ id, token });   // client must store the token; it can't be recovered
});

function auth(req, res, next) {
  const id = req.get('x-player-id'), tok = req.get('x-token');
  const p = isId(id) && db.players[id];
  if (!p || !tok || !safeEq(sha(tok), p.tokenHash)) return res.status(401).json({ error: 'unauthorized' });
  req.pid = id; req.player = p; next();
}
const pub = p => ({ name: p.name, genes: p.genes, coins: p.coins, unlocked: p.unlocked, best: p.best });

app.get('/api/me', auth, (req, res) => res.json(pub(req.player)));

// save: the client sends its current state. Values are clamped/validated.
app.put('/api/save', auth, (req, res) => {
  const b = req.body || {}, p = req.player;
  if (b.genes !== undefined) p.genes = int(b.genes);
  if (b.coins !== undefined) p.coins = int(b.coins);
  if (Array.isArray(b.unlocked)) p.unlocked = [...new Set(b.unlocked.filter(d => DINOS.includes(d)))];
  if (b.name !== undefined) p.name = cleanName(b.name);
  p.updated = Date.now(); persist();
  res.json(pub(p));
});

// pending gifts (set by admin) are applied here, once each
app.post('/api/gifts/claim', auth, (req, res) => {
  const list = db.gifts[req.pid] || [];
  if (!list.length) return res.json({ claimed: [], ...pub(req.player) });
  for (const g of list) {
    req.player.genes = Math.min(req.player.genes + g.genes, MAX_CURRENCY);
    req.player.coins = Math.min(req.player.coins + g.coins, MAX_CURRENCY);
  }
  delete db.gifts[req.pid]; persist();
  res.json({ claimed: list.map(({ genes, coins, note }) => ({ genes, coins, note })), ...pub(req.player) });
});

// leaderboard
app.post('/api/score', auth, (req, res) => {
  const s = int(req.body?.score, 1e9);
  if (s > req.player.best) { req.player.best = s; persist(); }
  res.json({ best: req.player.best });
});
app.get('/api/leaderboard', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
  const rows = Object.entries(db.players).filter(([, p]) => p.best > 0)
    .sort((a, b) => b[1].best - a[1].best).slice(0, limit)
    .map(([id, p], i) => ({ rank: i + 1, name: p.name || ('#' + id.slice(-4)), score: p.best }));
  res.json(rows);
});

// ---------- admin (needs x-admin-key) ----------
function admin(req, res, next) {
  const k = req.get('x-admin-key');
  if (!ADMIN_KEY || !k || !safeEq(sha(k), sha(ADMIN_KEY))) return res.status(403).json({ error: 'forbidden' });
  next();
}
// give a one-time gift to an id; the player gets it next time the game calls /api/gifts/claim
app.post('/admin/gift', admin, (req, res) => {
  const { id } = req.body || {};
  if (!isId(String(id))) return res.status(400).json({ error: 'bad_id' });
  const g = { genes: int(req.body.genes, 100000), coins: int(req.body.coins, 100000), note: String(req.body.note || '').slice(0, 80), at: Date.now() };
  if (!g.genes && !g.coins) return res.status(400).json({ error: 'empty_gift' });
  (db.gifts[id] ||= []).push(g); persist();
  res.json({ ok: true, pending: db.gifts[id].length });
});
app.get('/admin/player/:id', admin, (req, res) => {
  const p = db.players[req.params.id];
  if (!p) return res.status(404).json({ error: 'not_found' });
  const { tokenHash, ...rest } = p;
  res.json({ ...rest, pendingGifts: db.gifts[req.params.id] || [] });
});
// lost token? issue a new one (the old one stops working)
app.post('/admin/reset-token', admin, (req, res) => {
  const p = db.players[req.body?.id];
  if (!p) return res.status(404).json({ error: 'not_found' });
  const token = crypto.randomBytes(24).toString('hex'); p.tokenHash = sha(token); persist();
  res.json({ id: req.body.id, token });
});

// ---------- multiplayer (WebSocket /ws) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 });
const rooms = new Map();            // map name -> Set<client>
const byId = new Map();             // player id -> client
let online = 0;

const send = (c, o) => { if (c.readyState === 1) c.send(JSON.stringify(o)); };
function leaveRoom(c) {
  if (!c.room) return;
  const r = rooms.get(c.room);
  if (r) { r.delete(c); for (const o of r) send(o, { t: 'left', id: c.pid }); if (!r.size) rooms.delete(c.room); }
  c.room = null;
}
function joinRoom(c, map) {
  map = String(map || 'main').replace(/[^\w-]/g, '').slice(0, 24) || 'main';
  let r = rooms.get(map); if (!r) rooms.set(map, r = new Set());
  if (r.size >= ROOM_MAX) return send(c, { t: 'error', error: 'room_full' });
  leaveRoom(c); r.add(c); c.room = map;
  send(c, { t: 'welcome', you: c.pid, map, players: [...r].filter(o => o !== c).map(o => ({ id: o.pid, name: o.name, dino: o.st.dino })) });
  for (const o of r) if (o !== c) send(o, { t: 'joined', id: c.pid, name: c.name, dino: c.st.dino });
}
const num = v => (Number.isFinite(v) ? Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, v)) : 0);

wss.on('connection', ws => {
  ws.isAlive = true; ws.authed = false; ws.st = { x: 0, y: 0, z: 0, ry: 0, dino: 'rex', a: 0 }; ws.lastChat = 0; ws.lastPos = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  const timer = setTimeout(() => { if (!ws.authed) ws.close(4001, 'auth_timeout'); }, 8000);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!ws.authed) {
      if (m.t !== 'hello') return;
      const p = isId(String(m.id)) && db.players[m.id];
      if (!p || !m.token || !safeEq(sha(m.token), p.tokenHash)) return ws.close(4003, 'unauthorized');
      ws.authed = true; ws.pid = String(m.id); ws.name = cleanName(m.name) || p.name || ('#' + ws.pid.slice(-4));
      ws.st.dino = DINOS.includes(m.dino) ? m.dino : 'rex';
      const old = byId.get(ws.pid); if (old && old !== ws) { old.close(4000, 'logged_in_elsewhere'); }
      byId.set(ws.pid, ws); online++;
      return joinRoom(ws, m.map);
    }
    if (m.t === 'pos') {
      const now = Date.now(); if (now - ws.lastPos < 40) return; ws.lastPos = now;   // max ~25 updates/s
      ws.st = { x: num(m.x), y: num(m.y), z: num(m.z), ry: num(m.ry) % 360, dino: DINOS.includes(m.dino) ? m.dino : ws.st.dino, a: int(m.a, 20) };
    } else if (m.t === 'join') joinRoom(ws, m.map);
    else if (m.t === 'chat') {
      const now = Date.now(); if (now - ws.lastChat < 1000) return; ws.lastChat = now;
      const text = String(m.text ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 120); if (!text || !ws.room) return;
      for (const o of rooms.get(ws.room) || []) send(o, { t: 'chat', id: ws.pid, name: ws.name, text });
    }
  });
  ws.on('close', () => {
    clearTimeout(timer);
    if (ws.authed) { leaveRoom(ws); if (byId.get(ws.pid) === ws) { byId.delete(ws.pid); } online = Math.max(0, online - 1); }
  });
  ws.on('error', () => {});
});
// positions of everyone in the room, 10 times per second
setInterval(() => {
  for (const r of rooms.values()) {
    if (r.size < 2) continue;
    const all = [...r].map(c => ({ id: c.pid, ...c.st }));
    for (const c of r) send(c, { t: 'snap', p: all.filter(p => p.id !== c.pid) });
  }
}, TICK_MS);
setInterval(() => { for (const c of wss.clients) { if (!c.isAlive) { c.terminate(); continue; } c.isAlive = false; c.ping(); } }, 30_000);

server.listen(PORT, () => console.log(`dino server on :${PORT}` + (ADMIN_KEY ? '' : '  (ADMIN_KEY not set: /admin/* disabled)')));
