import { test, expect } from '@playwright/test'
import { AREAS } from '../../src/lib/workshop.ts'

// Dobles de HTTP para probar la UI sin alterar el proyecto Supabase del usuario.
// RLS y RPC se verifican por separado ejecutando setup.sql en PostgreSQL real.
function fixture() {
  const state = { phase: 'waiting', participants: [], ideas: [], choices: [], nextId: 0, failSave: false }
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
      const failure = message => respond({ message, code: 'P0001', details: null, hint: null }, 400)
      if (url.pathname.endsWith('/signup')) return respond(session({ id: `00000000-0000-4000-8000-${String(++state.nextId).padStart(12, '0')}`, is_anonymous: true }))
      if (url.pathname.endsWith('/token')) return respond(session(body.email === moderator.email ? moderator : { id: 'unprivileged', is_anonymous: false }))
      if (url.pathname.endsWith('/logout')) return respond({})
      if (url.pathname.endsWith('/user')) return respond(user)
      const endpoint = url.pathname.split('/').at(-1)
      if (url.pathname.includes('/rpc/')) {
        if (endpoint === 'is_moderator') return respond(mod)
        if (endpoint === 'join_workshop') {
          if (mine) return respond(mine)
          if (state.phase !== 'waiting') return failure('El ingreso cerró.')
          const participant = { user_id: user.id, name: body.participant_name }
          state.participants.push(participant)
          return respond(participant)
        }
        if (endpoint === 'advance_phase') {
          if (!mod) return failure('Se requieren permisos de moderador.')
          state.phase = { waiting: 'ideas', ideas: 'classification', classification: 'results' }[state.phase]
          return respond(state.phase)
        }
        if (endpoint === 'classify_idea') {
          if (!mine || state.phase !== 'classification') return failure('La clasificación está cerrada.')
          state.choices = state.choices.filter(c => c.user_id !== user.id || c.idea_id !== body.target_idea)
          state.choices.push({ user_id: user.id, idea_id: body.target_idea, area_id: body.selected_area })
          return respond(null)
        }
        if (endpoint === 'get_progress') return respond(state.participants.map(p => ({ ...p, completed: state.choices.filter(c => c.user_id === p.user_id).length, total: state.ideas.length })))
        if (endpoint === 'get_results') return respond(state.ideas.flatMap(i => AREAS.map((_, n) => ({ idea_id: i.id, area_id: n + 1, votes: state.choices.filter(c => c.idea_id === i.id && c.area_id === n + 1).length, total: state.choices.filter(c => c.idea_id === i.id).length }))))
      }
      const single = request.headers().accept?.includes('application/vnd.pgrst.object')
      const replyRows = rows => respond(single ? rows[0] : rows)
      if (endpoint === 'workshops') return replyRows([{ id: 1, title: 'Laboratorio de ideas', phase: state.phase }])
      if (endpoint === 'participants') return replyRows(state.participants.filter(p => p.user_id === user?.id))
      if (endpoint === 'classifications') return replyRows(state.choices.filter(c => c.user_id === user?.id))
      if (endpoint === 'ideas') {
        if (method === 'GET') return replyRows(state.ideas.filter(i => mod || (mine && (state.phase !== 'ideas' || i.author_id === user?.id))))
        if (state.failSave) { state.failSave = false; return failure('Error de conexión de prueba. Volvé a intentar.') }
        if (state.phase !== 'ideas') return failure('La escritura de ideas está cerrada.')
        if (method === 'POST') {
          state.ideas.push({ ...body, id: `idea-${++state.nextId}`, created_at: new Date().toISOString() })
          return respond(null, 201)
        }
        const id = url.searchParams.get('id')?.replace('eq.', '')
        const idea = state.ideas.find(i => i.id === id)
        if (method === 'PATCH') idea.content = body.content
        if (method === 'DELETE') state.ideas = state.ideas.filter(i => i.id !== id)
        return replyRows([{ id }])
      }
      return failure(`Endpoint de prueba desconocido: ${url.pathname}`)
    })
  }
  return { state, attach }
}

