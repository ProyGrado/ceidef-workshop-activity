-- CEIDEF: ejecutar UNA VEZ en el SQL Editor de un proyecto Supabase.
-- Transaccional: ante un error no deja una instalación parcial.
begin;

create schema if not exists ceidef_private;
revoke all on schema ceidef_private from public, anon, authenticated;

create table public.workshops (
  id smallint primary key check (id = 1),
  title text not null default 'Laboratorio de ideas',
  phase text not null default 'waiting' check (phase in ('waiting', 'ideas', 'classification', 'results')),
  updated_at timestamptz not null default now()
);
insert into public.workshops (id) values (1);

create table ceidef_private.moderators (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create table public.participants (
  user_id uuid primary key references auth.users(id),
  name text not null check (length(btrim(name)) between 1 and 60),
  created_at timestamptz not null default now()
);

create table public.areas (
  id smallint primary key,
  name text unique not null
);
insert into public.areas values
  (1, 'Individualización de tratamientos'),
  (2, 'Farmacovigilancia'),
  (3, 'Seguimiento farmacoterapéutico'),
  (4, 'Acceso y sostenibilidad'),
  (5, 'Estandarización de procesos'),
  (6, 'Información de medicamentos'),
  (7, 'Transversal / no estoy seguro');

create table public.ideas (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id),
  content text not null check (length(btrim(content)) between 1 and 500),
  organizer boolean not null default false,
  created_at timestamptz not null default now()
);
create index ideas_author_idx on public.ideas(author_id);

create table public.classifications (
  user_id uuid not null references public.participants(user_id),
  idea_id uuid not null references public.ideas(id) on delete cascade,
  area_id smallint not null references public.areas(id),
  updated_at timestamptz not null default now(),
  primary key (user_id, idea_id)
);
create index classifications_idea_idx on public.classifications(idea_id);

-- Helpers de lectura: definer para evitar recursión de RLS. Sin parámetros
-- arbitrarios; siempre verifican al usuario del JWT y un search_path fijo.
create function public.is_moderator() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((auth.jwt()->>'is_anonymous')::boolean, true) = false
    and exists (select 1 from ceidef_private.moderators where user_id = auth.uid());
$$;
create function ceidef_private.is_participant() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.participants where user_id = auth.uid());
$$;
create function ceidef_private.phase() returns text
language sql stable security definer set search_path = '' as $$
  select phase from public.workshops where id = 1;
$$;

alter table public.workshops enable row level security;
alter table public.participants enable row level security;
alter table public.areas enable row level security;
alter table public.ideas enable row level security;
alter table public.classifications enable row level security;
alter table ceidef_private.moderators enable row level security;

create policy workshop_read on public.workshops for select to authenticated using (true);
create policy areas_read on public.areas for select to authenticated using (true);
create policy participants_read on public.participants for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_moderator()));
create policy ideas_read on public.ideas for select to authenticated using (
  (select public.is_moderator()) or (
    (select ceidef_private.is_participant()) and (
      author_id = (select auth.uid()) or (select ceidef_private.phase()) in ('classification', 'results')
    )
  )
);
create policy ideas_insert on public.ideas for insert to authenticated with check (
  author_id = (select auth.uid()) and (select ceidef_private.phase()) = 'ideas' and (
    (organizer and (select public.is_moderator())) or
    (not organizer and (select ceidef_private.is_participant()) and not (select public.is_moderator()))
  )
);
create policy ideas_update on public.ideas for update to authenticated
  using (author_id = (select auth.uid()) and (select ceidef_private.phase()) = 'ideas')
  with check (author_id = (select auth.uid()) and (select ceidef_private.phase()) = 'ideas');
create policy ideas_delete on public.ideas for delete to authenticated
  using (author_id = (select auth.uid()) and (select ceidef_private.phase()) = 'ideas');
-- Ni siquiera los moderadores pueden leer clasificaciones ajenas: el progreso
-- y los resultados se consultan mediante RPC que devuelven solo agregados.
create policy classifications_read on public.classifications for select to authenticated
  using (user_id = (select auth.uid()));
