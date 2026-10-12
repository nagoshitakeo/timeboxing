import { createStore } from './store.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------- 日付・時刻 ----------
const pad = n => String(n).padStart(2, '0');
const fmtDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseDay(s); d.setDate(d.getDate() + n); return fmtDay(d); };
const todayStr = () => fmtDay(new Date());
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const slotLabel = s => `${pad(Math.floor(s / 4))}:${pad((s % 4) * 15)}`;
const dayLabel = s => { const d = parseDay(s); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`; };

// ---------- 設定（端末ごと） ----------
const ls = {
  get(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 無視 */ } },
};
const settings = { startHour: 8, endHour: 20, weekStart: 1, ...ls.get('tb.settings', {}) };

const state = {
  anchor: todayStr(),
  view: ls.get('tb.view', matchMedia('(max-width: 700px)').matches ? 'day' : 'week'),
  categories: [],
  entries: new Map(), // day -> entry[]
  inbox: [],
  placing: null, // 「時間割に置く」中の inbox 項目
  lastCat: ls.get('tb.lastCat', null),
};

const DEFAULT_CATEGORIES = [
  ['会議', '#4f7cff'], ['作業', '#2da44e'], ['連絡・調整', '#e3a008'], ['移動', '#8b949e'], ['休憩', '#d97bd0'],
];

let store;
let rowPx = 20;
const minSlot = () => settings.startHour * 4;
const maxSlot = () => settings.endHour * 4;

// ---------- 起動 ----------
init();

async function init() {
  try {
    // URL に ?demo を付けると、本番の設定があっても端末内保存のデモモードで動く（動作確認用）
    const demo = new URLSearchParams(location.search).has('demo');
    store = await createStore(demo ? '' : SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (e) {
    document.body.textContent = '読み込みに失敗しました：' + e.message;
    return;
  }
  bindStatic();
  store.onAuthChange(user => { if (!user) showLogin(); });
  const user = await store.getUser();
  if (user) await startApp(); else showLogin();
}

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
}

async function startApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#demo-note').hidden = store.mode !== 'local';
  $('#logout-item').hidden = store.mode === 'local';
  $('#keys-item').hidden = !hasMouse;
  await loadCategories();
  if (state.categories.length === 0) {
    for (const [i, [name, color]] of DEFAULT_CATEGORIES.entries()) {
      await store.saveCategory({ name, color, sort_order: i });
    }
    await loadCategories();
  }
  initCursor();
  setInboxOpen(matchMedia('(min-width: 701px)').matches && ls.get('tb.inboxOpen', true));
  loadInbox();
  await refresh();
  scrollToNow();
}

async function loadCategories() {
  state.categories = await store.listCategories();
}

// ---------- 表示範囲 ----------
function visibleDays() {
  if (state.view === 'day') return [state.anchor];
  const d = parseDay(state.anchor);
  const back = (d.getDay() - settings.weekStart + 7) % 7;
  const first = addDays(state.anchor, -back);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

async function refresh() {
  render(); // 先に枠だけ描いて体感速度を上げる
  const days = visibleDays();
  try {
    const rows = await store.listEntries(days[0], days[days.length - 1]);
    days.forEach(d => state.entries.set(d, []));
    rows.forEach(r => state.entries.get(r.day)?.push(r));
    render();
  } catch (e) {
    toast('読み込みに失敗しました：' + e.message);
  }
}

function move(step) {
  const n = step * (state.view === 'day' ? 1 : 7);
  state.anchor = addDays(state.anchor, n);
  if (cursor) cursor.day = addDays(cursor.day, n);
  refresh();
}

function goToday() {
  state.anchor = todayStr();
  initCursor();
  refresh().then(scrollToNow);
}

// ---------- 描画 ----------
const catById = id => state.categories.find(c => c.id === id);
const dayEntries = day => state.entries.get(day) || [];

function render() {
  const days = visibleDays();
  const today = todayStr();
  const md = s => { const d = parseDay(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
  $('#range-label').textContent = days.length === 1
    ? dayLabel(days[0])
    : matchMedia('(max-width: 480px)').matches
      ? `${md(days[0])}–${md(days[6])}`
      : `${dayLabel(days[0])} – ${dayLabel(days[6])}`;
  $$('.seg button').forEach(b => b.classList.toggle('on', b.dataset.view === state.view));

  const board = $('#board');
  const scroll = board.scrollTop;
  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.style.setProperty('--cols', days.length);

  grid.append(el('div', 'dayhead corner'));
  for (const d of days) {
    const wd = parseDay(d).getDay();
    const h = el('div', 'dayhead' + (d === today ? ' today' : '') + (wd === 0 ? ' sun' : wd === 6 ? ' sat' : ''));
    // スマホの週表示は幅が足りないので「12(月)」まで短くする
    h.textContent = days.length > 1 && matchMedia('(max-width: 480px)').matches
      ? `${parseDay(d).getDate()}(${WD[wd]})`
      : dayLabel(d);
    if (days.length > 1) {
      h.style.cursor = 'pointer';
      h.title = 'この日を表示';
      h.onclick = () => {
        state.anchor = d;
        if (cursor) cursor.day = d;
        setView('day');
      };
    }
    grid.append(h);
  }

  rowPx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row')) || 20;
  const height = (maxSlot() - minSlot()) * rowPx;

  const times = el('div', 'times');
  times.style.height = height + 'px';
  for (let h = settings.startHour + 1; h < settings.endHour; h++) {
    const s = el('span');
    s.textContent = `${h}:00`;
    s.style.top = (h * 4 - minSlot()) * rowPx + 'px';
    times.append(s);
  }
  grid.append(times);

  for (const d of days) {
    const col = el('div', 'col' + (d === today ? ' today' : ''));
    col.dataset.day = d;
    col.style.height = height + 'px';
    for (const e of dayEntries(d)) col.append(entryEl(e));
    grid.append(col);
  }

  board.replaceChildren(grid);
  board.scrollTop = scroll;
  drawNow();
  drawCursor(false);
}

function entryEl(e) {
  const top = Math.max(e.start_slot, minSlot());
  const bottom = Math.min(e.end_slot, maxSlot());
  const div = el('div', 'entry');
  if (bottom <= top) { div.hidden = true; return div; } // 表示範囲外
  const cat = catById(e.category_id);
  div.style.setProperty('--c', cat?.color || '#8b949e');
  div.style.top = (top - minSlot()) * rowPx + 1 + 'px';
  div.style.height = (bottom - top) * rowPx - 2 + 'px';
  if (bottom - top <= 2) div.classList.add('short');
  const c = el('span', 'cat'); c.textContent = cat?.name || '未分類';
  const t = el('span', 't'); t.textContent = e.title;
  const tm = el('span', 'time'); tm.textContent = `${slotLabel(e.start_slot)}–${slotLabel(e.end_slot)}`;
  div.append(c, t, tm);
  if (hasMouse) div.append(el('div', 'grip')); // 下端ドラッグで長さ変更
  div.dataset.id = e.id;
  div.title = `${slotLabel(e.start_slot)}–${slotLabel(e.end_slot)} ${cat?.name || '未分類'} ${e.title}`;
  return div;
}

function drawNow() {
  $$('.now').forEach(n => n.remove());
  const col = $(`.col[data-day="${todayStr()}"]`);
  if (!col) return;
  const d = new Date();
  const slots = (d.getHours() * 60 + d.getMinutes()) / 15;
  if (slots < minSlot() || slots > maxSlot()) return;
  const n = el('div', 'now');
  n.style.top = (slots - minSlot()) * rowPx + 'px';
  col.append(n);
}
setInterval(drawNow, 60_000);

function scrollToNow() {
  const n = $('.now');
  if (n) $('#board').scrollTop = Math.max(0, n.offsetTop - $('#board').clientHeight / 3);
}

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

// ---------- 共通 ----------
const colOf = day => $(`.col[data-day="${day}"]`);
const colAtX = x => $$('.col').find(c => { const r = c.getBoundingClientRect(); return x >= r.left && x < r.right; });
const entryAt = (day, slot) => dayEntries(day).find(e => e.start_slot <= slot && slot < e.end_slot);
const clampSlot = s => Math.min(Math.max(s, minSlot()), maxSlot() - 1);
const overlaps = (day, start, end, exceptId) =>
  dayEntries(day).some(o => o.id !== exceptId && o.start_slot < end && start < o.end_slot);

function findEntry(id) {
  for (const list of state.entries.values()) {
    const e = list.find(x => x.id === id);
    if (e) return e;
  }
  return null;
}

function slotAt(col, clientY) {
  const r = col.getBoundingClientRect();
  return clampSlot(Math.floor((clientY - r.top) / rowPx) + minSlot());
}

// ドラッグ中に上下の端へ近づいたらスクロールする
function autoScroll(clientY) {
  const b = $('#board');
  const r = b.getBoundingClientRect();
  const head = $('.dayhead')?.offsetHeight || 0;
  if (clientY < r.top + head + 30) b.scrollTop -= 10;
  else if (clientY > r.bottom - 30) b.scrollTop += 10;
}

// ---------- カーソル（PCのキー操作用） ----------
const hasMouse = matchMedia('(pointer: fine)').matches;
let cursor = null; // { day, slot }

function initCursor() {
  if (!hasMouse) return;
  const days = visibleDays();
  const d = new Date();
  cursor = {
    day: days.includes(todayStr()) ? todayStr() : days[0],
    slot: clampSlot(Math.floor((d.getHours() * 60 + d.getMinutes()) / 15)),
  };
}

function drawCursor(scroll) {
  $$('.cursor').forEach(c => c.remove());
  if (!cursor) return;
  const col = colOf(cursor.day);
  if (!col) return;
  cursor.slot = clampSlot(cursor.slot);
  const c = el('div', 'cursor');
  c.style.top = (cursor.slot - minSlot()) * rowPx + 'px';
  col.append(c);
  if (!scroll) return;
  const b = $('#board');
  const br = b.getBoundingClientRect(), cr = c.getBoundingClientRect();
  const head = $('.dayhead').offsetHeight;
  if (cr.top < br.top + head) b.scrollTop -= br.top + head - cr.top + rowPx;
  else if (cr.bottom > br.bottom) b.scrollTop += cr.bottom - br.bottom + rowPx;
}

function setCursor(day, slot, scroll = false) {
  if (!cursor) return;
  cursor = { day, slot };
  drawCursor(scroll);
}

function stepSlot(d) {
  if (sel) {
    updateSelTo(sel.cur + d);
    setCursor(sel.day, sel.cur, true);
  } else {
    setCursor(cursor.day, cursor.slot + d, true);
  }
}

function stepDay(d) {
  const day = addDays(cursor.day, d);
  cursor.day = day;
  if (visibleDays().includes(day)) drawCursor(true);
  else { state.anchor = day; refresh(); }
}

// スペース：予定があれば開く／なければ選択開始／選択中なら登録
function pressCursor() {
  if (sel) { endSel(true); return; }
  const e = entryAt(cursor.day, cursor.slot);
  if (state.placing) {
    // 置く場所選びの最中は、1回で30分枠として入力画面を開く
    if (e) toast('空いている枠を選んでください');
    else if (beginSelAt(cursor.day, cursor.slot)) endSel(true);
  } else if (e) openEntry(e);
  else beginSelAt(cursor.day, cursor.slot);
}

// ---------- 範囲選択（ドラッグ／長押しスライド／キー） ----------
let sel = null;

// アンカー位置から、既存の予定にぶつからずに伸ばせる範囲
function freeRange(day, anchor) {
  let lo = minSlot(), hi = maxSlot();
  for (const e of dayEntries(day)) {
    if (e.end_slot <= anchor) lo = Math.max(lo, e.end_slot);
    else if (e.start_slot > anchor) hi = Math.min(hi, e.start_slot);
    else return null; // アンカー自体が埋まっている
  }
  return { lo, hi };
}

function beginSelAt(day, slot) {
  endSel(false);
  const col = colOf(day);
  const free = col && freeRange(day, slot);
  if (!free) return false;
  const box = el('div', 'sel');
  col.append(box);
  sel = { col, day, anchor: slot, cur: slot, ...free, box };
  drawSel();
  return true;
}

function selRange() {
  return { start: Math.min(sel.anchor, sel.cur), end: Math.max(sel.anchor, sel.cur) + 1 };
}

function drawSel() {
  const { start, end } = selRange();
  sel.box.style.top = (start - minSlot()) * rowPx + 'px';
  sel.box.style.height = (end - start) * rowPx + 'px';
  sel.box.textContent = `${slotLabel(start)}–${slotLabel(end)}`;
}

function updateSelTo(slot) {
  if (!sel) return;
  slot = Math.min(Math.max(slot, sel.lo), sel.hi - 1);
  if (slot === sel.cur) return;
  sel.cur = slot;
  drawSel();
}

function endSel(commit) {
  if (!sel) return;
  let { start, end } = selRange();
  const { day, box, hi } = sel;
  sel = null;
  if (!commit) { box.remove(); return; }
  const item = state.placing;
  if (item) {
    // inbox から置くときは、1枠だけの指定なら30分にする（次の予定の手前まで）
    if (end - start === 1) end = Math.min(start + 2, hi);
    openEntry({ day, start_slot: start, end_slot: end, category_id: item.category_id, title: item.title },
      () => { box.remove(); stopPlacing(); }, item);
  } else {
    openEntry({ day, start_slot: start, end_slot: end, category_id: null, title: '' }, () => box.remove());
  }
}

// ---------- 予定の移動・長さ変更（ドラッグ） ----------
let drag = null;

function beginDrag(entry, mode, x, y) {
  const col = colOf(entry.day);
  if (!col) return false;
  const src = col.querySelector(`.entry[data-id="${entry.id}"]`);
  src?.classList.add('dragging');
  const ghost = entryEl(entry);
  ghost.classList.add('ghost');
  drag = {
    entry, mode, src, ghost,
    grab: slotAt(col, y) - entry.start_slot,
    day: entry.day, start: entry.start_slot, end: entry.end_slot, valid: true,
  };
  updateDrag(x, y);
  return true;
}

function updateDrag(x, y) {
  const e = drag.entry;
  const dur = e.end_slot - e.start_slot;
  let day = drag.day, start, end;
  if (drag.mode === 'move') {
    day = colAtX(x)?.dataset.day || day;
    start = Math.min(Math.max(slotAt(colOf(day), y) - drag.grab, minSlot()), Math.max(minSlot(), maxSlot() - dur));
    end = start + dur;
  } else {
    start = e.start_slot;
    end = Math.min(Math.max(slotAt(colOf(day), y) + 1, start + 1), maxSlot());
  }
  Object.assign(drag, { day, start, end, valid: !overlaps(day, start, end, e.id) });

  const g = drag.ghost;
  const col = colOf(day);
  if (g.parentNode !== col) col.append(g);
  g.style.top = (start - minSlot()) * rowPx + 1 + 'px';
  g.style.height = (end - start) * rowPx - 2 + 'px';
  g.classList.toggle('short', end - start <= 2);
  g.classList.toggle('invalid', !drag.valid);
  g.querySelector('.time').textContent = `${slotLabel(start)}–${slotLabel(end)}`;
  autoScroll(y);
}

function endDrag(commit) {
  if (!drag) return;
  const d = drag;
  drag = null;
  d.ghost.remove();
  d.src?.classList.remove('dragging');
  const e = d.entry;
  if (!commit || (d.day === e.day && d.start === e.start_slot && d.end === e.end_slot)) return;
  if (!d.valid) { toast('他の予定と重なるため移動できません'); return; }
  setCursor(d.day, d.start);
  saveMoved(e, { day: d.day, start_slot: d.start, end_slot: d.end });
}

// 先に画面へ反映し、保存に失敗したら元に戻す
async function saveMoved(e, patch) {
  const before = { ...e };
  removeLocal(e);
  Object.assign(e, patch);
  dayEntries(e.day).push(e);
  render();
  try {
    Object.assign(e, await store.saveEntry(e));
  } catch (err) {
    removeLocal(e);
    Object.assign(e, before);
    dayEntries(e.day).push(e);
    render();
    toast(err.message);
  }
}

// ---------- ボード上のマウス・タッチ操作 ----------
function bindBoard() {
  const board = $('#board');

  // マウス・ペン：空き枠ドラッグで範囲選択、予定ドラッグで移動、下端ドラッグで長さ変更
  let p = null;
  board.addEventListener('pointerdown', ev => {
    if (ev.pointerType === 'touch' || ev.button !== 0) return;
    const col = ev.target.closest('.col');
    if (!col) return;
    ev.preventDefault();
    const ent = ev.target.closest('.entry');
    if (ent) {
      p = { entry: findEntry(ent.dataset.id), mode: ev.target.closest('.grip') ? 'resize' : 'move', x: ev.clientX, y: ev.clientY };
    } else {
      const slot = slotAt(col, ev.clientY);
      setCursor(col.dataset.day, slot);
      if (!beginSelAt(col.dataset.day, slot)) return;
      p = { select: true };
    }
    try { board.setPointerCapture(ev.pointerId); } catch { /* 合成イベントなど */ }
  });
  board.addEventListener('pointermove', ev => {
    if (!p || ev.pointerType === 'touch') return;
    if (p.select) {
      updateSelTo(slotAt(sel.col, ev.clientY));
      setCursor(sel.day, sel.cur);
      autoScroll(ev.clientY);
      return;
    }
    if (!drag && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < 4) return;
    if (!drag) beginDrag(p.entry, p.mode, p.x, p.y);
    updateDrag(ev.clientX, ev.clientY);
  });
  board.addEventListener('pointerup', ev => {
    if (!p || ev.pointerType === 'touch') return;
    const q = p;
    p = null;
    if (q.select) endSel(true);
    else if (drag) endDrag(true);
    else {
      setCursor(q.entry.day, q.entry.start_slot);
      openEntry(q.entry);
    }
  });
  board.addEventListener('pointercancel', ev => {
    if (ev.pointerType === 'touch') return;
    p = null;
    endSel(false);
    endDrag(false);
  });

  // タッチ：タップ＝空き枠なら15分で登録／予定なら開く
  //         長押し→スライド＝空き枠なら範囲選択／予定なら移動
  //         普通のスワイプ＝スクロール
  let t = null;
  board.addEventListener('touchstart', ev => {
    if (ev.touches.length !== 1) { cancelTouch(); return; }
    const col = ev.target.closest('.col');
    if (!col) return;
    const ent = ev.target.closest('.entry');
    const pt = ev.touches[0];
    t = { x: pt.clientX, y: pt.clientY, col, entry: ent && findEntry(ent.dataset.id), moved: false };
    t.timer = setTimeout(() => {
      if (!t || t.moved) return;
      const ok = t.entry ? beginDrag(t.entry, 'move', t.x, t.y) : beginSelAt(col.dataset.day, slotAt(col, t.y));
      if (ok) navigator.vibrate?.(10);
    }, 300);
  }, { passive: true });
  board.addEventListener('touchmove', ev => {
    if (!t) return;
    const pt = ev.touches[0];
    if (sel || drag) {
      ev.preventDefault();
      if (sel) { updateSelTo(slotAt(sel.col, pt.clientY)); autoScroll(pt.clientY); }
      else updateDrag(pt.clientX, pt.clientY);
      return;
    }
    if (Math.abs(pt.clientX - t.x) > 8 || Math.abs(pt.clientY - t.y) > 8) { t.moved = true; clearTimeout(t.timer); }
  }, { passive: false });
  board.addEventListener('touchend', ev => {
    if (!t) return;
    clearTimeout(t.timer);
    const q = t;
    t = null;
    if (sel) { ev.preventDefault(); endSel(true); }
    else if (drag) { ev.preventDefault(); endDrag(true); }
    else if (!q.moved) {
      ev.preventDefault();
      if (q.entry) openEntry(q.entry);
      else if (beginSelAt(q.col.dataset.day, slotAt(q.col, q.y))) endSel(true);
    }
  });
  board.addEventListener('touchcancel', cancelTouch);
  function cancelTouch() {
    if (t) clearTimeout(t.timer);
    t = null;
    endSel(false);
    endDrag(false);
  }

  // inbox の項目をドロップ（PC）：落とした位置から30分（次の予定の手前まで）
  let preview = null;
  const dropRange = ev => {
    const col = ev.target.closest?.('.col') || colAtX(ev.clientX);
    if (!col) return null;
    const slot = slotAt(col, ev.clientY);
    const free = freeRange(col.dataset.day, slot);
    return free && { col, day: col.dataset.day, start: slot, end: Math.min(slot + 2, free.hi) };
  };
  const clearPreview = () => { preview?.remove(); preview = null; };
  board.addEventListener('dragover', ev => {
    if (!inboxDragging) return;
    const r = dropRange(ev);
    if (!r) { clearPreview(); return; } // 予定の上には落とせない
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    if (!preview) preview = el('div', 'sel');
    if (preview.parentNode !== r.col) r.col.append(preview);
    preview.style.top = (r.start - minSlot()) * rowPx + 'px';
    preview.style.height = (r.end - r.start) * rowPx + 'px';
    preview.textContent = `${slotLabel(r.start)}–${slotLabel(r.end)}`;
    autoScroll(ev.clientY);
  });
  board.addEventListener('dragleave', ev => { if (!board.contains(ev.relatedTarget)) clearPreview(); });
  board.addEventListener('drop', ev => {
    const item = inboxDragging;
    const r = item && dropRange(ev);
    clearPreview();
    if (!r) return;
    ev.preventDefault();
    setCursor(r.day, r.start);
    openEntry({ day: r.day, start_slot: r.start, end_slot: r.end, category_id: item.category_id, title: item.title }, null, item);
  });
  document.addEventListener('dragend', clearPreview);
}

// ---------- カテゴリの選択ボタン ----------
// 選択中のIDを返す関数を返す。allowNone なら「なし」も選べる
function renderChips(container, categoryId, initial, allowNone) {
  const active = state.categories.filter(c => !c.archived || c.id === categoryId);
  let chosen = initial;
  const items = allowNone ? [{ id: null, name: 'なし', color: '#8b949e' }, ...active] : active;
  container.replaceChildren(...items.map(c => {
    const b = el('button');
    b.type = 'button';
    b.textContent = c.name;
    b.style.setProperty('--c', c.color);
    b.onclick = () => { chosen = c.id; mark(); };
    b._id = c.id;
    return b;
  }));
  const mark = () => $$('button', container).forEach(b => b.classList.toggle('on', b._id === chosen));
  mark();
  return { get: () => chosen, active };
}

// ---------- 予定ダイアログ ----------
const entryDlg = $('#entry-dlg');
const entryForm = $('#entry-form');
let editing = null;
let onEntryClose = null;
let fromInbox = null; // inbox から置いた場合の元の項目

function fillSlotOptions(select, from, to) {
  select.replaceChildren(...Array.from({ length: to - from + 1 }, (_, i) => {
    const o = document.createElement('option');
    o.value = from + i;
    o.textContent = slotLabel(from + i);
    return o;
  }));
}
fillSlotOptions(entryForm.start, 0, 95);
fillSlotOptions(entryForm.end, 1, 96);

function openEntry(e, onClose, inboxItem) {
  editing = e;
  onEntryClose = onClose || null;
  fromInbox = inboxItem || null;
  entryForm.day.value = e.day;
  entryForm.start.value = e.start_slot;
  entryForm.end.value = e.end_slot;
  entryForm.elements.title.value = e.title || '';
  $('#entry-msg').textContent = '';
  $('#entry-del').hidden = !e.id;
  $('#entry-to-inbox').hidden = !e.id;
  updateCount();

  // 既存の予定・inbox でカテゴリ指定済みならそれを、新規なら前回使ったカテゴリを選んでおく
  const active = state.categories.filter(c => !c.archived || c.id === e.category_id);
  const initial = e.id || e.category_id ? e.category_id
    : active.some(c => c.id === state.lastCat) ? state.lastCat : active[0]?.id ?? null;
  entryForm.getChosen = renderChips($('#cat-chips'), e.category_id, initial, false).get;

  openDialog(entryDlg);
  // PCでは内容欄にすぐ入力できるように。スマホではキーボードが出て邪魔なので任意
  if (matchMedia('(pointer: fine)').matches) entryForm.elements.title.focus();
}

function updateCount() {
  $('#title-count').textContent = `${entryForm.elements.title.value.length}/20`;
}
entryForm.elements.title.addEventListener('input', updateCount);

entryDlg.addEventListener('close', () => {
  onEntryClose?.();
  onEntryClose = null;
  editing = null;
  fromInbox = null;
});

entryForm.addEventListener('submit', async ev => {
  ev.preventDefault();
  const row = {
    id: editing.id,
    day: entryForm.day.value,
    start_slot: +entryForm.start.value,
    end_slot: +entryForm.end.value,
    category_id: entryForm.getChosen(),
    title: entryForm.elements.title.value.trim(),
  };
  const msg = $('#entry-msg');
  if (!row.day) { msg.textContent = '日付を入れてください'; return; }
  if (row.end_slot <= row.start_slot) { msg.textContent = '終了は開始より後にしてください'; return; }
  if (!state.entries.has(row.day)) {
    // 表示範囲外の日に移した場合は、その日の予定を読み込んでから重なりを確認する
    state.entries.set(row.day, await store.listEntries(row.day, row.day).catch(() => []));
  }
  const clash = dayEntries(row.day).find(x => x.id !== row.id && x.start_slot < row.end_slot && row.start_slot < x.end_slot);
  if (clash) {
    msg.textContent = `${slotLabel(clash.start_slot)}–${slotLabel(clash.end_slot)} の予定と重なっています`;
    return;
  }
  try {
    const saved = await store.saveEntry(row);
    if (editing.id) removeLocal(editing);
    dayEntries(saved.day).push(saved);
    state.lastCat = row.category_id;
    ls.set('tb.lastCat', state.lastCat);
    const placed = fromInbox;
    entryDlg.close();
    render();
    if (placed) {
      // 予定として保存できたら inbox から消す（失敗しても予定は残るので、項目が二重になるだけ）
      await store.deleteInbox(placed.id).catch(err => toast(err.message));
      state.inbox = state.inbox.filter(i => i.id !== placed.id);
      renderInbox();
    }
  } catch (e) {
    msg.textContent = e.message;
  }
});

$('#entry-to-inbox').addEventListener('click', async () => {
  const e = editing;
  const title = e.title || catById(e.category_id)?.name || '（無題）';
  try {
    // 先に inbox へ入れてから予定を消す（途中で失敗しても消えてしまわない順番）
    const item = await store.saveInbox({ title, category_id: e.category_id });
    state.inbox.unshift(item);
    await store.deleteEntry(e.id);
    removeLocal(e);
    entryDlg.close();
    render();
    renderInbox();
    toast('inboxへ戻しました');
  } catch (err) {
    $('#entry-msg').textContent = err.message;
  }
});

$('#entry-del').addEventListener('click', async () => {
  const e = editing;
  try {
    await store.deleteEntry(e.id);
    removeLocal(e);
    entryDlg.close();
    render();
    toast('削除しました');
  } catch (err) {
    $('#entry-msg').textContent = err.message;
  }
});

function removeLocal(e) {
  const list = state.entries.get(e.day);
  if (list) state.entries.set(e.day, list.filter(x => x.id !== e.id));
}

// ---------- inbox ----------
let inboxDragging = null; // PCでドラッグ中の inbox 項目

async function loadInbox() {
  try {
    state.inbox = await store.listInbox();
  } catch (e) {
    toast('inboxの読み込みに失敗しました：' + e.message);
  }
  renderInbox();
}

function renderInbox() {
  const n = state.inbox.length;
  const badge = $('#inbox-count');
  badge.hidden = n === 0;
  badge.textContent = n;
  $('#inbox-empty').hidden = n > 0;
  $('#inbox-list').replaceChildren(...state.inbox.map(item => {
    const li = el('li');
    const cat = catById(item.category_id);
    if (cat) li.style.setProperty('--c', cat.color);
    li.textContent = item.title;
    li.title = (cat ? `${cat.name}：` : '') + item.title;
    if (state.placing?.id === item.id) li.classList.add('placing');
    li.onclick = () => openInboxItem(item);
    if (hasMouse) {
      li.draggable = true;
      li.addEventListener('dragstart', ev => {
        inboxDragging = item;
        ev.dataTransfer.effectAllowed = 'copy';
        ev.dataTransfer.setData('text/plain', item.title);
      });
      li.addEventListener('dragend', () => { inboxDragging = null; });
    }
    return li;
  }));
}

const isWide = () => matchMedia('(min-width: 701px)').matches;

function setInboxOpen(open) {
  $('#app').classList.toggle('inbox-open', open);
  if (isWide()) ls.set('tb.inboxOpen', open); // PCでは開閉を覚えておく
}

$('#inbox-add').addEventListener('submit', async ev => {
  ev.preventDefault();
  const input = ev.target.elements.title;
  const title = input.value.trim();
  if (!title) return;
  input.value = ''; // 続けて書けるように、保存を待たずに空にする
  try {
    state.inbox.unshift(await store.saveInbox({ title }));
    renderInbox();
  } catch (e) {
    input.value = title;
    toast(e.message);
  }
});
$('#inbox-add').elements.title.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') ev.target.blur();
});

// inbox の項目の編集
const inboxDlg = $('#inbox-dlg');
const inboxForm = $('#inbox-form');
let inboxEditing = null;

function openInboxItem(item) {
  inboxEditing = item;
  inboxForm.elements.title.value = item.title;
  $('#inbox-msg').textContent = '';
  inboxForm.getChosen = renderChips($('#inbox-chips'), item.category_id, item.category_id, true).get;
  openDialog(inboxDlg);
}

// 編集内容を保存して、保存後の項目を返す（変更がなければそのまま）
async function saveInboxEdit() {
  const item = inboxEditing;
  const title = inboxForm.elements.title.value.trim();
  const category_id = inboxForm.getChosen();
  if (!title) throw new Error('内容を入れてください');
  if (title === item.title && category_id === item.category_id) return item;
  const saved = await store.saveInbox({ id: item.id, title, category_id });
  state.inbox = state.inbox.map(i => (i.id === saved.id ? saved : i));
  renderInbox();
  return saved;
}

inboxForm.addEventListener('submit', async ev => {
  ev.preventDefault();
  try {
    await saveInboxEdit();
    inboxDlg.close();
  } catch (e) {
    $('#inbox-msg').textContent = e.message;
  }
});

$('#inbox-del').addEventListener('click', async () => {
  try {
    await store.deleteInbox(inboxEditing.id);
    state.inbox = state.inbox.filter(i => i.id !== inboxEditing.id);
    inboxDlg.close();
    renderInbox();
  } catch (e) {
    $('#inbox-msg').textContent = e.message;
  }
});

$('#inbox-place').addEventListener('click', async () => {
  try {
    const item = await saveInboxEdit();
    inboxDlg.close();
    startPlacing(item);
  } catch (e) {
    $('#inbox-msg').textContent = e.message;
  }
});

// 「時間割に置く」：次に選んだ空き枠へ置く
function startPlacing(item) {
  state.placing = item;
  if (!isWide()) setInboxOpen(false); // スマホではシートを閉じて時間割を見せる
  $('#place-text').textContent = `「${item.title}」を置く枠を${hasMouse ? 'クリック（または Space）' : 'タップ'}`;
  $('#place-bar').hidden = false;
  $('#board').classList.add('placing');
  renderInbox();
}

function stopPlacing() {
  if (!state.placing) return;
  state.placing = null;
  $('#place-bar').hidden = true;
  $('#board').classList.remove('placing');
  renderInbox();
}

// ---------- カテゴリ管理 ----------
const catDlg = $('#cat-dlg');

function renderCategoryList() {
  const list = $('#cat-list');
  const cats = state.categories;
  list.replaceChildren(...cats.map((c, i) => {
    const li = el('li', c.archived ? 'archived' : '');
    const color = Object.assign(el('input'), { type: 'color', value: c.color });
    color.onchange = () => updateCategory(c, { color: color.value });
    const name = Object.assign(el('input'), { type: 'text', value: c.name, maxLength: 20 });
    name.onchange = () => {
      const v = name.value.trim();
      if (v) updateCategory(c, { name: v }); else name.value = c.name;
    };
    const up = Object.assign(el('button'), { type: 'button', textContent: '↑', disabled: i === 0, title: '上へ' });
    up.onclick = () => swapCategory(i, i - 1);
    const down = Object.assign(el('button'), { type: 'button', textContent: '↓', disabled: i === cats.length - 1, title: '下へ' });
    down.onclick = () => swapCategory(i, i + 1);
    const vis = el('label');
    const cb = Object.assign(el('input'), { type: 'checkbox', checked: !c.archived });
    cb.onchange = () => updateCategory(c, { archived: !cb.checked });
    vis.append(cb, '表示');
    const del = Object.assign(el('button'), { type: 'button', textContent: '削除', className: 'danger' });
    del.onclick = async () => {
      if (!confirm(`「${c.name}」を削除しますか？\nこのカテゴリの予定は「未分類」になります。`)) return;
      await guard(async () => {
        await store.deleteCategory(c.id);
        state.entries.forEach(list => list.forEach(e => { if (e.category_id === c.id) e.category_id = null; }));
        state.inbox.forEach(i => { if (i.category_id === c.id) i.category_id = null; });
        await loadCategories();
      });
    };
    li.append(color, name, up, down, vis, del);
    return li;
  }));
}

async function updateCategory(c, patch) {
  await guard(async () => {
    Object.assign(c, await store.saveCategory({ ...c, ...patch }));
  });
}

async function swapCategory(i, j) {
  const cats = state.categories;
  [cats[i], cats[j]] = [cats[j], cats[i]];
  await guard(async () => {
    // 並び順を振り直し、変わったものだけ保存
    for (const [k, c] of cats.entries()) {
      if (c.sort_order !== k) { c.sort_order = k; await store.saveCategory(c); }
    }
  });
}

async function guard(fn) {
  try { await fn(); } catch (e) { toast(e.message); await loadCategories(); }
  renderCategoryList();
  render();
  renderInbox();
}

$('#cat-add').addEventListener('submit', async ev => {
  ev.preventDefault();
  const f = ev.target;
  const name = f.elements.name.value.trim();
  if (!name) return;
  await guard(async () => {
    const max = Math.max(-1, ...state.categories.map(c => c.sort_order));
    state.categories.push(await store.saveCategory({ name, color: f.color.value, sort_order: max + 1 }));
    f.elements.name.value = '';
  });
});

// ---------- 表示設定 ----------
const setDlg = $('#set-dlg');
const setForm = $('#set-form');
setForm.startHour.replaceChildren(...Array.from({ length: 24 }, (_, h) => new Option(`${h}:00`, h)));
setForm.endHour.replaceChildren(...Array.from({ length: 24 }, (_, h) => new Option(`${h + 1}:00`, h + 1)));

function openSettings() {
  setForm.startHour.value = settings.startHour;
  setForm.endHour.value = settings.endHour;
  setForm.weekStart.value = settings.weekStart;
  $('#set-msg').textContent = '';
  openDialog(setDlg);
}

setForm.addEventListener('submit', ev => {
  ev.preventDefault();
  const s = +setForm.startHour.value, e = +setForm.endHour.value;
  if (e <= s) { $('#set-msg').textContent = '終了は開始より後にしてください'; return; }
  Object.assign(settings, { startHour: s, endHour: e, weekStart: +setForm.weekStart.value });
  ls.set('tb.settings', settings);
  setDlg.close();
  refresh();
});

// ---------- CSV ----------
const csvDlg = $('#csv-dlg');
const csvForm = $('#csv-form');

function openCsv() {
  const days = visibleDays();
  csvForm.from.value = days[0];
  csvForm.to.value = days[days.length - 1];
  $('#csv-msg').textContent = '';
  openDialog(csvDlg);
}

csvForm.addEventListener('submit', async ev => {
  ev.preventDefault();
  const from = csvForm.from.value, to = csvForm.to.value;
  if (to < from) { $('#csv-msg').textContent = '期間の指定が逆です'; return; }
  try {
    const rows = await store.listEntries(from, to);
    const q = v => /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const lines = [['日付', '曜日', '開始', '終了', '時間(分)', 'カテゴリ', '内容']];
    for (const r of rows) {
      lines.push([
        r.day, WD[parseDay(r.day).getDay()], slotLabel(r.start_slot), slotLabel(r.end_slot),
        String((r.end_slot - r.start_slot) * 15), catById(r.category_id)?.name || '未分類', r.title,
      ]);
    }
    const csv = '﻿' + lines.map(l => l.map(q).join(',')).join('\r\n') + '\r\n'; // BOM付きでExcelの文字化けを防ぐ
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `timebox_${from}_${to}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    csvDlg.close();
    toast(`${rows.length}件を出力しました`);
  } catch (e) {
    $('#csv-msg').textContent = e.message;
  }
});

