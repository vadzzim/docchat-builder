-- Keep an owner settings race from ever persisting an enabled bot without origins.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bots'::regclass
      and conname = 'bots_published_requires_origin'
  ) then
    alter table public.bots
      add constraint bots_published_requires_origin
      check (not public_enabled or cardinality(allowed_origins) > 0);
  end if;
end;
$$;
