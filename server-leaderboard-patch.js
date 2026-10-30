// اختیاری: ذخیره‌ی دائمی امتیازها روی سرور Render (daino-onlain-2)
// با این کد، حتی بازیکنی که آفلاین است هم در جدول بقیه دیده می‌شود.
// بازی (نسخه‌ی اصلاح‌شده) این پیام را می‌فرستد:   { t:'sc', nm:'اسم', pt: 1234 }
// و این پیام را از سرور می‌پذیرد:                  { t:'lb', list:[{nm:'اسم', pt:1234}, ...] }
//
// داخل فایل سرور خودت (جایی که پیام‌های t:'p' و t:'e' را پردازش می‌کنی) اضافه کن:

const fs = require('fs');
const SCORE_FILE = process.env.SCORE_FILE || './scores.json';   // روی Render بهتر است Disk یا دیتابیس باشد
let scores = {};
try { scores = JSON.parse(fs.readFileSync(SCORE_FILE, 'utf8')); } catch (e) {}
let dirty = false;
setInterval(() => { if (dirty) { dirty = false; fs.writeFile(SCORE_FILE, JSON.stringify(scores), () => {}); } }, 5000);

const clean = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 14);
const topList = () => Object.entries(scores).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([nm, pt]) => ({ nm, pt }));

// 1) هر کلاینت که وصل شد، جدول فعلی را بگیرد (بعد از ارسال {t:'hi'}):
//    ws.send(JSON.stringify({ t: 'lb', list: topList() }));

// 2) داخل ws.on('message'):
//    if (msg.t === 'sc') {
//      const nm = clean(msg.nm), pt = Math.min(Math.floor(+msg.pt), 1e9);
//      if (nm && isFinite(pt) && pt > (scores[nm] || 0)) { scores[nm] = pt; dirty = true; }
//      return;
//    }

// 3) هر ۵ ثانیه برای همه‌ی کلاینت‌های وصل پخش کن:
//    setInterval(() => { const m = JSON.stringify({ t: 'lb', list: topList() }); wss.clients.forEach(c => c.readyState === 1 && c.send(m)); }, 5000);
