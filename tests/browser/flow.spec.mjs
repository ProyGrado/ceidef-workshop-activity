import { test, expect } from '@playwright/test'
import { AREAS, IDEA_FIELDS, MAX_IDEAS } from '../../src/lib/workshop.ts'

// Dobles de HTTP para probar la UI sin alterar el proyecto Supabase del usuario.
// RLS y RPC se verifican por separado ejecutando setup.sql en PostgreSQL real.
function fixture() {
  const state = { phase: 'waiting', revision: 0, participants: [], ideas: [], choices: [], nextId: 0, failSave: false }
  const users = new Map()
  const moderator = { id: '00000000-0000-4000-8000-000000000100', email: 'moderador@example.test', is_anonymous: false }
  function session(user) {
    const token = `${Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, is_anonymous: user.is_anonymous, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fake-signature`
    users.set(token, user)
    return { access_token: token, refresh_token: `refresh-${user.id}`, token_type: 'bearer', expires_in: 3600, user: { ...user, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } }
  }
  async function attach(context) {
    await context.routeWebSocket('**/realtime/v1/websocket*', socket => socket.close())
    await context.route('http://supabase.test/**', async route => {
      const request = route.request()
      const url = new URL(request.url())
      const method = request.method()
      const body = request.postDataJSON() ?? {}
      const user = users.get(request.headers().authorization?.replace('Bearer ', ''))
      const mod = user?.id === moderator.id
      const mine = state.participants.find(p => p.user_id === user?.id)
      const respond = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
      const paginate = rows => {
        const start = Number(url.searchParams.get('offset') ?? 0)
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 1000), 1000)
        return rows.slice(start, start + limit)
      }
      const failure = message => respond({ message, code: 'P0001', details: null, hint: null }, 400)
      if (url.pathname.endsWith('/signup')) return respond(session({ id: `00000000-0000-4000-8000-${String(++state.nextId).padStart(12, '0')}`, is_anonymous: true }))
      if (url.pathname.endsWith('/token')) return respond(session(body.email === moderator.email ? moderator : { id: 'unprivileged', is_anonymous: false }))
      if (url.pathname.endsWith('/logout')) return respond({})
      if (url.pathname.endsWith('/user')) return respond(user)
      const endpoint = url.pathname.split('/').at(-1)
      if (url.pathname.includes('/rpc/')) {
        if (endpoint === 'is_moderator') return respond(mod)
        if (endpoint === 'get_hidden_idea_ids') {
          if (!mod) return failure('Se requieren permisos de moderador.')
          return respond(paginate(state.ideas.filter(i => i.hidden && (!i.preset || ['review', 'classification', 'results'].includes(state.phase))).map(i => ({ idea_id: i.id }))))
        }
        if (endpoint === 'set_idea_visibility') {
          if (!mod) return failure('Se requieren permisos de moderador.')
          if (state.failVisibility) { state.failVisibility = false; return failure('No se pudo cambiar la visibilidad.') }
          const idea = state.ideas.find(i => i.id === body.target_idea)
          if (!idea) return failure('La idea ya no está disponible.')
          idea.hidden = !body.visible; state.revision++
          return respond(null)
        }
        if (endpoint === 'join_workshop') {
          if (mine) return respond(mine)
          if (mod) return failure('El moderador no ocupa un lugar de participante.')
          if (state.participants.length >= 100) return failure('La actividad ya tiene 100 participantes.')
          const participant = { user_id: user.id, name: body.participant_name }
          state.participants.push(participant)
          return respond(participant)
        }
        if (endpoint === 'advance_phase') {
          if (!mod) return failure('Se requieren permisos de moderador.')
          state.phase = { waiting: 'ideas', ideas: 'review', review: 'classification', classification: 'results' }[state.phase]
          state.revision++
          return respond(state.phase)
        }
        if (endpoint === 'reset_workshop') {
          if (!mod) return failure('Se requieren permisos de moderador.')
          if (body.expected_revision !== `revision-${state.revision}`) return failure('La actividad cambió. Cerrá la confirmación y revisá antes de reiniciar.')
          if (state.failReset) { state.failReset = false; return failure('No se pudo reiniciar. Volvé a intentar.') }
          state.participants = []; state.choices = []
          state.ideas = state.ideas.filter(idea => idea.preset)
          state.ideas.forEach(idea => { idea.hidden = false })
          state.phase = 'waiting'; state.revision++
          return respond(null)
        }
        if (endpoint === 'classify_idea') {
          if (!mine || state.phase !== 'classification') return failure('La clasificación está cerrada.')
          if (state.ideas.find(i => i.id === body.target_idea)?.hidden) return failure('La idea ya no está disponible.')
          state.choices = state.choices.filter(c => c.user_id !== user.id || c.idea_id !== body.target_idea)
          state.choices.push({ user_id: user.id, idea_id: body.target_idea, area_ids: body.selected_areas })
          return respond(null)
        }
        if (endpoint === 'get_progress') return respond(paginate(state.participants.map(p => ({ ...p, completed: state.choices.filter(c => c.user_id === p.user_id && !state.ideas.find(i => i.id === c.idea_id)?.hidden).length, total: state.ideas.filter(i => !i.hidden && (!i.preset || ['review', 'classification', 'results'].includes(state.phase))).length }))))
        if (endpoint === 'get_results') return respond(paginate(state.ideas.filter(i => mod || !i.hidden).flatMap(i => AREAS.map((_, n) => ({ idea_id: i.id, area_id: n + 1, votes: state.choices.filter(c => c.idea_id === i.id && c.area_ids.includes(n + 1)).length, total: state.choices.filter(c => c.idea_id === i.id).length, no_area: state.choices.filter(c => c.idea_id === i.id && c.area_ids.length === 0).length })))))
      }
      const single = request.headers().accept?.includes('application/vnd.pgrst.object')
      const replyRows = rows => respond(single ? rows[0] : paginate(rows))
      if (endpoint === 'workshops') return replyRows([{ id: 1, title: 'Laboratorio de ideas', phase: state.phase, updated_at: `revision-${state.revision}` }])
      if (endpoint === 'participants') return replyRows(state.participants.filter(p => p.user_id === user?.id))
      if (endpoint === 'classifications') return replyRows(state.choices.filter(c => c.user_id === user?.id && !state.ideas.find(i => i.id === c.idea_id)?.hidden))
      if (endpoint === 'ideas') {
        if (method === 'GET') return replyRows(state.ideas.filter(i => (!i.preset || (mod ? ['review', 'classification', 'results'] : ['classification', 'results']).includes(state.phase)) && (mod || (mine && state.phase !== 'review' && !i.hidden && (state.phase !== 'ideas' || i.author_id === user?.id)))))
        if (state.failSave) { state.failSave = false; return failure('Error de conexión de prueba. Volvé a intentar.') }
        if (state.phase !== 'ideas') return failure('La escritura de ideas está cerrada.')
        if (method === 'POST') {
          state.ideas.push({ ...body, id: `idea-${++state.nextId}`, created_at: new Date().toISOString() })
          return respond(null, 201)
        }
        const id = url.searchParams.get('id')?.replace('eq.', '')
        const idea = state.ideas.find(i => i.id === id)
        if (method === 'PATCH') Object.assign(idea, body)
        if (method === 'DELETE') state.ideas = state.ideas.filter(i => i.id !== id)
        return replyRows([{ id }])
      }
      return failure(`Endpoint de prueba desconocido: ${url.pathname}`)
    })
  }
  return { state, attach }
}

