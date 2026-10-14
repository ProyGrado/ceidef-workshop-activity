import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const moderator = uid(1000)
const read = path => readFile(new URL(path, import.meta.url), 'utf8')

for (const migrated of [false, true]) {
  test(`ingreso en todas las fases: ${migrated ? 'migración sobre datos existentes' : 'instalación nueva'}`, async t => {
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
    } else await db.exec(await read('../supabase/setup.sql'))
    await db.query('insert into auth.users select unnest($1::uuid[])', [[...Array.from({ length: 102 }, (_, n) => uid(n + 1)), moderator]])
    await db.query('insert into ceidef_private.moderators values ($1)', [moderator])
    const as = (user, sql, params = [], role = 'authenticated') => db.transaction(async tx => {
      await tx.exec(`set local role ${role}`)
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, is_anonymous: user !== moderator })])
      return tx.query(sql, params)
    })
    await as(uid(1), "select public.join_workshop('Original')")
    await as(moderator, "select public.advance_phase('waiting')")
    const idea = (await as(uid(1), 'insert into public.ideas(author_id,task) values ($1,$2) returning id', [uid(1), 'Idea anterior'])).rows[0].id
    await as(moderator, "select public.advance_phase('ideas')")
    if (!migrated) await as(moderator, "select public.advance_phase('review')")
    await as(uid(1), 'select public.classify_idea($1,array[1]::smallint[])', [idea])
    await as(moderator, "select public.advance_phase('classification')")
    const before = (await db.query('select * from public.workshops')).rows
    const ideasBefore = (await db.query('select * from public.ideas order by id')).rows
    const votesBefore = (await db.query('select * from public.classifications')).rows
    if (migrated) {
      const migration = await read('../supabase/migrations/20261013_join_any_phase.sql')
      await db.exec(migration)
      await db.exec(migration)
      assert.deepEqual((await db.query('select * from public.workshops')).rows, before)
      assert.deepEqual((await db.query('select * from public.ideas order by id')).rows, ideasBefore)
      assert.deepEqual((await db.query('select * from public.classifications')).rows, votesBefore)
      await as(uid(6), "select public.join_workshop('Ingreso tras migrar resultados')")
    }
    // Volver a espera solo para recorrer las cuatro fases con los mismos datos.
    await db.exec("update public.workshops set phase='waiting'")
    for (const [index, phase] of (migrated ? ['waiting', 'ideas', 'classification', 'results'] : ['waiting', 'ideas', 'review', 'classification', 'results']).entries()) {
      const user = uid(index + 2)
      await as(user, 'select public.join_workshop($1)', [`Tardío ${phase}`])
      await as(user, "select public.join_workshop('Otro nombre')")
      assert.equal((await as(user, 'select name from public.participants')).rows[0].name, `Tardío ${phase}`)
      assert.equal((await as(user, 'select phase from public.workshops')).rows[0].phase, phase)
      assert.equal((await as(user, 'select * from public.classifications')).rows.length, 0)
      if (phase === 'waiting' || phase === 'ideas' || phase === 'review') {
        assert.equal((await as(user, 'select * from public.ideas')).rows.length, 0)
      } else assert.equal((await as(user, 'select * from public.ideas')).rows.length, 4)
      const insert = () => as(user, 'insert into public.ideas(author_id,task) values ($1,$2) returning id', [user, 'Nueva idea'])
      if (phase === 'ideas') {
        const own = (await insert()).rows[0].id
        await as(user, 'delete from public.ideas where id=$1', [own])
      } else await assert.rejects(insert(), /policy|cerrada/)
      if (phase === 'classification') {
        await as(user, "select public.classify_idea($1,'{}'::smallint[])", [idea])
        assert.equal((await as(user, 'select * from public.classifications')).rows.length, 1)
      } else await assert.rejects(as(user, 'select public.classify_idea($1,array[2]::smallint[])', [idea]), /policy|cerrada/)
      if (phase === 'results') {
        const results = (await as(user, 'select * from public.get_results()')).rows
        assert.equal(Number(results.find(row => row.idea_id === idea).total), 2)
      } else await as(moderator, 'select public.advance_phase($1)', [phase])
    }
    await assert.rejects(as(null, "select public.join_workshop('Sin sesión')"), /sesión/)
    await assert.rejects(as(null, "select public.join_workshop('Sin sesión')", [], 'anon'), /permission/)
    await assert.rejects(as(moderator, "select public.join_workshop('Moderador')"), /no ocupa/)
    await assert.rejects(as(uid(7), "select public.join_workshop('   ')"), /nombre/)
    await assert.rejects(as(uid(7), 'insert into public.participants(user_id,name) values ($1,$2)', [uid(7), 'Directo']), /permission|policy/)
    for (let n = 6; n <= 100; n++) await as(uid(n), 'select public.join_workshop($1)', [`Persona ${n}`])
    await as(uid(1), "select public.join_workshop('Recarga con actividad llena')")
    await assert.rejects(as(uid(101), "select public.join_workshop('Sin lugar')"), /100 participantes/)
    assert.equal((await db.query('select count(*)::int as total from public.participants')).rows[0].total, 100)
  })
}
