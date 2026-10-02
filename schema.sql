-- タイムボクシング用スキーマ
-- Supabase の SQL Editor にこのファイルの中身を貼り付けて実行してください。

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

-- Data API からの利用権限（ログイン済みユーザーのみ。未ログインの anon には付けない）
-- 「Automatically expose new tables」をオフにしたプロジェクトでも動くよう明示的に付与する
grant select, insert, update, delete on public.categories, public.entries to authenticated;
revoke all on public.categories, public.entries from anon;

-- 行レベルセキュリティ：自分のデータだけ読み書きできる
alter table public.categories enable row level security;
alter table public.entries    enable row level security;

drop policy if exists "own categories" on public.categories;
create policy "own categories" on public.categories
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own entries" on public.entries;
create policy "own entries" on public.entries
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
