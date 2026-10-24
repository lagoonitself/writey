-- sort_key holds fractional-index strings (fractional-indexing package). They only
-- order correctly under byte-wise comparison, not the default locale collation.
alter table public.notebooks alter column sort_key type text collate "C";
alter table public.pages     alter column sort_key type text collate "C";