create policy classifications_insert on public.classifications for insert to authenticated with check (
  user_id = (select auth.uid()) and (select ceidef_private.is_participant())
  and (select ceidef_private.phase()) = 'classification'
);
create policy classifications_update on public.classifications for update to authenticated
  using (user_id = (select auth.uid()) and (select ceidef_private.phase()) = 'classification')
  with check (user_id = (select auth.uid()) and (select ceidef_private.phase()) = 'classification');

-- RLS y permisos de columna evitan cambiar identidades, marcas o fechas.
revoke all on public.workshops, public.participants, public.areas, public.ideas, public.classifications from public, anon, authenticated;
grant select on public.workshops, public.participants, public.areas, public.ideas, public.classifications to authenticated;
grant insert (author_id, content, organizer), update (content), delete on public.ideas to authenticated;
grant insert (user_id, idea_id, area_id), update (area_id) on public.classifications to authenticated;

-- Este lock es compartido con TODAS las escrituras de ideas/clasificaciones.
-- El cambio de fase usa un lock exclusivo: cierre y escrituras concurrentes se
-- serializan. No alcanza con consultar la fase desde una política RLS.
create function ceidef_private.guard_idea() returns trigger
language plpgsql security definer set search_path = '' as $$
declare current_phase text; owner_id uuid; is_team boolean;
begin
  select phase into current_phase from public.workshops where id = 1 for share;
  if current_phase <> 'ideas' then raise exception 'La escritura de ideas está cerrada.'; end if;
  if TG_OP = 'DELETE' then owner_id := OLD.author_id; is_team := OLD.organizer;
  else owner_id := NEW.author_id; is_team := NEW.organizer; end if;
  if owner_id is distinct from auth.uid() then raise exception 'Solo podés modificar tus propias ideas.'; end if;
  if is_team then
    if not public.is_moderator() then raise exception 'Se requieren permisos de moderador.'; end if;
  else
    -- Serializa inserciones simultáneas del mismo participante (máximo 3).
    perform 1 from public.participants where user_id = owner_id for update;
    if not found or public.is_moderator() then raise exception 'Participante no registrado.'; end if;
    if TG_OP = 'INSERT' and (select count(*) from public.ideas where author_id = owner_id and not organizer) >= 3 then
      raise exception 'Podés guardar hasta 3 ideas.';
    end if;
  end if;
  if TG_OP = 'DELETE' then return OLD; end if;
  if TG_OP = 'UPDATE' and (NEW.id, NEW.author_id, NEW.organizer, NEW.created_at) is distinct from (OLD.id, OLD.author_id, OLD.organizer, OLD.created_at) then
    raise exception 'No se puede cambiar la identidad de una idea.';
  end if;
  NEW.content := btrim(NEW.content);
  return NEW;
end;
$$;
create trigger guard_idea before insert or update or delete on public.ideas
  for each row execute function ceidef_private.guard_idea();

create function ceidef_private.guard_classification() returns trigger
language plpgsql security definer set search_path = '' as $$
declare current_phase text;
begin
  select phase into current_phase from public.workshops where id = 1 for share;
  if current_phase <> 'classification' then raise exception 'La clasificación está cerrada.'; end if;
  if NEW.user_id is distinct from auth.uid() or not ceidef_private.is_participant() then
    raise exception 'Solo podés guardar tus propias clasificaciones.';
  end if;
  if TG_OP = 'UPDATE' and (NEW.user_id, NEW.idea_id) is distinct from (OLD.user_id, OLD.idea_id) then
    raise exception 'No se puede cambiar la identidad de una clasificación.';
  end if;
  NEW.updated_at := now();
  return NEW;
end;
$$;
create trigger guard_classification before insert or update on public.classifications
  for each row execute function ceidef_private.guard_classification();

