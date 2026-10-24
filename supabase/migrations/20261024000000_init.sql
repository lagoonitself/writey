-- Writey initial schema. See docs/ARCHITECTURE.md §9.
-- Every table is owned by one user; RLS limits rows to auth.uid().

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  settings     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

-- Create a profile row whenever someone signs up.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.email));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- notebooks and pages
-- ---------------------------------------------------------------------------
create table public.notebooks (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title      text not null default 'Untitled notebook',
  sort_key   text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index notebooks_owner_idx on public.notebooks (owner_id, sort_key) where deleted_at is null;

create table public.pages (
  id          uuid primary key default gen_random_uuid(),
  notebook_id uuid not null references public.notebooks (id) on delete cascade,
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  sort_key    text not null,
  width       real not null default 595,   -- PDF points; A4
  height      real not null default 842,
  background  jsonb not null default '{"kind":"blank"}'::jsonb,
  content_key text,                         -- R2 object key of the gzipped ink blob
  version     integer not null default 0,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index pages_notebook_idx on public.pages (notebook_id, sort_key) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- uploaded files (bytes live in R2)
-- ---------------------------------------------------------------------------
create table public.assets (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('pdf', 'image')),
  r2_key     text not null unique,
  bytes      bigint not null check (bytes >= 0),
  sha256     text not null,
  page_count integer,
  created_at timestamptz not null default now()
);
create index assets_owner_idx on public.assets (owner_id);

-- ---------------------------------------------------------------------------
-- AI conversation memory, one thread per page
-- ---------------------------------------------------------------------------
create table public.ai_threads (
  id         uuid primary key default gen_random_uuid(),
  page_id    uuid not null unique references public.pages (id) on delete cascade,
  owner_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  summary    text,
  updated_at timestamptz not null default now()
);

create table public.ai_messages (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null references public.ai_threads (id) on delete cascade,
  owner_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role       text not null check (role in ('user', 'assistant')),
  content    jsonb not null,
  model      text,
  usage      jsonb,
  created_at timestamptz not null default now()
);
create index ai_messages_thread_idx on public.ai_messages (thread_id, created_at);

-- ---------------------------------------------------------------------------
-- encrypted provider keys — Worker (service role) only
-- ---------------------------------------------------------------------------
create table public.provider_credentials (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  provider    text not null check (provider in ('openrouter', 'opencode-zen', 'gemini')),
  label       text,
  ciphertext  bytea not null,
  iv          bytea not null,
  key_version integer not null default 1,
  last4       text not null,
  created_at  timestamptz not null default now(),
  unique (owner_id, provider)
);

-- ---------------------------------------------------------------------------
-- keep updated_at fresh
-- ---------------------------------------------------------------------------
create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger notebooks_touch before update on public.notebooks
  for each row execute function public.touch_updated_at();
create trigger pages_touch before update on public.pages
  for each row execute function public.touch_updated_at();
create trigger ai_threads_touch before update on public.ai_threads
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- row-level security
-- ---------------------------------------------------------------------------
alter table public.profiles             enable row level security;
alter table public.notebooks            enable row level security;
alter table public.pages                enable row level security;
alter table public.assets               enable row level security;
alter table public.ai_threads           enable row level security;
alter table public.ai_messages          enable row level security;
alter table public.provider_credentials enable row level security;

create policy "own profile" on public.profiles
  for all to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "own notebooks" on public.notebooks
  for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

-- A page must belong to a notebook the user owns.
create policy "own pages" on public.pages
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.notebooks n
                where n.id = notebook_id and n.owner_id = (select auth.uid()))
  );

create policy "own assets" on public.assets
  for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

create policy "own threads" on public.ai_threads
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.pages p
                where p.id = page_id and p.owner_id = (select auth.uid()))
  );

create policy "own messages" on public.ai_messages
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.ai_threads t
                where t.id = thread_id and t.owner_id = (select auth.uid()))
  );

-- provider_credentials: RLS on, no policies → no client access at all.
-- The UI reads key metadata through the Worker.
