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
    // empty (null / "") means the character does not have that value, not 0
    const n = x => x != null && x !== '' && Number.isFinite(Number(x));
    if (v && typeof v === 'object') {
      if (n(v.max)) stats[k] = { max: Number(v.max) };
      else if (n(v.value)) stats[k] = { value: Number(v.value) };
    } else if (n(v)) stats[k] = (k === 'HP' || k === 'TP') ? { max: Number(v) } : { value: Number(v) };
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
  const data = {
    format: 'pw-character', version: 2,
    name: raw.name, player: String(raw.player || ''),
    core, stats,
    // tp: TP consumed when the 特技 is used (cost is accepted as an older name)
    skills: Array.isArray(raw.skills) ? raw.skills.map(x => { const t = x?.tp ?? x?.cost; return { ...item(x), tp: t != null && Number.isFinite(Number(t)) ? Number(t) : null }; }) : [],
    weapons,
    // portrait: the 立ち絵 (by label) the character switches to when changing into that variation; basePortrait for 基本
    variations: Array.isArray(raw.variations) ? raw.variations.map(v => ({ name: String(v?.name || 'バリエーション'), slots: slotsFrom(v?.slots), portrait: v?.portrait ? String(v.portrait) : null })) : [],
    basePortrait: raw.basePortrait ? String(raw.basePortrait) : null,
    wingDrive: raw.wingDrive ? item(raw.wingDrive) : null,
    // enemies: any number of ダークドライブ (an enemy's counterpart of the ウイングドライブ), each with its own TP cost
    darkDrives: (Array.isArray(raw.darkDrives) ? raw.darkDrives : []).map(x => { const t = x?.tp; return { ...item(x), tp: t != null && t !== '' && Number.isFinite(Number(t)) ? Number(t) : null }; }).filter(x => x.name),
    // 巨大キャラクター: takes 2×2 squares on the board (x, y = its top-left square on screen)
    size: Number(raw.size) === 2 ? 2 : 1,
    // enemies: what the change of variation is called — 'morph' (メタモルフォーゼ) or 'swap' (換装); unset = decided by the weapons
    formStyle: raw.formStyle === 'morph' || raw.formStyle === 'swap' ? raw.formStyle : null,
    // {label, url}; a plain URL string (older sheets) gets a numbered label
    portraits: Array.isArray(raw.portraits) ? raw.portraits.map((p, i) => typeof p === 'string' ? { label: `立ち絵${i + 1}`, url: p } : p)
      .filter(p => p && typeof p.url === 'string' && p.url.trim()).map(p => ({ label: String(p.label || '立ち絵'), url: toDirectImage(p.url) })) : [],
    memo: String(raw.memo || ''),
  };
  dropStaleFormPortraits(data);
  return data;
}
// links to a 立ち絵 that no longer exists are cleared
function dropStaleFormPortraits(d) {
  const labels = new Set(d.portraits.map(p => p.label));
  if (!labels.has(d.basePortrait)) d.basePortrait = null;
  for (const v of d.variations) if (!labels.has(v.portrait)) v.portrait = null;
}
// the 立ち絵 linked to variation i (-1 = 基本), or null
const formPortrait = (ch, i) => (i === -1 ? ch.data.basePortrait : (ch.data.variations[i] || {}).portrait) || null;
const portraitUrl = (ch, label) => (ch.data.portraits.find(p => p.label === label) || {}).url || null;
// クロスユニゾン (an all-out attack): every PC lines up in the effect, the declarer first
const UNISON = /クロスユニゾン/;
// what a change of variation is called: PCs 換装; an enemy as set (a princess on the other side 換装s too),
// and when unset, メタモルフォーゼ if it has a 〈メタモルフォーゼ〉 weapon
const formWord = ch => {
  if (!ch || ch.side === 'pc') return '換装';
  const st = ch.data.formStyle;
  if (st) return st === 'morph' ? 'メタモルフォーゼ' : '換装';
  return [ch.data.weapons.slots, ...ch.data.variations.map(v => v.slots)].some(sl => (sl || []).some(w => isMorphWeapon(w))) ? 'メタモルフォーゼ' : '換装';
};
// a weapon paid with a joker (カオティックムーン and the like; クロスユニゾン has its own effect)
const isJokerWeapon = w => !!w && !UNISON.test(w.name || '') && /ジョーカー\s*1?\s*枚?\s*を?\s*提出/.test(String(w.text || '').normalize('NFKC'));
// a weapon that switches to バリエーション① and back (〈メタモルフォーゼ〉)
const isMorphWeapon = w => !!w && /メタモルフォーゼ/.test(w.name || '') && /バリエーション/.test(w.text || '');
// ----- board footprint: a 巨大キャラクター covers 2×2 squares from (x, y) -----
const sizeOf = c => c && c.data && c.data.size === 2 ? 2 : 1;
function cellsOf(c, x = c.x, y = c.y) {
  const n = sizeOf(c), out = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out.push([x + i, y + j]);
  return out;
}
// squares between two pieces (or a piece and a square {x, y}); a giant counts from its nearest square
function gap(a, b) {
  let best = Infinity;
  for (const [ax, ay] of cellsOf(a)) for (const [bx, by] of cellsOf(b)) best = Math.min(best, Math.abs(ax - bx) + Math.abs(ay - by));
  return best;
}
// whoever already stands on the squares ch would cover at (x, y)
const blockerAt = (room, ch, x, y) => { const mine = cellsOf(ch, x, y); return Object.values(room.chars).find(o => o.id !== ch.id && o.x != null && cellsOf(o).some(([ox, oy]) => mine.some(([mx, my]) => mx === ox && my === oy))); };
// after a change of size: keep the piece on the board if it still fits (pulled in from the edge), otherwise take it off
function refit(room, ch) {
  if (ch.x == null) return '';
  const n = sizeOf(ch), x = Math.min(ch.x, 8 - n), y = Math.min(ch.y, 8 - n);
  if (!blockerAt(room, ch, x, y)) { ch.x = x; ch.y = y; return ''; }
  ch.x = ch.y = null;
  return '（重なるため盤外に出しました）';
}
// クロスユニゾン and the ウイングドライブ are once per scenario: declaring them ticks their 使用済み box
// ----- lasting effects (buffs / debuffs) -----
// Read from the effect text by how long it lasts, which the rules always write the same way:
//   phase   このアクションフェイズの間 / アクションフェイズが終わるまで → until the turn passes
//   nextOwn 次の自分のアクションフェイズまで                      → until this character's next turn
//   round   1ターンの間 / このラウンドの間                           → until the round ends
//   manual  added by hand                                           → until removed
// ===== reading rules shared with the character sheet tool (princess-wing-sheet.html): keep both copies the same =====
const EFFECT_DUR = { phase: 'この手番の間', nextOwn: '次の自分の手番まで', round: 'ラウンド終了まで', manual: '外すまで' };
const DUR_RE = { nextOwn: /次の自分のアクションフェイズ(?:を迎える)?まで/, phase: /このアクションフェイズ(の間|中(?!に)|が終わるまで)|アクションフェイズが終わるまで/, round: /1ターンの間|このターンの間|このラウンド(の間|中)|ラウンド(が)?終了(する)?まで/ };
function effectDuration(text) {
  const t = String(text || '').normalize('NFKC');
  return ['nextOwn', 'phase', 'round'].find(k => DUR_RE[k].test(t)) || null;
}
// who the lasting effect is on: 'target' when its sentence is about 対象 (e.g. 対象は、1ターンの間…), otherwise the user
function effectTarget(text) {
  const t = String(text || '').normalize('NFKC');
  const d = effectDuration(t); if (!d) return null;
  const sentence = t.split(/[。\n]/).find(x => DUR_RE[d].test(x)) || '';
  return /対象(は|の|が)/.test(sentence) && !/自分は/.test(sentence) ? 'target' : 'self';
}
// 射程: "2" / "1～2" are read; "－", "効果参照" and empty mean no range; anything else cannot be shown on the board
const RANGE_NONE = /^(|[-－―—ー]|効果参照|なし|自身)$/;
function parseRangeText(r) {
  const t = String(r ?? '').normalize('NFKC').trim();
  let m = t.match(/^(\d+)\s*[~〜～\-－―]\s*(\d+|∞)$/);
  // 1～∞: no upper limit (anywhere on the board)
  if (m) { const b = m[2] === '∞' ? Infinity : +m[2]; return { min: Math.min(+m[1], b), max: Math.max(+m[1], b) }; }
  m = t.match(/^(\d+)$/);
  return m ? { min: +m[1], max: +m[1] } : null;
}
const rangeIssue = r => { const t = String(r ?? '').normalize('NFKC').trim(); return RANGE_NONE.test(t) || parseRangeText(t) ? null : t; };
// ===== end of shared rules =====
// a short summary for the chip: 威力+3 / 回避+1 / 武装+3回 (empty when nothing simple is found)
function effectNote(text) {
  const t = String(text || '').normalize('NFKC');
  const out = [];
  let m;
  if ((m = t.match(/威力(?:すべて)?に?(?:すべて)?\s*\+\s*(\d+)/))) out.push(`威力+${m[1]}`);
  if ((m = t.match(/回避コスト[^。]*?\+\s*(\d+)/))) out.push(`回避+${m[1]}`);
  if ((m = t.match(/移動値[^。]*?\+\s*(\d+)/))) out.push(`移動+${m[1]}`);
  if ((m = t.match(/追加で(\d+)回/))) out.push(`武装+${m[1]}回`);
  if ((m = t.match(/ダメージ[^。]*?(\d+)点軽減/))) out.push(`軽減${m[1]}`);
  return out.join(' ');
}
function addEffect(room, ch, { name, note, dur, text, by }) {
  if (!ch) return;
  ch.effects = (ch.effects || []).filter(e => e.name !== name);        // using it again refreshes it
  ch.effects.push({ id: uid('e'), name: String(name).slice(0, 30), note: String(note || '').slice(0, 30), dur: EFFECT_DUR[dur] ? dur : 'manual',
    text: String(text || '').slice(0, 300), turn: room.turn.current || null, seq: room.turn.seq || 0 });
}
// after the turn moves (次の手番, 手番の指定, ラウンド): drop what has run out, with a log line each
function expireEffects(room, by, roundEnded) {
  room.turn.seq = (room.turn.seq || 0) + 1;
  for (const ch of Object.values(room.chars)) {
    const gone = [];
    ch.effects = (ch.effects || []).filter(e => {
      const out = e.dur === 'phase' ? (roundEnded || room.turn.current !== e.turn)
        : e.dur === 'nextOwn' ? room.turn.current === ch.id && room.turn.seq > e.seq
        : e.dur === 'round' ? roundEnded : false;
      if (out) gone.push(e.name);
      return !out;
    });
    if (gone.length) log(room, { tab: opsTab(room), type: 'sys', by, cid: ch.id, text: `${ch.data.name}の「${gone.join('」「')}」の効果が切れました` });
  }
}
// a declaration (コマンド or 武装を使う) whose text has a duration starts a lasting effect on the declarer,
// but only for the items the player confirmed when importing (ch.autoFx: names; reading the text can be wrong)
function effectsFromText(room, ch, name, text, by, targets) {
  const dur = effectDuration(text);
  if (!ch || !dur || !(ch.autoFx || []).includes(name)) return;
  // on the 対象: the targets chosen in 武装を使う (nothing to attach to without them)
  const on = effectTarget(text) === 'target' ? (targets || []).map(id => room.chars[id]).filter(Boolean) : [ch];
  on.forEach(c => addEffect(room, c, { name, note: effectNote(text), dur, text, by }));
}
// every item of a sheet whose text has a duration: what the import asks about
function detectEffects(d) {
  const out = [], seen = new Set();
  const add = (grp, it) => { if (!it || !it.name || seen.has(it.name)) return; const dur = effectDuration(it.text); if (dur) { seen.add(it.name); out.push({ grp, name: it.name, note: effectNote(it.text), dur, target: effectTarget(it.text) }); } };
  (d.skills || []).forEach(it => add('特技', it));
  (d.core?.functions || []).forEach(it => add('特殊機能', it));
  add('ウイングドライブ', d.wingDrive);
  (d.darkDrives || []).forEach(it => add('ダークドライブ', it));
  (d.weapons?.common || []).forEach(it => add('武装', it));
  [d.weapons?.slots || [], ...(d.variations || []).map(v => v.slots || [])].forEach(sl => sl.forEach(it => add('武装', it)));
  return out;
}
// weapons whose 射程 cannot be read (shown before import, so it can be fixed in the sheet)
function rangeProblems(d) {
  const out = [];
  [d.weapons?.common || [], d.weapons?.slots || [], ...(d.variations || []).map(v => v.slots || [])].forEach(l => l.forEach(w => {
    const bad = w && w.name && rangeIssue(w.attrs?.['射程']);
    if (bad && !out.some(x => x.name === w.name)) out.push({ name: w.name, range: bad });
  }));
  return out;
}
const cleanAutoFx = list => Array.isArray(list) ? [...new Set(list.map(String))].slice(0, 60) : null;
// end of a round: hand exchange, the round number goes up, the top of the order acts, round-long effects end
function nextRound(room, by) {
  log(room, { tab: opsTab(room), type: 'round', by, text: `第${room.turn.round}ラウンド終了（手札交換のタイミングです）` });
  room.turn.round += 1;
  room.turn.done = [];
  const next = seatNext(room);
  expireEffects(room, by, true);
  log(room, { tab: opsTab(room), type: 'round', by, start: room.turn.round, cid: room.turn.current || undefined, text: `第${room.turn.round}ラウンド開始${next ? `：${next}` : ''}` });
}
// 機械兵A → 機械兵B, 機械兵1 → 機械兵2, 機械兵 → 機械兵2 (the first name not in use)
function nextCopyName(room, name) {
  const used = new Set(Object.values(room.chars).map(c => c.data.name));
  const n = String(name).normalize('NFKC');
  let m;
  if ((m = n.match(/^(.*?)([A-Z])$/))) { for (let c = m[2].charCodeAt(0) + 1; c <= 90; c++) { const t = m[1] + String.fromCharCode(c); if (!used.has(t)) return t; } }
  if ((m = n.match(/^(.*?)(\d+)$/))) { for (let k = +m[2] + 1; k < 1000; k++) { const t = m[1] + k; if (!used.has(t)) return t; } }
  for (let k = 2; k < 1000; k++) { const t = n + k; if (!used.has(t)) return t; }
  return n + '（複製）';
}
function markOncePerScenario(ch, { unison, wd, dd, joker }) {
  if (!ch) return;
  if (joker) {
    const once = w => w && w.name === joker && /1シナリオに1回/.test(String(w.text || '').normalize('NFKC'));
    ch.data.weapons.common.forEach((w, i) => { if (once(w)) ch.used[`common:${i}`] = true; });
    currentSlots(ch).forEach((w, i) => { if (once(w)) ch.used[`slot${ch.variation}:${i}`] = true; });
  }
  if (dd >= 0) ch.used[`darkDrive:${dd}`] = true;
  if (unison) ch.data.weapons.common.forEach((w, i) => { if (UNISON.test(w.name || '')) ch.used[`common:${i}`] = true; });
  if (wd && ch.data.wingDrive) ch.used['wingDrive:0'] = true;
}
const unisonMembers = (room, firstId) => Object.values(room.chars).filter(c => c.side === 'pc').sort((x, y) => (x.id === firstId ? -1 : 0) - (y.id === firstId ? -1 : 0))
  .map(c => ({ name: c.data.name, color: c.color, url: portraitUrl(c, c.portrait) || (c.data.portraits[0] || {}).url || null }));
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

