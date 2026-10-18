'use strict';
// プリンセスウイング卓 — room server.
// The room state lives here; browsers send actions and receive only what their seat may see.
globalThis.crypto ??= require('crypto').webcrypto;
const http = require('http');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { WebSocketServer } = require('ws');
const core = require('./public/core.js');
const { createStore } = require('./store.js');

const PORT = process.env.PORT || 10000;
const store = createStore();
const sha = s => nodeCrypto.createHash('sha256').update(String(s)).digest('hex');
const randomId = (p, n = 14) => p + nodeCrypto.randomBytes(16).toString('base64url').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, n);
const html = () => fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8').replace('<!--PW_ONLINE-->', '<script>window.PW_ONLINE = true;</script>');

// ---------- diagnosis ----------
function explain(e) {
  const code = e && (e.code ?? '');
  const msg = String((e && e.message) || e || '');
  if (code === 5 || /NOT_FOUND/i.test(msg)) return 'Firestoreのデータベースが見つかりません。名前付きのデータベースなら、Renderの環境変数 FIRESTORE_DATABASE_ID にその名前を入れてください';
  if (code === 7 || /PERMISSION_DENIED/i.test(msg)) return 'Firestoreへの権限がありません。FIREBASE_SERVICE_ACCOUNT が同じプロジェクトの秘密鍵か確認してください';
  if (code === 16 || /UNAUTHENTICATED|invalid_grant|private key/i.test(msg)) return 'サービスアカウントの鍵が無効です。秘密鍵を作り直して FIREBASE_SERVICE_ACCOUNT に貼り直してください';
  if (code === 9 || /FAILED_PRECONDITION/i.test(msg)) return 'Firestoreの設定が足りません（' + msg.slice(0, 120) + '）';
  return msg.slice(0, 160) || '不明なエラー';
}
let storeStatus = { ok: null, detail: '確認中' };
(async () => {
  try { storeStatus = await store.check(); console.log('store check ok:', storeStatus.detail); }
  catch (e) { storeStatus = { ok: false, detail: explain(e) }; console.error('store check FAILED:', storeStatus.detail, '\n', e); }
})();

// ---------- rooms in memory ----------
const rooms = new Map();     // id -> entry { room, gmKeyHash, clients:Set, seq, saveTimer, idleSince }
const loading = new Map();
async function getRoom(id) {
  if (rooms.has(id)) return rooms.get(id);
  if (loading.has(id)) return loading.get(id);
  const p = (async () => {
    const got = await store.load(id);
    if (!got) return null;
    const room = core.migrateRoom(got.room);
    room.logs = room.logs || [];
    const entry = { room, gmKeyHash: got.gmKeyHash, seatKeyHashes: got.seatKeyHashes || {}, clients: new Set(), seq: room.logs.reduce((m, l) => Math.max(m, l.n || 0), 0), saveTimer: null, idleSince: Date.now() };
    rooms.set(id, entry);
    return entry;
  })();
  loading.set(id, p);
  try { return await p; } finally { loading.delete(id); }
}
function saveSoon(id, entry) {
  clearTimeout(entry.saveTimer);
  entry.saveTimer = setTimeout(() => saveNow(id, entry), 1500);
}
async function saveNow(id, entry) {
  clearTimeout(entry.saveTimer); entry.saveTimer = null;
  const { logs, ...rest } = entry.room;
  try { await store.saveRoom(id, JSON.stringify(rest), { name: entry.room.name, gmKeyHash: entry.gmKeyHash, seatKeyHashes: entry.seatKeyHashes || {} }); }
  catch (e) { console.error('save failed', id, e.message); }
}
// drop rooms nobody has used for a while (they are reloaded from the store on demand)
setInterval(async () => {
  for (const [id, e] of rooms) if (!e.clients.size && Date.now() - e.idleSince > 15 * 60 * 1000) { await saveNow(id, e); rooms.delete(id); }
}, 60 * 1000);