const draftValues = text => ({ position: 'Farmacéutico/a', task: text, information: 'Historia clínica y medicación actual', supervisor: 'Equipo clínico', boundaries: 'No cambiar un tratamiento sin autorización', success_criteria: 'Menos errores de medicación documentados' })

for (const phase of ['ideas', 'classification', 'results']) {
  test(`ingreso tardío en ${phase}, recarga y otro dispositivo sin actividad previa`, async ({ page, browser }, testInfo) => {
    const api = fixture()
    api.state.phase = phase
    const original = '00000000-0000-4000-8000-000000000090'
    api.state.participants.push({ user_id: original, name: 'Original' })
    api.state.ideas.push({ ...draftValues('Idea existente'), id: 'existing-idea', author_id: original, organizer: false, created_at: new Date().toISOString() })
    api.state.choices.push({ user_id: original, idea_id: 'existing-idea', area_ids: [1] })
    await api.attach(page.context())
    await page.goto('/')
    await page.getByLabel('Tu nombre').fill('Ingreso tardío')
    await expect(page.getByRole('button', { name: 'Entrar a la actividad' })).toBeEnabled()
    await page.getByRole('button', { name: 'Entrar a la actividad' }).click()
    const heading = phase === 'ideas' ? 'Tus post-its' : 'Nuestro mural de ideas'
    await expect(page.getByRole('heading', { name: heading })).toBeVisible()
    expect(api.state.phase).toBe(phase)
    if (phase === 'ideas') {
      await expect(page.getByText('Idea existente', { exact: true })).toHaveCount(0)
      await addIdea(page, 'Idea desde ingreso tardío')
    } else {
      await expect(page.locator('.idea-composer')).toHaveCount(0)
      await expect(page.getByText('Idea existente', { exact: true })).toBeVisible()
      if (phase === 'classification') {
        await expect(page.getByText('0 de 1 ideas clasificadas')).toBeVisible()
        await page.locator('.area-option').filter({ hasText: AREAS[1] }).click()
        await expect(page.getByText('1 de 1 ideas clasificadas')).toBeVisible()
      } else {
        await expect(page.locator('.result-total')).toContainText('1')
        await expect(page.locator('.area-option')).toHaveCount(0)
      }
    }
    await page.reload()
    await expect(page.getByRole('heading', { name: heading })).toBeVisible()
    expect(api.state.participants).toHaveLength(2)
    if (phase === 'classification') await expect(page.getByText('1 de 1 ideas clasificadas')).toBeVisible()
    // Otro navegador no hereda las ideas ni las elecciones de una sesión anónima.
    const other = await browser.newContext({ viewport: testInfo.project.use.viewport })
    try {
      await api.attach(other)
      const next = await other.newPage()
      await next.goto('http://127.0.0.1:5199')
      await next.getByLabel('Tu nombre').fill('Ingreso tardío')
      await next.getByRole('button', { name: 'Entrar a la actividad' }).click()
      await expect(next.getByRole('heading', { name: heading })).toBeVisible()
      expect(api.state.participants).toHaveLength(3)
      expect(api.state.participants[1].user_id).not.toBe(api.state.participants[2].user_id)
      if (phase === 'ideas') await expect(next.locator('article')).toHaveCount(0)
      if (phase === 'classification') await expect(next.getByText('0 de 1 ideas clasificadas')).toBeVisible()
      if (phase === 'results') await expect(next.locator('.result-total')).toContainText('1')
      await next.screenshot({ path: testInfo.outputPath(`ingreso-${phase}.png`), fullPage: true })
    } finally { await other.close() }
  })
}

