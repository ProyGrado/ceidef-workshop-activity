import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('migración desde versión anterior conserva ideas, votos y permisos, y aplica nuevos límites', async () => {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
    $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid; $$;
    grant usage on schema auth to authenticated, anon;
  `)
  await db.exec(await readFile(new URL('./fixtures/setup-v1.sql', import.meta.url), 'utf8'))
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const moderator = id(1000)
  await db.query('insert into auth.users select unnest($1::uuid[])', [[...Array.from({ length: 101 }, (_, i) => id(i + 1)), moderator]])
  await db.query('insert into ceidef_private.moderators values ($1)', [moderator])
  const as = (user, sql, params = []) => db.transaction(async tx => {
    await tx.exec('set local role authenticated')
    await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, is_anonymous: user !== moderator })])
    return tx.query(sql, params)
  })
  await as(id(1), "select public.join_workshop('Persona anterior')")
  await as(moderator, "select public.advance_phase('waiting')")
  const idea = (await as(id(1), 'insert into public.ideas(author_id,content) values ($1,$2) returning id', [id(1), 'Texto original que debe conservarse'])).rows[0].id
  await as(moderator, "select public.advance_phase('ideas')")
  await as(id(1), 'select public.classify_idea($1, 2::smallint)', [idea])
  await as(moderator, "select public.advance_phase('classification')")

  const migration = await readFile(new URL('../supabase/migrations/20261011_structured_ideas.sql', import.meta.url), 'utf8')
  await db.exec(migration)
  await db.exec(migration) // Reejecución segura, también tras instalación nueva.
  const old = (await as(id(1), 'select * from public.ideas')).rows[0]
  assert.equal(old.id, idea)
  assert.equal(old.task, 'Texto original que debe conservarse')
  for (const field of ['position', 'information', 'supervisor', 'boundaries', 'success_criteria']) assert.equal(old[field], '')
  assert.equal((await as(moderator, 'select phase from public.workshops')).rows[0].phase, 'results')
  assert.equal((await as(moderator, 'select public.is_moderator()')).rows[0].is_moderator, true)
  const counts = (await as(id(1), 'select * from public.get_results()')).rows
  assert.equal(Number(counts.find(r => r.area_id === 2).votes), 1)
  assert.equal((await as(id(2), 'select * from public.classifications')).rows.length, 0)
  assert.equal((await as(id(1), 'select * from public.participants')).rows[0].name, 'Persona anterior')

  // Abrir escritura solo como administrador para verificar edición de legado;
  // la migración misma no cambia ni reabre la fase.
  await db.exec("update public.workshops set phase='ideas'")
  await assert.rejects(as(id(1), 'update public.ideas set task=$1 where id=$2', ['Solo un campo', idea]), /check constraint/)
  await as(id(1), `update public.ideas set position='Puesto',information='Datos',supervisor='Equipo',boundaries='Límites',success_criteria='Indicador' where id=$1`, [idea])
  const insert = 'insert into public.ideas(author_id,position,task,information,supervisor,boundaries,success_criteria) values ($1,\'Puesto\',$2,\'Datos\',\'Equipo\',\'Límites\',\'Indicador\')'
  for (let n = 2; n <= 10; n++) await as(id(1), insert, [id(1), `Idea ${n}`])
  await assert.rejects(as(id(1), insert, [id(1), 'Idea once']), /hasta 10/)
  await assert.rejects(as(id(1), 'update public.ideas set organizer=true where id=$1', [idea]), /permission/)
  await assert.rejects(as(id(1), 'update public.ideas set author_id=$1 where id=$2', [id(2), idea]), /permission/)
  await db.exec("update public.workshops set phase='waiting'")
  for (let n = 2; n <= 100; n++) await as(id(n), 'select public.join_workshop($1)', [`Persona ${n}`])
  await assert.rejects(as(id(101), "select public.join_workshop('Demasiados')"), /100 participantes/)
  await db.exec("update public.workshops set phase='classification'")
  await as(id(2), 'select public.classify_idea($1, 7::smallint)', [idea])
  await as(moderator, "select public.advance_phase('classification')")
  const multiple = await readFile(new URL('../supabase/migrations/20261011_multiple_areas.sql', import.meta.url), 'utf8')
  await db.exec(multiple)
  await db.exec(multiple)
  assert.deepEqual((await as(id(1), 'select area_ids from public.classifications')).rows[0].area_ids, [2])
  assert.deepEqual((await as(id(2), 'select area_ids from public.classifications')).rows[0].area_ids, [])
  assert.equal((await as(moderator, 'select * from public.areas')).rows.length, 6)
  const migrated = (await as(moderator, 'select * from public.get_results()')).rows.filter(r => r.idea_id === idea)
  assert.equal(migrated.length, 6)
  assert.ok(migrated.every(row => Number(row.total) === 2 && Number(row.no_area) === 1))
  assert.equal(Number(migrated.find(row => row.area_id === 2).votes), 1)
  assert.equal((await as(moderator, 'select phase from public.workshops')).rows[0].phase, 'results')
  assert.equal((await as(moderator, 'select public.is_moderator()')).rows[0].is_moderator, true)
  await assert.rejects(as(id(1), 'select public.classify_idea($1, array[1,2]::smallint[])', [idea]), /cerrada/)
  await db.exec("update public.workshops set phase='ideas'")
  await as(id(1), "update public.ideas set position='',information='',supervisor='',boundaries='',success_criteria='' where id=$1", [idea])
  assert.equal((await as(id(1), 'select task from public.ideas where id=$1', [idea])).rows[0].task, 'Texto original que debe conservarse')
  await db.close()
})

test('migración de la versión de seis campos permite solo Tarea y conserva respuestas', async () => {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
    $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid; $$;
    grant usage on schema auth to authenticated, anon;
  `)
  await db.exec(await readFile(new URL('./fixtures/setup-v2.sql', import.meta.url), 'utf8'))
  const user = '00000000-0000-4000-8000-000000000001'
  await db.query('insert into auth.users values ($1)', [user])
  await db.query('insert into public.participants(user_id,name) values ($1,$2)', [user, 'Persona existente'])
  await db.exec(await readFile(new URL('../supabase/migrations/20261011_multiple_areas.sql', import.meta.url), 'utf8'))
  await db.exec("update public.workshops set phase='ideas'")
  const as = (sql, params = []) => db.transaction(async tx => {
    await tx.exec('set local role authenticated')
    await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, is_anonymous: true })])
    return tx.query(sql, params)
  })
  const idea = (await as('insert into public.ideas(author_id,task) values ($1,$2) returning id', [user, 'Tarea obligatoria'])).rows[0].id
  await db.exec("update public.workshops set phase='classification'")
  await as('select public.classify_idea($1,array[6,2]::smallint[])', [idea])
  assert.deepEqual((await as('select area_ids from public.classifications')).rows[0].area_ids, [2, 6])
  await as("select public.classify_idea($1,'{}'::smallint[])", [idea])
  assert.deepEqual((await as('select area_ids from public.classifications')).rows[0].area_ids, [])
  assert.equal((await as('select * from public.classifications')).rows.length, 1)
  await db.exec("update public.workshops set phase='results'")
  const result = (await as('select * from public.get_results()')).rows
  assert.ok(result.every(row => Number(row.votes) === 0 && Number(row.total) === 1 && Number(row.no_area) === 1))
  await db.close()
})
