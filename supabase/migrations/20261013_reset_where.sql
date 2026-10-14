-- Corregir el reinicio para entornos que exigen WHERE en DELETE.
-- Requiere la migracion de visibilidad. Ejecutar completo como postgres.
-- Solo reemplaza la funcion: no reinicia ni borra datos al instalarse.
begin;

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
revoke all on function public.reset_workshop(timestamptz) from public, anon, authenticated;
grant execute on function public.reset_workshop(timestamptz) to authenticated;

commit;
