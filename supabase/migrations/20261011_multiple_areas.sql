-- Actualizar la versión con seis campos / clasificación de un área.
-- Si venís de la primera versión, ejecutar ANTES 20261011_structured_ideas.sql.
-- SQL Editor como postgres, entre actividades. No borra ideas ni participantes.
begin;
lock table public.workshops, public.participants, public.ideas, public.classifications, public.areas
  in access exclusive mode nowait;

-- Tarea sigue siendo obligatoria. Los otros cinco campos aceptan texto vacío.
do $$
declare field_name text;
begin
  foreach field_name in array array['position', 'information', 'supervisor', 'boundaries', 'success_criteria'] loop
    execute format('alter table public.ideas drop constraint if exists %I', 'ideas_' || field_name || '_check');
    execute format('alter table public.ideas add constraint %I check (length(btrim(%I)) between 0 and 500)', 'ideas_' || field_name || '_check', field_name);
    execute format('alter table public.ideas alter column %I set default %L', field_name, '');
  end loop;
end;
$$;

-- ALTER TYPE convierte los datos sin ejecutar triggers de escritura ni cambiar
-- la fase. Una clasificación anterior se vuelve un array con una sola área.
-- La antigua área 7 se conserva como respuesta SIN ÁREAS (array vacío).
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'classifications' and column_name = 'area_id') then
    alter table public.classifications drop constraint if exists classifications_area_id_fkey;
    alter table public.classifications rename column area_id to area_ids;
    alter table public.classifications alter column area_ids type smallint[]
      using (case when area_ids = 7 then '{}'::smallint[] else array[area_ids]::smallint[] end);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.classifications'::regclass and conname = 'classifications_areas_check') then
    alter table public.classifications add constraint classifications_areas_check check (
      cardinality(area_ids) <= 6 and (array_ndims(area_ids) is null or array_ndims(area_ids) = 1)
      and array_position(area_ids, null) is null and area_ids <@ array[1,2,3,4,5,6]::smallint[]
    );
  end if;
end;
$$;
alter table public.classifications alter column area_ids set default '{}';
delete from public.areas where id = 7;

revoke all on public.classifications from public, anon, authenticated;
grant select on public.classifications to authenticated;
grant insert (user_id, idea_id, area_ids), update (area_ids) on public.classifications to authenticated;

create or replace function ceidef_private.guard_classification() returns trigger
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
  NEW.area_ids := array(select distinct value from unnest(NEW.area_ids) as chosen(value) order by value);
  NEW.updated_at := now();
  return NEW;
end;
$$;

-- Quitar la firma vieja para que la API no acepte clasificaciones de un área.
drop function if exists public.classify_idea(uuid, smallint);
create or replace function public.classify_idea(target_idea uuid, selected_areas smallint[]) returns void
language sql security invoker set search_path = '' as $$
  insert into public.classifications(user_id, idea_id, area_ids)
    values (auth.uid(), target_idea, selected_areas)
    on conflict (user_id, idea_id) do update set area_ids = excluded.area_ids;
$$;

-- La firma del resultado incluye ahora el contador de respuestas sin áreas.
drop function if exists public.get_results();
create function public.get_results() returns table (idea_id uuid, area_id smallint, votes bigint, total bigint, no_area bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if ceidef_private.phase() <> 'results' then raise exception 'Los resultados todavía están cerrados.'; end if;
  if not (public.is_moderator() or ceidef_private.is_participant()) then raise exception 'Ingresá a la actividad para ver los resultados.'; end if;
  return query select i.id, a.id, count(c.user_id),
    (select count(*) from public.classifications c2 where c2.idea_id = i.id),
    (select count(*) from public.classifications c3 where c3.idea_id = i.id and cardinality(c3.area_ids) = 0)
    from public.ideas i cross join public.areas a
    left join public.classifications c on c.idea_id = i.id and a.id = any(c.area_ids)
    group by i.id, a.id order by i.id, a.id;
end;
$$;
revoke all on function ceidef_private.guard_classification() from public, anon, authenticated;
revoke all on function public.classify_idea(uuid, smallint[]), public.get_results() from public, anon, authenticated;
grant execute on function public.classify_idea(uuid, smallint[]), public.get_results() to authenticated;
update public.workshops set updated_at = now() where id = 1;
notify pgrst, 'reload schema';
commit;
