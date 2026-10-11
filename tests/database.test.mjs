import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const moderator = uid(100)

test('SQL real: fases, límites, RPC y privacidad con roles y JWT', async t => {
  const db = new PGlite()
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
    $$;
    create function auth.uid() returns uuid language sql stable as $$
      select (auth.jwt()->>'sub')::uuid;
    $$;
    grant usage on schema auth to authenticated, anon;
  `)
  await db.exec(await readFile(new URL('../supabase/setup.sql', import.meta.url), 'utf8'))
  await db.query('insert into auth.users select unnest($1::uuid[])', [[...Array.from({ length: 12 }, (_, i) => uid(i + 1)), moderator]])
  await db.query('insert into ceidef_private.moderators values ($1)', [moderator])

  async function as(user, sql, params = [], anonymous = user !== moderator, role = 'authenticated') {
    return db.transaction(async tx => {
      await tx.exec(`set local role ${role}`)
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, is_anonymous: anonymous })])
      return tx.query(sql, params)
    })
  }
  const denied = (user, sql, params = [], pattern = /permission|policy|cerrad|requieren|propias|participante|hasta 3|10 participantes|foreign key|duplicate|check constraint/i) =>
    assert.rejects(as(user, sql, params), pattern)
  const insertIdea = (user, text, team = false) => as(user, 'insert into public.ideas(author_id, content, organizer) values ($1,$2,$3) returning id', [user, text, team])
  let firstIdea, secondIdea, teamIdea

  await t.test('sin sesión no se puede leer ni ejecutar RPC', async () => {
    await assert.rejects(as(null, 'select * from public.ideas', [], true, 'anon'), /permission/)
    await assert.rejects(as(null, "select public.join_workshop('Intruso')", [], true, 'anon'), /permission/)
  })
  await t.test('registro idempotente, nombre válido y máximo 10', async () => {
    await denied(uid(1), "select public.join_workshop('   ')", [], /nombre/)
    for (let i = 1; i <= 10; i++) await as(uid(i), 'select public.join_workshop($1)', [`Persona ${i}`])
    await as(uid(1), "select public.join_workshop('Reintento')")
    assert.equal((await as(uid(1), 'select name from public.participants')).rows[0].name, 'Persona 1')
    await denied(uid(11), "select public.join_workshop('Once')", [], /10 participantes/)
    await denied(moderator, "select public.join_workshop('Moderador')", [], /no ocupa/)
  })
  await t.test('no hay autoasignación de moderador ni cambios directos de fase', async () => {
    await denied(uid(1), 'insert into ceidef_private.moderators values ($1)', [uid(1)])
    await denied(uid(1), "update public.workshops set phase='results'")
    await denied(moderator, "update public.workshops set phase='results'")
    assert.equal((await as(uid(1), 'select public.is_moderator()')).rows[0].is_moderator, false)
    assert.equal((await as(moderator, 'select public.is_moderator()', [], true)).rows[0].is_moderator, false)
    await denied(uid(1), "select public.advance_phase('waiting')")
    await denied(uid(1), 'select * from public.get_progress()')
  })
  await t.test('escritura y resultados cerrados en espera', async () => {
    await assert.rejects(insertIdea(uid(1), 'Fuera de tiempo'), /cerrada|policy/)
    await denied(uid(1), 'select * from public.get_results()')
    await as(moderator, "select public.advance_phase('waiting')")
    await denied(moderator, "select public.advance_phase('waiting')", [], /fase cambió/)
    await denied(uid(12), "select public.join_workshop('Tarde')", [], /ingreso cerró/)
    await as(uid(1), "select public.join_workshop('Recarga')")
  })
  await t.test('ideas privadas, máximo 3, edición y eliminación propias', async () => {
    firstIdea = (await insertIdea(uid(1), 'Primera idea')).rows[0].id
    secondIdea = (await insertIdea(uid(2), 'Idea privada de otra persona')).rows[0].id
    teamIdea = (await insertIdea(moderator, 'Propuesta del equipo', true)).rows[0].id
    await insertIdea(uid(1), 'Segunda idea')
    await insertIdea(uid(1), 'Tercera idea')
    await assert.rejects(insertIdea(uid(1), 'Cuarta idea'), /hasta 3/)
    assert.equal((await as(uid(1), 'select * from public.ideas')).rows.length, 3)
    assert.equal((await as(uid(11), 'select * from public.ideas')).rows.length, 0)
    assert.equal((await as(moderator, 'select * from public.ideas')).rows.length, 5)
    assert.equal((await as(uid(1), 'update public.ideas set content=$1 where id=$2 returning id', ['Ataque', secondIdea])).rows.length, 0)
    assert.equal((await as(uid(1), 'delete from public.ideas where id=$1 returning id', [secondIdea])).rows.length, 0)
    await denied(uid(1), 'update public.ideas set author_id=$1 where id=$2', [uid(2), firstIdea])
    await assert.rejects(insertIdea(uid(1), 'Marca falsificada', true), /moderador|policy/)
    await assert.rejects(insertIdea(uid(11), 'No ingresó'), /registrado|policy/)
    await as(uid(1), 'update public.ideas set content=$1 where id=$2', ['Primera idea editada', firstIdea])
    await as(uid(1), 'delete from public.ideas where id <> $1', [firstIdea])
    await insertIdea(uid(1), 'Nueva idea después de eliminar')
    await denied(uid(1), 'select public.classify_idea($1, 1::smallint)', [firstIdea])
  })
  await t.test('clasificación: mural público solo a miembros y escritura bloqueada', async () => {
    await as(moderator, "select public.advance_phase('ideas')")
    assert.equal((await as(uid(1), 'select * from public.ideas')).rows.length, 4)
    assert.equal((await as(uid(11), 'select * from public.ideas')).rows.length, 0)
    await assert.rejects(insertIdea(uid(1), 'Fuera de fase'), /cerrada|policy/)
    await assert.rejects(insertIdea(moderator, 'Fuera de fase', true), /cerrada|policy/)
    assert.equal((await as(uid(1), 'update public.ideas set content=$1 where id=$2 returning id', ['Tarde', firstIdea])).rows.length, 0)
    assert.equal((await as(uid(1), 'delete from public.ideas where id=$1 returning id', [firstIdea])).rows.length, 0)
    await denied(moderator, 'select * from public.get_results()')
  })
  await t.test('clasificación única, modificable, áreas válidas y votos ajenos ocultos', async () => {
    await as(uid(1), 'select public.classify_idea($1, 1::smallint)', [firstIdea])
    await as(uid(1), 'select public.classify_idea($1, 2::smallint)', [firstIdea])
    await as(uid(2), 'select public.classify_idea($1, 2::smallint)', [firstIdea])
    await as(uid(1), 'select public.classify_idea($1, 7::smallint)', [teamIdea])
    const mine = (await as(uid(1), 'select * from public.classifications')).rows
    assert.equal(mine.length, 2)
    assert.equal(mine.find(r => r.idea_id === firstIdea).area_id, 2)
    assert.equal((await as(uid(2), 'select * from public.classifications')).rows.length, 1)
    assert.equal((await as(moderator, 'select * from public.classifications')).rows.length, 0)
    await denied(uid(1), 'insert into public.classifications values ($1,$2,1,now())', [uid(2), secondIdea])
    await denied(uid(1), 'insert into public.classifications(user_id,idea_id,area_id) values ($1,$2,1)', [uid(1), firstIdea])
    await denied(uid(1), 'select public.classify_idea($1, 99::smallint)', [firstIdea])
    await denied(uid(11), 'select public.classify_idea($1, 1::smallint)', [firstIdea])
    await denied(uid(1), 'delete from public.classifications')
    const progress = (await as(moderator, 'select * from public.get_progress()')).rows
    assert.equal(progress.length, 10)
    assert.equal(Number(progress.find(p => p.user_id === uid(1)).completed), 2)
    assert.equal(Number(progress[0].total), 4)
    assert.deepEqual(Object.keys(progress[0]).sort(), ['completed', 'name', 'total', 'user_id'])
  })
  await t.test('resultados: 7 áreas incluyendo ceros y total por idea; cierre definitivo', async () => {
    await as(moderator, "select public.advance_phase('classification')")
    const results = (await as(uid(1), 'select * from public.get_results()')).rows
    assert.equal(results.length, 4 * 7)
    const counts = results.filter(r => r.idea_id === firstIdea)
    assert.equal(counts.length, 7)
    assert.equal(Number(counts.find(r => r.area_id === 2).votes), 2)
    assert.equal(Number(counts.find(r => r.area_id === 1).votes), 0)
    assert.ok(counts.every(r => Number(r.total) === 2))
    assert.ok(results.filter(r => r.idea_id === secondIdea).every(r => Number(r.total) === 0))
    assert.equal((await as(moderator, 'select * from public.get_results()')).rows.length, 28)
    await denied(uid(11), 'select * from public.get_results()', [], /Ingresá a la actividad/)
    await denied(uid(1), 'select public.classify_idea($1, 3::smallint)', [firstIdea])
    await denied(uid(1), 'select public.classify_idea($1, 3::smallint)', [secondIdea])
    await denied(moderator, "select public.advance_phase('results')", [], /finalizó/)
    assert.equal((await as(uid(1), 'select * from public.classifications')).rows.length, 2)
  })
  await t.test('solo workshops se publica en Realtime', async () => {
    const tables = (await db.query("select tablename from pg_publication_tables where pubname='supabase_realtime'")).rows
    assert.deepEqual(tables.map(r => r.tablename), ['workshops'])
  })
  await t.test('reinicio administrativo: vacía actividad y conserva Auth, áreas, permisos y RLS', async () => {
    const reset = await readFile(new URL('../supabase/reset.sql', import.meta.url), 'utf8')
    const authCount = (await db.query('select count(*)::int as n from auth.users')).rows[0].n
    await denied(uid(1), 'truncate public.classifications, public.ideas, public.participants')
    await denied(moderator, 'truncate public.classifications, public.ideas, public.participants')
    await db.exec(reset)
    for (const table of ['participants', 'ideas', 'classifications']) {
      assert.equal((await db.query(`select count(*)::int as n from public.${table}`)).rows[0].n, 0)
    }
    assert.equal((await as(moderator, 'select phase from public.workshops')).rows[0].phase, 'waiting')
    assert.equal((await as(moderator, 'select public.is_moderator()')).rows[0].is_moderator, true)
    assert.equal((await as(moderator, 'select * from public.areas')).rows.length, 7)
    assert.equal((await db.query('select count(*)::int as n from auth.users')).rows[0].n, authCount)
    assert.equal((await as(uid(1), 'select * from public.participants')).rows.length, 0)
    const rls = (await db.query("select relrowsecurity from pg_class where relnamespace='public'::regnamespace and relname in ('workshops','participants','areas','ideas','classifications')")).rows
    assert.equal(rls.length, 5)
    assert.ok(rls.every(row => row.relrowsecurity))
    await denied(uid(1), 'select * from public.get_results()')
    // El mismo UUID/sesión puede ingresar de nuevo, escribir y clasificar.
    await as(uid(1), "select public.join_workshop('Nueva edición')")
    assert.equal((await as(uid(1), 'select name from public.participants')).rows[0].name, 'Nueva edición')
    await as(moderator, "select public.advance_phase('waiting')")
    const nextIdea = (await insertIdea(uid(1), 'Idea del nuevo encuentro')).rows[0].id
    assert.notEqual(nextIdea, firstIdea)
    await as(moderator, "select public.advance_phase('ideas')")
    await as(uid(1), 'select public.classify_idea($1, 1::smallint)', [nextIdea])
    await denied(uid(1), 'select public.classify_idea($1, 1::smallint)', [firstIdea], /foreign key/)
    // También funciona antes de resultados y es repetible estando vacío.
    await db.exec(reset)
    await db.exec(reset)
    assert.equal((await as(moderator, 'select * from public.get_progress()')).rows.length, 0)
    assert.equal((await as(moderator, 'select phase from public.workshops')).rows[0].phase, 'waiting')
  })
  await db.close()
})
