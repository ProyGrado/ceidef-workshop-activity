-- CEIDEF: reinicio manual, ejecutar completo desde el SQL Editor como postgres.
-- ATENCIÓN: borra definitivamente participantes, ideas y clasificaciones,
-- incluidas las ideas del equipo organizador. Exportá los CSV antes.
-- Conserva usuarios de Auth, permisos de moderación, áreas, RLS y funciones.
-- No ejecutar setup.sql nuevamente para reiniciar.

begin;

-- Evita mezclar el reinicio con ingresos, escrituras o cambios de fase.
-- NOWAIT aborta sin borrar si hay una operación concurrente que impide el lock.
-- Ante un error de bloqueo: ejecutar ROLLBACK; y reintentar el archivo completo
-- cuando nadie esté usando la actividad (cerrar las pestañas de participantes).
lock table public.workshops, public.participants, public.ideas, public.classifications
  in access exclusive mode nowait;

-- Las tres tablas se vacían juntas para respetar sus claves foráneas.
-- Sin CASCADE: no se borran otras tablas. TRUNCATE no dispara guard_idea,
-- que impide DELETE fuera de la fase de escritura o sobre ideas ajenas.
truncate table public.classifications, public.ideas, public.participants;

update public.workshops
set phase = 'waiting', updated_at = now()
where id = 1;

commit;
