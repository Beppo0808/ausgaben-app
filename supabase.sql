-- Ausgaben-App: Synchronisation über Supabase
-- Einmalig im Supabase-Dashboard unter "SQL Editor" einfügen und auf "Run" klicken.
--
-- Sicherheit:
--  * Alle Inhalte werden schon auf euren Geräten Ende-zu-Ende-verschlüsselt (AES-256).
--    Hier landen nur unlesbare Daten – auch Supabase selbst kann sie nicht lesen.
--  * Die Tabelle ist über die API NICHT direkt zugänglich, nur über die beiden Funktionen
--    unten und nur mit der (aus dem geheimen Haushalts-Code abgeleiteten) Haushalts-Kennung.

create table if not exists public.sync_items (
  household  text        not null,
  kind       text        not null,
  id         text        not null,
  data       jsonb,
  mtime      bigint      not null,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (household, kind, id)
);

create index if not exists sync_items_pull_idx on public.sync_items (household, updated_at);

alter table public.sync_items enable row level security;
-- Keine Policies => kein direkter Zugriff über die API.
revoke all on public.sync_items from anon, authenticated;

-- Änderungen hochladen. Neuere Änderung (mtime) gewinnt.
create or replace function public.sync_push(p_household text, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if p_household is null or length(p_household) < 20 then
    raise exception 'Haushalts-Code ungültig';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 1000 then
    raise exception 'Ungültige Daten';
  end if;

  insert into public.sync_items as t (household, kind, id, data, mtime, deleted, updated_at)
  select p_household,
         i->>'kind',
         i->>'id',
         i->'data',  -- verschlüsselt (Ende-zu-Ende), für den Server unlesbar
         (i->>'mtime')::bigint,
         coalesce((i->>'deleted')::boolean, false),
         clock_timestamp()
  from jsonb_array_elements(p_items) as i
  where i->>'kind' in ('expense', 'sub', 'category', 'settings', 'rule')
    and length(i->>'id') between 1 and 200
  on conflict (household, kind, id) do update
    set data       = excluded.data,
        mtime      = excluded.mtime,
        deleted    = excluded.deleted,
        updated_at = clock_timestamp()
    where excluded.mtime >= t.mtime;

  get diagnostics n = row_count;
  return n;
end;
$$;

-- Änderungen seit einem Zeitpunkt abholen (seitenweise, max. 1000 pro Abruf).
create or replace function public.sync_pull(p_household text, p_since timestamptz)
returns table (kind text, id text, data jsonb, mtime bigint, deleted boolean, updated_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select s.kind, s.id, s.data, s.mtime, s.deleted, s.updated_at
  from public.sync_items s
  where s.household = p_household
    and length(p_household) >= 20
    and s.updated_at > p_since
  order by s.updated_at
  limit 1000;
$$;

revoke all on function public.sync_push(text, jsonb) from public;
revoke all on function public.sync_pull(text, timestamptz) from public;
grant execute on function public.sync_push(text, jsonb) to anon, authenticated;
grant execute on function public.sync_pull(text, timestamptz) to anon, authenticated;
