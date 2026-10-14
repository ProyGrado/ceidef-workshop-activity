-- Ocultar y restaurar ideas para todos sin borrar respuestas.
-- Requiere las migraciones anteriores, incluido el reinicio del moderador.
-- Ejecutar completo como postgres. No borra datos ni cambia la fase.
begin;
lock table public.workshops, public.participants, public.ideas, public.classifications in access exclusive mode nowait;

create table if not exists ceidef_private.hidden_ideas (
  idea_id uuid primary key references public.ideas(id) on delete cascade,
  hidden_by uuid not null,
  hidden_at timestamptz not null default now()
);
alter table ceidef_private.hidden_ideas enable row level security;
revoke all on ceidef_private.hidden_ideas from public, anon, authenticated;

create or replace function ceidef_private.idea_is_visible(target_idea uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from ceidef_private.hidden_ideas h where h.idea_id = target_idea);
$$;

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
  if not public.is_moderator() and not ceidef_private.idea_is_visible(case when TG_OP = 'DELETE' then OLD.id else NEW.id end) then
    raise exception 'La idea ya no está disponible.';
  end if;
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

create or replace function ceidef_private.guard_classification() returns trigger
language plpgsql security definer set search_path = '' as $$
declare current_phase text;
begin
  select phase into current_phase from public.workshops where id = 1 for share;
  if current_phase <> 'classification' then raise exception 'La clasificación está cerrada.'; end if;
  if not ceidef_private.idea_is_visible(NEW.idea_id) then raise exception 'La idea ya no está disponible.'; end if;
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

create or replace function public.get_progress() returns table (user_id uuid, name text, completed bigint, total bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_moderator() then raise exception 'Se requieren permisos de moderador.'; end if;
  return query select p.user_id, p.name, count(c.idea_id),
    (select count(*) from public.ideas i where ceidef_private.idea_is_visible(i.id)
      and (not i.preset or ceidef_private.phase() in ('classification', 'results')))
    from public.participants p left join public.classifications c on c.user_id = p.user_id
      and ceidef_private.idea_is_visible(c.idea_id)
    group by p.user_id, p.name, p.created_at order by p.created_at;
end;
$$;

create or replace function public.get_results() returns table (idea_id uuid, area_id smallint, votes bigint, total bigint, no_area bigint)
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
    where public.is_moderator() or ceidef_private.idea_is_visible(i.id)
    group by i.id, a.id order by i.id, a.id;
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
  delete from ceidef_private.hidden_ideas where idea_id is not null;
  update public.workshops set phase = 'waiting', updated_at = clock_timestamp() where id = 1;
  delete from ceidef_private.reset_context where transaction_id = pg_current_xact_id();
exception when lock_not_available then
  raise exception 'Hay una operación en curso. Esperá unos segundos y volvé a intentar.';
end;
$$;

drop policy if exists ideas_read on public.ideas;
create policy ideas_read on public.ideas for select to authenticated using (
  ((select public.is_moderator()) or ceidef_private.idea_is_visible(id)) and
  (not preset or (select ceidef_private.phase()) in ('classification', 'results')) and (
    (select public.is_moderator()) or (
      (select ceidef_private.is_participant()) and (
        author_id = (select auth.uid()) or (select ceidef_private.phase()) in ('classification', 'results')
      )
    )
  )
);

drop policy if exists classifications_read on public.classifications;
create policy classifications_read on public.classifications for select to authenticated using (user_id = (select auth.uid()) and ceidef_private.idea_is_visible(idea_id));

create or replace function public.get_hidden_idea_ids() returns table (idea_id uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_moderator() then raise exception 'Se requieren permisos de moderador.'; end if;
  return query select h.idea_id from ceidef_private.hidden_ideas h join public.ideas i on i.id = h.idea_id
    where not i.preset or ceidef_private.phase() in ('classification', 'results') order by h.idea_id;
end;
$$;
create or replace function public.set_idea_visibility(target_idea uuid, visible boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare current_phase text;
begin
  if not public.is_moderator() then raise exception 'Se requieren permisos de moderador.'; end if;
  if visible is null then raise exception 'Indicá si la idea debe mostrarse.'; end if;
  select phase into current_phase from public.workshops where id = 1 for update;
  if not exists (select 1 from public.ideas i where i.id = target_idea
    and (not i.preset or current_phase in ('classification', 'results'))) then
    raise exception 'La idea ya no está disponible.';
  end if;
  if visible then delete from ceidef_private.hidden_ideas where idea_id = target_idea;
  else insert into ceidef_private.hidden_ideas(idea_id, hidden_by) values (target_idea, auth.uid())
    on conflict (idea_id) do nothing;
  end if;
  -- Invalida el mural conservado, también en Resultados, y avisa por Realtime.
  update public.workshops set updated_at = clock_timestamp() where id = 1;
end;
$$;
revoke all on function public.get_hidden_idea_ids(), public.set_idea_visibility(uuid, boolean) from public, anon, authenticated;
grant execute on function public.get_hidden_idea_ids(), public.set_idea_visibility(uuid, boolean) to authenticated;

revoke all on function ceidef_private.idea_is_visible(uuid) from public, anon, authenticated;
grant execute on function ceidef_private.idea_is_visible(uuid) to authenticated;
commit;