// ---------- 共通の操作 ----------
// キー操作（PC）
//   ↑↓ / k j：カーソル上下      ← → / h l：前後の日へ（週の端を越えると週も移動）
//   Space / Enter：予定があれば開く／なければ選択開始→もう一度で登録
//   Esc：選択・配置を取り消し   T：今日   D / W：日表示・週表示   I：inbox に書く
function onKey(e) {
  if ($('#app').hidden || $('dialog[open]') || e.target.matches?.('input, select, textarea')
    || e.ctrlKey || e.metaKey || e.altKey) return;
  // ヘッダーのボタンにフォーカスが残っているとスペースで押されてしまうので外す
  if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
  const k = e.key;
  if (k === 'Escape') { endSel(false); endDrag(false); stopPlacing(); $('#menu').hidden = true; return; }
  if (k === 'i') {
    e.preventDefault(); // 入力欄に「i」が入らないように
    setInboxOpen(true);
    $('#inbox-add').elements.title.focus();
    return;
  }
  if (k === 't') return goToday();
  if (k === 'd') return setView('day');
  if (k === 'w') return setView('week');
  if (drag) return;
  if (!cursor) {
    // カーソルがない端末（タッチ主体）では ← → でページ送りだけ
    if (k === 'ArrowLeft') move(-1);
    if (k === 'ArrowRight') move(1);
    return;
  }
  if (k === 'ArrowUp' || k === 'k') stepSlot(-1);
  else if (k === 'ArrowDown' || k === 'j') stepSlot(1);
  else if (k === 'ArrowLeft' || k === 'h') { if (!sel) stepDay(-1); }
  else if (k === 'ArrowRight' || k === 'l') { if (!sel) stepDay(1); }
  else if (k === ' ' || k === 'Enter') { if (!e.repeat) pressCursor(); }
  else return;
  e.preventDefault();
}

