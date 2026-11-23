// Browser-side helper for the game. Add near the top of the game's <script>, set SERVER to your server address.
const SERVER = 'https://YOUR-SERVER.onrender.com';   // wss:// is derived from this automatically

const DinoNet = (() => {
  let id = localStorage.getItem('dinoPlayerId'), token = localStorage.getItem('dinoToken'), ws = null;
  const H = () => ({ 'content-type': 'application/json', 'x-player-id': id, 'x-token': token });
  const call = async (method, url, body, auth = true) => {
    const r = await fetch(SERVER + url, { method, headers: auth ? H() : { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
    return r.json();
  };
  return {
    // first run: creates the account. If the game already has an id, pass it so the same id is kept.
    async init(name) {
      if (id && token) return { id };
      const r = await call('POST', '/api/register', { id: id || undefined, name }, false);
      id = r.id; token = r.token; localStorage.setItem('dinoPlayerId', id); localStorage.setItem('dinoToken', token);
      return r;
    },
    me: () => call('GET', '/api/me'),
    save: s => call('PUT', '/api/save', s),                    // {genes, coins, unlocked:['rex',...], name}
    claimGifts: () => call('POST', '/api/gifts/claim'),        // -> {claimed:[{genes,coins,note}], genes, coins, ...}
    submitScore: score => call('POST', '/api/score', { score }),
    leaderboard: (n = 50) => call('GET', '/api/leaderboard?limit=' + n, null, false),
    // multiplayer
    connect({ map = 'main', dino = 'rex', name, onSnap, onJoin, onLeft, onChat, onWelcome, onClose }) {
      ws = new WebSocket(SERVER.replace(/^http/, 'ws') + '/ws');
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', id, token, name, dino, map }));
      ws.onmessage = e => {
        const m = JSON.parse(e.data);
        ({ snap: onSnap, joined: onJoin, left: onLeft, chat: onChat, welcome: onWelcome })[m.t]?.(m);
      };
      ws.onclose = e => onClose?.(e.code);
    },
    sendPos: (x, y, z, ry, dino, a = 0) => ws?.readyState === 1 && ws.send(JSON.stringify({ t: 'pos', x, y, z, ry, dino, a })),  // call ~15-20 times/second
    chat: text => ws?.readyState === 1 && ws.send(JSON.stringify({ t: 'chat', text })),
    changeMap: map => ws?.readyState === 1 && ws.send(JSON.stringify({ t: 'join', map })),
  };
})();
