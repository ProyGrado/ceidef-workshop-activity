-- Etapa de revision exclusiva del moderador antes de clasificar.
-- Requiere las migraciones anteriores. Ejecutar completo como postgres.
-- Conserva datos y la fase actual; no retrocede actividades en curso.
begin;
lock table public.workshops, public.participants, public.ideas, public.classifications in access exclusive mode nowait;
alter table public.workshops drop constraint if exists workshops_phase_check;
alter table public.workshops add constraint workshops_phase_check check (phase in ('waiting','ideas','review','classification','results'));

create or replace function public.advance_phase(expected_phase text) returns text
language plpgsql security definer set search_path = '' as $$
declare current_phase text; next_phase text;
begin
  if not public.is_moderator() then raise exception 'Se requieren permisos de moderador.'; end if;
  select phase into current_phase from public.workshops where id = 1 for update;
  if current_phase is distinct from expected_phase then raise exception 'La fase cambió. Actualizá antes de continuar.'; end if;
  next_phase := case current_phase when 'waiting' then 'ideas' when 'ideas' then 'review' when 'review' then 'classification' when 'classification' then 'results' end;
  if next_phase is null then raise exception 'La actividad ya finalizó.'; end if;
  update public.workshops set phase = next_phase, updated_at = now() where id = 1;
  return next_phase;
end;
$$;

create or replace function public.get_progress() returns table (user_id uuid, name text, completed bigint, total bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_moderator() then raise exception 'Se requieren permisos de moderador.'; end if;
  return query select p.user_id, p.name, count(c.idea_id),
    (select count(*) from public.ideas i where ceidef_private.idea_is_visible(i.id)
      and (not i.preset or ceidef_private.phase() in ('review', 'classification', 'results')))
    from public.participants p left join public.classifications c on c.user_id = p.user_id
      and ceidef_private.idea_is_visible(c.idea_id)
    group by p.user_id, p.name, p.created_at order by p.created_at;
end;
$$;

create or replace function public.get_hidden_idea_ids() returns table (idea_id uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_moderator() then raise exception 'Se requieren permisos de moderador.'; end if;
  return query select h.idea_id from ceidef_private.hidden_ideas h join public.ideas i on i.id = h.idea_id
    where not i.preset or ceidef_private.phase() in ('review', 'classification', 'results') order by h.idea_id;
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
    and (not i.preset or current_phase in ('review', 'classification', 'results'))) then
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

drop policy if exists ideas_read on public.ideas;
create policy ideas_read on public.ideas for select to authenticated using (
  ((select public.is_moderator()) and
    (not preset or (select ceidef_private.phase()) in ('review', 'classification', 'results')))
  or (
    (select ceidef_private.is_participant()) and (select ceidef_private.phase()) <> 'review'
    and ceidef_private.idea_is_visible(id)
    and (not preset or (select ceidef_private.phase()) in ('classification', 'results'))
    and (author_id = (select auth.uid()) or (select ceidef_private.phase()) in ('classification', 'results'))
  )
);

commit;
