'use strict';
// =====================================================================
// core: state, actions, visibility
// Everything that changes a room goes through apply(room, action, by).
// Everything a viewer may see goes through the view* functions.
// When moving to a server, these two parts move there unchanged.
// =====================================================================
const SUIT = { S: '♠', C: '♣', H: '♥', D: '♦' };
const RANK = r => ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }[r] || String(r));
const KIND = { attack: '攻撃', evade: '回避', other: 'その他' };
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clone = o => JSON.parse(JSON.stringify(o));

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// copy 1 uses plain ids (S7); extra decks get a suffix (S7#2) so every card stays unique
function newDeck(jokers, copies = 1) {
  const d = [];
  for (let k = 1; k <= copies; k++) {
    const tag = k === 1 ? '' : '#' + k;
    for (const s of 'SCHD') for (let r = 1; r <= 13; r++) d.push(s + r + tag);
    for (let i = 1; i <= jokers; i++) d.push('X' + i + tag);
  }
  return shuffle(d);
}
const cardOf = c => c[0] === 'X' ? { joker: true } : { s: c[0], r: parseInt(c.slice(1), 10) };
const cardText = c => { const k = cardOf(c); return k.joker ? 'JOKER' : SUIT[k.s] + RANK(k.r); };
function sortCards(cards, mode) {
  const so = { S: 0, C: 1, H: 2, D: 3 };
  return [...cards].sort((a, b) => {
    const x = cardOf(a), y = cardOf(b);
    if (x.joker || y.joker) return (x.joker ? 1 : 0) - (y.joker ? 1 : 0) || a.localeCompare(b);
    return mode === 'rank' ? (x.r - y.r || so[x.s] - so[y.s]) : (so[x.s] - so[y.s] || x.r - y.r);
  });
}

// Dropbox share link -> direct image link
function toDirectImage(url) {
  const s = (url || '').trim();
  try {
    const u = new URL(s);
    if (/(^|\.)dropbox\.com$/.test(u.hostname)) { u.searchParams.delete('dl'); u.searchParams.set('raw', '1'); }
    return u.toString();
  } catch (e) { return s; }
}

