import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const moderator = uid(3)
const read = path => readFile(new URL(path, import.meta.url), 'utf8')
for (const migrated of [false, true]) {
  test(`visibilidad protegida y respuestas conservadas: ${migrated ? 'migración' : 'setup'}`, async t => {
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
      for (const file of ['20261011_preset_ideas.sql', '20261013_join_any_phase.sql', '20261013_moderator_reset.sql']) {
        await db.exec(await read(`../supabase/migrations/${file}`))
      }
    } else await db.exec(await read('../supabase/setup.sql'))
    await db.query('insert into auth.users select unnest($1::uuid[])', [[uid(1), uid(2), moderator, uid(4)]])
    await db.query('insert into ceidef_private.moderators values ($1)', [moderator])
    const as = (user, sql, params = [], anonymous = user !== moderator, role = 'authenticated') => db.transaction(async tx => {
      await tx.exec(`set local role ${role}`)
      await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, is_anonymous: anonymous })])
      return tx.query(sql, params)
    })
    await as(uid(1), "select public.join_workshop('Uno')")
    await as(uid(2), "select public.join_workshop('Dos')")
    await as(moderator, "select public.advance_phase('waiting')")
    const idea = (await as(uid(1), 'insert into public.ideas(author_id,task) values ($1,$2) returning id', [uid(1), 'Propuesta'])).rows[0].id
    await as(moderator, 'insert into public.ideas(author_id,task,organizer) values ($1,$2,true)', [moderator, 'Equipo'])
    await as(moderator, "select public.advance_phase('ideas')")
    if (!migrated) await as(moderator, "select public.advance_phase('review')")
    const preset = 'ce1def00-0000-4000-8000-000000000001'
    await as(uid(1), 'select public.classify_idea($1,array[1]::smallint[])', [idea])
    await as(uid(2), 'select public.classify_idea($1,array[2]::smallint[])', [idea])
    await as(uid(1), "select public.classify_idea($1,'{}'::smallint[])", [preset])
    const votes = (await db.query('select * from public.classifications order by user_id,idea_id')).rows
    const before = (await db.query('select * from public.workshops')).rows
    if (migrated) {
      const migration = await read('../supabase/migrations/20261013_idea_visibility.sql')
      await db.exec(migration); await db.exec(migration)
      const resetFix = await read('../supabase/migrations/20261013_reset_where.sql')
      await db.exec(resetFix); await db.exec(resetFix)
      assert.deepEqual((await db.query('select * from public.workshops')).rows, before)
      assert.deepEqual((await db.query('select * from public.classifications order by user_id,idea_id')).rows, votes)
    }
    for (const actor of [uid(1), uid(4)]) {
      await assert.rejects(as(actor, 'select public.set_idea_visibility($1,false)', [idea]), /moderador/)
      await assert.rejects(as(actor, 'select * from public.get_hidden_idea_ids()'), /moderador/)
    }
    await assert.rejects(as(moderator, 'select public.set_idea_visibility($1,false)', [idea], true), /moderador/)
    await assert.rejects(as(null, 'select public.set_idea_visibility($1,false)', [idea], true, 'anon'), /permission/)
    await assert.rejects(as(moderator, 'select public.set_idea_visibility($1,null)', [idea]), /Indicá/)
    for (const actor of [uid(1), moderator]) {
      await assert.rejects(as(actor, 'select * from ceidef_private.hidden_ideas'), /permission/)
      await assert.rejects(as(actor, 'insert into ceidef_private.hidden_ideas(idea_id,hidden_by) values ($1,$2)', [idea, actor]), /permission/)
    }
    await as(moderator, 'select public.set_idea_visibility($1,false)', [idea])
    await as(moderator, 'select public.set_idea_visibility($1,false)', [idea])
    assert.notDeepEqual((await db.query('select * from public.workshops')).rows, before)
    assert.deepEqual((await as(moderator, 'select * from public.get_hidden_idea_ids()')).rows, [{ idea_id: idea }])
    assert.equal((await as(uid(1), 'select * from public.ideas')).rows.length, 4)
    assert.equal((await as(moderator, 'select * from public.ideas')).rows.length, 5)
    assert.equal((await as(uid(1), 'select * from public.classifications')).rows.length, 1)
    await assert.rejects(as(uid(1), 'select public.classify_idea($1,array[3]::smallint[])', [idea]), /disponible/)
    const progress = (await as(moderator, 'select * from public.get_progress()')).rows
    assert.equal(Number(progress.find(p => p.user_id === uid(1)).completed), 1)
    assert.equal(Number(progress[0].total), 4)
    await as(moderator, 'select public.set_idea_visibility($1,false)', [preset])
    await as(moderator, "select public.advance_phase('classification')")
    const shown = (await as(uid(1), 'select * from public.get_results()')).rows
    assert.equal(shown.length, 18)
    assert.ok(shown.every(row => row.idea_id !== idea && row.idea_id !== preset))
    const archived = (await as(moderator, 'select * from public.get_results()')).rows
    assert.equal(Number(archived.find(row => row.idea_id === idea).total), 2)
    assert.deepEqual((await db.query('select * from public.classifications order by user_id,idea_id')).rows, votes)
    await as(moderator, 'select public.set_idea_visibility($1,true)', [idea])
    assert.equal((await as(uid(1), 'select * from public.ideas')).rows.length, 4)
    assert.equal(Number((await as(uid(1), 'select * from public.get_results()')).rows.find(row => row.idea_id === idea).total), 2)
    // PGlite no carga safeupdate: comprobar las condiciones del SQL instalado.
    const definition = (await db.query("select pg_get_functiondef('public.reset_workshop(timestamptz)'::regprocedure) as sql")).rows[0].sql
    const deletes = [...definition.matchAll(/\bdelete\s+from\s+[^;]+;/gi)]
    assert.equal(deletes.length, 3)
    for (const [statement] of deletes) assert.match(statement, /\bwhere\b/i)
    // El reinicio restaura también la visibilidad de las fichas permanentes.
    const revision = (await db.query('select updated_at from public.workshops')).rows[0].updated_at
    await as(moderator, 'select public.reset_workshop($1)', [revision])
    assert.equal((await db.query('select * from ceidef_private.hidden_ideas')).rows.length, 0)
    assert.equal((await db.query('select * from public.ideas')).rows.length, 3)
    assert.equal((await db.query('select * from public.classifications')).rows.length, 0)
    await as(uid(1), "select public.join_workshop('Otra edición')")
    await as(moderator, "select public.advance_phase('waiting')")
    await assert.rejects(as(moderator, 'select public.set_idea_visibility($1,false)', [preset]), /disponible/)
    const own = (await as(uid(1), 'insert into public.ideas(author_id,task) values ($1,$2) returning id', [uid(1), 'Nueva tarea'])).rows[0].id
    await as(moderator, 'select public.set_idea_visibility($1,false)', [own])
    assert.equal((await as(uid(1), 'update public.ideas set task=$1 where id=$2 returning id', ['Alterada', own])).rows.length, 0)
    await db.exec(await read('../supabase/reset.sql'))
    assert.equal((await db.query('select * from ceidef_private.hidden_ideas')).rows.length, 0)
  })
}
