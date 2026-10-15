-- タイムボクシング用スキーマ
-- Supabase の SQL Editor にこのファイルの中身を貼り付けて実行してください。
-- 何度実行しても安全です（既存のテーブル・データはそのまま。機能追加時は再実行してください）。

create extension if not exists btree_gist;

-- カテゴリ
create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null check (char_length(name) between 1 and 20),
  color       text not null default '#4f7cff',
  sort_order  int  not null default 0,
  archived    boolean not null default false,
  created_at  timestamptz not null default now()
);

-- 予定（15分 = 1スロット。0 = 00:00、96 = 24:00。end_slot は含まない）
create table if not exists public.entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  day         date not null,
  start_slot  int  not null check (start_slot between 0 and 95),
  end_slot    int  not null check (end_slot between 1 and 96),
  category_id uuid references public.categories on delete set null,
  title       text not null default '' check (char_length(title) <= 20),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (end_slot > start_slot),
  -- 同じ人・同じ日で時間帯が重なる予定は登録できない
  constraint entries_no_overlap
    exclude using gist (user_id with =, day with =, int4range(start_slot, end_slot) with &&)
);

create index if not exists entries_user_day on public.entries (user_id, day);

-- 予定の「ひとこと」：やってみてどうだったか（気分 1〜5 と短い文章。どちらも任意）
alter table public.entries add column if not exists mood smallint check (mood between 1 and 5);
alter table public.entries add column if not exists note text check (char_length(note) <= 100);

-- 日記（BEAT）：1日1件。A（行動）はその日の予定なので持たない。どの欄も任意
--   physical_level / physical_note : B 体の感覚（1〜5）とメモ
--   emotion_level  / emotion_note  : E 感情（1〜5）とメモ
--   body                           : T 思考（自由なメモ。旧「日のメモ」の本文をそのまま使う）
create table if not exists public.day_notes (
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  day         date not null,
  body        text,
  updated_at  timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.day_notes alter column body drop not null;
alter table public.day_notes drop constraint if exists day_notes_body_check;
alter table public.day_notes add constraint day_notes_body_check check (char_length(body) <= 1000);
alter table public.day_notes add column if not exists physical_level smallint check (physical_level between 1 and 5);
alter table public.day_notes add column if not exists physical_note  text check (char_length(physical_note) <= 200);
alter table public.day_notes add column if not exists emotion_level  smallint check (emotion_level between 1 and 5);
alter table public.day_notes add column if not exists emotion_note   text check (char_length(emotion_note) <= 200);

-- inbox：まだ時間を決めていないメモ（時間割に置いたら消える）
create table if not exists public.inbox (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  title       text not null check (char_length(title) between 1 and 20),
  category_id uuid references public.categories on delete set null,
  created_at  timestamptz not null default now()
);

-- Data API からの利用権限（ログイン済みユーザーのみ。未ログインの anon には付けない）
-- 「Automatically expose new tables」をオフにしたプロジェクトでも動くよう明示的に付与する
grant select, insert, update, delete on public.categories, public.entries, public.inbox, public.day_notes to authenticated;
revoke all on public.categories, public.entries, public.inbox, public.day_notes from anon;

-- 行レベルセキュリティ：自分のデータだけ読み書きできる
alter table public.categories enable row level security;
alter table public.entries    enable row level security;
alter table public.inbox      enable row level security;
alter table public.day_notes  enable row level security;

drop policy if exists "own categories" on public.categories;
create policy "own categories" on public.categories
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own entries" on public.entries;
create policy "own entries" on public.entries
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own inbox" on public.inbox;
create policy "own inbox" on public.inbox
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own day notes" on public.day_notes;
create policy "own day notes" on public.day_notes
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
