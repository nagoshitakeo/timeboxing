// データの読み書き。Supabase とローカル（デモ）の2実装を同じ形で提供する。

const ENTRY_FIELDS = ['day', 'start_slot', 'end_slot', 'category_id', 'title'];
const CATEGORY_FIELDS = ['name', 'color', 'sort_order', 'archived'];
const INBOX_FIELDS = ['title', 'category_id'];

const pick = (obj, keys) => Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]]));

export const OVERLAP_MESSAGE = '他の予定と時間が重なっています';

export async function createStore(url, key) {
  if (!url || !key) return localStore();
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  return supabaseStore(createClient(url, key));
}

function supabaseStore(sb) {
  const check = ({ data, error }) => {
    if (error) {
      if (error.code === '23P01') throw new Error(OVERLAP_MESSAGE);
      throw new Error(error.message);
    }
    return data;
  };

  return {
    mode: 'supabase',
    async getUser() {
      const { data } = await sb.auth.getSession();
      return data.session?.user ?? null;
    },
    onAuthChange(fn) {
      sb.auth.onAuthStateChange((_event, session) => fn(session?.user ?? null));
    },
    async signIn(email, password) {
      check(await sb.auth.signInWithPassword({ email, password }));
    },
    async signUp(email, password) {
      const data = check(await sb.auth.signUp({ email, password }));
      return !!data.session; // false ならメール確認待ち
    },
    async signOut() {
      await sb.auth.signOut();
    },

    async listCategories() {
      return check(await sb.from('categories').select('*').order('sort_order').order('created_at'));
    },
    async saveCategory(c) {
      const row = pick(c, CATEGORY_FIELDS);
      const q = c.id
        ? sb.from('categories').update(row).eq('id', c.id)
        : sb.from('categories').insert(row);
      return check(await q.select().single());
    },
    async deleteCategory(id) {
      check(await sb.from('categories').delete().eq('id', id));
    },

    async listEntries(from, to) {
      return check(await sb.from('entries').select('*').gte('day', from).lte('day', to)
        .order('day').order('start_slot'));
    },
    async saveEntry(e) {
      const row = pick(e, ENTRY_FIELDS);
      const q = e.id
        ? sb.from('entries').update({ ...row, updated_at: new Date().toISOString() }).eq('id', e.id)
        : sb.from('entries').insert(row);
      return check(await q.select().single());
    },
    async deleteEntry(id) {
      check(await sb.from('entries').delete().eq('id', id));
    },

    async listInbox() {
      return check(await sb.from('inbox').select('*').order('created_at', { ascending: false }));
    },
    async saveInbox(item) {
      const row = pick(item, INBOX_FIELDS);
      const q = item.id
        ? sb.from('inbox').update(row).eq('id', item.id)
        : sb.from('inbox').insert(row);
      return check(await q.select().single());
    },
    async deleteInbox(id) {
      check(await sb.from('inbox').delete().eq('id', id));
    },
  };
}

function localStore() {
  const KEY = 'tb.local';
  const read = () => {
    try { return JSON.parse(localStorage.getItem(KEY)) || { categories: [], entries: [] }; }
    catch { return { categories: [], entries: [] }; }
  };
  const write = db => {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* 保存できない環境では揮発 */ }
  };
  // localStorage が使えない環境でもセッション中は動くようメモリに保持
  let db = read();
  db.inbox ??= [];
  const commit = () => write(db);
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2));

  return {
    mode: 'local',
    async getUser() { return { id: 'local' }; },
    onAuthChange() {},
    async signIn() {},
    async signUp() { return true; },
    async signOut() {},

    async listCategories() {
      return [...db.categories].sort((a, b) => a.sort_order - b.sort_order);
    },
    async saveCategory(c) {
      const row = pick(c, CATEGORY_FIELDS);
      let saved;
      if (c.id) {
        saved = db.categories.find(x => x.id === c.id);
        Object.assign(saved, row);
      } else {
        saved = { id: uuid(), color: '#4f7cff', sort_order: 0, archived: false, ...row };
        db.categories.push(saved);
      }
      commit();
      return { ...saved };
    },
    async deleteCategory(id) {
      db.categories = db.categories.filter(c => c.id !== id);
      db.entries.forEach(e => { if (e.category_id === id) e.category_id = null; });
      db.inbox.forEach(i => { if (i.category_id === id) i.category_id = null; });
      commit();
    },

    async listEntries(from, to) {
      return db.entries.filter(e => e.day >= from && e.day <= to)
        .sort((a, b) => a.day.localeCompare(b.day) || a.start_slot - b.start_slot)
        .map(e => ({ ...e }));
    },
    async saveEntry(e) {
      const row = pick(e, ENTRY_FIELDS);
      const clash = db.entries.some(x => x.id !== e.id && x.day === row.day
        && x.start_slot < row.end_slot && row.start_slot < x.end_slot);
      if (clash) throw new Error(OVERLAP_MESSAGE);
      let saved;
      if (e.id) {
        saved = db.entries.find(x => x.id === e.id);
        Object.assign(saved, row);
      } else {
        saved = { id: uuid(), ...row };
        db.entries.push(saved);
      }
      commit();
      return { ...saved };
    },
    async deleteEntry(id) {
      db.entries = db.entries.filter(e => e.id !== id);
      commit();
    },

    async listInbox() {
      return [...db.inbox].sort((a, b) => b.created_at.localeCompare(a.created_at)).map(i => ({ ...i }));
    },
    async saveInbox(item) {
      const row = pick(item, INBOX_FIELDS);
      let saved;
      if (item.id) {
        saved = db.inbox.find(x => x.id === item.id);
        Object.assign(saved, row);
      } else {
        saved = { id: uuid(), category_id: null, created_at: new Date().toISOString(), ...row };
        db.inbox.push(saved);
      }
      commit();
      return { ...saved };
    },
    async deleteInbox(id) {
      db.inbox = db.inbox.filter(i => i.id !== id);
      commit();
    },
  };
}