create function public.join_workshop(participant_name text) returns public.participants
language plpgsql security definer set search_path = '' as $$
declare existing public.participants; current_phase text;
begin
  if auth.uid() is null then raise exception 'Iniciá una sesión para ingresar.'; end if;
  if public.is_moderator() then raise exception 'El moderador no ocupa un lugar de participante.'; end if;
  -- Lock exclusivo para que dos ingresos no excedan juntos los 10 lugares.
  select phase into current_phase from public.workshops where id = 1 for update;
  select * into existing from public.participants where user_id = auth.uid();
  if found then return existing; end if;
  if current_phase <> 'waiting' then raise exception 'El ingreso cerró cuando comenzó la actividad.'; end if;
  if (select count(*) from public.participants) >= 10 then raise exception 'La actividad ya tiene 10 participantes.'; end if;
  if participant_name is null or length(btrim(participant_name)) not between 1 and 60 then
    raise exception 'Ingresá un nombre de entre 1 y 60 caracteres.';
  end if;
  insert into public.participants(user_id, name) values (auth.uid(), btrim(participant_name)) returning * into existing;
  return existing;
end;
$$;

create function public.advance_phase(expected_phase text) returns text
language plpgsql security definer set search_path = '' as $$
declare current_phase text; next_phase text;
begin
  if not public.is_moderator() then raise exception 'Se requieren permisos de moderador.'; end if;
  select phase into current_phase from public.workshops where id = 1 for update;
  if current_phase is distinct from expected_phase then raise exception 'La fase cambió. Actualizá antes de continuar.'; end if;
  next_phase := case current_phase when 'waiting' then 'ideas' when 'ideas' then 'classification' when 'classification' then 'results' end;
  if next_phase is null then raise exception 'La actividad ya finalizó.'; end if;
  update public.workshops set phase = next_phase, updated_at = now() where id = 1;
  return next_phase;
end;
$$;

create function public.get_progress() returns table (user_id uuid, name text, completed bigint, total bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_moderator() then raise exception 'Se requieren permisos de moderador.'; end if;
  return query select p.user_id, p.name, count(c.idea_id), (select count(*) from public.ideas)
    from public.participants p left join public.classifications c on c.user_id = p.user_id
    group by p.user_id, p.name, p.created_at order by p.created_at;
end;
$$;

create function public.get_results() returns table (idea_id uuid, area_id smallint, votes bigint, total bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if ceidef_private.phase() <> 'results' then raise exception 'Los resultados todavía están cerrados.'; end if;
  if not (public.is_moderator() or ceidef_private.is_participant()) then raise exception 'Ingresá a la actividad para ver los resultados.'; end if;
  -- CROSS JOIN incluye todas las áreas, incluso las que no recibieron votos.
  return query select i.id, a.id, count(c.user_id),
    (select count(*) from public.classifications c2 where c2.idea_id = i.id)
    from public.ideas i cross join public.areas a
    left join public.classifications c on c.idea_id = i.id and c.area_id = a.id
    group by i.id, a.id order by i.id, a.id;
end;
$$;

-- Revocar el EXECUTE que Postgres otorga por defecto a PUBLIC.
revoke all on function public.is_moderator(), public.join_workshop(text), public.advance_phase(text), public.get_progress(), public.get_results() from public, anon, authenticated;
grant execute on function public.is_moderator(), public.join_workshop(text), public.advance_phase(text), public.get_progress(), public.get_results() to authenticated;
revoke all on all functions in schema ceidef_private from public, anon, authenticated;
-- Los helpers usados por las políticas requieren USAGE/EXECUTE; el esquema no
-- debe incluirse en los esquemas expuestos de la API de Supabase.
grant usage on schema ceidef_private to authenticated;
grant execute on function ceidef_private.is_participant(), ceidef_private.phase() to authenticated;

-- Publicar solamente la fase. Las ideas y votos privados NO van a Realtime.
-- El cliente relee datos con RLS cada 5 s y al recuperar foco/conexión.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'workshops') then
    alter publication supabase_realtime add table public.workshops;
  end if;
end;
$$;
commit;
