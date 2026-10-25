-- Conversations belong to the notebook, not the page: Writey keeps the context while you
-- move between pages. A notebook can hold several conversations; the newest is current.

alter table public.ai_threads add column notebook_id uuid references public.notebooks (id) on delete cascade;
alter table public.ai_threads add column title text;
alter table public.ai_threads add column created_at timestamptz not null default now();

update public.ai_threads t
set notebook_id = p.notebook_id
from public.pages p
where p.id = t.page_id;

update public.ai_threads t
set title = left((
  select m.content ->> 'text' from public.ai_messages m
  where m.thread_id = t.id and m.role = 'user'
  order by m.created_at limit 1
), 80);

delete from public.ai_threads where notebook_id is null;
alter table public.ai_threads alter column notebook_id set not null;

drop policy "own threads" on public.ai_threads;
alter table public.ai_threads drop column page_id;

create index ai_threads_notebook_idx on public.ai_threads (notebook_id, updated_at desc);

create policy "own threads" on public.ai_threads
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.notebooks n
                where n.id = notebook_id and n.owner_id = (select auth.uid()))
  );

-- A new message moves its conversation to the top of the list.
create function public.touch_thread()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.ai_threads set updated_at = now() where id = new.thread_id;
  return new;
end;
$$;
revoke execute on function public.touch_thread() from public, anon, authenticated;

create trigger ai_messages_touch_thread after insert on public.ai_messages
  for each row execute function public.touch_thread();
