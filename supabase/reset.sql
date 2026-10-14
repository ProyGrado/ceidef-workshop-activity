-- CEIDEF: reinicio manual, ejecutar completo desde el SQL Editor como postgres.
-- ATENCIÓN: borra participantes, ideas de usuarios/organizadores y clasificaciones.
-- Exportá los CSV antes. Conserva las tres ideas predeterminadas y sus UUIDs,
-- pero borra sus respuestas para que cada encuentro comience sin votos.
-- Conserva usuarios de Auth, permisos de moderación, áreas, RLS y funciones.
-- Requiere la migración 20261011_preset_ideas.sql (o el setup.sql actualizado).
-- No ejecutar setup.sql nuevamente para reiniciar.

begin;

-- Evita mezclar el reinicio con ingresos, escrituras o cambios de fase.
-- NOWAIT aborta sin borrar si hay una operación concurrente que impide el lock.
-- Ante un error de bloqueo: ejecutar ROLLBACK; y reintentar el archivo completo
-- cuando nadie esté usando la actividad (cerrar las pestañas de participantes).
lock table public.workshops, public.participants, public.ideas, public.classifications
  in access exclusive mode nowait;

-- Vaciar las respuestas y participantes juntos respeta las claves foráneas.
-- El trigger permite este DELETE administrativo como postgres, sin JWT.
-- Las ideas predeterminadas permanecen intactas y quedan ocultas en Espera.
truncate table public.classifications, public.participants;
delete from public.ideas where not preset;
-- Compatible con instalaciones anteriores a la gestión de visibilidad.
do $$ begin
  if to_regclass('ceidef_private.hidden_ideas') is not null then
    execute 'delete from ceidef_private.hidden_ideas where idea_id is not null';
  end if;
end; $$;

update public.workshops
set phase = 'waiting', updated_at = now()
where id = 1;

commit;
