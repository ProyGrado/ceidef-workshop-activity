import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const moderator = uid(3)
const read = path => readFile(new URL(path, import.meta.url), 'utf8')
for (const migrated of [false, true]) {
  test(`revisión exclusiva antes de clasificar: ${migrated ? 'migración con datos' : 'setup'}`, async t => {
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
      for (const file of ['20261011_preset_ideas.sql', '20261013_join_any_phase.sql', '20261013_moderator_reset.sql', '20261013_idea_visibility.sql', '20261013_reset_where.sql']) {
        await db.exec(await read(`../supabase/migrations/${file}`))
      }
    } else await db.exec(await read('../supabase/setup.sql'))
    await db.query('insert into auth.users select unnest($1::uuid[])', [[uid(1), uid(2), moderator, uid(4)]])
    await db.query('insert into ceidef_private.moderators values ($1)', [moderator])
    const as = (user, sql, params = []) => db.transaction(async tx => {
      await tx.exec('set local role authenticated')
      await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, is_anonymous: user !== moderator })])
      return tx.query(sql, params)
    })
    await as(uid(1), "select public.join_workshop('Persona')")
    await as(moderator, "select public.advance_phase('waiting')")
    const idea = (await as(uid(1), 'insert into public.ideas(author_id,task) values ($1,$2) returning id', [uid(1), 'Idea para revisar'])).rows[0].id
    const team = (await as(moderator, 'insert into public.ideas(author_id,task,organizer) values ($1,$2,true) returning id', [moderator, 'Equipo'])).rows[0].id
    const before = (await db.query('select * from public.ideas order by id')).rows
    const phaseBefore = (await db.query('select * from public.workshops')).rows
    const migration = await read('../supabase/migrations/20261013_review_phase.sql')
    if (migrated) {
      await db.exec(migration); await db.exec(migration)
      assert.deepEqual((await db.query('select * from public.ideas order by id')).rows, before)
      assert.deepEqual((await db.query('select * from public.workshops')).rows, phaseBefore)
    }
    assert.equal((await as(moderator, "select public.advance_phase('ideas')")).rows[0].advance_phase, 'review')
    assert.equal((await as(moderator, 'select * from public.ideas')).rows.length, 5)
    assert.equal((await as(uid(1), 'select * from public.ideas')).rows.length, 0)
    assert.equal((await as(uid(4), 'select * from public.ideas')).rows.length, 0)
    await as(uid(4), "select public.join_workshop('Llegué durante revisión')")
    assert.equal((await as(uid(4), 'select * from public.ideas')).rows.length, 0)
    for (const actor of [uid(1), moderator]) {
      await assert.rejects(as(actor, 'insert into public.ideas(author_id,task,organizer) values ($1,$2,$3)', [actor, 'Fuera de tiempo', actor === moderator]), /policy|cerrada/)
      assert.equal((await as(actor, 'update public.ideas set task=$1 where id=$2 returning id', ['Editada', actor === moderator ? team : idea])).rows.length, 0)
      await assert.rejects(as(actor, 'select public.classify_idea($1,array[1]::smallint[])', [idea]), /cerrada/)
    }
    await assert.rejects(as(uid(1), "select public.advance_phase('review')"), /moderador/)
    await assert.rejects(as(moderator, "select public.advance_phase('ideas')"), /fase cambió/)
    const preset = 'ce1def00-0000-4000-8000-000000000001'
    await as(moderator, 'select public.set_idea_visibility($1,false)', [idea])
    await as(moderator, 'select public.set_idea_visibility($1,false)', [preset])
    assert.equal((await as(moderator, 'select * from public.get_hidden_idea_ids()')).rows.length, 2)
    assert.equal(Number((await as(moderator, 'select * from public.get_progress()')).rows[0].total), 3)
    await assert.rejects(as(uid(1), 'select * from public.get_results()'), /cerrados/)
    assert.equal((await as(moderator, "select public.advance_phase('review')")).rows[0].advance_phase, 'classification')
    const exposed = (await as(uid(1), 'select * from public.ideas')).rows
    assert.equal(exposed.length, 3)
    assert.ok(exposed.every(row => row.id !== idea && row.id !== preset))
    await assert.rejects(as(uid(1), 'select public.classify_idea($1,array[1]::smallint[])', [idea]), /disponible/)
    await as(uid(1), 'select public.classify_idea($1,array[1]::smallint[])', [team])
    await as(moderator, "select public.advance_phase('classification')")
    const results = (await as(uid(1), 'select * from public.get_results()')).rows
    const closed = (await db.query('select * from public.workshops')).rows
    await db.exec(migration)
    assert.deepEqual((await db.query('select * from public.workshops')).rows, closed)
    assert.deepEqual((await as(uid(1), 'select * from public.get_results()')).rows, results)
  })
}