// ----- character import format (pw-character v2, v1 also accepted) -----
const SLOT_SUITS = ['S', 'C', 'H', 'D'];
// name colours chosen to stay readable on the black chat
const NAME_COLORS = ['#5DADEC', '#FF6B9A', '#4FD1A5', '#FFB547', '#B48CFF', '#7C8CFF', '#FF8A5C', '#E6E66A', '#FF7A7A', '#FFFFFF', '#9BE15D', '#F28CD8'];
const isHex = s => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);
const STAT_KEYS = ['HP', 'TP', 'SS値', '移動値'];
function normalizeChar(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('JSONの形になっていません');
  if (raw.format && raw.format !== 'pw-character') throw new Error(`形式が違います（${raw.format}）`);
  if (!raw.name || typeof raw.name !== 'string') throw new Error('name（キャラクター名）がありません');
  const item = x => ({ name: String(x?.name || ''), attrs: x?.attrs && typeof x.attrs === 'object' ? x.attrs : {}, text: String(x?.text || '') });
  // values: {HP:{max:20}} / {SS値:{value:3}} / {HP:20} (shorthand = max for HP/TP, value otherwise)
  const stats = {};
  for (const [k, v] of Object.entries(raw.values || {})) {
    if (v && typeof v === 'object') {
      if (Number.isFinite(Number(v.max))) stats[k] = { max: Number(v.max) };
      else if (Number.isFinite(Number(v.value))) stats[k] = { value: Number(v.value) };
    } else if (Number.isFinite(Number(v))) stats[k] = (k === 'HP' || k === 'TP') ? { max: Number(v) } : { value: Number(v) };
  }
  // weapons: {common:[2], slots:[4 by suit]}; a v1 array becomes common weapons
  const w = raw.weapons;
  const slotsFrom = arr => {
    const out = SLOT_SUITS.map(s => ({ suit: s, ...item(null) }));
    (Array.isArray(arr) ? arr : []).forEach((x, i) => {
      const s = SLOT_SUITS.includes(x?.suit) ? x.suit : SLOT_SUITS[i];
      if (s) out[SLOT_SUITS.indexOf(s)] = { suit: s, ...item(x) };
    });
    return out;
  };
  const weapons = Array.isArray(w) ? { common: w.map(item), slots: slotsFrom([]) }
    : { common: Array.isArray(w?.common) ? w.common.map(item) : [], slots: slotsFrom(w?.slots) };
  // 特殊機能 may sit in core.functions or at the top level (functions)
  const fnSrc = Array.isArray(raw.core?.functions) ? raw.core.functions : Array.isArray(raw.functions) ? raw.functions : [];
  const core = raw.core || fnSrc.length ? { ...item(raw.core || { name: '' }), functions: fnSrc.map(item) } : null;
  return {
    format: 'pw-character', version: 2,
    name: raw.name, player: String(raw.player || ''),
    core, stats,
    // tp: TP consumed when the 特技 is used (cost is accepted as an older name)
    skills: Array.isArray(raw.skills) ? raw.skills.map(x => { const t = x?.tp ?? x?.cost; return { ...item(x), tp: t != null && Number.isFinite(Number(t)) ? Number(t) : null }; }) : [],
    weapons,
    variations: Array.isArray(raw.variations) ? raw.variations.map(v => ({ name: String(v?.name || 'バリエーション'), slots: slotsFrom(v?.slots) })) : [],
    wingDrive: raw.wingDrive ? item(raw.wingDrive) : null,
    portraits: Array.isArray(raw.portraits) ? raw.portraits.filter(p => p && p.url).map(p => ({ label: String(p.label || '立ち絵'), url: toDirectImage(p.url) })) : [],
    memo: String(raw.memo || ''),
  };
}
const statStart = s => s.max ?? s.value;
const currentSlots = ch => ch.variation >= 0 && ch.data.variations[ch.variation] ? ch.data.variations[ch.variation].slots : ch.data.weapons.slots;
const ssOf = ch => Number.isFinite(ch.cur['SS値']) ? ch.cur['SS値'] : (ch.data.stats['SS値'] ? statStart(ch.data.stats['SS値']) : -Infinity);
// turn order: SS値 high -> low; ties: PC before enemy, then join order
function turnOrder(room) {
  return Object.values(room.chars).filter(c => c.side !== 'npc')
    .map((c, i) => ({ c, i }))
    .sort((a, b) => ssOf(b.c) - ssOf(a.c) || (a.c.side === 'pc' ? 0 : 1) - (b.c.side === 'pc' ? 0 : 1) || a.i - b.i)
    .map(x => x.c);
}

function newRoom(name) {
  return {
    id: uid('r'), name: name || '新しい部屋', createdAt: Date.now(),
    settings: { jokers: 2, decks: 1, opsTab: 'battle', digestTab: 'main', gmSeesSecret: true, logValues: true },
    turn: { round: 1, current: null },
    chars: {},
    cards: { deck: newDeck(2), discard: [], hands: { gm: [] } },
    tabs: [
      { id: 'main', name: 'メイン' },
      { id: 'battle', name: '戦闘' },
      { id: 'chat', name: '雑談' },
    ],
    logs: [],
  };
}

// seats: 'gm', each PC character id, 'obs'
const isPcSeat = (room, seat) => !!(room.chars[seat] && room.chars[seat].side === 'pc');
function seatName(room, seat) {
  if (seat === 'gm') return 'GM';
  if (seat === 'obs') return '観戦';
  return room.chars[seat]?.data.name || '（不明）';
}
function canControlChar(room, seat, cid) { return seat === 'gm' || seat === cid; }

class ActionError extends Error {}
function need(cond, msg) { if (!cond) throw new ActionError(msg); }

