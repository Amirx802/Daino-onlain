// leaderboard.js — جدول‌های امتیاز مشترک (بدون هیچ وابستگی)
// دو جدول کاملاً مستقل از هم:
//   🎃 کدو    :  GET/POST /api/leaderboard  {name, score}   → فایل leaderboard.json
//   💀 کشتن   :  GET/POST /api/kills        {name, score}   → فایل kills.json
//
// استفاده (express یا http خام):
//   const lb = require('./leaderboard');
//   app.use((req, res, next) => lb.handle(req, res) || next());
//
// هشدار: روی پلن رایگان Render دیسک موقتی است و با هر دیپلوی/ری‌استارت پاک می‌شود.
// برای ذخیره‌ی واقعی، یک Persistent Disk وصل کن و DATA_DIR را روی مسیر آن بگذار.
const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || __dirname;
const KEEP = 100;             // چند نفر ذخیره شود
const SEND = 50;              // چند نفر برگردانده شود

const clean = s => String(s == null ? '' : s)
  .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
  .trim().slice(0, 14);

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

function makeBoard({ route, file, maxScore, lockAfter }) {
  let board = {};
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (o && typeof o === 'object') board = o;
  } catch (e) { /* فایل هنوز نیست */ }

  let saveTimer = null;
  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file + '.tmp', JSON.stringify(board));
        fs.renameSync(file + '.tmp', file);
      } catch (e) { console.warn(route + ' save failed:', e.message); }
    }, 500);
  }

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

  function handle(req, res) {
    const url = (req.url || '').split('?')[0].replace(/\/+$/, '');
    if (url !== route) return false;
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
      if (lockAfter && Date.now() >= lockAfter) return send(res, 200, { ok: true, ended: true, players: list() });   // رویداد تمام شده؛ جدول نهایی ثابت می‌ماند
      const v = Math.min(score, maxScore);
      if (v > (board[name] || 0)) { board[name] = v; trim(); save(); }   // فقط رکورد بالاتر جایگزین می‌شود
      send(res, 200, { ok: true, players: list() });
    });
    return true;
  }
  return { handle, list };
}

const pumpkin = makeBoard({
  route: '/api/leaderboard',
  file: process.env.LEADERBOARD_FILE || path.join(DIR, 'leaderboard.json'),
  maxScore: 10000000,
});
const kills = makeBoard({
  route: '/api/kills',
  file: path.join(process.env.LEADERBOARD_FILE ? path.dirname(process.env.LEADERBOARD_FILE) : DIR, 'kills.json'),
  maxScore: 1000000,
  lockAfter: Number(process.env.KILLS_END_MS) || Date.UTC(2026, 10, 11, 9, 3, 0),   // پایان رویداد کشتن: ۱۱ نوامبر ۲۰۲۶، ۱۲:۳۳ به وقت تهران
});

module.exports = {
  handle: (req, res) => pumpkin.handle(req, res) || kills.handle(req, res),
  list: pumpkin.list,
  listKills: kills.list,
};
