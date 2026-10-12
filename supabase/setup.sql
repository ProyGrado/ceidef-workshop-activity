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
  (6, 'Información de medicamentos');

create table public.ideas (
  id uuid primary key default gen_random_uuid(),
  author_id uuid references auth.users(id),
  position text not null default '' constraint ideas_position_check check (length(btrim(position)) between 0 and 500),
  task text not null constraint ideas_task_check check (length(btrim(task)) between 1 and 500),
  information text not null default '' constraint ideas_information_check check (length(btrim(information)) between 0 and 500),
  supervisor text not null default '' constraint ideas_supervisor_check check (length(btrim(supervisor)) between 0 and 500),
  boundaries text not null default '' constraint ideas_boundaries_check check (length(btrim(boundaries)) between 0 and 500),
  success_criteria text not null default '' constraint ideas_success_criteria_check check (length(btrim(success_criteria)) between 0 and 500),
  organizer boolean not null default false,
  preset boolean not null default false,
  title text not null default '',
  created_at timestamptz not null default now(),
  constraint ideas_preset_author_check check (
    (preset and author_id is null and organizer and length(btrim(title)) between 1 and 150)
    or (not preset and author_id is not null and title = '')
  )
);
create index ideas_author_idx on public.ideas(author_id);

create table public.classifications (
  user_id uuid not null references public.participants(user_id),
  idea_id uuid not null references public.ideas(id) on delete cascade,
  area_ids smallint[] not null default '{}' constraint classifications_areas_check check (
    cardinality(area_ids) <= 6 and (array_ndims(area_ids) is null or array_ndims(area_ids) = 1)
    and array_position(area_ids, null) is null and area_ids <@ array[1,2,3,4,5,6]::smallint[]
  ),
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
  (not preset or (select ceidef_private.phase()) in ('classification', 'results')) and (
    (select public.is_moderator()) or (
      (select ceidef_private.is_participant()) and (
        author_id = (select auth.uid()) or (select ceidef_private.phase()) in ('classification', 'results')
      )
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
revoke all on ceidef_private.moderators from public, anon, authenticated;
grant select on public.workshops, public.participants, public.areas, public.ideas, public.classifications to authenticated;
grant insert (author_id, position, task, information, supervisor, boundaries, success_criteria, organizer),
  update (position, task, information, supervisor, boundaries, success_criteria), delete on public.ideas to authenticated;
grant insert (user_id, idea_id, area_ids), update (area_ids) on public.classifications to authenticated;

-- Este lock es compartido con TODAS las escrituras de ideas/clasificaciones.
-- El cambio de fase usa un lock exclusivo: cierre y escrituras concurrentes se
-- serializan. No alcanza con consultar la fase desde una política RLS.
create function ceidef_private.guard_idea() returns trigger
language plpgsql security definer set search_path = '' as $$
declare current_phase text; owner_id uuid; is_team boolean;
begin
  -- Dos operaciones administrativas puntuales; nunca se habilitan para los
  -- roles de la API, aunque falte el JWT. SECURITY DEFINER NO cambia el GUC role.
  if auth.uid() is null and current_setting('role', true) in ('none', 'postgres') then
    if TG_OP = 'INSERT' and NEW.preset then return NEW; end if;
    if TG_OP = 'DELETE' and not OLD.preset then return OLD; end if;
  end if;
  if TG_OP = 'DELETE' then
    if OLD.preset then raise exception 'Las ideas predeterminadas son permanentes.'; end if;
  else
    if NEW.preset then raise exception 'Las ideas predeterminadas son permanentes.'; end if;
    if TG_OP = 'UPDATE' and (NEW.preset, NEW.title) is distinct from (OLD.preset, OLD.title) then
      raise exception 'No se puede cambiar el tipo de una idea.';
    end if;
  end if;
  select phase into current_phase from public.workshops where id = 1 for share;
  if current_phase <> 'ideas' then raise exception 'La escritura de ideas está cerrada.'; end if;
  if TG_OP = 'DELETE' then owner_id := OLD.author_id; is_team := OLD.organizer;
  else owner_id := NEW.author_id; is_team := NEW.organizer; end if;
  if owner_id is distinct from auth.uid() then raise exception 'Solo podés modificar tus propias ideas.'; end if;
  if is_team then
    if not public.is_moderator() then raise exception 'Se requieren permisos de moderador.'; end if;
  else
    perform 1 from public.participants where user_id = owner_id for update;
    if not found or public.is_moderator() then raise exception 'Participante no registrado.'; end if;
    if TG_OP = 'INSERT' and (select count(*) from public.ideas where author_id = owner_id and not organizer) >= 10 then
      raise exception 'Podés guardar hasta 10 ideas.';
    end if;
  end if;
  if TG_OP = 'DELETE' then return OLD; end if;
  if TG_OP = 'UPDATE' and (NEW.id, NEW.author_id, NEW.organizer, NEW.created_at) is distinct from (OLD.id, OLD.author_id, OLD.organizer, OLD.created_at) then
    raise exception 'No se puede cambiar la identidad de una idea.';
  end if;
  NEW.position := btrim(NEW.position);
  NEW.task := btrim(NEW.task);
  NEW.information := btrim(NEW.information);
  NEW.supervisor := btrim(NEW.supervisor);
  NEW.boundaries := btrim(NEW.boundaries);
  NEW.success_criteria := btrim(NEW.success_criteria);
  return NEW;
end;
$$;
create trigger guard_idea before insert or update or delete on public.ideas
  for each row execute function ceidef_private.guard_idea();

create function ceidef_private.guard_ideas_truncate() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'No se puede vaciar ideas con TRUNCATE. Usá el reset.sql actualizado para conservar las ideas predeterminadas.';
end;
$$;
drop trigger if exists guard_ideas_truncate on public.ideas;
create trigger guard_ideas_truncate before truncate on public.ideas
  for each statement execute function ceidef_private.guard_ideas_truncate();


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
  if NEW.area_ids is null or coalesce(array_ndims(NEW.area_ids), 1) <> 1 or cardinality(NEW.area_ids) > 6
    or array_position(NEW.area_ids, null) is not null
    or not (NEW.area_ids <@ array[1,2,3,4,5,6]::smallint[]) then
    raise exception 'Elegí áreas válidas, del 1 al 6, o guardá sin áreas.';
  end if;
  -- Un área no puede duplicarse dentro de una misma respuesta.
  NEW.area_ids := array(select distinct value from unnest(NEW.area_ids) as chosen(value) order by value);
  NEW.updated_at := now();
  return NEW;
end;
$$;
create trigger guard_classification before insert or update on public.classifications
  for each row execute function ceidef_private.guard_classification();

-- Invoker: el upsert conserva RLS, permisos y triggers, también entre pestañas.
create function public.classify_idea(target_idea uuid, selected_areas smallint[]) returns void
language sql security invoker set search_path = '' as $$
  insert into public.classifications(user_id, idea_id, area_ids)
    values (auth.uid(), target_idea, selected_areas)
    on conflict (user_id, idea_id) do update set area_ids = excluded.area_ids;
$$;

create function public.join_workshop(participant_name text) returns public.participants
language plpgsql security definer set search_path = '' as $$
declare existing public.participants; current_phase text;
begin
  if auth.uid() is null then raise exception 'Iniciá una sesión para ingresar.'; end if;
  if public.is_moderator() then raise exception 'El moderador no ocupa un lugar de participante.'; end if;
  -- Lock exclusivo para que dos ingresos no excedan juntos los 100 lugares.
  select phase into current_phase from public.workshops where id = 1 for update;
  select * into existing from public.participants where user_id = auth.uid();
  if found then return existing; end if;
  if current_phase <> 'waiting' then raise exception 'El ingreso cerró cuando comenzó la actividad.'; end if;
  if (select count(*) from public.participants) >= 100 then raise exception 'La actividad ya tiene 100 participantes.'; end if;
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
  return query select p.user_id, p.name, count(c.idea_id),
    (select count(*) from public.ideas i where not i.preset or ceidef_private.phase() in ('classification', 'results'))
    from public.participants p left join public.classifications c on c.user_id = p.user_id
    group by p.user_id, p.name, p.created_at order by p.created_at;
end;
$$;

create function public.get_results() returns table (idea_id uuid, area_id smallint, votes bigint, total bigint, no_area bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if ceidef_private.phase() <> 'results' then raise exception 'Los resultados todavía están cerrados.'; end if;
  if not (public.is_moderator() or ceidef_private.is_participant()) then raise exception 'Ingresá a la actividad para ver los resultados.'; end if;
  -- CROSS JOIN incluye todas las áreas, incluso las que no recibieron votos.
  return query select i.id, a.id, count(c.user_id),
    (select count(*) from public.classifications c2 where c2.idea_id = i.id),
    (select count(*) from public.classifications c3 where c3.idea_id = i.id and cardinality(c3.area_ids) = 0)
    from public.ideas i cross join public.areas a
    left join public.classifications c on c.idea_id = i.id and a.id = any(c.area_ids)
    group by i.id, a.id order by i.id, a.id;
end;
$$;

-- Revocar el EXECUTE que Postgres otorga por defecto a PUBLIC.
revoke all on function public.is_moderator(), public.join_workshop(text), public.advance_phase(text), public.get_progress(), public.get_results(), public.classify_idea(uuid, smallint[]) from public, anon, authenticated;
grant execute on function public.is_moderator(), public.join_workshop(text), public.advance_phase(text), public.get_progress(), public.get_results(), public.classify_idea(uuid, smallint[]) to authenticated;
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
-- BEGIN PRESET DATA: UUIDs estables; ninguna cuenta ficticia de Auth.
insert into public.ideas(id, author_id, organizer, preset, title, position, task, information, supervisor, boundaries, success_criteria) values
(
  'ce1def00-0000-4000-8000-000000000001', null, true, true,
  'Asistente para revisar combinaciones de medicamentos',
  'Asistente de revisión de medicamentos.',
  $task1$• Revisar los medicamentos que toma una persona y avisar si alguna combinación puede causar problemas.
• Proponer otras opciones para que el equipo las evalúe.
• Detectar medicamentos que cumplen la misma función o que podrían no ser adecuados para esa persona.$task1$,
  'La lista de medicamentos de la persona, información relevante sobre su salud y fuentes confiables sobre medicamentos.',
  'Un médico y un profesional especializado en medicamentos.',
  'Cambiar una receta o indicar que se deje de tomar un medicamento.',
  'Si encuentra combinaciones problemáticas y da avisos útiles, sin llenar al equipo de alertas innecesarias.'
),
(
  'ce1def00-0000-4000-8000-000000000002', null, true, true,
  'Asistente para detectar posibles problemas con medicamentos',
  'Asistente de seguimiento de efectos no deseados.',
  $task2$• Revisar reportes sobre posibles efectos no deseados de medicamentos.
• Buscar casos parecidos o problemas que se estén repitiendo.
• Avisar al equipo cuando encuentre algo que merezca investigarse.$task2$,
  'Reportes de posibles reacciones a medicamentos, datos generales de las personas y registros de casos anteriores.',
  'La persona responsable de farmacovigilancia.',
  'Afirmar por su cuenta que un medicamento causó un problema de salud.',
  'Si encuentra patrones que el equipo considera importantes y muestra qué reportes respaldan sus avisos.'
),
(
  'ce1def00-0000-4000-8000-000000000003', null, true, true,
  'Asistente para explicar el uso de medicamentos',
  'Asistente de información para pacientes.',
  $task3$• Explicar información sobre medicamentos con palabras fáciles de entender.
• Preparar imágenes y materiales que ayuden a seguir el tratamiento y usar los medicamentos correctamente.
• Responder preguntas habituales sobre cómo guardarlos, cómo tomarlos y qué efectos no deseados pueden aparecer.$task3$,
  'Prospectos oficiales, guías de salud y preguntas que suelen hacer los pacientes del Hospital de Clínicas.',
  'Un farmacéutico y una persona del equipo de comunicación.',
  'Dar indicaciones médicas para un caso particular o reemplazar la consulta con un profesional.',
  'Si las personas entienden las explicaciones y el equipo confirma que la información es correcta.'
)
on conflict (id) do nothing;
-- END PRESET DATA
commit;