function log(room, entry) {
  // names are stored at the time of logging, so old logs stay readable after a character leaves
  const extra = { byName: seatName(room, entry.by) };
  if (entry.seat) extra.seatName = seatName(room, entry.seat);
  room.logs.push({ id: uid('l'), t: Date.now(), ...extra, ...entry });
  if (room.logs.length > 5000) room.logs.splice(0, room.logs.length - 5000);
}
// essentials (HP/TP changes, cards played, variation switches) also appear in the digest tab (メイン)
function isImportant(l) {
  if (l.type === 'play' || l.type === 'variation' || l.type === 'weapon') return true;
  if (l.type === 'value') return l.key === 'HP' || l.key === 'TP' || /の(HP|TP)：/.test(l.text || '');
  return false;
}
const digestTab = room => room.tabs.some(t => t.id === room.settings.digestTab) ? room.settings.digestTab : null;
function logsForTab(room, tabId) {
  const ops = opsTab(room), dg = digestTab(room);
  if (tabId === dg && dg !== ops) return room.logs.filter(l => l.tab === tabId || (l.tab === ops && isImportant(l)));
  return room.logs.filter(l => l.tab === tabId);
}
const opsTab = room => room.tabs.some(t => t.id === room.settings.opsTab) ? room.settings.opsTab : room.tabs[0].id;

