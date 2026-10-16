// Dinosaur game: static file server + WebSocket multiplayer rooms.
// Protocol (matches the game's client):
//  server -> client: {t:'hi', id}            on connect
//                    {t:'s', list:[{peer, presence}]}   room snapshot
//                    {t:'e', n, d, from}     event from another player
//  client -> server: {t:'p', d}              set my presence
//                    {t:'e', n, d}           broadcast an event to others
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'public', 'index.html');
const MAX_PLAYERS_PER_ROOM = 16;
const SNAPSHOT_MS = 80; // ~12 snapshots/sec per room

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(INDEX).pipe(res);
  }
  res.writeHead(404); res.end('not found');
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
const rooms = new Map(); // name -> { clients:Set<ws>, dirty:bool }

function roomName(req) {
  try {
    const r = new URL(req.url, 'http://x').searchParams.get('room') || 'main';
    return r.replace(/[^\w\-]/g, '').slice(0, 32) || 'main';
  } catch { return 'main'; }
}

wss.on('connection', (ws, req) => {
  const name = roomName(req);
  let room = rooms.get(name);
  if (!room) { room = { clients: new Set(), dirty: false }; rooms.set(name, room); }
  if (room.clients.size >= MAX_PLAYERS_PER_ROOM) { ws.close(1013, 'room full'); return; }

  ws.id = crypto.randomBytes(4).toString('hex');
  ws.presence = null;
  ws.isAlive = true;
  ws.room = room;
  ws.roomName = name;
  room.clients.add(ws);
  ws.send(JSON.stringify({ t: 'hi', id: ws.id }));
  room.dirty = true;

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'p') {
      ws.presence = m.d;
      room.dirty = true;
    } else if (m.t === 'e' && typeof m.n === 'string' && m.n.length <= 32) {
      const out = JSON.stringify({ t: 'e', n: m.n, d: m.d, from: ws.id });
      for (const c of room.clients) if (c !== ws && c.readyState === 1) c.send(out);
    }
  });
  ws.on('close', () => {
    room.clients.delete(ws);
    room.dirty = true;
    if (room.clients.size === 0) rooms.delete(name);
  });
  ws.on('error', () => {});
});

// push room snapshots (throttled)
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.dirty) continue;
    room.dirty = false;
    const list = [];
    for (const c of room.clients) list.push({ peer: c.id, presence: c.presence || {} });
    const out = JSON.stringify({ t: 's', list });
    for (const c of room.clients) if (c.readyState === 1) c.send(out);
  }
}, SNAPSHOT_MS);

// drop dead connections
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

server.listen(PORT, () => console.log('listening on ' + PORT));
