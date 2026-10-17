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
const CREATE_PASSWORD = process.env.CREATE_PASSWORD || '';   // optional: required to create rooms
const store = createStore();
const sha = s => nodeCrypto.createHash('sha256').update(String(s)).digest('hex');
const randomId = (p, n = 14) => p + nodeCrypto.randomBytes(16).toString('base64url').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, n);
const html = () => fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8').replace('<!--PW_ONLINE-->', '<script>window.PW_ONLINE = true;</script>');

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
    const entry = { room, gmKeyHash: got.gmKeyHash, clients: new Set(), seq: room.logs.reduce((m, l) => Math.max(m, l.n || 0), 0), saveTimer: null, idleSince: Date.now() };
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
  try { await store.saveRoom(id, JSON.stringify(rest), { name: entry.room.name, gmKeyHash: entry.gmKeyHash }); }
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
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const body = await readJson(req);
      if (CREATE_PASSWORD && body.password !== CREATE_PASSWORD) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: '部屋を作る合言葉が違います' })); return; }
      const room = core.newRoom(String(body.name || '').slice(0, 60) || '新しい部屋');
      room.id = randomId('r');
      const gmKey = randomId('k', 24);
      const entry = { room, gmKeyHash: sha(gmKey), clients: new Set(), seq: 0, saveTimer: null, idleSince: Date.now() };
      rooms.set(room.id, entry);
      await saveNow(room.id, entry);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: room.id, gmKey, name: room.name })); return;
    }
    res.writeHead(404); res.end('not found');
  } catch (e) { console.error(e); res.writeHead(500); res.end('error'); }
});

// ---------- websocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 });
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
function seatFor(entry, seat, gmKey) {
  if (seat === 'gm') return gmKey && sha(gmKey) === entry.gmKeyHash ? 'gm' : 'obs';
  if (seat && core.isPcSeat(entry.room, seat)) return seat;
  return 'obs';
}
function sendJoined(conn) {
  const { room } = conn.entry;
  send(conn.ws, { t: 'joined', seat: conn.seat, room: core.viewRoom(room, conn.seat),
    logs: room.logs.map(l => core.viewLog(room, l, conn.seat)).filter(Boolean) });
}
function broadcast(entry, diff) {
  const { room } = entry;
  for (const conn of entry.clients) {
    // a PC seat whose character left falls back to spectating
    if (conn.seat !== 'gm' && conn.seat !== 'obs' && !core.isPcSeat(room, conn.seat)) conn.seat = 'obs';
    send(conn.ws, { t: 'state', seat: conn.seat, room: core.viewRoom(room, conn.seat) });
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
  try { core.apply(room, a, conn.seat); }
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
        conn.seat = seatFor(entry, m.seat, m.gmKey);
        if (m.seat === 'gm' && conn.seat !== 'gm') send(ws, { t: 'error', message: 'GMキーが違うため、観戦で入りました' });
        sendJoined(conn);
      } else if (m.t === 'act') await handleAct(conn, m.a);
    } catch (e) { console.error(e); send(ws, { t: 'error', message: 'サーバーでエラーが起きました' }); }
  });
  ws.on('close', () => { if (conn.entry) { conn.entry.clients.delete(conn); if (!conn.entry.clients.size) conn.entry.idleSince = Date.now(); } });
});
setInterval(() => { for (const ws of wss.clients) { if (ws._pwDead) { ws.terminate(); continue; } ws._pwDead = true; ws.ping(); } }, 30000);
wss.on('connection', ws => ws.on('pong', () => { ws._pwDead = false; }));

// save everything before Render stops the instance
async function shutdown() { for (const [id, e] of rooms) await saveNow(id, e); process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

server.listen(PORT, () => console.log(`pw-room server on :${PORT} (store: ${store.kind})`));
