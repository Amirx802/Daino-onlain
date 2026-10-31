// leaderboard.js — جدول امتیازات مشترک (بدون هیچ وابستگی)
// استفاده در سرور Render (هر دو حالت http خام و express):
//
//   const lb = require('./leaderboard');
//   // express:
//   app.use((req, res, next) => lb.handle(req, res) || next());
//   // http خام:
//   const server = http.createServer((req, res) => { if (lb.handle(req, res)) return; /* بقیه‌ی کد سرور */ });
//
// مسیرها:  GET /api/leaderboard   و   POST /api/leaderboard  {name, score}
const fs = require('fs');
const path = require('path');

const FILE = process.env.LEADERBOARD_FILE ||
  path.join(process.env.DATA_DIR || __dirname, 'leaderboard.json');
const MAX_SCORE = 10000000;   // سقف منطقی امتیاز
const KEEP = 100;             // چند نفر ذخیره شود
const SEND = 50;              // چند نفر برگردانده شود

let board = {};
try {
  const o = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (o && typeof o === 'object') board = o;
} catch (e) { /* فایل هنوز نیست */ }

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE + '.tmp', JSON.stringify(board));
      fs.renameSync(FILE + '.tmp', FILE);
    } catch (e) { console.warn('leaderboard save failed:', e.message); }
  }, 500);
}

const clean = s => String(s == null ? '' : s)
  .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '')
  .trim().slice(0, 14);

function list() {
  return Object.entries(board)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, SEND)
    .map(([name, score]) => ({ name, score }));
}

function trim() {
  const e = Object.entries(board).sort((a, b) => b[1] - a[1]);
  if (e.length > KEEP) board = Object.fromEntries(e.slice(0, KEEP));
}

// محدودیت ساده‌ی درخواست برای هر IP
const hits = new Map();
function limited(ip) {
  const now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < 60000);
  h.push(now); hits.set(ip, h);
  if (hits.size > 5000) hits.clear();
  return h.length > 90;
}

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(obj));
}

function handle(req, res) {
  const url = (req.url || '').split('?')[0].replace(/\/+$/, '');
  if (url !== '/api/leaderboard') return false;
  if (req.method === 'OPTIONS') { send(res, 204, {}); return true; }
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (limited(ip)) { send(res, 429, { error: 'too many requests' }); return true; }
  if (req.method === 'GET') { send(res, 200, { ok: true, players: list() }); return true; }
  if (req.method !== 'POST') { send(res, 405, { error: 'method not allowed' }); return true; }

  let body = '';
  req.on('data', c => { body += c; if (body.length > 2000) req.destroy(); });
  req.on('end', () => {
    let d; try { d = JSON.parse(body); } catch (e) { return send(res, 400, { error: 'bad json' }); }
    const name = clean(d && d.name), score = Math.floor(Number(d && d.score));
    if (!name || !isFinite(score) || score <= 0) return send(res, 400, { error: 'bad name/score' });
    const v = Math.min(score, MAX_SCORE);
    if (v > (board[name] || 0)) { board[name] = v; trim(); save(); }   // فقط رکورد بالاتر جایگزین می‌شود
    send(res, 200, { ok: true, players: list() });
  });
  return true;
}

module.exports = { handle, list };
