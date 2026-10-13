import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const user = '00000000-0000-4000-8000-000000000001'
const moderator = '00000000-0000-4000-8000-000000000002'
const outsider = '00000000-0000-4000-8000-000000000003'
const read = path => readFile(new URL(path, import.meta.url), 'utf8')

for (const migrated of [false, true]) {
  test(`reinicio autorizado y atómico: ${migrated ? 'migración' : 'setup'}`, async t => {
    const db = new PGlite()
    t.after(() => db.close())
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
      $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid; $$;
      grant usage on schema auth to authenticated, anon;
    `)
    if (migrated) {
      await db.exec(await read('./fixtures/setup-v3.sql'))
      await db.exec(await read('../supabase/migrations/20261011_preset_ideas.sql'))
      await db.exec(await read('../supabase/migrations/20261013_join_any_phase.sql'))
    } else await db.exec(await read('../supabase/setup.sql'))
    await db.query('insert into auth.users values ($1),($2),($3)', [user, moderator, outsider])
    await db.query('insert into ceidef_private.moderators values ($1)', [moderator])
    const as = (actor, sql, params = [], anonymous = actor !== moderator, role = 'authenticated') => db.transaction(async tx => {
      await tx.exec(`set local role ${role}`)
      await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor, is_anonymous: anonymous })])
      return tx.query(sql, params)
    })
    const state = async () => {
      const values = {}
      for (const table of ['workshops', 'participants', 'ideas', 'classifications']) {
        values[table] = (await db.query(`select * from public.${table} order by 1`)).rows
      }
      return values
    }
    const revision = async () => (await db.query('select updated_at from public.workshops')).rows[0].updated_at
    const seed = async () => {
      await db.exec("update public.workshops set phase='ideas',updated_at=clock_timestamp()")
      await as(user, "select public.join_workshop('Persona')")
      const idea = (await as(user, 'insert into public.ideas(author_id,task) values ($1,$2) returning id', [user, 'Idea participante'])).rows[0].id
      await as(moderator, 'insert into public.ideas(author_id,task,organizer) values ($1,$2,true)', [moderator, 'Idea organizador'])
      await as(moderator, "select public.advance_phase('ideas')")
      await as(user, 'select public.classify_idea($1,array[1]::smallint[])', [idea])
      await as(user, "select public.classify_idea($1,'{}'::smallint[])", ['ce1def00-0000-4000-8000-000000000001'])
      await as(moderator, "select public.advance_phase('classification')")
      return idea
    }
    await seed()
    const original = await state()
    if (migrated) {
      const migration = await read('../supabase/migrations/20261013_moderator_reset.sql')
      await db.exec(migration)
      await db.exec(migration)
      assert.deepEqual(await state(), original)
    }
    const presets = original.ideas.filter(idea => idea.preset)
    const expected = await revision()
    await assert.rejects(as(user, 'select public.reset_workshop($1)', [expected]), /moderador/)
    await assert.rejects(as(outsider, 'select public.reset_workshop($1)', [expected], false), /moderador/)
    await assert.rejects(as(moderator, 'select public.reset_workshop($1)', [expected], true), /moderador/)
    await assert.rejects(as(null, 'select public.reset_workshop($1)', [expected], true, 'anon'), /permission/)
    await assert.rejects(as(moderator, 'select public.reset_workshop(null)'), /cambió/)
    assert.deepEqual(await state(), original)
    // Ningún rol de la API, incluso un moderador, puede falsificar el contexto.
    for (const actor of [user, moderator]) {
      await assert.rejects(as(actor, 'insert into ceidef_private.reset_context values (pg_current_xact_id(),$1)', [actor]), /permission/)
      await assert.rejects(as(actor, 'select * from ceidef_private.reset_context'), /permission/)
    }
    const config = (await db.query("select proconfig from pg_proc where oid='public.reset_workshop(timestamptz)'::regprocedure")).rows[0].proconfig
    assert.ok(config.every(setting => setting.startsWith('search_path=')))
    await assert.rejects(as(user, 'select ceidef_private.guard_idea()'), /permission/)
    assert.equal((await as(user, 'delete from public.ideas returning id')).rows.length, 0)
    // Un fallo después de vaciar respuestas y padrón revierte todo el reinicio.
    await db.exec(`create function public.fail_reset() returns trigger language plpgsql as $$
      begin raise exception 'Fallo simulado'; end; $$;
      create trigger fail_reset after delete on public.ideas for each row execute function public.fail_reset();`)
    await assert.rejects(as(moderator, 'select public.reset_workshop($1)', [expected]), /Fallo simulado/)
    assert.deepEqual(await state(), original)
    assert.equal((await db.query('select * from ceidef_private.reset_context')).rows.length, 0)
    await db.exec('drop trigger fail_reset on public.ideas; drop function public.fail_reset()')
    await as(moderator, 'select public.reset_workshop($1)', [expected])
    await assert.rejects(as(moderator, 'select public.reset_workshop($1)', [expected]), /cambió/)
    for (const phase of ['waiting', 'ideas', 'classification', 'results']) {
      const oldIdea = await seed()
      await db.query('update public.workshops set phase=$1,updated_at=clock_timestamp()', [phase])
      await as(moderator, 'select public.reset_workshop($1)', [await revision()])
      const after = await state()
      assert.deepEqual(after.ideas, presets)
      assert.equal(after.participants.length, 0)
      assert.equal(after.classifications.length, 0)
      assert.equal(after.workshops[0].phase, 'waiting')
      assert.equal((await db.query('select * from ceidef_private.reset_context')).rows.length, 0)
      assert.equal((await as(moderator, 'select public.is_moderator()')).rows[0].is_moderator, true)
      assert.equal((await db.query('select * from auth.users')).rows.length, 3)
      assert.equal((await as(moderator, 'select * from public.areas')).rows.length, 6)
      await as(user, "select public.join_workshop('Nueva edición')")
      assert.equal((await as(user, 'select * from public.ideas')).rows.length, 0)
      await assert.rejects(as(user, 'select public.classify_idea($1,array[1]::smallint[])', [oldIdea]), /cerrada|policy/)
      await as(moderator, 'select public.reset_workshop($1)', [await revision()])
    }
  })
}
