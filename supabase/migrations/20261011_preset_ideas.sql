-- Ejecutar después de 20261011_multiple_areas.sql, en SQL Editor como postgres.
-- Agrega tres ideas permanentes, visibles desde clasificación y en resultados.
-- Conserva los datos y la fase actual. Se puede volver a ejecutar sin duplicados.
begin;
lock table public.workshops, public.participants, public.ideas, public.classifications
  in access exclusive mode nowait;

alter table public.ideas
  add column if not exists preset boolean not null default false,
  add column if not exists title text not null default '';
alter table public.ideas alter column author_id drop not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ideas'::regclass and conname = 'ideas_preset_author_check') then
    alter table public.ideas add constraint ideas_preset_author_check check (
      (preset and author_id is null and organizer and length(btrim(title)) between 1 and 150)
      or (not preset and author_id is not null and title = '')
    );
  end if;
end;
$$;

drop policy if exists ideas_read on public.ideas;
create policy ideas_read on public.ideas for select to authenticated using (
  (not preset or (select ceidef_private.phase()) in ('classification', 'results')) and (
    (select public.is_moderator()) or (
      (select ceidef_private.is_participant()) and (
        author_id = (select auth.uid()) or (select ceidef_private.phase()) in ('classification', 'results')
      )
    )
  )
);

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

-- TRUNCATE no pasa por los triggers de fila. Bloquearlo evita que el reset
-- anterior vacíe la tabla de ideas; el nuevo reset usa DELETE WHERE NOT preset.
create or replace function ceidef_private.guard_ideas_truncate() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'No se puede vaciar ideas con TRUNCATE. Usá el reset.sql actualizado para conservar las ideas predeterminadas.';
end;
$$;
drop trigger if exists guard_ideas_truncate on public.ideas;
create trigger guard_ideas_truncate before truncate on public.ideas
  for each statement execute function ceidef_private.guard_ideas_truncate();

create or replace function public.get_progress() returns table (user_id uuid, name text, completed bigint, total bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_moderator() then raise exception 'Se requieren permisos de moderador.'; end if;
  return query select p.user_id, p.name, count(c.idea_id),
    (select count(*) from public.ideas i where not i.preset or ceidef_private.phase() in ('classification', 'results'))
    from public.participants p left join public.classifications c on c.user_id = p.user_id
    group by p.user_id, p.name, p.created_at order by p.created_at;
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

revoke all on function ceidef_private.guard_idea(), ceidef_private.guard_ideas_truncate() from public, anon, authenticated;
revoke all on function public.get_progress() from public, anon, authenticated;
grant execute on function public.get_progress() to authenticated;
update public.workshops set updated_at = now() where id = 1;
notify pgrst, 'reload schema';
commit;