test('moderación actualiza los participantes que ingresan en resultados', async ({ page, browser }, testInfo) => {
  const api = fixture()
  api.state.phase = 'results'
  api.state.participants.push({ user_id: 'original', name: 'Original' })
  api.state.ideas.push({ ...draftValues('Idea existente'), id: 'existing', author_id: 'original', organizer: false, created_at: new Date().toISOString() })
  await api.attach(page.context())
  await page.goto('/?moderador')
  await page.getByLabel('Correo electrónico').fill('moderador@example.test')
  await page.getByLabel('Contraseña').fill('test-password-only')
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click()
  await expect(page.getByText('Participantes y progreso (1)', { exact: true })).toBeVisible()
  const other = await browser.newContext({ viewport: testInfo.project.use.viewport })
  try {
    await api.attach(other)
    const next = await other.newPage()
    await next.goto('http://127.0.0.1:5199')
    await next.getByLabel('Tu nombre').fill('Recién llegado')
    await next.getByRole('button', { name: 'Entrar a la actividad' }).click()
    await expect(next.getByRole('heading', { name: 'Nuestro mural de ideas' })).toBeVisible()
    await expect(page.getByText('Participantes y progreso (2)', { exact: true })).toBeVisible({ timeout: 10000 })
    await page.locator('.participant-details summary').click()
    await expect(page.locator('.participant-details li').filter({ hasText: 'Recién llegado' })).toContainText('0 / 1')
    await page.screenshot({ path: testInfo.outputPath('moderacion-ingreso-resultados.png'), fullPage: true })
  } finally { await other.close() }
})

