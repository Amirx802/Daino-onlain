'use strict';
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { randomUUID } = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true, maxPayload: 64 * 1024 });
const PORT = process.env.PORT || 10000;
const clients = new Map(); // ws -> { id, room, presence }

app.get('/health', (_req, res) => res.status(200).json({ ok: true, service: 'dinosaur-online-server' }));
app.use(express.static(path.join(__dirname), { index: 'index.html', etag: true, maxAge: '1h' }));

function roomClients(room) {
  return [...clients.entries()].filter(([, c]) => c.room === room);
}
function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcastState(room) {
  const list = roomClients(room).map(([, c]) => ({ peer: c.id, presence: c.presence || {} }));
  for (const [ws] of roomClients(room)) send(ws, { t: 's', list });
}
function cleanRoom(raw) {
  return String(raw || 'main').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'main';
}

server.on('upgrade', (req, socket, head) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
  if (u.pathname !== '/ws') { socket.destroy(); return; }
  const room = cleanRoom(u.searchParams.get('room'));
  wss.handleUpgrade(req, socket, head, ws => {
    ws.roomId = room;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', ws => {
  const client = { id: randomUUID().slice(0, 12), room: ws.roomId || 'main', presence: {} };
  clients.set(ws, client);
  send(ws, { t: 'hi', id: client.id });
  broadcastState(client.room);

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'p') {
      if (!m.d || typeof m.d !== 'object' || Array.isArray(m.d)) return;
      // Keep presence compact and JSON-safe.
      try {
        const encoded = JSON.stringify(m.d);
        if (encoded.length > 4000) return;
        client.presence = m.d;
      } catch { return; }
      broadcastState(client.room);
    } else if (m.t === 'e' && typeof m.n === 'string') {
      const name = m.n.slice(0, 40);
      let data = m.d;
      try { if (JSON.stringify(data).length > 4000) return; } catch { return; }
      for (const [other, c] of roomClients(client.room)) {
        if (other !== ws) send(other, { t: 'e', from: client.id, n: name, d: data });
      }
    }
  });
  ws.on('close', () => {
    const old = clients.get(ws);
    clients.delete(ws);
    if (old) broadcastState(old.room);
  });
  ws.on('error', () => {});
});

server.listen(PORT, '0.0.0.0', () => console.log(`Dinosaur multiplayer server listening on ${PORT}`));
