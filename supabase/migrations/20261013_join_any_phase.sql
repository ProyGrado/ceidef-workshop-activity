-- Habilitar el ingreso de participantes en cualquier fase.
-- Ejecutar completo en SQL Editor como postgres sobre una instalación existente.
-- Conserva datos, fase, permisos, límite de participantes y cierres de escritura.
begin;

create or replace function public.join_workshop(participant_name text) returns public.participants
language plpgsql security definer set search_path = '' as $$
declare existing public.participants;
begin
  if auth.uid() is null then raise exception 'Iniciá una sesión para ingresar.'; end if;
  if public.is_moderator() then raise exception 'El moderador no ocupa un lugar de participante.'; end if;
  -- Serializar ingresos y coordinarse con los cambios de fase y el reinicio.
  perform 1 from public.workshops where id = 1 for update;
  select * into existing from public.participants where user_id = auth.uid();
  if found then return existing; end if;
  if (select count(*) from public.participants) >= 100 then raise exception 'La actividad ya tiene 100 participantes.'; end if;
  if participant_name is null or length(btrim(participant_name)) not between 1 and 60 then
    raise exception 'Ingresá un nombre de entre 1 y 60 caracteres.';
  end if;
  insert into public.participants(user_id, name) values (auth.uid(), btrim(participant_name)) returning * into existing;
  return existing;
end;
$$;

-- No habilitar llamadas sin sesión ni modificar los demás permisos.
revoke all on function public.join_workshop(text) from public, anon, authenticated;
grant execute on function public.join_workshop(text) to authenticated;

commit;