function logValue(room, ch, a, by, before, v) {
  if (room.settings.logValues === false) return;
  // repeated +/- on the same value within a few seconds are folded into one log line (20 → 14)
  const last = room.logs[room.logs.length - 1];
  if (last && last.type === 'value' && !last.cmd && last.cid === a.cid && last.key === a.key && last.by === by && Date.now() - last.t < 8000) {
    if (last.from === v) room.logs.pop();
    else { last.to = v; last.t = Date.now(); last.text = `${ch.data.name}の${a.key}：${last.from} → ${v}`; }
    return;
  }
  log(room, { tab: opsTab(room), type: 'value', by, cid: a.cid, key: a.key, from: before, to: v, text: `${ch.data.name}の${a.key}：${before} → ${v}` });
}
function changeForm(room, ch, i, by) {
  if (ch.variation === i) return;
  ch.variation = i;
  // a variation with a linked 立ち絵 changes the portrait too; when it really changes, the effect shows before → after
  const from = portraitUrl(ch, ch.portrait), link = formPortrait(ch, i);
  if (link) ch.portrait = link;
  const to = portraitUrl(ch, ch.portrait), swap = from && to && from !== to;
  const name = i === -1 ? '基本' : ch.data.variations[i].name;
  log(room, { tab: opsTab(room), type: 'variation', by, cid: ch.id, fx: 'form', formName: name, ptFrom: swap ? from : undefined, ptTo: swap ? to : undefined,
    text: formWord(ch) === 'メタモルフォーゼ' ? `${ch.data.name}がメタモルフォーゼ：「${name}」になりました` : `${ch.data.name}の武装を「${name}」に切り替えました` });
}
// 〈メタモルフォーゼ〉: to バリエーション① and, from there, back to the original
const morph = (room, ch, by) => { if (ch.data.variations.length) changeForm(room, ch, ch.variation === -1 ? 0 : -1, by); };
// SS値 is the initiative: the next to act is the highest SS値 among those who have not acted this round
// (room.turn.done). A tie is not decided by the table order: the players choose (room.turn.pick).
// HP 0 or less = 戦闘不能: skipped by the initiative until healed (characters without HP are never down)
const isDown = c => !!c && Number.isFinite(c.cur.HP) && c.cur.HP <= 0;
function nextActors(room) {
  const done = new Set(room.turn.done || []);
  const left = turnOrder(room).filter(c => !done.has(c.id) && !isDown(c));
  return left.length ? left.filter(c => ssOf(c) === ssOf(left[0])) : [];
}
const tieText = g => `SS値${ssOf(g[0])}が同値：${g.map(c => c.data.name).join('、')}から次に動くキャラを選びます`;
// put the next actor (or the tie to choose from) in place; returns the log text for it
function seatNext(room) {
  const g = nextActors(room);
  room.turn.current = g.length === 1 ? g[0].id : null;
  room.turn.pick = g.length > 1 ? g.map(c => c.id) : null;
  return g.length === 1 ? `${g[0].data.name}の手番です` : g.length ? tieText(g) : '';
}
function newRoom(name) {
  return {
    id: uid('r'), name: name || '新しい部屋', createdAt: Date.now(),
    players: {},
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
// a character seat (PC or NPC): it has its own hand and can be sat in
const isPcSeat = (room, seat) => !!(room.chars[seat] && (room.chars[seat].side === 'pc' || room.chars[seat].side === 'npc'));
// characters the GM added and has not handed to a player yet
const gmOwned = ch => !!ch && ch.owner === 'gm';
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
  const extra = { byName: seatName(room, entry.by), pid: room._pid || null };
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

function apply(room, a, by, pid) {
  pid = pid || by;
  room.players = room.players || {};
  room._pid = pid;
  try { return applyInner(room, a, by, pid); } finally { delete room._pid; }
}
function applyInner(room, a, by, pid) {
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
        color: a.side === 'enemy' ? '#FF7A7A' : colors[Object.keys(room.chars).filter(k => room.chars[k].side !== 'enemy').length % colors.length],
        owner: by === 'gm' ? 'gm' : (pid && pid !== by ? pid : id), autoFx: cleanAutoFx(a.autoFx) || [] };
      if (a.side === 'pc' || a.side === 'npc') room.cards.hands[id] = room.cards.hands[id] || [];
      log(room, { tab: opsTab(room), type: 'sys', by, text: `${data.name}（${{ pc: 'PC', enemy: '敵', npc: 'NPC' }[a.side]}）が参加しました` });
      return id;
    }
    case 'updateCharData': {
      need(ch && canControlChar(room, by, a.cid), 'このキャラクターは編集できません');
      const data = normalizeChar(a.data);
      // a sheet from the sheet tool has no 立ち絵 links: keep the ones set here (variations matched by name)
      if (!('basePortrait' in a.data)) data.basePortrait = ch.data.basePortrait || null;
      data.variations.forEach((v, i) => { const rv = (Array.isArray(a.data.variations) ? a.data.variations : [])[i]; if (!(rv && typeof rv === 'object' && 'portrait' in rv)) v.portrait = (ch.data.variations.find(o => o.name === v.name) || {}).portrait || null; });
      if (!Array.isArray(a.data.portraits)) data.portraits = ch.data.portraits;
      dropStaleFormPortraits(data);
      if (cleanAutoFx(a.autoFx)) ch.autoFx = cleanAutoFx(a.autoFx);
      for (const [k, s] of Object.entries(data.stats)) if (!(k in ch.cur)) ch.cur[k] = statStart(s);
      ch.data = data; ch.dv = (ch.dv || 1) + 1;
      if (!(ch.variation < data.variations.length)) ch.variation = -1;
      if (ch.portrait && !data.portraits.some(p => p.label === ch.portrait)) ch.portrait = data.portraits[0]?.label || null;
      const off = refit(room, ch);
      log(room, { tab: opsTab(room), type: 'sys', by, text: `${data.name}のデータを更新しました${off}` });
      return;
    }
    case 'setAutoFx': {
      need(ch && canControlChar(room, by, a.cid), 'このキャラクターは操作できません');
      ch.autoFx = cleanAutoFx(a.names) || [];
      return;
    }
    case 'cloneChar': { // GM: another copy of an enemy / NPC, fresh (full values, off the board), named with the next free suffix
      need(by === 'gm', '複製できるのはGMだけです');
      need(ch && (ch.side !== 'pc' || gmOwned(ch)), 'PLのキャラは複製できません');
      const id = typeof a.id === 'string' && /^c[0-9a-z]{6,30}$/.test(a.id) && !room.chars[a.id] ? a.id : uid('c');
      const name = nextCopyName(room, ch.data.name);
      const data = clone(ch.data); data.name = name;
      const cur = {}; for (const [k, st] of Object.entries(data.stats)) cur[k] = statStart(st);
      room.chars[id] = { ...clone(ch), id, data, dv: 1, cur, used: {}, effects: [], x: null, y: null, owner: 'gm' };
      if (ch.side === 'pc' || ch.side === 'npc') room.cards.hands[id] = [];
      log(room, { tab: opsTab(room), type: 'sys', by, text: `${ch.data.name}を複製して${name}を追加しました` });
      return id;
    }
    case 'addEffect': {
      need(ch && canControlChar(room, by, a.cid), 'このキャラクターは操作できません');
      const nm = String(a.name || '').trim();
      need(nm, '効果の名前を入れてください');
      addEffect(room, ch, { name: nm, note: a.note, dur: a.dur, text: a.text, by });
      log(room, { tab: opsTab(room), type: 'sys', by, cid: ch.id, text: `${ch.data.name}に「${nm}」（${EFFECT_DUR[a.dur] || EFFECT_DUR.manual}）を付けました` });
      return;
    }
    case 'removeEffect': {
      need(ch && canControlChar(room, by, a.cid), 'このキャラクターは操作できません');
      const e = (ch.effects || []).find(x => x.id === a.eid);
      need(e, 'その効果は見つかりません');
      ch.effects = ch.effects.filter(x => x.id !== a.eid);
      log(room, { tab: opsTab(room), type: 'sys', by, cid: ch.id, text: `${ch.data.name}の「${e.name}」を外しました` });
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
      const wasDown = isDown(ch);
      ch.cur[a.key] = v;
      logValue(room, ch, a, by, before, v);
      // crossing HP 0 is always told (even with value logs off): it takes the character out of / back into the initiative
      if (a.key === 'HP' && isDown(ch) !== wasDown) log(room, { tab: opsTab(room), type: 'sys', by, cid: ch.id, fx: isDown(ch) ? 'ko' : undefined,
        text: isDown(ch) ? `${ch.data.name}は戦闘不能になりました` : `${ch.data.name}が戦闘不能から復帰しました` });
      return;
    }
    case 'toggleUsed': {
      need(ch && canControlChar(room, by, a.cid), 'このキャラクターは操作できません');
      const k = `${a.group}:${a.idx}`;
      ch.used[k] = !ch.used[k];
      const it = a.group === 'wingDrive' ? ch.data.wingDrive : a.group === 'darkDrive' ? (ch.data.darkDrives || [])[a.idx] : a.group === 'common' ? ch.data.weapons.common[a.idx]
        : a.group.startsWith('slot') ? currentSlots(ch)[a.idx] : a.group === 'func' ? ch.data.core?.functions[a.idx] : ch.data[a.group]?.[a.idx];
      log(room, { tab: opsTab(room), type: 'value', by, text: `${ch.data.name}の「${it?.name || '?'}」を${ch.used[k] ? '使用済み' : '未使用'}にしました` });
      return;
    }
    case 'setPortraits': {
      need(ch && canControlChar(room, by, a.cid), 'このキャラクターは編集できません');
      ch.data.portraits = a.portraits.map(p => ({ label: String(p.label || '立ち絵'), url: toDirectImage(p.url) })).filter(p => p.url);
      // forms: { "-1": label for 基本, "0": label for variation 0, ... } (null = no link)
      if (a.forms && typeof a.forms === 'object') {
        const pick = k => a.forms[k] ? String(a.forms[k]) : null;
        ch.data.basePortrait = pick('-1');
        ch.data.variations.forEach((v, i) => { v.portrait = pick(String(i)); });
      }
      dropStaleFormPortraits(ch.data);
      ch.dv = (ch.dv || 1) + 1;
      // a link set for the variation being worn takes effect now
      const now = formPortrait(ch, ch.variation);
      if (a.forms && now) ch.portrait = now;
      if (!ch.data.portraits.some(p => p.label === ch.portrait)) ch.portrait = ch.data.portraits[0]?.label || null;
      return;
    }
    case 'setFormStyle': { // GM: an enemy's change of variation is called 換装 or メタモルフォーゼ
      need(by === 'gm', '変更できるのはGMだけです');
      need(ch && ch.side !== 'pc', 'PCは換装です');
      ch.data.formStyle = a.style === 'morph' ? 'morph' : 'swap'; ch.dv = (ch.dv || 1) + 1;
      return;
    }
    case 'setSize': { // GM: make a piece a 巨大キャラクター (2×2) or back to one square
      need(by === 'gm', '大きさを変えられるのはGMだけです');
      need(ch, 'キャラクターが見つかりません');
      const n = Number(a.size) === 2 ? 2 : 1;
      if (sizeOf(ch) === n) return;
      ch.data.size = n; ch.dv = (ch.dv || 1) + 1;
      const off = refit(room, ch);
      log(room, { tab: opsTab(room), type: 'sys', by, text: `${ch.data.name}を${n > 1 ? '巨大キャラクター（2×2マス）' : '1マスのキャラクター'}にしました${off}` });
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
      changeForm(room, ch, i, by);
      return;
    }

    // ----- turn -----
    case 'setTurn': {
      need(by === 'gm', '手番を指定できるのはGMだけです');
      need(a.cid === null || room.chars[a.cid], 'キャラクターが見つかりません');
      room.turn.current = a.cid && room.turn.current !== a.cid ? a.cid : null;   // pressing the current one again clears it
      room.turn.pick = null;
      if (room.turn.current) log(room, { tab: opsTab(room), type: 'turn', by, cid: room.turn.current, text: `${room.chars[room.turn.current].data.name}の手番です` });
      expireEffects(room, by, false);
      return;
    }
    case 'nextTurn': {
      need(by === 'gm' || by === room.turn.current, '手番を進められるのは、GMか手番のキャラだけです');
      need(turnOrder(room).length, 'キャラクターがいません');
      need(!(room.turn.pick || []).length, '同値のキャラから、次に動くキャラを選んでください');
      if (room.turn.current) room.turn.done = [...new Set([...(room.turn.done || []), room.turn.current])];
      if (!nextActors(room).length) { nextRound(room, by); return; }       // everyone has acted: the round ends
      const text = seatNext(room);
      log(room, { tab: opsTab(room), type: 'turn', by, cid: room.turn.current || undefined, text });
      expireEffects(room, by, false);
      return;
    }
    case 'pickTurn': { // a tie on SS値: one of the tied characters goes now
      need((room.turn.pick || []).includes(a.cid), 'そのキャラクターは今は選べません');
      need(canControlChar(room, by, a.cid), '選べるのはGMか、そのキャラの持ち主だけです');
      room.turn.current = a.cid; room.turn.pick = null;
      log(room, { tab: opsTab(room), type: 'turn', by, cid: a.cid, text: `${room.chars[a.cid].data.name}の手番です` });
      expireEffects(room, by, false);
      return;
    }
    case 'endRound': {
      need(by === 'gm', 'ラウンドを進められるのはGMだけです');
      nextRound(room, by);
      return;
    }
    case 'endCombat': {
      need(by === 'gm', '戦闘を終えられるのはGMだけです');
      room.turn.current = null; room.turn.pick = null; room.turn.done = [];
      room.turn.seq = (room.turn.seq || 0) + 1;
      for (const c of Object.values(room.chars)) c.effects = (c.effects || []).filter(e => e.dur === 'manual');
      log(room, { tab: opsTab(room), type: 'round', by, text: `戦闘終了（第${room.turn.round}ラウンド）` });
      return;
    }
    case 'resetRound': {
      need(by === 'gm', 'ラウンドを戻せるのはGMだけです');
      room.turn = { round: 1, current: null, seq: (room.turn.seq || 0), done: [], pick: null };
      const first = seatNext(room);
      for (const c of Object.values(room.chars)) c.effects = (c.effects || []).filter(e => e.dur === 'manual');
      log(room, { tab: opsTab(room), type: 'round', by, start: 1, cid: room.turn.current || undefined, text: `戦闘開始：第1ラウンド${first ? `、${first}` : ''}` });
      return;
    }

    // ----- map -----
    case 'move': {
      need(ch && canControlChar(room, by, a.cid), 'このコマは動かせません');
      const from = ch.x == null ? '盤外' : coordName(ch.x, ch.y);
      if (a.x == null) { ch.x = ch.y = null; }
      else {
        const n = sizeOf(ch);
        need(a.x >= 0 && a.x <= 8 - n && a.y >= 0 && a.y <= 8 - n, n > 1 ? '巨大キャラクターがマップからはみ出します' : 'マップの外です');
        // one piece per square (a giant needs all four of its squares free)
        const occ = blockerAt(room, ch, a.x, a.y);
        if (occ) throw new ActionError(n > 1 ? `${occ.data.name}と重なります` : `${coordName(a.x, a.y)}にはすでに${occ.data.name}がいます`);
        ch.x = a.x; ch.y = a.y;
      }
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
      need(isPcSeat(room, seat) && isPcSeat(room, a.to) && seat !== a.to, '渡せるのは味方のキャラ同士だけです');
      const hand = room.cards.hands[seat] || [];
      need(a.cards.length && a.cards.every(c => hand.includes(c)), '手札にないカードが含まれています');
      room.cards.hands[seat] = hand.filter(c => !a.cards.includes(c));
      (room.cards.hands[a.to] = room.cards.hands[a.to] || []).push(...a.cards);
      log(room, { tab: opsTab(room), type: 'give', by, seat, to: a.to, toName: seatName(room, a.to), cards: a.cards });
      return;
    }
    case 'useWeapons': { // declare one or more weapons at once, discarding any cards (suits are not enforced)
      need(ch && canControlChar(room, by, a.cid), 'このキャラクターは操作できません');
      need(!(by === 'gm' && ch.side === 'pc' && !gmOwned(ch)), 'GMはPLのキャラの武装を使えません');
      const seat = ch.side === 'pc' ? ch.id : 'gm';
      const hand = room.cards.hands[seat] || [];
      const cards = Array.isArray(a.cards) ? a.cards : [];
      need(cards.every(x => hand.includes(x)) && new Set(cards).size === cards.length, '手札にないカードが含まれています');
      // keys: c<i> common, s<i> current variation, v<n>_<i> slot i of variation n (-1 = 基本)
      const slotsOf = n => n === -1 ? ch.data.weapons.slots : (ch.data.variations[n] || {}).slots || [];
      let offForm = false;
      const ws = (Array.isArray(a.weapons) ? a.weapons : []).map(k => {
        k = String(k);
        if (k[0] === 'c') return ch.data.weapons.common[+k.slice(1)];
        if (k[0] === 's') return currentSlots(ch)[+k.slice(1)];
        const m = k.match(/^v(-?\d+)_(\d+)$/); if (!m) return null;
        if (+m[1] !== ch.variation) offForm = true;
        return slotsOf(+m[1])[+m[2]];
      }).filter(w => w && w.name);
      need(ws.length, '武装を選んでください');
      room.cards.hands[seat] = hand.filter(x => !cards.includes(x));
      room.cards.discard.push(...cards);
      const unisonUsed = ws.some(w => UNISON.test(w.name)), jw = !unisonUsed && ws.find(isJokerWeapon);
      markOncePerScenario(ch, { unison: unisonUsed, joker: jw ? jw.name : null });
      ws.forEach(w => effectsFromText(room, ch, w.name, w.text, by, Array.isArray(a.targets) ? a.targets.filter(id => room.chars[id]) : []));
      log(room, { tab: opsTab(room), type: 'weapon', by, seat, cid: ch.id, charName: ch.data.name,
        weapons: ws.map(w => ({ name: w.name, suit: w.suit || null, attrs: { ...(w.attrs || {}) }, text: w.text || '' })),
        cards, targets: (Array.isArray(a.targets) ? a.targets : []).map(id => room.chars[id]?.data.name).filter(Boolean), memo: String(a.memo || '').trim(), offForm,
        ...(unisonUsed ? { fx: 'unison', members: unisonMembers(room, ch.id) } : jw ? { fx: 'joker', jokerName: jw.name } : {}) });
      if (ws.some(isMorphWeapon)) morph(room, ch, by);
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
      need(canSeeTab(room, tab, by, pid), 'このタブには発言できません');
      const text = (a.text || '').trim();
      need(text, '空の発言は送れません');
      // who may speak as whom: a PL only as their own PC (or as themselves), the GM as GM / NPC / enemies — never as a PC
      if (a.as) {
        const sc = room.chars[a.as];
        need(sc, 'そのキャラクターはいません');
        if (by === 'gm') need(sc.side !== 'pc' || gmOwned(sc), 'GMはPLのキャラとして発言できません');
        else need(by === a.as, '自分のキャラクターとしてだけ発言できます');
      }
      const freeName = speakerName(room, by, a.name, pid);
      // a reply quotes a message of the same tab (so it never shows anything the readers could not see already)
      let reply;
      if (a.reply) {
        const o = room.logs.find(x => x.id === a.reply);
        need(o && o.type === 'say' && o.tab === tab.id, '返信先の発言が見つかりません');
        const body = o.dice ? (o.dice.secret ? 'シークレットダイス' : `${o.dice.comment ? o.dice.comment + ' ' : ''}${o.dice.result}`) : o.text;
        reply = { id: o.id, name: o.name || '', pid: o.pid || null, by: o.by, text: String(body || '').replace(/\s+/g, ' ').slice(0, 60) };
      }
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
      const unison = UNISON.test(a.cmd || '') || /^【武装】[^\n]*クロスユニゾン/.test(text);
      const wdChar = a.as && room.chars[a.as];
      const wd = a.fx === 'wd' || !!(wdChar && wdChar.data.wingDrive && a.cmd && a.cmd === wdChar.data.wingDrive.name);
      const dd = wdChar && a.cmd ? (wdChar.data.darkDrives || []).findIndex(x => x.name === a.cmd) : -1;
      const cmdWeapon = wdChar && a.cmd ? [...wdChar.data.weapons.common, ...currentSlots(wdChar)].find(w => w && w.name === a.cmd) : null;
      const joker = !unison && isJokerWeapon(cmdWeapon);
      markOncePerScenario(wdChar, { unison, wd, dd, joker: joker ? cmdWeapon.name : null });
      if (wdChar && a.cmd) effectsFromText(room, wdChar, a.cmd, text, by);
      log(room, { tab: tab.id, type: 'say', by, as: a.as || null, name: a.as ? room.chars[a.as].data.name : freeName, color, portrait: a.portrait || null, portraitUrl: pUrl, text, cmd: a.cmd || null, dice, fx: unison ? 'unison' : joker ? 'joker' : dd >= 0 || a.fx === 'dd' ? 'dd' : a.fx === 'wd' ? 'wd' : undefined, jokerName: joker ? cmdWeapon.name : undefined, members: unison ? unisonMembers(room, a.as) : undefined, reply });
      if (isMorphWeapon(cmdWeapon)) morph(room, wdChar, by);
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
      need(l.pid ? l.pid === pid : l.by === by, '自分の発言だけ編集できます');
      need(!l.dice, 'ダイスの発言は結果が変わってしまうので編集できません');
      const text = String(a.text || '').trim();
      need(text, '空にはできません');
      if (text === l.text) return;
      l.text = text; l.edited = Date.now();
      return;
    }
    case 'addTab': {
      const members = a.secret ? [...new Set([...(a.members || []), pid])] : null;
      let name = String(a.name || '').trim().slice(0, 24);
      if (!name) {
        const names = (members || []).map(p => room.players[p]?.name || seatName(room, p)).filter(Boolean);
        name = a.secret ? `秘匿：${names.join('・') || room.tabs.filter(t => t.secret).length + 1}`.slice(0, 24) : `タブ${room.tabs.length + 1}`;
      }
      const t = { id: typeof a.id === 'string' && /^t[0-9a-z]{6,30}$/.test(a.id) && !room.tabs.some(x => x.id === a.id) ? a.id : uid('t'), name };
      if (a.secret) { t.secret = true; t.members = members; }
      room.tabs.push(t);
      return t.id;
    }
    case 'editTab': {
      const t = room.tabs.find(x => x.id === a.tab); need(t, 'タブが見つかりません');
      need(by === 'gm' || (t.members || []).includes(pid) || (t.members || []).includes(by), 'このタブは編集できません');
      if (a.name && a.name.trim()) t.name = a.name.trim().slice(0, 24);
      if (t.secret && a.members) t.members = [...new Set(a.members)];
      return;
    }
    case 'giveChar': { // hand your own character to another player (or to the GM); nobody can take one
      need(ch, 'キャラクターが見つかりません');
      const mine = ch.owner === pid || (by === 'gm' && ch.owner === 'gm');
      need(mine, '譲渡できるのは自分のキャラクターだけです');
      need(a.to === 'gm' || (room.players[a.to] && a.to !== ch.owner), '譲渡先のプレイヤーを選んでください');
      ch.owner = a.to;
      const toName = a.to === 'gm' ? 'GM' : room.players[a.to].name;
      log(room, { tab: opsTab(room), type: 'sys', by, text: `${ch.data.name}を${toName}に譲渡しました` });
      return;
    }
    case 'setPlayer': { // a person's display name in this room
      const name = String(a.name || '').trim().slice(0, 20);
      need(name, '名前を入れてください');
      room.players[pid] = { ...(room.players[pid] || {}), name };
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
  room.players = room.players || {};
  room.settings.decks = room.settings.decks || 1;
  if (!('digestTab' in room.settings)) room.settings.digestTab = 'main';
  for (const ch of Object.values(room.chars)) {
    if (!ch.data.stats || ch.data.skills.some(s => !('tp' in s))) { try { ch.data = normalizeChar({ ...ch.data, values: ch.data.stats ? Object.fromEntries(Object.entries(ch.data.stats)) : ch.data.values }); } catch (e) {} }
    if (ch.variation == null) ch.variation = -1;
    if (!ch.dv) ch.dv = 1;
    if (ch.owner !== 'gm') ch.owner = ch.id;          // older rooms stored the importer's seat here
    if ((ch.side === 'pc' || ch.side === 'npc') && !room.cards.hands[ch.id]) room.cards.hands[ch.id] = [];
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

// A1 is the bottom-left square (rows are counted upward); y=0 is the top row on screen
// the name used when not speaking as a character: GM may name NPCs freely (but not after a PC);
// a PL speaks under their player name (no "（PL）" suffix); spectators are just spectators
function speakerName(room, by, wanted, pid) {
  const pname = room.players && pid && room.players[pid] ? room.players[pid].name : '';
  if (by === 'gm') {
    const n = String(wanted || 'GM').trim().slice(0, 30) || 'GM';
    const pcNames = Object.values(room.chars).filter(c => c.side === 'pc' && !gmOwned(c)).map(c => c.data.name);
    need(!pcNames.includes(n), 'PCと同じ名前では発言できません');
    return n;
  }
  if (isPcSeat(room, by)) { const d = room.chars[by].data; return pname || d.player || d.name; }
  return pname ? `${pname}（観戦）` : '観戦者';
}
const coordName = (x, y) => 'ABCDEFGH'[x] + (8 - y);

// ----- visibility -----
// secret tabs belong to players (people), not seats: switching characters keeps what you can see
function canSeeTab(room, tab, seat, pid) {
  if (!tab.secret) return true;
  if (seat === 'gm' && room.settings.gmSeesSecret) return true;
  const m = tab.members || [];
  return m.includes(pid || seat) || m.includes(seat);
}
// hands: the PC side sees every PC hand; GM's hand is only a count for everyone else
function viewHand(room, owner, viewer) {
  const hand = room.cards.hands[owner] || [];
  if (owner === 'gm') return viewer === 'gm' ? hand : null;
  return hand;
}
function viewLog(room, l, viewer, pid) {
  const tab = room.tabs.find(t => t.id === l.tab);
  if (!tab || !canSeeTab(room, tab, viewer, pid)) return null;
  if (l.type === 'draw' && l.secretCards && viewer !== 'gm') return { ...l, cards: null };
  if (l.type === 'say' && l.dice && l.dice.secret && viewer !== 'gm' && viewer !== l.by && (!pid || pid !== l.pid)) return { ...l, text: '', dice: { secret: true, hidden: true } };
  return l;
}

// what one seat may receive (server -> browser). Logs are sent separately through viewLog.
function viewRoom(room, seat, pid) {
  const { logs, ...rest } = room;
  const r = JSON.parse(JSON.stringify(rest));
  r.cards.deck = Array(room.cards.deck.length).fill('?');
  if (seat !== 'gm') r.cards.hands.gm = Array((room.cards.hands.gm || []).length).fill('?');
  r.tabs = r.tabs.filter(t => canSeeTab(room, t, seat, pid));
  return r;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rangeProblems, effectTarget, rangeIssue, nextActors, isDown, formWord, isJokerWeapon, gap, sizeOf, cellsOf, detectEffects, apply, newRoom, migrateRoom, viewRoom, viewLog, canSeeTab, isPcSeat, gmOwned, ActionError, normalizeChar, turnOrder };
}
