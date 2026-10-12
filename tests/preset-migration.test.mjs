import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('migración de predeterminadas: conserva datos, impide duplicados y protege el reinicio', async () => {
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
  await db.exec(await readFile(new URL('./fixtures/setup-v3.sql', import.meta.url), 'utf8'))
  const user = '00000000-0000-4000-8000-000000000001'
  const mod = '00000000-0000-4000-8000-000000000002'
  await db.query('insert into auth.users values ($1),($2)', [user, mod])
  await db.query('insert into ceidef_private.moderators values ($1)', [mod])
  const as = (actor, sql, params = []) => db.transaction(async tx => {
    await tx.exec('set local role authenticated')
    await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor, is_anonymous: actor !== mod })])
    return tx.query(sql, params)
  })
  await as(user, "select public.join_workshop('Persona existente')")
  await as(mod, "select public.advance_phase('waiting')")
  const idea = (await as(user, 'insert into public.ideas(author_id,task) values ($1,$2) returning id', [user, 'Idea existente'])).rows[0].id
  const team = (await as(mod, 'insert into public.ideas(author_id,task,organizer) values ($1,$2,true) returning id', [mod, 'Idea organizador'])).rows[0].id
  await as(mod, "select public.advance_phase('ideas')")
  await as(user, 'select public.classify_idea($1,array[2]::smallint[])', [idea])
  await as(user, "select public.classify_idea($1,'{}'::smallint[])", [team])
  await as(mod, "select public.advance_phase('classification')")
  const votesBefore = (await as(user, 'select * from public.classifications order by idea_id')).rows
  const migration = await readFile(new URL('../supabase/migrations/20261011_preset_ideas.sql', import.meta.url), 'utf8')
  await db.exec(migration)
  const seeds = (await db.query('select * from public.ideas where preset order by id')).rows
  assert.equal(seeds.length, 3)
  await db.exec(migration)
  assert.deepEqual((await db.query('select * from public.ideas where preset order by id')).rows, seeds)
  assert.equal((await as(user, 'select * from public.ideas')).rows.length, 5)
  assert.deepEqual((await as(user, 'select * from public.classifications order by idea_id')).rows, votesBefore)
  assert.equal((await as(mod, 'select phase from public.workshops')).rows[0].phase, 'results')
  assert.equal((await as(mod, 'select public.is_moderator()')).rows[0].is_moderator, true)
  const results = (await as(user, 'select * from public.get_results()')).rows
  assert.equal(results.length, 30)
  assert.equal(Number(results.find(r => r.idea_id === idea && r.area_id === 2).votes), 1)
  assert.ok(results.filter(r => r.idea_id === seeds[0].id).every(r => Number(r.total) === 0))
  const reset = await readFile(new URL('../supabase/reset.sql', import.meta.url), 'utf8')
  await db.exec(reset)
  assert.deepEqual((await db.query('select * from public.ideas order by id')).rows, seeds)
  assert.equal((await db.query('select * from public.classifications')).rows.length, 0)
  assert.equal((await db.query('select * from public.participants')).rows.length, 0)
  assert.equal((await as(mod, 'select * from public.ideas')).rows.length, 0)
  await as(user, "select public.join_workshop('Nuevo encuentro')")
  await as(mod, "select public.advance_phase('waiting')")
  assert.equal((await as(user, 'select * from public.ideas')).rows.length, 0)
  assert.equal((await as(mod, 'select * from public.ideas')).rows.length, 0)
  assert.equal(Number((await as(mod, 'select * from public.get_progress()')).rows[0].total), 0)
  // Un JWT ausente no habilita la excepción administrativa en el rol API.
  assert.equal((await as(null, 'delete from public.ideas where not preset returning id')).rows.length, 0)
  await as(mod, "select public.advance_phase('ideas')")
  assert.equal((await as(user, 'select * from public.ideas')).rows.length, 3)
  assert.equal(Number((await as(mod, 'select * from public.get_progress()')).rows[0].total), 3)
  await as(user, 'select public.classify_idea($1,array[1,3]::smallint[])', [seeds[0].id])
  await as(mod, "select public.advance_phase('classification')")
  assert.equal(Number((await as(user, 'select * from public.get_results()')).rows.find(r => r.idea_id === seeds[0].id && r.area_id === 3).votes), 1)
  await db.exec(reset)
  await db.exec(reset)
  assert.deepEqual((await db.query('select * from public.ideas order by id')).rows, seeds)
  assert.equal((await db.query('select * from public.classifications')).rows.length, 0)
  await db.close()
})