// ---------- http ----------
function readJson(req) {
  return new Promise((res, rej) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } }); });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); res.end(html()); return;
    }
    if (req.method === 'GET' && url.pathname === '/core.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(fs.readFileSync(path.join(__dirname, 'public', 'core.js'))); return;
    }
    if (req.method === 'GET' && url.pathname === '/healthz') { res.writeHead(200); res.end('ok'); return; }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      try { storeStatus = await store.check(); } catch (e) { storeStatus = { ok: false, detail: explain(e) }; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ store: store.kind, ok: storeStatus.ok, detail: storeStatus.detail, roomsInMemory: rooms.size }, null, 2)); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const body = await readJson(req);
      const room = core.newRoom(String(body.name || '').slice(0, 60) || '新しい部屋');
      room.id = randomId('r');
      const gmKey = randomId('k', 24);
      const entry = { room, gmKeyHash: sha(gmKey), seatKeyHashes: {}, clients: new Set(), seq: 0, saveTimer: null, idleSince: Date.now() };
      const { logs, ...rest } = room;
      try { await store.saveRoom(room.id, JSON.stringify(rest), { name: room.name, gmKeyHash: entry.gmKeyHash, seatKeyHashes: {} }); }
      catch (e) { console.error('create failed', e); res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: '部屋を保存できませんでした：' + explain(e) })); return; }
      rooms.set(room.id, entry);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: room.id, gmKey, name: room.name })); return;
    }
    res.writeHead(404); res.end('not found');
  } catch (e) { console.error(e); res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: explain(e) })); }
});

