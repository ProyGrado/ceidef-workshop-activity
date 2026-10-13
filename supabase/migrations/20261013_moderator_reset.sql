-- Reinicio desde el panel: requiere las migraciones previas de ideas predeterminadas.
-- Ejecutar completo como postgres. No reinicia ni borra datos al instalarse.
begin;

-- No usa parámetros personalizados: algunos proyectos restringen su configuración.
-- Esta tabla solo es accesible a las funciones privilegiadas; queda vacía al salir.
create table if not exists ceidef_private.reset_context (
  transaction_id xid8 primary key,
  moderator_id uuid not null
);
alter table ceidef_private.reset_context enable row level security;
revoke all on ceidef_private.reset_context from public, anon, authenticated;

create or replace function ceidef_private.guard_idea() returns trigger
language plpgsql security definer set search_path = '' as $$
declare current_phase text; owner_id uuid; is_team boolean;
begin
  -- Dos operaciones administrativas puntuales; nunca se habilitan para los
  -- roles de la API, aunque falte el JWT. SECURITY DEFINER NO cambia el GUC role.
  if auth.uid() is null and current_setting('role', true) in ('none', 'postgres') then
    if TG_OP = 'INSERT' and NEW.preset then return NEW; end if;
    if TG_OP = 'DELETE' and not OLD.preset then return OLD; end if;
  end if;
  -- Excepción acotada al reinicio autorizado: no permite borrar predeterminadas.
  if TG_OP = 'DELETE' and not OLD.preset
    and public.is_moderator() and exists (
      select 1 from ceidef_private.reset_context c
      where c.transaction_id = pg_current_xact_id() and c.moderator_id = auth.uid()
    ) then
    return OLD;
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

create or replace function public.reset_workshop(expected_revision timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
declare revision timestamptz;
begin
  if not public.is_moderator() then raise exception 'Se requieren permisos de moderador.'; end if;
  -- Mismo orden de locks que reset.sql. Ante actividad concurrente, abortar todo.
  lock table public.workshops, public.participants, public.ideas, public.classifications
    in access exclusive mode nowait;
  select updated_at into revision from public.workshops where id = 1;
  if not found or revision is distinct from expected_revision then
    raise exception 'La actividad cambió. Cerrá la confirmación y revisá antes de reiniciar.';
  end if;
  insert into ceidef_private.reset_context(transaction_id, moderator_id)
    values (pg_current_xact_id(), auth.uid());
  truncate table public.classifications, public.participants;
  delete from public.ideas where not preset;
  update public.workshops set phase = 'waiting', updated_at = clock_timestamp() where id = 1;
  delete from ceidef_private.reset_context where transaction_id = pg_current_xact_id();
exception when lock_not_available then
  raise exception 'Hay una operación en curso. Esperá unos segundos y volvé a intentar.';
end;
$$;
revoke all on function public.reset_workshop(timestamptz) from public, anon, authenticated;
grant execute on function public.reset_workshop(timestamptz) to authenticated;

commit;
