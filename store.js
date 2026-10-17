'use strict';
// Persistence. Firestore when FIREBASE_SERVICE_ACCOUNT is set, otherwise memory (for local testing only).
// Layout: groups/<GROUP_ID>/pwrooms/<roomId> { json, name, gmKeyHash, updatedAt }
//         groups/<GROUP_ID>/pwrooms/<roomId>/logs/<logId> { n, tab, json }
const MAX_LOGS = 5000;

function memoryStore() {
  const rooms = new Map();
  return {
    kind: 'memory',
    async load(id) {
      const r = rooms.get(id); if (!r) return null;
      const room = JSON.parse(r.json);
      room.logs = [...r.logs.values()].sort((a, b) => a.n - b.n).slice(-MAX_LOGS).map(x => JSON.parse(x.json));
      return { room, gmKeyHash: r.gmKeyHash };
    },
    async saveRoom(id, json, meta) {
      const r = rooms.get(id) || { logs: new Map() };
      Object.assign(r, { json, ...meta }); rooms.set(id, r);
    },
    async putLogs(id, logs) { const r = rooms.get(id); if (!r) return; for (const l of logs) r.logs.set(l.id, { n: l.n, tab: l.tab, json: JSON.stringify(l) }); },
    async deleteLogs(id, ids) { const r = rooms.get(id); if (!r) return; ids.forEach(x => r.logs.delete(x)); },
  };
}

function firestoreStore() {
  const { initializeApp, cert } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const app = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = process.env.FIRESTORE_DATABASE_ID ? getFirestore(app, process.env.FIRESTORE_DATABASE_ID) : getFirestore(app);
  const base = db.collection('groups').doc(process.env.GROUP_ID || 'default').collection('pwrooms');
  const inChunks = async (items, fn) => { for (let i = 0; i < items.length; i += 400) { const b = db.batch(); items.slice(i, i + 400).forEach(x => fn(b, x)); await b.commit(); } };
  return {
    kind: 'firestore',
    async load(id) {
      const doc = await base.doc(id).get();
      if (!doc.exists) return null;
      const d = doc.data();
      const snap = await base.doc(id).collection('logs').orderBy('n', 'desc').limit(MAX_LOGS).get();
      const room = JSON.parse(d.json);
      room.logs = snap.docs.map(x => JSON.parse(x.data().json)).reverse();
      return { room, gmKeyHash: d.gmKeyHash };
    },
    async saveRoom(id, json, meta) { await base.doc(id).set({ json, ...meta, updatedAt: Date.now() }); },
    async putLogs(id, logs) { await inChunks(logs, (b, l) => b.set(base.doc(id).collection('logs').doc(l.id), { n: l.n, tab: l.tab, json: JSON.stringify(l) })); },
    async deleteLogs(id, ids) { await inChunks(ids, (b, x) => b.delete(base.doc(id).collection('logs').doc(x))); },
  };
}

module.exports = { createStore: () => process.env.FIREBASE_SERVICE_ACCOUNT ? firestoreStore() : memoryStore() };