// ---------- websocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 });
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
// Seats: GM needs the GM key. A PC seat needs that character's seat key (issued to whoever imported it).
// A PC created before seat keys existed is claimed by the first person who sits in it.
function issueSeatKey(entry, cid, conn) {
  const key = randomId('s', 24);
  entry.seatKeyHashes[cid] = sha(key);
  saveSoon(entry.room.id, entry);
  send(conn.ws, { t: 'seatKey', room: entry.room.id, cid, key });
  return key;
}
function seatFor(entry, seat, gmKey, seatKey, conn) {
  if (seat === 'gm') return gmKey && sha(gmKey) === entry.gmKeyHash ? { seat: 'gm' } : { seat: 'obs', why: 'GMキーが違うため、観戦で入りました' };
  if (seat && core.isPcSeat(entry.room, seat)) {
    const h = entry.seatKeyHashes[seat];
    if (!h) { issueSeatKey(entry, seat, conn); return { seat }; }
    if (seatKey && sha(seatKey) === h) return { seat };
    return { seat: 'obs', why: 'このキャラの席の鍵がないため、観戦で入りました。持ち主かGMに「席のリンク」をもらってください' };
  }
  return { seat: 'obs' };
}
function sendState(conn) {
  const { room } = conn.entry;
  send(conn.ws, { t: 'state', seat: conn.seat, room: core.viewRoom(room, conn.seat), locked: Object.keys(conn.entry.seatKeyHashes) });
}
function sendJoined(conn) {
  const { room } = conn.entry;
  send(conn.ws, { t: 'joined', seat: conn.seat, room: core.viewRoom(room, conn.seat), locked: Object.keys(conn.entry.seatKeyHashes),
    logs: room.logs.map(l => core.viewLog(room, l, conn.seat)).filter(Boolean) });
}
function broadcast(entry, diff) {
  const { room } = entry;
  for (const conn of entry.clients) {
    // a PC seat whose character left falls back to spectating
    if (conn.seat !== 'gm' && conn.seat !== 'obs' && !core.isPcSeat(room, conn.seat)) conn.seat = 'obs';
    sendState(conn);
    if (diff.reset) { send(conn.ws, { t: 'logs', room: room.id, reset: true, add: room.logs.map(l => core.viewLog(room, l, conn.seat)).filter(Boolean) }); continue; }
    const v = l => core.viewLog(room, l, conn.seat);
    const add = diff.added.map(v).filter(Boolean), update = diff.updated.map(v).filter(Boolean);
    if (add.length || update.length || diff.removed.length) send(conn.ws, { t: 'logs', room: room.id, add, update, remove: diff.removed });
  }
}
async function handleAct(conn, a) {
  const entry = conn.entry; if (!entry) return send(conn.ws, { t: 'error', message: '部屋に入っていません' });
  if (!a || typeof a !== 'object' || typeof a.type !== 'string') return;
  delete a.by;
  const room = entry.room;
  const tail = new Map(room.logs.slice(-6).map(l => [l.id, JSON.stringify(l)]));
  const allIds = a.type === 'removeTab' ? new Set(room.logs.map(l => l.id)) : null;
  let ret;
  try { ret = core.apply(room, a, conn.seat); }
  catch (e) {
    if (e instanceof core.ActionError || (e && e.message)) return send(conn.ws, { t: 'error', message: e.message || '操作できませんでした' });
    throw e;
  }
  const added = room.logs.filter(l => l.n == null);
  added.forEach(l => { l.n = ++entry.seq; });
  const updated = [], removed = [];
  for (const [id, js] of tail) {
    const now = room.logs.find(l => l.id === id);
    if (!now) removed.push(id); else if (JSON.stringify(now) !== js) updated.push(now);
  }
  let deleted = removed;
  if (allIds) { const still = new Set(room.logs.map(l => l.id)); deleted = [...allIds].filter(id => !still.has(id)); }
  if (a.type === 'addChar' && a.side === 'pc' && typeof ret === 'string') {
    issueSeatKey(entry, ret, conn);                       // whoever imported the PC holds its seat key
    if (conn.seat === 'obs') conn.seat = ret;              // a spectator who imports a PC sits in it
  }
  if (a.type === 'removeChar') delete entry.seatKeyHashes[a.cid];
  broadcast(entry, { added, updated, removed, reset: !!allIds });
  saveSoon(room.id, entry);
  const put = [...added, ...updated];
  if (put.length) store.putLogs(room.id, put).catch(e => console.error('log save failed', e.message));
  if (deleted.length) store.deleteLogs(room.id, deleted).catch(e => console.error('log delete failed', e.message));
}
wss.on('connection', ws => {
  const conn = { ws, entry: null, seat: 'obs', alive: true };
  ws.on('pong', () => { conn.alive = true; });
  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    try {
      if (m.t === 'join') {
        const entry = await getRoom(String(m.room || ''));
        if (!entry) return send(ws, { t: 'error', code: 'not_found', message: 'この部屋は見つかりません' });
        if (conn.entry && conn.entry !== entry) { conn.entry.clients.delete(conn); if (!conn.entry.clients.size) conn.entry.idleSince = Date.now(); }
        conn.entry = entry; entry.clients.add(conn);
        const r = seatFor(entry, m.seat, m.gmKey, m.seatKey, conn);
        conn.seat = r.seat;
        if (r.why) send(ws, { t: 'error', message: r.why });
        sendJoined(conn);
      } else if (m.t === 'act') await handleAct(conn, m.a);
      else if (m.t === 'reissueSeat') {
        // GM: make a new seat key for a PC (lost device / hand-over). Old key holders drop to spectating.
        const entry = conn.entry;
        if (!entry || conn.seat !== 'gm' || !core.isPcSeat(entry.room, m.cid)) return send(ws, { t: 'error', message: '席の鍵を作り直せるのはGMだけです' });
        issueSeatKey(entry, m.cid, conn);
        for (const c of entry.clients) if (c !== conn && c.seat === m.cid) { c.seat = 'obs'; send(c.ws, { t: 'error', message: 'GMが席の鍵を作り直したため、観戦に戻りました' }); sendJoined(c); }
        send(ws, { t: 'reissued', cid: m.cid });
      }
    } catch (e) { console.error('ws handler error:', m && m.t, e); send(ws, { t: 'error', message: 'サーバーでエラーが起きました：' + explain(e) }); }
  });
  ws.on('close', () => { if (conn.entry) { conn.entry.clients.delete(conn); if (!conn.entry.clients.size) conn.entry.idleSince = Date.now(); } });
});
setInterval(() => { for (const ws of wss.clients) { if (ws._pwDead) { ws.terminate(); continue; } ws._pwDead = true; ws.ping(); } }, 30000);
wss.on('connection', ws => ws.on('pong', () => { ws._pwDead = false; }));

// save everything before Render stops the instance
async function shutdown() { for (const [id, e] of rooms) await saveNow(id, e); process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

server.listen(PORT, () => console.log(`pw-room server on :${PORT} (store: ${store.kind})`));