async function addIdea(page, text) {
  await page.getByLabel('¿Qué te gustaría proponer?').fill(text)
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
  await second.goto('http://127.0.0.1:5173')
  await second.getByLabel('Tu nombre').fill('Martín')
  await second.getByRole('button', { name: 'Entrar a la actividad' }).click()
  await expect(second.getByRole('heading', { name: 'Hola, Martín.' })).toBeVisible()
  await mod.goto('http://127.0.0.1:5173/?moderador')
  await mod.getByLabel('Correo electrónico').fill('moderador@example.test')
  await mod.getByLabel('Contraseña').fill('test-password-only')
  await mod.getByRole('button', { name: 'Ingresar', exact: true }).click()
  await expect(mod.getByText('El pulso del encuentro')).toBeVisible()
  await advance(mod, 'Comenzar escritura')
  await expect(page.getByRole('heading', { name: 'Tus post-its' })).toBeVisible({ timeout: 10000 })
  await addIdea(page, 'Un seguimiento más cercano')
  await addIdea(page, 'Una idea para eliminar')
  const removable = page.locator('article', { hasText: 'Una idea para eliminar' })
  await removable.getByRole('button', { name: 'Eliminar', exact: true }).click()
  await removable.getByRole('button', { name: 'Sí, eliminar' }).click()
  await expect(page.getByText('Una idea para eliminar', { exact: true })).toHaveCount(0)
  const first = page.locator('article').first()
  await first.getByRole('button', { name: 'Editar' }).click()
  await first.getByLabel('Editar idea').fill('Un seguimiento personalizado')
  await first.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.locator('.note-content', { hasText: 'Un seguimiento personalizado' })).toBeVisible()
  await addIdea(page, 'Segunda propuesta')
  await addIdea(page, 'Tercera propuesta')
  await expect(page.getByLabel('¿Qué te gustaría proponer?')).toHaveCount(0)
  await expect(second.getByRole('heading', { name: 'Tus post-its' })).toBeVisible({ timeout: 10000 })
  await addIdea(second, 'Acceso a medicamentos')
  await expect(page.getByText('Acceso a medicamentos', { exact: true })).toHaveCount(0)
  await expect(second.getByText('Un seguimiento personalizado', { exact: true })).toHaveCount(0)
  await addIdea(mod, 'Propuesta del equipo')
  await advance(mod, 'Cerrar escritura')
  await expect(page.locator('article')).toHaveCount(5, { timeout: 10000 })
  await expect(page.getByRole('button', { name: 'Editar' })).toHaveCount(0)
  const choice = page.locator('article', { hasText: 'Un seguimiento personalizado' }).getByRole('combobox')
  await choice.selectOption('1')
  await expect(choice).toHaveValue('1')
  await expect(choice).toBeEnabled()
  await choice.selectOption('2')
  await expect(choice).toHaveValue('2')
  await page.reload()
  await expect(page.locator('article', { hasText: 'Un seguimiento personalizado' }).getByRole('combobox')).toHaveValue('2')
  await expect(second.locator('article')).toHaveCount(5, { timeout: 10000 })
  const otherChoice = second.locator('article', { hasText: 'Un seguimiento personalizado' }).getByRole('combobox')
  await expect(otherChoice).toHaveValue('')
  await otherChoice.selectOption('2')
  await expect(otherChoice).toHaveValue('2')
  await expect(mod.locator('.participant-details li').filter({ hasText: 'Lucía' })).toContainText('1 / 5', { timeout: 10000 })
  await expect(mod.getByRole('combobox')).toHaveCount(0)
  await advance(mod, 'Mostrar resultados')
  await expect(page.locator('.results-list')).toHaveCount(5, { timeout: 10000 })
  const result = page.locator('article', { hasText: 'Un seguimiento personalizado' })
  await expect(result.locator('.results-list li')).toHaveCount(7)
  await expect(result.locator('.results-list li').filter({ hasText: 'Farmacovigilancia' }).locator('b')).toHaveText('2')
  await expect(result.locator('.results-list li').filter({ hasText: 'Individualización' }).locator('b')).toHaveText('0')
  await expect(result.locator('.result-total strong')).toHaveText('2')
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
  await page.reload()
  await expect(page.locator('.results-list')).toHaveCount(5)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('resultados.png'), fullPage: true })
  await moderatorContext.close()
  await secondContext.close()
})

test('errores al guardar conservan el texto y permiten reintentar', async ({ page }) => {
  const api = fixture()
  await api.attach(page.context())
  await page.goto('/')
  await page.getByLabel('Tu nombre').fill('Ana')
  await page.getByRole('button', { name: 'Entrar a la actividad' }).click()
  await expect(page.getByRole('heading', { name: 'Hola, Ana.' })).toBeVisible()
  api.state.phase = 'ideas'
  await page.reload()
  await expect(page.getByLabel('¿Qué te gustaría proponer?')).toBeVisible()
  api.state.failSave = true
  await page.getByLabel('¿Qué te gustaría proponer?').fill('Esta idea debe conservarse')
  await page.getByRole('button', { name: 'Guardar idea' }).click()
  await expect(page.getByRole('alert')).toContainText('Error de conexión de prueba')
  await expect(page.getByLabel('¿Qué te gustaría proponer?')).toHaveValue('Esta idea debe conservarse')
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
