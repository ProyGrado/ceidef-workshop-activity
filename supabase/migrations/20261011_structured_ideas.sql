-- Para una base que YA instaló la primera versión de setup.sql.
-- Ejecutar completo en SQL Editor como postgres, entre actividades.
-- Preserva ideas, votos, participantes, fase y moderadores. No usar reset.sql.
begin;
lock table public.workshops, public.participants, public.ideas, public.classifications
  in access exclusive mode nowait;

-- El texto original se conserva íntegro como Tarea, sin modificar las filas
-- ni desactivar triggers. Los otros campos de ideas anteriores quedan vacíos.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ideas' and column_name = 'content') then
    alter table public.ideas rename column content to task;
    alter table public.ideas rename constraint ideas_content_check to ideas_task_check;
  end if;
end;
$$;

alter table public.ideas
  add column if not exists position text not null default '',
  add column if not exists information text not null default '',
  add column if not exists supervisor text not null default '',
  add column if not exists boundaries text not null default '',
  add column if not exists success_criteria text not null default '';

-- NOT VALID conserva las ideas anteriores incompletas, pero exige completar
-- TODOS los campos en cada inserción o edición posterior. No inventa respuestas.
do $$
declare field_name text;
begin
  foreach field_name in array array['position', 'information', 'supervisor', 'boundaries', 'success_criteria'] loop
    if not exists (select 1 from pg_constraint where conrelid = 'public.ideas'::regclass and conname = 'ideas_' || field_name || '_check') then
      execute format('alter table public.ideas add constraint %I check (length(btrim(%I)) between 1 and 500) not valid', 'ideas_' || field_name || '_check', field_name);
    end if;
    execute format('alter table public.ideas alter column %I drop default', field_name);
  end loop;
end;
$$;

revoke all on public.ideas from public, anon, authenticated;
grant select, delete on public.ideas to authenticated;
grant insert (author_id, position, task, information, supervisor, boundaries, success_criteria, organizer),
  update (position, task, information, supervisor, boundaries, success_criteria) on public.ideas to authenticated;

-- Funciones con las mismas comprobaciones y locks de la instalación original.
-- Únicos cambios: seis campos recortados y límites 10 / 100.
create or replace function ceidef_private.guard_idea() returns trigger
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

create or replace function public.join_workshop(participant_name text) returns public.participants
language plpgsql security definer set search_path = '' as $$
declare existing public.participants; current_phase text;
begin
  if auth.uid() is null then raise exception 'Iniciá una sesión para ingresar.'; end if;
  if public.is_moderator() then raise exception 'El moderador no ocupa un lugar de participante.'; end if;
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

revoke all on function ceidef_private.guard_idea() from public, anon, authenticated;
revoke all on function public.join_workshop(text) from public, anon, authenticated;
grant execute on function public.join_workshop(text) to authenticated;

-- Notificar al PostgREST de las columnas y permisos nuevos.
update public.workshops set updated_at = now() where id = 1;
notify pgrst, 'reload schema';
commit;
