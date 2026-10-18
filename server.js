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

// ---------- BGM: the GM's uploaded file lives in memory only (never stored) ----------
const BGM_MAX = 20 * 1024 * 1024;
const bgmInfo = e => ({ name: e.bgm.name, token: e.bgm.token, loop: e.bgm.loop, at: e.bgm.at });
function readRaw(req, max) {
  return new Promise((res, rej) => { const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > max) { rej(new Error('too_big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => res(Buffer.concat(chunks))); req.on('error', rej); });
}

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
    if (req.method === 'POST' && url.pathname === '/api/bgm') {
      const entry = rooms.get(String(url.searchParams.get('room') || ''));
      if (!entry || sha(req.headers['x-gm-key'] || '') !== entry.gmKeyHash) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'BGMを流せるのはGMだけです' })); return; }
      let buf; try { buf = await readRaw(req, BGM_MAX); } catch (e) { res.writeHead(413, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'ファイルが大きすぎます（20MBまで）' })); return; }
      const type = String(req.headers['content-type'] || '');
      if (!/^audio\//.test(type)) { res.writeHead(415, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: '音声ファイルを選んでください' })); return; }
      entry.bgm = { buf, type, name: decodeURIComponent(String(req.headers['x-name'] || 'BGM')).slice(0, 80), token: randomId('b', 12), loop: true, at: Date.now() };
      for (const c of entry.clients) send(c.ws, { t: 'bgm', bgm: bgmInfo(entry) });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return;
    }
    const bm = url.pathname.match(/^\/api\/bgm\/([a-z0-9]+)\/([a-z0-9]+)$/);
    if (req.method === 'GET' && bm) {
      const entry = rooms.get(bm[1]);
      if (!entry || !entry.bgm || entry.bgm.token !== bm[2]) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': entry.bgm.type, 'content-length': entry.bgm.buf.length, 'cache-control': 'private, max-age=3600' });
      res.end(entry.bgm.buf); return;
    }
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
  const isGm = !!gmKey && sha(gmKey) === entry.gmKeyHash;
  if (seat === 'gm') return isGm ? { seat: 'gm' } : { seat: 'obs', why: 'GMキーが違うため、観戦で入りました' };
  if (seat && core.isPcSeat(entry.room, seat)) {
    const ch = entry.room.chars[seat];
    // the GM may sit in characters it still holds, never in a player's
    if (isGm) return core.gmOwned(ch) ? { seat } : { seat: 'gm', why: 'GMはPLのキャラの席には座れません' };
    const h = entry.seatKeyHashes[seat];
    if (!h) {
      if (core.gmOwned(ch)) return { seat: 'obs', why: 'GMのキャラです。GMから席のリンクをもらってください' };
      issueSeatKey(entry, seat, conn); return { seat };
    }
    if (seatKey && sha(seatKey) === h) {
      // a player opening the seat link of a GM-held character takes it over
      if (core.gmOwned(ch)) { ch.owner = ch.id; entry.ownerChanged = true; saveSoon(entry.room.id, entry); }
      return { seat };
    }
    return { seat: 'obs', why: 'このキャラの席の鍵がないため、観戦で入りました。持ち主かGMに「席のリンク」をもらってください' };
  }
  return { seat: 'obs' };
}
function sendState(conn) {
  const { room } = conn.entry;
  const v = core.viewRoom(room, conn.seat, conn.pid);
  conn.sentDv = conn.sentDv || {};
  for (const [cid, ch] of Object.entries(v.chars)) {
    if (conn.sentDv[cid] === ch.dv) delete ch.data;      // the browser keeps the sheet it already has
    else conn.sentDv[cid] = ch.dv;
  }
  send(conn.ws, { t: 'state', seat: conn.seat, room: v, locked: Object.keys(conn.entry.seatKeyHashes) });
}
const JOIN_LOGS = 1000;   // older lines stay in the store; the room opens with the most recent ones
function sendJoined(conn) {
  const { room } = conn.entry;
  conn.sentDv = Object.fromEntries(Object.values(room.chars).map(c => [c.id, c.dv]));
  const logs = room.logs.map(l => core.viewLog(room, l, conn.seat, conn.pid)).filter(Boolean);
  send(conn.ws, { t: 'joined', seat: conn.seat, pid: conn.pid, room: core.viewRoom(room, conn.seat, conn.pid), locked: Object.keys(conn.entry.seatKeyHashes),
    logs: logs.slice(-JOIN_LOGS), olderLogs: Math.max(0, logs.length - JOIN_LOGS) });
  if (conn.entry.bgm) send(conn.ws, { t: 'bgm', bgm: bgmInfo(conn.entry) });
}
function broadcast(entry, diff) {
  const { room } = entry;
  for (const conn of entry.clients) {
    // a PC seat whose character left falls back to spectating
    if (conn.seat !== 'gm' && conn.seat !== 'obs' && !core.isPcSeat(room, conn.seat)) conn.seat = 'obs';
    sendState(conn);
    if (diff.reset) { send(conn.ws, { t: 'logs', room: room.id, reset: true, add: room.logs.map(l => core.viewLog(room, l, conn.seat, conn.pid)).filter(Boolean) }); continue; }
    const v = l => core.viewLog(room, l, conn.seat, conn.pid);
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
  try { ret = core.apply(room, a, conn.seat, conn.pid); }
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
  if (a.type === 'editSay') { const l = room.logs.find(x => x.id === a.id); if (l && !updated.includes(l)) updated.push(l); }
  let deleted = removed;
  if (allIds) { const still = new Set(room.logs.map(l => l.id)); deleted = [...allIds].filter(id => !still.has(id)); }
  if (a.type === 'addChar' && (a.side === 'pc' || a.side === 'npc') && typeof ret === 'string') {
    issueSeatKey(entry, ret, conn);                       // whoever imported the PC holds its seat key
    if (conn.seat === 'obs') conn.seat = ret;              // a spectator who imports a PC sits in it
  }
  if (a.type === 'removeChar') delete entry.seatKeyHashes[a.cid];
  const reset = !!allIds || a.type === 'editTab' || a.type === 'addTab';
  broadcast(entry, { added, updated, removed, reset });
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
        // the person behind the connection: a browser-made id plus a display name
        const p = m.player || {};
        conn.pid = typeof p.id === 'string' && /^p[0-9a-z]{8,40}$/.test(p.id) ? p.id : randomId('p', 16);
        conn.isGm = !!m.gmKey && sha(m.gmKey) === entry.gmKeyHash;
        const pname = String(p.name || '').trim().slice(0, 20);
        const players = entry.room.players = entry.room.players || {};
        const nameChanged = pname && (!players[conn.pid] || players[conn.pid].name !== pname);
        if (nameChanged) { players[conn.pid] = { name: pname }; saveSoon(entry.room.id, entry); }
        const r = seatFor(entry, m.seat, m.gmKey, m.seatKey, conn);
        conn.seat = r.seat;
        if (r.why) send(ws, { t: 'error', message: r.why });
        sendJoined(conn);
        if (nameChanged) for (const c of entry.clients) if (c !== conn) sendState(c);
        if (entry.ownerChanged) {
          entry.ownerChanged = false;
          for (const c of entry.clients) if (c !== conn) {
            if (c.seat === m.seat && c.seat !== 'obs') { c.seat = 'gm'; send(c.ws, { t: 'error', message: `${entry.room.chars[m.seat].data.name}はPLに渡りました` }); }
            sendState(c);
          }
        }
      } else if (m.t === 'act') await handleAct(conn, m.a);
      else if (m.t === 'typing') {
        // "○○が入力中…": relayed (not stored) to people who can see that tab, at most once a second
        const entry = conn.entry; if (!entry) return;
        const now = Date.now(); if (now - (conn.lastTyping || 0) < 1000) return; conn.lastTyping = now;
        const tab = entry.room.tabs.find(t => t.id === m.tab); if (!tab) return;
        const name = (entry.room.players[conn.pid] || {}).name || '誰か';
        for (const c of entry.clients) if (c !== conn && core.canSeeTab(entry.room, tab, c.seat, c.pid)) send(c.ws, { t: 'typing', tab: tab.id, name, pid: conn.pid });
      }
      else if (m.t === 'bgmStop' || m.t === 'bgmLoop') {
        const entry = conn.entry; if (!entry || !conn.isGm) return send(ws, { t: 'error', message: 'BGMを操作できるのはGMだけです' });
        if (m.t === 'bgmStop') entry.bgm = null; else if (entry.bgm) entry.bgm.loop = !!m.loop;
        for (const c of entry.clients) send(c.ws, { t: 'bgm', bgm: entry.bgm ? bgmInfo(entry) : null });
      }
      else if (m.t === 'reissueSeat') {
        // GM: make a new seat key for a PC (lost device / hand-over). Old key holders drop to spectating.
        const entry = conn.entry;
        if (!entry || conn.seat !== 'gm' || !core.isPcSeat(entry.room, m.cid)) return send(ws, { t: 'error', message: '席の鍵を作り直せるのはGMだけです' });
        issueSeatKey(entry, m.cid, conn);
        entry.room.chars[m.cid].owner = 'gm';          // back in the GM's hands until someone opens the new link
        for (const c of entry.clients) sendState(c);
        saveSoon(entry.room.id, entry);
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