function setView(v) {
  if (v === 'day' && cursor) state.anchor = cursor.day;
  state.view = v;
  ls.set('tb.view', v);
  refresh();
}

// スマホでは開いた直後に入力欄へフォーカスが当たると、ピッカーやキーボードが勝手に出るので外す
function openDialog(d) {
  d.showModal();
  if (!hasMouse && document.activeElement?.matches('input, select, textarea')) document.activeElement.blur();
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
}

function bindStatic() {
  $('#prev').onclick = () => move(-1);
  $('#next').onclick = () => move(1);
  $('#today').onclick = goToday;
  $$('.seg button').forEach(b => { b.onclick = () => setView(b.dataset.view); });

  const menu = $('#menu');
  $('#menu-btn').onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.addEventListener('click', async e => {
    const act = e.target.dataset.act;
    if (act === 'csv') openCsv();
    if (act === 'categories') { renderCategoryList(); openDialog(catDlg); }
    if (act === 'settings') openSettings();
    if (act === 'keys') openDialog($('#keys-dlg'));
    if (act === 'logout') await store.signOut();
  });

  $$('[data-close]').forEach(b => { b.onclick = () => b.closest('dialog').close(); });
  // ダイアログの外側をクリックで閉じる
  $$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

  document.addEventListener('keydown', onKey);

  // 別の端末で入れた予定を、画面に戻ってきたときに反映する
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !$('#app').hidden && !$('dialog[open]') && !sel && !drag) {
      refresh();
      loadInbox();
    }
  });

  $('#inbox-btn').onclick = () => setInboxOpen(!$('#app').classList.contains('inbox-open'));
  $('#inbox-close').onclick = () => setInboxOpen(false);
  $('#place-cancel').onclick = stopPlacing;

  bindBoard();

  // ログイン
  const lf = $('#login-form');
  const lmsg = $('#login-msg');
  lf.addEventListener('submit', async ev => {
    ev.preventDefault();
    lmsg.textContent = '';
    try {
      await store.signIn(lf.email.value, lf.password.value);
      await startApp();
    } catch (e) { lmsg.textContent = e.message; }
  });
  $('#signup-btn').onclick = async () => {
    if (!lf.reportValidity()) return;
    lmsg.textContent = '';
    try {
      const ready = await store.signUp(lf.email.value, lf.password.value);
      if (ready) await startApp();
      else lmsg.textContent = '確認メールを送りました。メール内のリンクを開いてからログインしてください。';
    } catch (e) { lmsg.textContent = e.message; }
  };
}
