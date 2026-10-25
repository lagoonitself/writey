-- Provider keys: only OpenRouter and OpenCode Zen are stored (ChatGPT lives in the Helper).
-- The Worker encrypts keys and talks to Postgres as the signed-in user, so it never holds
-- the service-role key. Clients may list key metadata but never read the ciphertext
-- columns; the Worker fetches those through provider_secret(). The ciphertext is useless
-- without the Worker's master key anyway (docs/ARCHITECTURE.md §6.2).

alter table public.provider_credentials
  drop constraint provider_credentials_provider_check;
alter table public.provider_credentials
  add constraint provider_credentials_provider_check
  check (provider in ('openrouter', 'opencode-zen'));

alter table public.provider_credentials
  alter column owner_id set default auth.uid();

revoke all on public.provider_credentials from anon, authenticated;
grant select (id, owner_id, provider, label, key_version, last4, created_at)
  on public.provider_credentials to authenticated;
grant insert (provider, label, ciphertext, iv, key_version, last4, created_at),
      update (provider, label, ciphertext, iv, key_version, last4, created_at),
      delete
  on public.provider_credentials to authenticated;

create policy "own credentials" on public.provider_credentials
  for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

create function public.provider_secret(p_provider text)
returns table (ciphertext bytea, iv bytea, key_version integer)
language sql
stable
security definer
set search_path = ''
as $$
  select c.ciphertext, c.iv, c.key_version
  from public.provider_credentials c
  where c.owner_id = (select auth.uid()) and c.provider = p_provider;
$$;

revoke execute on function public.provider_secret(text) from public, anon;
grant execute on function public.provider_secret(text) to authenticated;