function apply(room, a, by) {
  const name = seatName(room, by);
  const ch = a.cid ? room.chars[a.cid] : null;
  switch (a.type) {
    // ----- characters -----
    case 'addChar': {
      need(by === 'gm' || a.side === 'pc', '敵やNPCを追加できるのはGMだけです');
      const data = normalizeChar(a.data);
      const id = typeof a.id === 'string' && /^c[0-9a-z]{6,30}$/.test(a.id) && !room.chars[a.id] ? a.id : uid('c');
      const cur = {}; for (const [k, s] of Object.entries(data.stats)) cur[k] = statStart(s);
      const colors = NAME_COLORS.slice(0, 8);
      room.chars[id] = { id, side: a.side, data, dv: 1, cur, used: {}, variation: -1, x: null, y: null, portrait: data.portraits[0]?.label || null,
        color: a.side === 'enemy' ? '#FF7A7A' : colors[Object.keys(room.chars).filter(k => room.chars[k].side !== 'enemy').length % colors.length], owner: by };
      if (a.side === 'pc') room.cards.hands[id] = room.cards.hands[id] || [];
      log(room, { tab: opsTab(room), type: 'sys', by, text: `${data.name}（${{ pc: 'PC', enemy: '敵', npc: 'NPC' }[a.side]}）が参加しました` });
      return id;
    }
    case 'updateCharData': {
      need(ch && canControlChar(room, by, a.cid), 'このキャラクターは編集できません');
      const data = normalizeChar(a.data);
      for (const [k, s] of Object.entries(data.stats)) if (!(k in ch.cur)) ch.cur[k] = statStart(s);
      ch.data = data; ch.dv = (ch.dv || 1) + 1;
      if (!(ch.variation < data.variations.length)) ch.variation = -1;
      if (ch.portrait && !data.portraits.some(p => p.label === ch.portrait)) ch.portrait = data.portraits[0]?.label || null;
      log(room, { tab: opsTab(room), type: 'sys', by, text: `${data.name}のデータを更新しました` });
      return;
    }
    case 'removeChar': {
      need(ch && (by === 'gm' || by === a.cid), 'このキャラクターは削除できません');
      const hand = room.cards.hands[a.cid] || [];
      room.cards.discard.push(...hand);
      delete room.cards.hands[a.cid];
      delete room.chars[a.cid];
      if (room.turn.current === a.cid) room.turn.current = null;
      log(room, { tab: opsTab(room), type: 'sys', by, text: `${ch.data.name}が退出しました${hand.length ? `（手札${hand.length}枚は捨て札へ）` : ''}` });
      return;
    }
    case 'setValue': {
      need(ch && canControlChar(room, by, a.cid), 'このキャラクターの値は変えられません');
      const before = ch.cur[a.key];
      const v = Number(a.value);
      need(Number.isFinite(v), '数値を入れてください');
      if (before === v) return;
      ch.cur[a.key] = v;
      if (room.settings.logValues === false) return;
      // repeated +/- on the same value within a few seconds are folded into one log line (20 → 14)
      const last = room.logs[room.logs.length - 1];
      if (last && last.type === 'value' && !last.cmd && last.cid === a.cid && last.key === a.key && last.by === by && Date.now() - last.t < 8000) {
        if (last.from === v) room.logs.pop();
        else { last.to = v; last.t = Date.now(); last.text = `${ch.data.name}の${a.key}：${last.from} → ${v}`; }
        return;
      }
      log(room, { tab: opsTab(room), type: 'value', by, cid: a.cid, key: a.key, from: before, to: v, text: `${ch.data.name}の${a.key}：${before} → ${v}` });
      return;
    }
    case 'toggleUsed': {
      need(ch && canControlChar(room, by, a.cid), 'このキャラクターは操作できません');
      const k = `${a.group}:${a.idx}`;
      ch.used[k] = !ch.used[k];
      const it = a.group === 'wingDrive' ? ch.data.wingDrive : a.group === 'common' ? ch.data.weapons.common[a.idx]
        : a.group.startsWith('slot') ? currentSlots(ch)[a.idx] : a.group === 'func' ? ch.data.core?.functions[a.idx] : ch.data[a.group]?.[a.idx];
      log(room, { tab: opsTab(room), type: 'value', by, text: `${ch.data.name}の「${it?.name || '?'}」を${ch.used[k] ? '使用済み' : '未使用'}にしました` });
      return;
    }
    case 'setPortraits': {
      need(ch && canControlChar(room, by, a.cid), 'このキャラクターは編集できません');
      ch.data.portraits = a.portraits.map(p => ({ label: String(p.label || '立ち絵'), url: toDirectImage(p.url) })).filter(p => p.url);
      ch.dv = (ch.dv || 1) + 1;
      if (!ch.data.portraits.some(p => p.label === ch.portrait)) ch.portrait = ch.data.portraits[0]?.label || null;
      return;
    }
    case 'setColor': {
      need(ch && canControlChar(room, by, a.cid), 'このキャラクターの色は変えられません');
      need(isHex(a.color), '色の指定が正しくありません');
      ch.color = a.color.toUpperCase();
      return;
    }
    case 'setPortrait': { need(ch && canControlChar(room, by, a.cid), '操作できません'); ch.portrait = a.label; return; }

    case 'variation': {
      need(ch && canControlChar(room, by, a.cid), 'このキャラクターは操作できません');
      const i = a.idx | 0;
      need(i === -1 || ch.data.variations[i], 'そのバリエーションはありません');
      if (ch.variation === i) return;
      ch.variation = i;
      log(room, { tab: opsTab(room), type: 'variation', by, cid: a.cid, text: `${ch.data.name}の武装を「${i === -1 ? '基本' : ch.data.variations[i].name}」に切り替えました` });
      return;
    }

    // ----- turn -----
    case 'setTurn': {
      need(by === 'gm', '手番を指定できるのはGMだけです');
      need(a.cid === null || room.chars[a.cid], 'キャラクターが見つかりません');
      room.turn.current = a.cid;
      if (a.cid) log(room, { tab: opsTab(room), type: 'turn', by, text: `${room.chars[a.cid].data.name}の手番です` });
      return;
    }
    case 'nextTurn': {
      need(by === 'gm' || by === room.turn.current, '手番を進められるのは、GMか手番のPCだけです');
      const order = turnOrder(room);
      const i = order.findIndex(c => c.id === room.turn.current);
      const next = order[i + 1] || null;
      room.turn.current = next ? next.id : null;
      log(room, { tab: opsTab(room), type: 'turn', by, text: next ? `${next.data.name}の手番です` : '全員の手番が終わりました。ラウンド終了です' });
      return;
    }
    case 'endRound': {
      need(by === 'gm', 'ラウンドを進められるのはGMだけです');
      log(room, { tab: opsTab(room), type: 'round', by, text: `第${room.turn.round}ラウンド終了（手札交換のタイミングです）` });
      room.turn.round += 1;
      room.turn.current = turnOrder(room)[0]?.id || null;
      log(room, { tab: opsTab(room), type: 'round', by, text: `第${room.turn.round}ラウンド開始${room.turn.current ? `：${room.chars[room.turn.current].data.name}の手番です` : ''}` });
      return;
    }
    case 'resetRound': {
      need(by === 'gm', 'ラウンドを戻せるのはGMだけです');
      room.turn = { round: 1, current: turnOrder(room)[0]?.id || null };
      log(room, { tab: opsTab(room), type: 'round', by, text: `戦闘開始：第1ラウンド${room.turn.current ? `、${room.chars[room.turn.current].data.name}の手番です` : ''}` });
      return;
    }

    // ----- map -----
    case 'move': {
      need(ch && canControlChar(room, by, a.cid), 'このコマは動かせません');
      const from = ch.x == null ? '盤外' : coordName(ch.x, ch.y);
      if (a.x == null) { ch.x = ch.y = null; }
      else { need(a.x >= 0 && a.x < 8 && a.y >= 0 && a.y < 8, 'マップの外です'); ch.x = a.x; ch.y = a.y; }
      const to = ch.x == null ? '盤外' : coordName(ch.x, ch.y);
      if (from !== to) log(room, { tab: opsTab(room), type: 'move', by, text: `${ch.data.name}：${from} → ${to}` });
      return;
    }

    // ----- cards -----
    case 'draw': {
      const seat = a.seat || by;
      need(seat === by || by === 'gm', '他の人の手札は操作できません');
      need(seat === 'gm' || isPcSeat(room, seat), 'この席は手札を持てません');
      const n = Math.max(1, Math.min(20, a.n | 0));
      need(room.cards.deck.length >= n, `山札が足りません（残り${room.cards.deck.length}枚）`);
      const got = room.cards.deck.splice(0, n);
      (room.cards.hands[seat] = room.cards.hands[seat] || []).push(...got);
      // a GM draw only shows how many; PC draws are open to the PC side
      log(room, { tab: opsTab(room), type: 'draw', by, seat, n, cards: got, secretCards: seat === 'gm' });
      return;
    }
    case 'play': {
      const seat = a.seat || by;
      need(seat === by || by === 'gm', '他の人の手札は出せません');
      const hand = room.cards.hands[seat] || [];
      need(a.cards.length > 0, 'カードを選んでください');
      need(a.cards.every(c => hand.includes(c)), '手札にないカードが含まれています');
      room.cards.hands[seat] = hand.filter(c => !a.cards.includes(c));
      room.cards.discard.push(...a.cards);
      log(room, { tab: opsTab(room), type: 'play', by, seat, cards: a.cards, kind: a.kind, memo: (a.memo || '').trim(), as: a.as || null });
      return;
    }
    case 'pick': { // pick a card up from the discard pile (card effects)
      const seat = a.seat || by;
      need(seat === by || by === 'gm', '他の人の手札には拾えません');
      need(seat === 'gm' || isPcSeat(room, seat), 'この席は手札を持てません');
      const i = room.cards.discard.lastIndexOf(a.card);
      need(i >= 0, 'そのカードは捨て札にありません');
      room.cards.discard.splice(i, 1);
      (room.cards.hands[seat] = room.cards.hands[seat] || []).push(a.card);
      log(room, { tab: opsTab(room), type: 'pick', by, seat, cards: [a.card], memo: (a.memo || '').trim() });
      return;
    }
    case 'give': { // hand cards to an ally (e.g. end-of-round exchange)
      const seat = a.seat || by;
      need(seat === by || by === 'gm', '他の人の手札は渡せません');
      need(isPcSeat(room, seat) && isPcSeat(room, a.to) && seat !== a.to, '渡せるのは味方のPC同士だけです');
      const hand = room.cards.hands[seat] || [];
      need(a.cards.length && a.cards.every(c => hand.includes(c)), '手札にないカードが含まれています');
      room.cards.hands[seat] = hand.filter(c => !a.cards.includes(c));
      (room.cards.hands[a.to] = room.cards.hands[a.to] || []).push(...a.cards);
      log(room, { tab: opsTab(room), type: 'give', by, seat, to: a.to, toName: seatName(room, a.to), cards: a.cards });
      return;
    }
    case 'useWeapons': { // declare one or more weapons at once, discarding any cards (suits are not enforced)
      need(ch && canControlChar(room, by, a.cid), 'このキャラクターは操作できません');
      const seat = ch.side === 'pc' ? ch.id : 'gm';
      const hand = room.cards.hands[seat] || [];
      const cards = Array.isArray(a.cards) ? a.cards : [];
      need(cards.every(x => hand.includes(x)) && new Set(cards).size === cards.length, '手札にないカードが含まれています');
      const pool = { c: ch.data.weapons.common, s: currentSlots(ch) };
      const ws = (Array.isArray(a.weapons) ? a.weapons : []).map(k => pool[String(k)[0]]?.[+String(k).slice(1)]).filter(w => w && w.name);
      need(ws.length, '武装を選んでください');
      room.cards.hands[seat] = hand.filter(x => !cards.includes(x));
      room.cards.discard.push(...cards);
      log(room, { tab: opsTab(room), type: 'weapon', by, seat, cid: ch.id, charName: ch.data.name,
        weapons: ws.map(w => ({ name: w.name, suit: w.suit || null, attrs: { ...(w.attrs || {}) }, text: w.text || '' })),
        cards, targets: (Array.isArray(a.targets) ? a.targets : []).map(id => room.chars[id]?.data.name).filter(Boolean), memo: String(a.memo || '').trim() });
      return;
    }
    case 'shuffleBack': {
      const n = room.cards.discard.length;
      need(n > 0, '捨て札がありません');
      room.cards.deck = shuffle([...room.cards.deck, ...room.cards.discard]);
      room.cards.discard = [];
      log(room, { tab: opsTab(room), type: 'sys', by, text: `捨て札${n}枚を山札に戻してシャッフルしました（山札${room.cards.deck.length}枚）` });
      return;
    }
    case 'resetDeck': {
      need(by === 'gm', '山札の作り直しはGMだけができます');
      room.cards.deck = newDeck(room.settings.jokers, room.settings.decks || 1);
      room.cards.discard = [];
      for (const k of Object.keys(room.cards.hands)) room.cards.hands[k] = [];
      log(room, { tab: opsTab(room), type: 'sys', by, text: `山札を作り直しました（${room.cards.deck.length}枚、全員の手札は空になりました）` });
      return;
    }
    case 'addDeck': { // more players -> shuffle one more full deck into the draw pile
      need(by === 'gm', '山札の追加はGMだけができます');
      const k = (room.settings.decks || 1) + 1;
      const extra = newDeck(room.settings.jokers, k).filter(id => id.endsWith('#' + k));
      room.settings.decks = k;
      room.cards.deck = shuffle([...room.cards.deck, ...extra]);
      log(room, { tab: opsTab(room), type: 'sys', by, text: `山札にトランプを1組追加してシャッフルしました（${k}組、山札${room.cards.deck.length}枚）` });
      return;
    }
    case 'moveCard': { // GM correction: discard/hand -> hand/discard/deck top
      need(by === 'gm', 'カードの補正はGMだけができます');
      const take = from => {
        const arr = from === 'discard' ? room.cards.discard : room.cards.hands[from];
        need(arr && arr.includes(a.card), 'そのカードは見つかりません');
        arr.splice(arr.indexOf(a.card), 1);
      };
      take(a.from);
      if (a.to === 'discard') room.cards.discard.push(a.card);
      else if (a.to === 'deck') room.cards.deck.unshift(a.card);
      else (room.cards.hands[a.to] = room.cards.hands[a.to] || []).push(a.card);
      const where = s => s === 'discard' ? '捨て札' : s === 'deck' ? '山札の上' : `${seatName(room, s)}の手札`;
      const hidden = a.from === 'gm' || a.to === 'gm' || a.to === 'deck';
      log(room, { tab: opsTab(room), type: 'fix', by, text: `補正：${hidden ? 'カード1枚' : cardText(a.card)}を${where(a.from)}から${where(a.to)}へ移しました` });
      return;
    }

    // ----- chat -----
    case 'say': {
      const tab = room.tabs.find(t => t.id === a.tab);
      need(tab, 'タブが見つかりません');
      need(canSeeTab(room, tab, by), 'このタブには発言できません');
      const text = (a.text || '').trim();
      need(text, '空の発言は送れません');
      if (a.as) need(room.chars[a.as] && canControlChar(room, by, a.as), 'そのキャラクターとしては発言できません');
      // a 特技 command spends its TP automatically; refuse before anything is logged if TP is short
      let tpCh = null;
      if (a.as && Number.isFinite(a.spendTP) && a.spendTP > 0) {
        tpCh = room.chars[a.as];
        need(Number.isFinite(tpCh.cur.TP), 'このキャラクターはTPを持っていません');
        need(tpCh.cur.TP >= a.spendTP, `TPが足りません（現在${tpCh.cur.TP}、必要${a.spendTP}）`);
      }
      const pUrl = a.as ? (room.chars[a.as].data.portraits.find(p => p.label === a.portrait) || {}).url || null : null;
      const dice = parseDice(text);
      const color = a.as ? room.chars[a.as].color : (isHex(a.color) ? a.color : null);
      log(room, { tab: tab.id, type: 'say', by, as: a.as || null, name: a.as ? room.chars[a.as].data.name : (a.name || name), color, portrait: a.portrait || null, portraitUrl: pUrl, text, cmd: a.cmd || null, dice });
      if (tpCh) {
        const before = tpCh.cur.TP;
        tpCh.cur.TP = before - a.spendTP;
        log(room, { tab: opsTab(room), type: 'value', by, cid: tpCh.id, key: 'TP', from: before, to: tpCh.cur.TP, cmd: true, text: `${tpCh.data.name}のTP：${before} → ${tpCh.cur.TP}（${a.cmd || '特技'}）` });
      }
      return;
    }
    case 'editSay': { // fix the text of one's own message later (dice results are never re-rolled)
      const l = room.logs.find(x => x.id === a.id);
      need(l && l.type === 'say', 'その発言は見つかりません');
      need(l.by === by || by === 'gm', '自分の発言だけ編集できます');
      need(!l.dice, 'ダイスの発言は結果が変わってしまうので編集できません');
      const text = String(a.text || '').trim();
      need(text, '空にはできません');
      if (text === l.text) return;
      l.text = text; l.edited = Date.now();
      return;
    }
    case 'addTab': {
      need((a.name || '').trim(), 'タブ名を入れてください');
      const t = { id: typeof a.id === 'string' && /^t[0-9a-z]{6,30}$/.test(a.id) && !room.tabs.some(x => x.id === a.id) ? a.id : uid('t'), name: a.name.trim() };
      if (a.secret) { t.secret = true; t.members = [...new Set([...(a.members || []), by])]; }
      room.tabs.push(t);
      return t.id;
    }
    case 'editTab': {
      const t = room.tabs.find(x => x.id === a.tab); need(t, 'タブが見つかりません');
      need(by === 'gm' || (t.members || []).includes(by), 'このタブは編集できません');
      if (a.name) t.name = a.name.trim();
      if (t.secret && a.members) t.members = [...new Set(a.members)];
      return;
    }
    case 'removeTab': {
      need(by === 'gm', 'タブの削除はGMだけができます');
      need(room.tabs.length > 1, '最後のタブは消せません');
      room.tabs = room.tabs.filter(t => t.id !== a.tab);
      room.logs = room.logs.filter(l => l.tab !== a.tab);
      return;
    }
    case 'settings': {
      need(by === 'gm', '部屋の設定はGMだけが変えられます');
      Object.assign(room.settings, a.patch);
      if ('name' in a) room.name = a.name;
      return;
    }
  }
  throw new ActionError('不明な操作です');
}
// upgrade rooms saved by an older version
function migrateRoom(room) {
  room.turn = room.turn || { round: 1, current: null };
  room.settings.decks = room.settings.decks || 1;
  if (!('digestTab' in room.settings)) room.settings.digestTab = 'main';
  for (const ch of Object.values(room.chars)) {
    if (!ch.data.stats || ch.data.skills.some(s => !('tp' in s))) { try { ch.data = normalizeChar({ ...ch.data, values: ch.data.stats ? Object.fromEntries(Object.entries(ch.data.stats)) : ch.data.values }); } catch (e) {} }
    if (ch.variation == null) ch.variation = -1;
    if (!ch.dv) ch.dv = 1;
  }
  return room;
}
// ----- dice (BCDice-like): 2D6+1>=8 / 1d100<=50 / choice[A,B,C] / S1D6 (secret) -----
// The first word is the command, the rest is a comment. Rolled on the authority side (here: apply()).
function rand(n) { return crypto.getRandomValues(new Uint32Array(1))[0] % n; }
function parseDice(raw) {
  const text = raw.trim();
  const sp = text.search(/\s/);
  let head = (sp < 0 ? text : text.slice(0, sp)).normalize('NFKC');
  let rest = sp < 0 ? '' : text.slice(sp).trim();
  let secret = false;
  if (/^s(?=[\dd(]|choice)/i.test(head)) { secret = true; head = head.slice(1); }
  // choice[A,B,C] / choice(A,B,C) / choice A B C
  let m = head.match(/^choice[\[(](.*)[\])]$/i);
  if (m || /^choice$/i.test(head)) {
    let items;
    if (m) items = m[1].split(/[,、，]/);
    else { items = rest.split(/\s+/); rest = ''; }
    items = items.map(s => s.trim()).filter(Boolean);
    if (items.length < 2) return null;
    const pick = items[rand(items.length)];
    return { secret, comment: rest, expr: `choice[${items.join(',')}]`, result: `(choice[${items.join(',')}]) ＞ ${pick}`, total: pick, kind: 'choice' };
  }
  m = head.match(/^([0-9dD+\-]+)(?:(>=|<=|<>|>|<|=)(-?\d+))?$/);
  if (!m || !/\d*[dD]\d+/.test(m[1])) return null;
  const terms = m[1].match(/[+\-]?[^+\-]+/g);
  if (!terms) return null;
  let total = 0, parts = [], count = 0;
  for (const t of terms) {
    const sign = t[0] === '-' ? -1 : 1, body = t.replace(/^[+\-]/, '');
    const d = body.match(/^(\d*)[dD](\d+)$/);
    if (d) {
      const n = d[1] === '' ? 1 : +d[1], f = +d[2];
      if (n < 1 || n > 100 || f < 1 || f > 1000) return null;
      count += n; if (count > 200) return null;
      const rolls = Array.from({ length: n }, () => rand(f) + 1);
      const s = rolls.reduce((a, b) => a + b, 0);
      total += sign * s;
      parts.push(`${sign < 0 ? '-' : parts.length ? '+' : ''}${s}[${rolls.join(',')}]`);
    } else if (/^\d+$/.test(body)) { total += sign * +body; parts.push(`${sign < 0 ? '-' : '+'}${body}`); }
    else return null;
  }
  const expr = m[1].toUpperCase() + (m[2] ? m[2] + m[3] : '');
  let ok = null;
  if (m[2]) {
    const t = +m[3];
    ok = { '>=': total >= t, '<=': total <= t, '>': total > t, '<': total < t, '=': total === t, '<>': total !== t }[m[2]];
  }
  const detail = parts.join('');
  const showDetail = !(terms.length === 1 && /^\d+\[\d+\]$/.test(detail) && detail.startsWith(String(total) + '[') && !detail.includes(','));
  return { secret, comment: rest, expr, total, ok, kind: 'dice',
    result: `(${expr}) ＞ ${showDetail ? detail + ' ＞ ' : ''}${total}${ok == null ? '' : ok ? ' ＞ 成功' : ' ＞ 失敗'}` };
}

const coordName = (x, y) => 'ABCDEFGH'[x] + (y + 1);

// ----- visibility -----
function canSeeTab(room, tab, seat) {
  if (!tab.secret) return true;
  if (seat === 'gm' && room.settings.gmSeesSecret) return true;
  return (tab.members || []).includes(seat);
}
// hands: the PC side sees every PC hand; GM's hand is only a count for everyone else
function viewHand(room, owner, viewer) {
  const hand = room.cards.hands[owner] || [];
  if (owner === 'gm') return viewer === 'gm' ? hand : null;
  return hand;
}
function viewLog(room, l, viewer) {
  const tab = room.tabs.find(t => t.id === l.tab);
  if (!tab || !canSeeTab(room, tab, viewer)) return null;
  if (l.type === 'draw' && l.secretCards && viewer !== 'gm') return { ...l, cards: null };
  if (l.type === 'say' && l.dice && l.dice.secret && viewer !== 'gm' && viewer !== l.by) return { ...l, text: '', dice: { secret: true, hidden: true } };
  return l;
}

// what one seat may receive (server -> browser). Logs are sent separately through viewLog.
function viewRoom(room, seat) {
  const { logs, ...rest } = room;
  const r = JSON.parse(JSON.stringify(rest));
  r.cards.deck = Array(room.cards.deck.length).fill('?');
  if (seat !== 'gm') r.cards.hands.gm = Array((room.cards.hands.gm || []).length).fill('?');
  r.tabs = r.tabs.filter(t => canSeeTab(room, t, seat));
  return r;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { apply, newRoom, migrateRoom, viewRoom, viewLog, canSeeTab, isPcSeat, ActionError, normalizeChar };
}
