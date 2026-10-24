-- Trigger functions are not part of the API. Without this, PostgREST exposes
-- handle_new_user (security definer) at /rest/v1/rpc/handle_new_user.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
