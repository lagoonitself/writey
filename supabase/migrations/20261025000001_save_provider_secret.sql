-- Upserting through PostgREST needs SELECT on every column, which would expose the
-- ciphertext. Writes go through this function instead, so clients keep metadata-only
-- access. The Worker encrypts before calling it.

revoke insert, update on public.provider_credentials from authenticated;

create function public.save_provider_secret(
  p_provider text,
  p_label text,
  p_ciphertext bytea,
  p_iv bytea,
  p_key_version integer,
  p_last4 text
)
returns timestamptz
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.provider_credentials
    (owner_id, provider, label, ciphertext, iv, key_version, last4, created_at)
  values
    ((select auth.uid()), p_provider, p_label, p_ciphertext, p_iv, p_key_version, p_last4, now())
  on conflict (owner_id, provider) do update set
    label = excluded.label,
    ciphertext = excluded.ciphertext,
    iv = excluded.iv,
    key_version = excluded.key_version,
    last4 = excluded.last4,
    created_at = excluded.created_at
  returning created_at;
$$;

revoke execute on function public.save_provider_secret(text, text, bytea, bytea, integer, text)
  from public, anon;
grant execute on function public.save_provider_secret(text, text, bytea, bytea, integer, text)
  to authenticated;