test('reinicio solo de moderación: popup, cancelar, error, reintentar y conservar predeterminadas', async ({ page, browser }, testInfo) => {
  const api = fixture()
  api.state.phase = 'results'
  api.state.participants = [{ user_id: 'original', name: 'Original' }]
  api.state.ideas = [
    { ...draftValues('Idea que se borra'), id: 'normal', author_id: 'original', organizer: false },
    ...[1, 2, 3].map(n => ({ ...draftValues(`Tarea permanente ${n}`), id: `preset-${n}`, author_id: null, organizer: true, preset: true, title: `Predeterminada ${n}` })),
  ]
  api.state.choices = [{ user_id: 'original', idea_id: 'normal', area_ids: [1] }]
  await api.attach(page.context())
  await page.goto('/')
  await page.getByLabel('Tu nombre').fill('Participante')
  await page.getByRole('button', { name: 'Entrar a la actividad' }).click()
  await expect(page.getByRole('heading', { name: 'Nuestro mural de ideas' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reiniciar actividad', exact: true })).toHaveCount(0)
  const context = await browser.newContext({ viewport: testInfo.project.use.viewport })
  try {
    await api.attach(context)
    const mod = await context.newPage()
    await mod.goto('http://127.0.0.1:5199/?moderador')
    await mod.getByLabel('Correo electrónico').fill('moderador@example.test')
    await mod.getByLabel('Contraseña').fill('test-password-only')
    await mod.getByRole('button', { name: 'Ingresar', exact: true }).click()
    const reset = mod.getByRole('button', { name: 'Reiniciar actividad', exact: true })
    const popup = mod.getByRole('dialog', { name: '¿Reiniciar la actividad?' })
    await reset.click()
    await expect(popup).toBeVisible()
    await expect(popup.getByRole('button', { name: 'Cancelar', exact: true })).toBeFocused()
    await popup.getByRole('button', { name: 'Cancelar', exact: true }).click()
    await expect(popup).toHaveCount(0)
    expect(api.state.phase).toBe('results')
    expect(api.state.ideas).toHaveLength(4)
    await reset.click()
    await mod.keyboard.press('Escape')
    await expect(popup).toHaveCount(0)
    await expect(reset).toBeFocused()
    await reset.click()
    api.state.failReset = true
    await popup.getByRole('button', { name: 'Sí, reiniciar actividad' }).click()
    await expect(popup.getByRole('alert')).toContainText('No se pudo reiniciar')
    expect(api.state.ideas).toHaveLength(4)
    await popup.screenshot({ path: testInfo.outputPath('confirmacion-reinicio.png') })
    await popup.getByRole('button', { name: 'Sí, reiniciar actividad' }).click()
    await expect(popup).toHaveCount(0)
    await expect(mod.getByRole('heading', { name: 'Todo listo para empezar.' })).toBeVisible()
    expect(api.state.participants).toHaveLength(0)
    expect(api.state.choices).toHaveLength(0)
    expect(api.state.ideas).toHaveLength(3)
    await expect(page.getByLabel('Tu nombre')).toBeVisible({ timeout: 10000 })
    await page.getByLabel('Tu nombre').fill('Nueva edición')
    await page.getByRole('button', { name: 'Entrar a la actividad' }).click()
    await expect(page.getByRole('heading', { name: 'Hola, Nueva edición.' })).toBeVisible()
    await advance(mod, 'Comenzar escritura')
    await expect(mod.locator('article')).toHaveCount(0)
    await advance(mod, 'Cerrar escritura')
  await advance(mod, 'Abrir clasificación')
    await expect(page.locator('article')).toHaveCount(3, { timeout: 10000 })
    await page.reload()
    await expect(page.locator('article')).toHaveCount(3)
    await expect(page.getByText('0 de 3 ideas clasificadas')).toBeVisible()
  } finally { await context.close() }
})

for (const phase of ['classification', 'results']) {
  test(`gestión discreta de ideas en ${phase}: ocultar para todos, listar y restaurar votos`, async ({ page, browser }, testInfo) => {
    const api = fixture()
    api.state.phase = phase
    api.state.participants.push({ user_id: 'original', name: 'Original' })
    api.state.ideas = [
      { ...draftValues('Idea a retirar'), id: 'normal', author_id: 'original', organizer: false },
      { ...draftValues('Una tarea de ejemplo'), id: 'preset', author_id: null, organizer: true, preset: true, title: 'Asistente' },
    ]
    api.state.choices = [{ user_id: 'original', idea_id: 'normal', area_ids: [1] }]
    await api.attach(page.context())
    await page.goto('/')
    await expect(page.getByText('PENSAR · COMPARTIR · CONECTAR')).toHaveCount(0)
    await expect(page.getByText('Ideas que conectan.')).toHaveCount(0)
    await page.getByLabel('Tu nombre').fill('Participante')
    await page.getByRole('button', { name: 'Entrar a la actividad' }).click()
    await expect(page.locator('article')).toHaveCount(2)
    await expect(page.getByText('Idea predeterminada · Equipo organizador')).toHaveCount(0)
    await expect(page.locator('article').last()).not.toHaveClass(/note-team/)
    if (phase === 'classification') {
      await page.locator('article').first().getByRole('button', { name: 'Guardar sin áreas', exact: true }).click()
      await expect(page.getByText('✓ Respuesta guardada sin áreas')).toBeVisible()
    }
    else {
      await expect(page.getByText('EL MAPA DEL ENCUENTRO')).toHaveCount(0)
      await expect(page.locator('.intro-description')).toHaveCount(0)
    }
    const votesBefore = structuredClone(api.state.choices)
    const context = await browser.newContext({ viewport: testInfo.project.use.viewport })
    try {
      await api.attach(context)
      const mod = await context.newPage()
      await mod.goto('http://127.0.0.1:5199/?moderador')
      await mod.getByLabel('Correo electrónico').fill('moderador@example.test')
      await mod.getByLabel('Contraseña').fill('test-password-only')
      await mod.getByRole('button', { name: 'Ingresar', exact: true }).click()
      await expect(mod.locator('article')).toHaveCount(2)
      await expect(mod.getByRole('button', { name: 'Ocultar', exact: true })).toHaveCount(0)
      const openManager = async () => {
        await mod.getByLabel('Opciones de moderación', { exact: true }).click()
        await mod.getByRole('button', { name: 'Administrar ideas', exact: true }).click()
      }
      await openManager()
      const popup = mod.getByRole('dialog', { name: 'Administrar ideas' })
      const entry = popup.locator('li').filter({ hasText: 'Idea a retirar' })
      api.state.failVisibility = true
      await entry.getByRole('button', { name: 'Ocultar', exact: true }).click()
      await expect(popup.getByRole('alert')).toContainText('No se pudo cambiar')
      await entry.getByRole('button', { name: 'Ocultar', exact: true }).click()
      await expect(entry).toHaveCount(0)
      await popup.getByRole('button', { name: 'Ocultas', exact: true }).click()
      await expect(entry).toHaveCount(1)
      await popup.screenshot({ path: testInfo.outputPath(`gestion-${phase}.png`) })
      await popup.getByRole('button', { name: 'Cerrar', exact: true }).click()
      await expect(mod.locator('article')).toHaveCount(1)
      await expect(mod.getByText('Ocultas', { exact: true })).toHaveCount(0)
      await expect(mod.getByText('Idea a retirar', { exact: true })).toHaveCount(0)
      await expect(page.locator('article')).toHaveCount(1, { timeout: 10000 })
      expect(api.state.choices).toEqual(votesBefore)
      await mod.reload()
      await expect(mod.locator('article')).toHaveCount(1)
      await page.reload()
      await expect(page.locator('article')).toHaveCount(1)
      await openManager()
      await popup.getByRole('button', { name: 'Ocultas', exact: true }).click()
      await entry.getByRole('button', { name: 'Mostrar', exact: true }).click()
      await expect(entry).toHaveCount(0)
      await popup.getByRole('button', { name: 'Cerrar', exact: true }).click()
      await expect(page.locator('article')).toHaveCount(2, { timeout: 10000 })
      expect(api.state.choices).toEqual(votesBefore)
      if (phase === 'classification') await expect(page.getByText('1 de 2 ideas clasificadas')).toBeVisible()
      else await expect(page.locator('article').first().locator('.result-total')).toContainText('1')
    } finally { await context.close() }
  })
}

test('revisión antes de clasificación: ocultar normales y precargadas sin exponer el mural', async ({ page, browser }, testInfo) => {
  const api = fixture()
  api.state.phase = 'ideas'
  api.state.participants.push({ user_id: 'original', name: 'Original' })
  api.state.ideas = [
    { ...draftValues('Propuesta para revisar'), id: 'normal', author_id: 'original', organizer: false },
    { ...draftValues('Tarea de ejemplo'), id: 'preset', author_id: null, organizer: true, preset: true, title: 'Asistente de ejemplo' },
    { ...draftValues('Propuesta que queda'), id: 'remaining', author_id: 'original', organizer: false },
  ]
  await api.attach(page.context())
  await page.goto('/')
  await page.getByLabel('Tu nombre').fill('Participante')
  await page.getByRole('button', { name: 'Entrar a la actividad' }).click()
  await expect(page.getByRole('heading', { name: 'Tus post-its' })).toBeVisible()
  const context = await browser.newContext({ viewport: testInfo.project.use.viewport })
  try {
    await api.attach(context)
    const mod = await context.newPage()
    await mod.goto('http://127.0.0.1:5199/?moderador')
    await mod.getByLabel('Correo electrónico').fill('moderador@example.test')
    await mod.getByLabel('Contraseña').fill('test-password-only')
    await mod.getByRole('button', { name: 'Ingresar', exact: true }).click()
    await expect(mod.locator('article').getByRole('button', { name: 'Ocultar', exact: true })).toHaveCount(0)
    await advance(mod, 'Cerrar escritura')
    expect(api.state.phase).toBe('review')
    await expect(mod.locator('article')).toHaveCount(3)
    await expect(mod.getByRole('button', { name: 'Abrir clasificación', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'La clasificación comenzará en breve.' })).toBeVisible({ timeout: 10000 })
    await expect(page.locator('article')).toHaveCount(0)
    await expect(page.locator('.idea-composer')).toHaveCount(0)
    await expect(page.locator('.area-option')).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'La clasificación comenzará en breve.' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Ocultar', exact: true })).toHaveCount(0)
    api.state.failVisibility = true
    const firstCard = mod.locator('article').filter({ hasText: 'Propuesta para revisar' })
    await firstCard.getByRole('button', { name: 'Ocultar', exact: true }).click()
    await expect(mod.getByRole('alert')).toContainText('No se pudo cambiar')
    await expect(mod.locator('article')).toHaveCount(3)
    for (const text of ['Propuesta para revisar', 'Asistente de ejemplo']) {
      const card = mod.locator('article').filter({ hasText: text })
      await card.getByRole('button', { name: 'Ocultar', exact: true }).click()
      await expect(card).toHaveCount(0)
    }
    await mod.getByLabel('Opciones de moderación', { exact: true }).click()
    await mod.getByRole('button', { name: 'Administrar ideas', exact: true }).click()
    const manager = mod.getByRole('dialog', { name: 'Administrar ideas' })
    await manager.getByRole('button', { name: 'Ocultas', exact: true }).click()
    await expect(manager.locator('li')).toHaveCount(2)
    await manager.getByRole('button', { name: 'Cerrar', exact: true }).click()
    await expect(mod.locator('article')).toHaveCount(1)
    await mod.reload()
    await expect(mod.getByRole('button', { name: 'Abrir clasificación', exact: true })).toBeVisible()
    await mod.screenshot({ path: testInfo.outputPath('etapa-revision.png'), fullPage: true })
    await advance(mod, 'Abrir clasificación')
    await expect(mod.locator('article').getByRole('button', { name: 'Ocultar', exact: true })).toHaveCount(0)
    await expect(page.locator('article')).toHaveCount(1, { timeout: 10000 })
    await expect(page.getByText('Propuesta que queda', { exact: true })).toBeVisible()
    await expect(page.getByText('Propuesta para revisar', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Asistente de ejemplo', exact: true })).toHaveCount(0)
    await page.locator('article').getByRole('button', { name: 'Guardar sin áreas', exact: true }).click()
    await expect(page.getByText('1 de 1 ideas clasificadas')).toBeVisible()
  } finally { await context.close() }
})

async function fillIdea(page, text) {
  for (const { key, label } of IDEA_FIELDS) await page.locator('.idea-composer').getByLabel(label, { exact: true }).fill(draftValues(text)[key])
}
async function addIdea(page, text) {
  await fillIdea(page, text)
  await page.getByRole('button', { name: 'Guardar idea' }).click()
  await expect(page.locator('.note-content', { hasText: text })).toBeVisible()
}
async function advance(page, label) {
  await page.getByRole('button', { name: label, exact: true }).click()
  await page.getByRole('button', { name: 'Confirmar cambio' }).click()
  await expect(page.getByText('La nueva fase ya está abierta.')).toBeVisible()
}

test('recorrido completo: dos participantes, moderación, recarga y CSV', async ({ browser, page }, testInfo) => {
  const api = fixture()
  await api.attach(page.context())
  const contextOptions = { viewport: testInfo.project.use.viewport }
  const moderatorContext = await browser.newContext(contextOptions)
  const secondContext = await browser.newContext(contextOptions)
  await api.attach(moderatorContext)
  await api.attach(secondContext)
  const mod = await moderatorContext.newPage()
  const second = await secondContext.newPage()
  await page.goto('/')
  await page.getByLabel('Tu nombre').fill('Lucía')
  await page.getByRole('button', { name: 'Entrar a la actividad' }).click()
  await expect(page.getByRole('heading', { name: 'Hola, Lucía.' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Hola, Lucía.' })).toBeVisible()
  await second.goto('http://127.0.0.1:5199')
  await second.getByLabel('Tu nombre').fill('Martín')
  await second.getByRole('button', { name: 'Entrar a la actividad' }).click()
  await expect(second.getByRole('heading', { name: 'Hola, Martín.' })).toBeVisible()
  await mod.goto('http://127.0.0.1:5199/?moderador')
  await mod.getByLabel('Correo electrónico').fill('moderador@example.test')
  await mod.getByLabel('Contraseña').fill('test-password-only')
  await mod.getByRole('button', { name: 'Ingresar', exact: true }).click()
  await expect(mod.getByText('El pulso del encuentro')).toBeVisible()
  await advance(mod, 'Comenzar escritura')
  await expect(page.getByRole('heading', { name: 'Tus post-its' })).toBeVisible({ timeout: 10000 })
  for (const { label, placeholder } of IDEA_FIELDS) {
    await expect(page.getByLabel(label, { exact: true })).toHaveAttribute('placeholder', placeholder)
  }
  await expect(page.getByRole('button', { name: 'Guardar idea' })).toBeDisabled()
  await addIdea(page, 'Un seguimiento más cercano')
  await addIdea(page, 'Una idea para eliminar')
  const removable = page.locator('article', { hasText: 'Una idea para eliminar' })
  await removable.getByRole('button', { name: 'Eliminar', exact: true }).click()
  await removable.getByRole('button', { name: 'Sí, eliminar' }).click()
  await expect(page.getByText('Una idea para eliminar', { exact: true })).toHaveCount(0)
  const first = page.locator('article').first()
  await first.getByRole('button', { name: 'Editar' }).click()
  await first.getByLabel('Tarea', { exact: true }).fill('Un seguimiento personalizado')
  await first.getByLabel('Quién lo supervisa').fill('Comité de farmacia')
  await first.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.locator('.note-content', { hasText: 'Un seguimiento personalizado' })).toBeVisible()
  await addIdea(page, 'Segunda propuesta')
  await addIdea(page, 'Tercera propuesta')
  for (let n = 4; n <= MAX_IDEAS; n++) await addIdea(page, `Propuesta ${n}`)
  await expect(page.getByText('10 de 10 ideas')).toBeVisible()
  await expect(page.locator('.idea-composer')).toHaveCount(0)
  await expect(second.getByRole('heading', { name: 'Tus post-its' })).toBeVisible({ timeout: 10000 })
  await addIdea(second, 'Acceso a medicamentos')
  await expect(page.getByText('Acceso a medicamentos', { exact: true })).toHaveCount(0)
  await expect(second.getByText('Un seguimiento personalizado', { exact: true })).toHaveCount(0)
  await addIdea(mod, 'Propuesta del equipo')
  await advance(mod, 'Cerrar escritura')
  await advance(mod, 'Abrir clasificación')
  await expect(page.locator('article')).toHaveCount(12, { timeout: 10000 })
  await expect(page.getByRole('button', { name: 'Editar' })).toHaveCount(0)
  const card = page.locator('article', { hasText: 'Un seguimiento personalizado' })
  await card.locator('.label-dropzone').scrollIntoViewIfNeeded()
  const source = page.getByRole('button', { name: `Etiqueta: ${AREAS[0]}`, exact: true })
  await source.dragTo(card.locator('.label-dropzone'))
  await expect(card.locator('.area-option').filter({ hasText: AREAS[0] })).toHaveAttribute('aria-pressed', 'true')
  await card.locator('.area-option').filter({ hasText: AREAS[1] }).click()
  await expect(card.locator('.area-option').filter({ hasText: AREAS[1] })).toHaveAttribute('aria-pressed', 'true')
  await card.getByRole('button', { name: `Quitar ${AREAS[0]}`, exact: true }).click()
  await expect(card.locator('.area-option').filter({ hasText: AREAS[0] })).toHaveAttribute('aria-pressed', 'false')
  await page.reload()
  await expect(card.locator('.area-option').filter({ hasText: AREAS[1] })).toHaveAttribute('aria-pressed', 'true')
  await card.locator('.area-option').filter({ hasText: AREAS[0] }).focus()
  await page.keyboard.press('Enter')
  await expect(card.locator('.area-option').filter({ hasText: AREAS[0] })).toHaveAttribute('aria-pressed', 'true')
  const noAreas = page.locator('article', { hasText: 'Segunda propuesta' })
  await noAreas.getByRole('button', { name: 'Guardar sin áreas', exact: true }).click()
  await expect(noAreas.getByText('✓ Respuesta guardada sin áreas')).toBeVisible()
  await expect(second.locator('article')).toHaveCount(12, { timeout: 10000 })
  const otherChoice = second.locator('article', { hasText: 'Un seguimiento personalizado' }).locator('.area-option').filter({ hasText: AREAS[1] })
  await expect(otherChoice).toHaveAttribute('aria-pressed', 'false')
  await otherChoice.click()
  await expect(otherChoice).toHaveAttribute('aria-pressed', 'true')
  await expect(mod.locator('.participant-details li').filter({ hasText: 'Lucía' })).toContainText('2 / 12', { timeout: 10000 })
  await expect(mod.getByRole('combobox')).toHaveCount(0)
  await advance(mod, 'Mostrar resultados')
  await expect(page.locator('.results-list')).toHaveCount(12, { timeout: 10000 })
  const result = page.locator('article', { hasText: 'Un seguimiento personalizado' })
  await expect(result.locator('.results-list li')).toHaveCount(6)
  await expect(result.locator('.results-list li').filter({ hasText: 'Farmacovigilancia' }).locator('b')).toHaveText('2')
  await expect(result.locator('.results-list li').filter({ hasText: 'Individualización' }).locator('b')).toHaveText('1')
  await expect(result.locator('.result-total strong')).toHaveText('2')
  await expect(result.getByText('Comité de farmacia', { exact: true })).toBeVisible()
  await expect(result.locator('.idea-details dt')).toHaveCount(6)
  await expect(page.locator('article', { hasText: 'Segunda propuesta' }).locator('.result-none strong')).toHaveText('1')
  await expect(page.getByText('Transversal / no estoy seguro', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('combobox')).toHaveCount(0)
  const csvEvent = mod.waitForEvent('download')
  await mod.getByRole('button', { name: 'Resultados CSV' }).click()
  const download = await csvEvent
  expect(download.suggestedFilename()).toBe('ceidef-resultados.csv')
  const stream = await download.createReadStream()
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  const csv = Buffer.concat(chunks).toString('utf8')
  expect(csv).toContain('Equipo organizador')
  expect(csv).toContain('Total de respuestas')
  for (const { label } of IDEA_FIELDS) expect(csv).toContain(label)
  expect(csv).toContain('Comité de farmacia')
  expect(csv).toContain('Sin áreas')
  expect(csv).not.toContain('Transversal')
  await page.reload()
  await expect(page.locator('.results-list')).toHaveCount(12)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('resultados.png'), fullPage: true })
  await moderatorContext.close()
  await secondContext.close()
})

test('errores al guardar conservan el texto y permiten reintentar', async ({ page }, testInfo) => {
  const api = fixture()
  await api.attach(page.context())
  await page.goto('/')
  await page.getByLabel('Tu nombre').fill('Ana')
  await page.getByRole('button', { name: 'Entrar a la actividad' }).click()
  await expect(page.getByRole('heading', { name: 'Hola, Ana.' })).toBeVisible()
  api.state.phase = 'ideas'
  await page.reload()
  await expect(page.getByLabel('Tarea', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.locator('.idea-composer').screenshot({ path: testInfo.outputPath('formulario.png') })
  api.state.failSave = true
  await fillIdea(page, 'Esta idea debe conservarse')
  await page.getByRole('button', { name: 'Guardar idea' }).click()
  await expect(page.getByRole('alert')).toContainText('Error de conexión de prueba')
  for (const { key, label } of IDEA_FIELDS) await expect(page.getByLabel(label, { exact: true })).toHaveValue(draftValues('Esta idea debe conservarse')[key])
  await page.getByRole('button', { name: 'Guardar idea' }).click()
  await expect(page.locator('.note-content')).toHaveText('Esta idea debe conservarse')
})

test('una cuenta sin permisos no reemplaza la sesión del participante', async ({ page }) => {
  const api = fixture()
  await api.attach(page.context())
  await page.goto('/')
  await page.getByLabel('Tu nombre').fill('Ana')
  await page.getByRole('button', { name: 'Entrar a la actividad' }).click()
  await expect(page.getByRole('heading', { name: 'Hola, Ana.' })).toBeVisible()
  await page.getByRole('button', { name: 'Moderación', exact: true }).click()
  await page.getByLabel('Correo electrónico').fill('sin-permisos@example.test')
  await page.getByLabel('Contraseña').fill('test-password-only')
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('no tiene permisos')
  await page.getByRole('button', { name: 'Volver a la actividad' }).click()
  await expect(page.getByRole('heading', { name: 'Hola, Ana.' })).toBeVisible()
})

test('resultados paginados: más de 1.000 filas y actualización después de reiniciar', async ({ page }) => {
  const api = fixture()
  await api.attach(page.context())
  await page.goto('/')
  await page.getByLabel('Tu nombre').fill('Ana')
  await page.getByRole('button', { name: 'Entrar a la actividad' }).click()
  await expect(page.getByRole('heading', { name: 'Hola, Ana.' })).toBeVisible()
  const userId = api.state.participants[0].user_id
  api.state.ideas = Array.from({ length: 180 }, (_, n) => ({
    ...draftValues(`Tarea ${n + 1}`), id: `large-idea-${n + 1}`, author_id: userId,
    organizer: false, created_at: new Date().toISOString(),
  }))
  api.state.choices = [{ user_id: userId, idea_id: 'large-idea-180', area_ids: [6] }]
  api.state.phase = 'results'
  api.state.revision++
  await page.reload()
  await expect(page.locator('.results-list')).toHaveCount(180)
  const last = page.locator('article').last()
  await expect(last.locator('.results-list li').filter({ hasText: 'Información de medicamentos' }).locator('b')).toHaveText('1')
  await expect(last.locator('.result-total strong')).toHaveText('1')
  // La caché de un mural cerrado se invalida al cambiar la revisión de fase.
  api.state.phase = 'waiting'
  api.state.revision++
  api.state.ideas = []
  api.state.choices = []
  api.state.participants = []
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByLabel('Tu nombre')).toBeVisible()
  await expect(page.locator('article')).toHaveCount(0)
})

test('solo Tarea obligatoria: crear, editar, recargar y leer con letra grande', async ({ page }, testInfo) => {
  const api = fixture()
  await api.attach(page.context())
  await page.goto('/')
  await page.getByLabel('Tu nombre').fill('Ana')
  await page.getByRole('button', { name: 'Entrar a la actividad' }).click()
  await expect(page.getByRole('heading', { name: 'Hola, Ana.' })).toBeVisible()
  api.state.phase = 'ideas'
  await page.reload()
  await page.getByLabel('Tarea', { exact: true }).fill('Revisar las interacciones de la medicación')
  for (const { key, label } of IDEA_FIELDS) {
    if (key !== 'task') {
      await expect(page.getByLabel(label, { exact: true })).not.toHaveAttribute('required', '')
      await expect(page.getByLabel(label, { exact: true })).toHaveValue('')
    }
  }
  await expect(page.getByRole('button', { name: 'Guardar idea' })).toBeEnabled()
  await page.getByRole('button', { name: 'Guardar idea' }).click()
  await expect(page.locator('article .note-content')).toHaveText('Revisar las interacciones de la medicación')
  await expect(page.locator('article .idea-details dt')).toHaveCount(1)
  await page.reload()
  await expect(page.locator('article .note-content')).toHaveText('Revisar las interacciones de la medicación')
  const size = await page.locator('article .note-content').evaluate(node => parseFloat(getComputedStyle(node).fontSize))
  expect(size).toBeGreaterThanOrEqual(22)
  await page.locator('article').getByRole('button', { name: 'Editar', exact: true }).click()
  await page.locator('article').getByLabel('Tarea', { exact: true }).fill('Tarea actualizada')
  await page.locator('article').getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.locator('article .note-content')).toHaveText('Tarea actualizada')
  await page.locator('article').screenshot({ path: testInfo.outputPath('idea-legible.png') })
})

test('arrastre con mouse y pantalla táctil, etiquetas por toque y quitar la última', async ({ page }, testInfo) => {
  const api = fixture()
  await api.attach(page.context())
  await page.goto('/')
  await page.getByLabel('Tu nombre').fill('Ana')
  await page.getByRole('button', { name: 'Entrar a la actividad' }).click()
  await expect(page.getByRole('heading', { name: 'Hola, Ana.' })).toBeVisible()
  api.state.ideas = [{ ...draftValues('Una tarea para conectar'), id: 'drag-idea', author_id: api.state.participants[0].user_id, organizer: false, created_at: new Date().toISOString() }]
  api.state.phase = 'classification'
  api.state.revision++
  await page.reload()
  const card = page.locator('article')
  const target = card.locator('.label-dropzone')
  await target.scrollIntoViewIfNeeded()
  const label = page.getByRole('button', { name: `Etiqueta: ${AREAS[0]}`, exact: true })
  if (testInfo.project.use.hasTouch) {
    const start = await label.boundingBox()
    const end = await target.boundingBox()
    const from = { x: start.x + start.width / 2, y: start.y + start.height / 2 }
    const to = { x: end.x + end.width / 2, y: end.y + end.height / 2 }
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] })
    for (let step = 1; step <= 8; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * step / 8, y: from.y + (to.y - from.y) * step / 8 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
  } else await label.dragTo(target)
  await expect(card.locator('.area-option').filter({ hasText: AREAS[0] })).toHaveAttribute('aria-pressed', 'true')
  const next = page.getByRole('button', { name: `Etiqueta: ${AREAS[1]}`, exact: true })
  if (testInfo.project.use.hasTouch) await next.tap()
  else await next.click()
  await expect(next).toHaveAttribute('aria-pressed', 'true')
  if (testInfo.project.use.hasTouch) await card.locator('.drop-hint').tap()
  else await card.locator('.drop-hint').click()
  await expect(card.locator('.area-option').filter({ hasText: AREAS[1] })).toHaveAttribute('aria-pressed', 'true')
  await card.screenshot({ path: testInfo.outputPath('clasificacion.png') })
  await card.getByRole('button', { name: `Quitar ${AREAS[0]}`, exact: true }).click()
  await expect(card.locator('.area-option').filter({ hasText: AREAS[0] })).toHaveAttribute('aria-pressed', 'false')
  await card.getByRole('button', { name: `Quitar ${AREAS[1]}`, exact: true }).click()
  await expect(card.getByText('✓ Respuesta guardada sin áreas')).toBeVisible()
  await page.reload()
  await expect(page.getByText('✓ Respuesta guardada sin áreas')).toBeVisible()
})

test('ideas predeterminadas: aparecen al clasificar, muestran resultados y sobreviven al reinicio', async ({ page, browser }, testInfo) => {
  const api = fixture()
  const titles = [
    'Asistente para revisar combinaciones de medicamentos',
    'Asistente para detectar posibles problemas con medicamentos',
    'Asistente para explicar el uso de medicamentos',
  ]
  const presets = titles.map((title, index) => ({
    ...draftValues(`Tareas de ejemplo ${index + 1}`), title,
    id: `ce1def00-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    preset: true, organizer: true, author_id: null, created_at: '2026-10-11T00:00:00.000Z',
  }))
  api.state.ideas = [...presets]
  await api.attach(page.context())
  const moderatorContext = await browser.newContext({ viewport: testInfo.project.use.viewport })
  await api.attach(moderatorContext)
  const mod = await moderatorContext.newPage()
  await page.goto('/')
  await page.getByLabel('Tu nombre').fill('Ana')
  await page.getByRole('button', { name: 'Entrar a la actividad' }).click()
  await expect(page.getByRole('heading', { name: 'Hola, Ana.' })).toBeVisible()
  await mod.goto('http://127.0.0.1:5199/?moderador')
  await mod.getByLabel('Correo electrónico').fill('moderador@example.test')
  await mod.getByLabel('Contraseña').fill('test-password-only')
  await mod.getByRole('button', { name: 'Ingresar', exact: true }).click()
  await expect(mod.getByText('El pulso del encuentro')).toBeVisible()
  await advance(mod, 'Comenzar escritura')
  await expect(page.locator('.idea-composer')).toBeVisible({ timeout: 10000 })
  for (const title of titles) {
    await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0)
    await expect(mod.getByRole('heading', { name: title, exact: true })).toHaveCount(0)
  }
  await addIdea(page, 'Idea que sí se borra al reiniciar')
  await advance(mod, 'Cerrar escritura')
  await advance(mod, 'Abrir clasificación')
  await expect(page.locator('article')).toHaveCount(4, { timeout: 10000 })
  for (const title of titles) await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  const first = page.locator('article', { hasText: titles[0] })
  await expect(first.getByRole('button', { name: 'Editar', exact: true })).toHaveCount(0)
  await expect(first.getByText('Idea predeterminada · Equipo organizador')).toHaveCount(0)
  await expect(first).not.toHaveClass(/note-team/)
  await first.locator('.area-option').filter({ hasText: AREAS[0] }).click()
  await expect(first.locator('.area-option').filter({ hasText: AREAS[0] })).toHaveAttribute('aria-pressed', 'true')
  await page.locator('article', { hasText: titles[1] }).getByRole('button', { name: 'Guardar sin áreas', exact: true }).click()
  await page.reload()
  await expect(first.locator('.area-option').filter({ hasText: AREAS[0] })).toHaveAttribute('aria-pressed', 'true')
  await advance(mod, 'Mostrar resultados')
  await expect(page.locator('.results-list')).toHaveCount(4, { timeout: 10000 })
  await expect(first.locator('.results-list li').filter({ hasText: AREAS[0] }).locator('b')).toHaveText('1')
  await expect(page.locator('article', { hasText: titles[1] }).locator('.result-none strong')).toHaveText('1')
  await expect(first.locator('.result-total strong')).toHaveText('1')
  const downloadEvent = mod.waitForEvent('download')
  await mod.getByRole('button', { name: 'Resultados CSV' }).click()
  const stream = await (await downloadEvent).createReadStream()
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  const csv = Buffer.concat(chunks).toString('utf8')
  for (const title of titles) expect(csv).toContain(title)
  expect(csv).toContain('Título')
  // Simular el reset administrativo; las tres filas siguen siendo las mismas.
  api.state.ideas = api.state.ideas.filter(idea => idea.preset)
  api.state.choices = []; api.state.participants = []; api.state.phase = 'waiting'; api.state.revision++
  expect(api.state.ideas).toEqual(presets)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await mod.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByLabel('Tu nombre')).toBeVisible()
  await expect(mod.getByRole('button', { name: 'Comenzar escritura', exact: true })).toBeVisible()
  await page.getByLabel('Tu nombre').fill('Ana en otra edición')
  await page.getByRole('button', { name: 'Entrar a la actividad' }).click()
  await expect(page.getByRole('heading', { name: 'Hola, Ana en otra edición.' })).toBeVisible()
  await advance(mod, 'Comenzar escritura')
  await expect(page.locator('.idea-composer')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('article')).toHaveCount(0)
  await advance(mod, 'Cerrar escritura')
  await advance(mod, 'Abrir clasificación')
  await expect(page.locator('article')).toHaveCount(3, { timeout: 10000 })
  for (const title of titles) await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await expect(page.getByText('0 de 3 ideas clasificadas', { exact: true })).toBeVisible()
  await moderatorContext.close()
})
