import { useEffect, useMemo, useState } from 'react'
import type { ButtonHTMLAttributes, FormEvent, ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { configurationError, moderationClient, supabase } from './lib/supabase'
import { useWorkshop } from './hooks/useWorkshop'
import { AREAS, MAX_IDEAS, MAX_PARTICIPANTS, PHASE_NAMES, PHASES, downloadCsv, emptyIdeaDraft, errorMessage, ideaDraft, indexResults, isCompleteIdea } from './lib/workshop'
import type { Idea, IdeaDraft, Phase, Snapshot } from './lib/workshop'
import { IdeaContent, IdeaFields } from './components/IdeaFields'
import { AreaLabels, IdeaAreas } from './components/AreaLabels'
import { ResetDialog } from './components/ResetDialog'
import './App.css'

const descriptions: Record<Phase, string> = {
  waiting: 'Un espacio para pensar juntos el futuro de la farmacoterapia.',
  ideas: 'Contanos la tarea que proponés. Si querés, agregá detalles para explicar cómo funcionaría.',
  classification: 'Leé cada idea y conectala con una, varias áreas o ninguna.',
  results: 'Distintas miradas, un mapa compartido. Así clasificamos nuestras ideas.',
}
const headings: Record<Phase, string> = {
  waiting: 'Todo empieza con una idea.', ideas: 'Tu mirada suma.',
  classification: 'Conectemos las ideas.', results: 'Lo que construimos juntos.',
}
const nextLabels: Partial<Record<Phase, string>> = {
  waiting: 'Comenzar escritura', ideas: 'Cerrar escritura', classification: 'Mostrar resultados',
}

function Icon({ kind, ...props }: { kind: 'arrow' | 'plus' | 'check' | 'download' | 'lock'; className?: string }) {
  const paths = { arrow: 'M4 12h16m-6-6 6 6-6 6', plus: 'M12 5v14M5 12h14', check: 'm5 12 4 4L19 6', download: 'M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4', lock: 'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5z' }
  return <svg {...props} viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>
}

function Button({ children, busy, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; children: ReactNode }) {
  return <button {...props} disabled={props.disabled || busy}>{busy ? <span className="spinner" aria-hidden="true" /> : null}{children}</button>
}

function Note({ idea, editable, onSave, onDelete, busy, children }: {
  idea: Idea; editable: boolean; onSave: (draft: IdeaDraft) => Promise<boolean>;
  onDelete: () => Promise<boolean>; busy: boolean; children?: ReactNode;
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(() => ideaDraft(idea))
  const [deleting, setDeleting] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (isCompleteIdea(draft) && await onSave(ideaDraft(draft))) setEditing(false)
  }
  return <article className={`note ${idea.organizer ? 'note-team' : ''}`}>
    <div className="note-top"><span className="note-dot" /><span>{idea.preset ? 'Idea predeterminada · Equipo organizador' : idea.organizer ? 'Equipo organizador' : 'Idea participante'}</span></div>
    {idea.title && <h3 className="preset-title">{idea.title}</h3>}
    {editing && editable ? <form onSubmit={submit}>
      <IdeaFields value={draft} onChange={setDraft} disabled={busy} idPrefix={`edit-${idea.id}`} />
      <div className="note-actions"><Button type="submit" busy={busy} disabled={!isCompleteIdea(draft)}>Guardar</Button><Button type="button" className="text-button" disabled={busy} onClick={() => setEditing(false)}>Cancelar</Button></div>
    </form> : <IdeaContent idea={idea} />}
    {editable && !editing && <div className="note-actions">
      {deleting ? <><span>¿Eliminar idea?</span><Button className="text-button danger" busy={busy} onClick={async () => { if (await onDelete()) setDeleting(false) }}>Sí, eliminar</Button><Button className="text-button" disabled={busy} onClick={() => setDeleting(false)}>Cancelar</Button></> : <><Button className="text-button" disabled={busy} onClick={() => { setDraft(ideaDraft(idea)); setEditing(true) }}>Editar</Button><Button className="text-button" disabled={busy} onClick={() => setDeleting(true)}>Eliminar</Button></>}
    </div>}
    {children}
  </article>
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [initializing, setInitializing] = useState(!!supabase)
  const [authError, setAuthError] = useState('')
  const [moderatorLogin, setModeratorLogin] = useState(new URLSearchParams(location.search).has('moderador'))
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [newIdea, setNewIdea] = useState(emptyIdeaDraft)
  const [confirmPhase, setConfirmPhase] = useState<Phase | null>(null)
  const { snapshot, error: syncError, refresh, updatedAt, live } = useWorkshop(session)
  const resultsByIdea = useMemo(() => indexResults(snapshot?.results ?? []), [snapshot?.results])
  const choicesByIdea = useMemo(() => new Map(snapshot?.choices.map(c => [c.idea_id, c.area_ids]) ?? []), [snapshot?.choices])

  useEffect(() => {
    if (!supabase) return
    let mounted = true
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (mounted) { setSession(nextSession); setInitializing(false) }
    })
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!mounted) return
      if (error) setAuthError(error.message)
      setSession(data.session)
      setInitializing(false)
    }).catch(cause => { if (mounted) { setAuthError(errorMessage(cause)); setInitializing(false) } })
    return () => { mounted = false; subscription.unsubscribe() }
  }, [])

  async function run(id: string, operation: () => Promise<void>, message = 'Cambios guardados.') {
    if (busy) return false
    setBusy(id); setActionError(''); setNotice('')
    try {
      await operation()
      if (!['join', 'login', 'logout'].includes(id)) await refresh()
      setNotice(message)
      return true
    } catch (cause) {
      setActionError(errorMessage(cause))
      if (!['join', 'login', 'logout'].includes(id)) await refresh()
      return false
    } finally { setBusy(null) }
  }

  async function join(event: FormEvent) {
    event.preventDefault()
    if (!supabase || !name.trim()) return
    await run('join', async () => {
      let current = session
      if (!current) {
        const { data, error } = await supabase!.auth.signInAnonymously()
        if (error) throw error
        current = data.session
        if (!current) throw new Error('No pudimos iniciar la sesión anónima.')
        setSession(current)
      }
      const { error } = await supabase!.rpc('join_workshop', { participant_name: name.trim() })
      if (error) throw error
      await refresh(current.user.id)
    }, 'Ya estás dentro. Tu sesión se conserva al recargar.')
  }

  async function login(event: FormEvent) {
    event.preventDefault()
    if (!supabase) return
    await run('login', async () => {
      // Verifica permisos ANTES de reemplazar la sesión del participante.
      const temporary = moderationClient!
      const { data, error } = await temporary.auth.signInWithPassword({ email: email.trim(), password })
      if (error) throw error
      const role = await temporary.rpc('is_moderator')
      if (role.error || role.data !== true) {
        await temporary.auth.signOut({ scope: 'local' })
        throw role.error ?? new Error('Esta cuenta no tiene permisos de moderación. Agregá su UUID en Supabase.')
      }
      if (!data.session) throw new Error('No pudimos iniciar la sesión.')
      const result = await supabase!.auth.setSession({ access_token: data.session.access_token, refresh_token: data.session.refresh_token })
      if (result.error) throw result.error
      setSession(result.data.session)
      setPassword(''); setModeratorLogin(false)
      await refresh(data.session.user.id)
    }, 'Sesión de moderación iniciada.')
  }

  const phase = snapshot?.workshop.phase ?? 'waiting'
  const joined = !!snapshot && (snapshot.moderator || !!snapshot.participant)
  const loading = initializing || (!!session && !snapshot && !syncError)
  const ownIdeas = snapshot?.ideas.filter(idea => idea.author_id === session?.user.id) ?? []
  const completed = snapshot?.choices.length ?? 0
  const fatalError = configurationError || authError

  const saveIdea = async (idea: Idea, draft: IdeaDraft) => run(idea.id, async () => {
    const { data, error } = await supabase!.from('ideas').update(draft).eq('id', idea.id).select('id').single()
    if (error) throw error
    if (!data) throw new Error('La escritura cerró o la idea ya no existe.')
  })
  const deleteIdea = async (idea: Idea) => run(idea.id, async () => {
    const { data, error } = await supabase!.from('ideas').delete().eq('id', idea.id).select('id').single()
    if (error) throw error
    if (!data) throw new Error('La escritura cerró o la idea ya no existe.')
  }, 'Idea eliminada.')
  const classify = (ideaId: string, areas: number[]) => run(ideaId, async () => {
    const { error } = await supabase!.rpc('classify_idea', { target_idea: ideaId, selected_areas: areas })
    if (error) throw error
  }, areas.length ? 'Áreas guardadas.' : 'Respuesta guardada sin áreas.')

  return <div className="app-shell">
    <header className="site-header">
      <a className="brand" href={import.meta.env.BASE_URL} aria-label="Actividad integradora, inicio">Actividad integradora</a>
      <div className="header-actions">{joined && <span className="identity">{snapshot.moderator ? 'Moderación' : snapshot.participant?.name}</span>}
        {!snapshot?.moderator && <Button className="text-button moderator-link" disabled={!!busy} onClick={() => { setModeratorLogin(!moderatorLogin); setActionError('') }}><Icon kind="lock" />{moderatorLogin ? 'Volver a la actividad' : 'Moderación'}</Button>}
        {snapshot?.moderator && <Button className="text-button" disabled={!!busy} onClick={() => void run('logout', async () => { const { error } = await supabase!.auth.signOut(); if (error) throw error }, 'Sesión cerrada.')}>Salir</Button>}
      </div>
    </header>

    <main>
      <nav className="phase-strip" aria-label="Fases de la actividad"><ol>{PHASES.map((p, index) => <li key={p} className={phase === p ? 'active' : PHASES.indexOf(phase) > index ? 'done' : ''} aria-current={phase === p ? 'step' : undefined}><span>{PHASES.indexOf(phase) > index ? <Icon kind="check" /> : `0${index + 1}`}</span><b>{PHASE_NAMES[p]}</b></li>)}</ol><span className="session-tag">TALLER VIRTUAL · HASTA {MAX_PARTICIPANTS} PERSONAS</span></nav>

      <section className="intro"><div><p className="eyebrow"><span /> PENSAR · COMPARTIR · CONECTAR</p><h1>{moderatorLogin ? 'Acompañá el encuentro.' : headings[phase]}</h1><p className="intro-description">{moderatorLogin ? 'Ingresá con la cuenta del equipo organizador para coordinar la actividad.' : descriptions[phase]}</p></div><div className="intro-art" aria-hidden="true"><div className="art-note art-blue">Cada mirada</div><div className="art-note art-peach">abre una<br />posibilidad.</div><span className="art-star">✳</span></div></section>

      <div className="messages" aria-live="polite">{(fatalError || actionError || syncError) && <div className="message error" role="alert"><span>{fatalError || actionError || `No se pudo sincronizar: ${syncError}`}</span>{syncError && <Button className="text-button" onClick={() => void refresh()}>Reintentar</Button>}</div>}{busy && <div className="message saving"><span className="spinner" /> Guardando…</div>}{notice && !busy && <div className="message success"><Icon kind="check" />{notice}</div>}</div>

      {loading ? <section className="panel loading"><span className="spinner" /> Recuperando tu sesión y la actividad…</section> : fatalError ? <section className="panel"><h2>Falta completar la configuración</h2><p>Revisá la configuración local y los pasos de Supabase en el README.</p></section> : moderatorLogin ? <section className="join-layout"><form className="panel join-panel" onSubmit={login}><p className="eyebrow">ACCESO DEL EQUIPO</p><h2>Ingresar como moderador</h2>{snapshot?.participant && <p className="login-warning">Usá otro navegador o perfil para moderar si querés conservar también tu acceso como participante en este dispositivo.</p>}<label htmlFor="email">Correo electrónico</label><input id="email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required disabled={!!busy} /><label htmlFor="password">Contraseña</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required disabled={!!busy} /><Button type="submit" className="primary" busy={busy === 'login'} disabled={!!busy}>Ingresar <Icon kind="arrow" /></Button></form><aside className="join-aside"><Icon kind="lock" /><h2>Un encuentro cuidado.</h2><p>Los permisos del equipo se verifican en la base de datos. La cuenta de moderación debe estar habilitada previamente.</p></aside></section> : !joined ? <section className="join-layout"><form className="panel join-panel" onSubmit={join}><p className="eyebrow">TU LUGAR EN LA CONVERSACIÓN</p><h2>Sumate al encuentro</h2><p>Solo necesitamos saber cómo llamarte.</p><label htmlFor="name">Tu nombre</label><input id="name" placeholder="Por ejemplo, Lucía" autoComplete="given-name" maxLength={60} value={name} onChange={e => setName(e.target.value)} required disabled={!!busy} /><Button type="submit" className="primary" busy={busy === 'join'} disabled={!!busy || !name.trim()}>Entrar a la actividad <Icon kind="arrow" /></Button><p className="fine-print">Sin registro ni contraseña. Tu sesión queda guardada en este navegador.</p></form><aside className="join-aside"><span className="aside-number">01—04</span><h2>De una idea a una mirada compartida.</h2><p>Primero escribimos. Después, cada persona clasifica las ideas. Al final, descubrimos las conexiones.</p></aside></section> : <>
        {snapshot.moderator && <ModeratorPanel onResetOpen={() => setActionError('')} actionError={actionError} reset={(revision) => run('reset', async () => { const { error } = await supabase!.rpc('reset_workshop', { expected_revision: revision }); if (error) throw error; setNewIdea(emptyIdeaDraft()); setConfirmPhase(null) }, 'Actividad reiniciada.')} snapshot={snapshot} busy={busy} confirmPhase={confirmPhase} setConfirmPhase={setConfirmPhase} advance={() => run('phase', async () => { const { error } = await supabase!.rpc('advance_phase', { expected_phase: phase }); if (error) throw error; setConfirmPhase(null) }, 'La nueva fase ya está abierta.')} />}
        {phase === 'waiting' && <section className="panel waiting-panel"><span className="waiting-orbit" aria-hidden="true">✳</span><p className="eyebrow">YA ESTÁS EN EL ENCUENTRO</p><h2>{snapshot.moderator ? 'Todo listo para empezar.' : `Hola, ${snapshot.participant?.name}.`}</h2><p>{snapshot.moderator ? 'Compartí el enlace y comenzá cuando hayan ingresado los participantes.' : 'El equipo organizador dará inicio a la actividad. Podés dejar esta página abierta: se actualizará automáticamente.'}</p><div className="waiting-status"><span className="status-dot" /> Esperando el inicio de la escritura</div></section>}

        {phase !== 'waiting' && <section className="board-section">
          <div className="section-heading"><div><p className="eyebrow">{phase === 'ideas' ? 'PRIMER PASO · ESCRIBIR' : phase === 'classification' ? 'SEGUNDO PASO · CONECTAR' : 'EL MAPA DEL ENCUENTRO'}</p><h2>{phase === 'ideas' ? snapshot.moderator ? 'Ideas del equipo organizador' : 'Tus post-its' : 'Nuestro mural de ideas'}</h2></div><span className="count-badge">{phase === 'ideas' && !snapshot.moderator ? `${ownIdeas.length} de ${MAX_IDEAS} ideas` : `${snapshot.ideas.length} ideas`}</span></div>
          <p className="board-help">{phase === 'ideas' ? snapshot.moderator ? 'Las ideas del equipo se identifican para todos. Solo podés editar las que creaste.' : 'Describí la tarea y completá los detalles que quieras. Durante esta fase, solo vos podés ver tus ideas.' : phase === 'classification' ? snapshot.moderator ? 'Las elecciones individuales permanecen privadas. Seguí el avance en el panel de participantes.' : 'Tus elecciones son privadas. Podés cambiarlas hasta que el equipo cierre esta fase.' : 'Cada listado incluye las seis áreas y las respuestas sin áreas. Una respuesta puede incluir varias etiquetas.'}</p>

          {phase === 'classification' && snapshot.participant && <div className="personal-progress"><div><strong>{completed} de {snapshot.ideas.length} ideas clasificadas</strong><span>{completed === snapshot.ideas.length && snapshot.ideas.length > 0 ? '¡Terminaste! Podés revisar tus elecciones.' : 'Guardamos cada elección al seleccionarla.'}</span></div><progress value={completed} max={snapshot.ideas.length || 1} aria-label="Tu progreso de clasificación" /></div>}

          {phase === 'ideas' && (snapshot.moderator || ownIdeas.length < MAX_IDEAS) &&
            <form className="panel idea-composer" onSubmit={async event => {
              event.preventDefault()
              if (!isCompleteIdea(newIdea)) return
              const saved = await run('new-idea', async () => {
                const { error } = await supabase!.from('ideas').insert({ author_id: session!.user.id, ...ideaDraft(newIdea), organizer: snapshot.moderator })
                if (error) throw error
              })
              if (saved) setNewIdea(emptyIdeaDraft())
            }}>
              <div className="composer-heading"><div><p className="eyebrow">UNA NUEVA IDEA</p><h3>{snapshot.moderator ? 'Propuesta del equipo organizador' : 'Definí tu propuesta'}</h3></div><Icon kind="plus" /></div>
              <p className="composer-help">Solo Tarea es obligatoria. Los demás campos son opcionales.</p>
              <IdeaFields value={newIdea} onChange={setNewIdea} disabled={!!busy} idPrefix="new-idea" />
              <div className="composer-actions"><small>Hasta 500 caracteres por campo.</small><Button type="submit" className="primary" busy={busy === 'new-idea'} disabled={!!busy || !isCompleteIdea(newIdea)}>Guardar idea <Icon kind="plus" /></Button></div>
            </form>}
          <AreaLabels active={phase === 'classification' && !!snapshot.participant} busy={!!busy} onAssign={(ideaId, area) => {
            if (phase !== 'classification' || !snapshot.participant) return
            const selected = choicesByIdea.get(ideaId) ?? []
            if (!selected.includes(area)) void classify(ideaId, [...selected, area].sort((a, b) => a - b))
          }}>
          <div className="notes-grid">
            {snapshot.ideas.map(idea => <Note key={idea.id} idea={idea} editable={phase === 'ideas' && !idea.preset && idea.author_id === session?.user.id} busy={!!busy} onSave={draft => saveIdea(idea, draft)} onDelete={() => deleteIdea(idea)}>
              {phase === 'classification' && snapshot.participant && <IdeaAreas ideaId={idea.id} selected={choicesByIdea.get(idea.id)} onChange={areas => { void classify(idea.id, areas) }} />}
              {phase === 'results' && <div className="results-list"><p className="result-label">ELECCIONES POR ÁREA</p><ul>{AREAS.map((area, index) => { const count = resultsByIdea.get(idea.id)?.find(r => r.area_id === index + 1)?.votes ?? 0; return <li key={area}><span>{area}</span><b className={count > 0 ? 'has-votes' : ''}>{count}</b></li> })}</ul><div className="result-none"><span>Sin áreas</span><strong>{resultsByIdea.get(idea.id)?.[0]?.no_area ?? 0}</strong></div><div className="result-total"><span>Total de respuestas</span><strong>{resultsByIdea.get(idea.id)?.[0]?.total ?? 0}</strong></div></div>}
            </Note>)}
          </div>
          </AreaLabels>
          {snapshot.ideas.length === 0 && phase !== 'ideas' && <div className="panel empty-state"><h3>No se guardaron ideas.</h3><p>El equipo organizador cerró la escritura sin post-its.</p></div>}
        </section>}
      </>}
    </main>
    <footer><span>CEIDEF <span className="footer-separator">/</span> Ideas que conectan.</span><span className="sync-status"><span className={`status-dot ${syncError ? 'offline' : ''}`} />{session ? syncError ? 'Sin sincronizar · reintentando' : live ? 'Fases en vivo · guardado en Supabase' : updatedAt ? 'Sincronización cada 5 segundos' : 'Conectando…' : 'Un espacio de construcción colectiva'}</span></footer>
  </div>
}

function ModeratorPanel({ snapshot, busy, confirmPhase, setConfirmPhase, advance, reset, actionError, onResetOpen }: {
  snapshot: Snapshot; busy: string | null; confirmPhase: Phase | null;
  setConfirmPhase: (phase: Phase | null) => void; advance: () => Promise<boolean>;
  reset: (revision: string) => Promise<boolean>; actionError: string;
  onResetOpen: () => void;
}) {
  const [resetRevision, setResetRevision] = useState<string | null>(null)
  const phase = snapshot.workshop.phase
  const totalCompleted = snapshot.progress.reduce((sum, p) => sum + p.completed, 0)
  const totalExpected = snapshot.progress.length * snapshot.ideas.length
  return <section className="moderator-panel panel"><div className="moderator-heading"><div><p className="eyebrow">PANEL DE MODERACIÓN</p><h2>El pulso del encuentro</h2></div><span className="phase-label">{PHASE_NAMES[phase]}</span></div><div className="moderator-controls"><div className="stats"><div><strong>{snapshot.progress.length}<small>/ {MAX_PARTICIPANTS}</small></strong><span>Participantes</span></div><div><strong>{snapshot.ideas.length}</strong><span>Ideas guardadas</span></div><div><strong>{totalCompleted}<small>/ {totalExpected}</small></strong><span>Clasificaciones</span></div></div><div className="control-buttons"><Button className="secondary" disabled={!!busy} onClick={() => downloadCsv(snapshot, false)}><Icon kind="download" /> Ideas CSV</Button>{phase === 'results' && <Button className="secondary" disabled={!!busy} onClick={() => downloadCsv(snapshot, true)}><Icon kind="download" /> Resultados CSV</Button>}{phase !== 'results' && <Button className="primary" disabled={!!busy} onClick={() => setConfirmPhase(phase)}>{nextLabels[phase]} <Icon kind="arrow" /></Button>}</div></div>
    <details className="participant-details" open={phase === 'waiting' || phase === 'classification'}><summary>Participantes y progreso ({snapshot.progress.length})</summary>{snapshot.progress.length === 0 ? <p>Todavía no ingresaron participantes.</p> : <ul>{snapshot.progress.map(p => <li key={p.user_id}><span className="participant-avatar" aria-hidden="true">{p.name.charAt(0).toUpperCase()}</span><span>{p.name}</span><span className="participant-count">{phase === 'waiting' || phase === 'ideas' ? 'En la actividad' : `${p.completed} / ${p.total}`}</span>{phase !== 'waiting' && phase !== 'ideas' && <progress value={p.completed} max={p.total || 1} aria-label={`Progreso de ${p.name}`} />}</li>)}</ul>}</details>
    {confirmPhase === phase && <div className="phase-confirm" role="alert"><div><strong>{phase === 'waiting' ? '¿Comenzar la actividad?' : phase === 'ideas' ? '¿Cerrar la escritura de ideas?' : '¿Cerrar la clasificación?'}</strong><p>{phase === 'waiting' ? 'Los participantes podrán comenzar a escribir. El ingreso seguirá abierto durante toda la actividad.' : phase === 'ideas' ? 'Las ideas quedarán bloqueadas y serán visibles para todos. Este cambio no se puede deshacer desde la aplicación.' : `Hay ${totalCompleted} de ${totalExpected} respuestas guardadas. Al cerrar no podrán cambiarse y se mostrarán los resultados.`}</p></div><Button className="primary" busy={busy === 'phase'} disabled={!!busy} onClick={() => void advance()}>Confirmar cambio</Button><Button className="text-button" disabled={!!busy} onClick={() => setConfirmPhase(null)}>Cancelar</Button></div>}
    <Button className="danger-button" disabled={!!busy} onClick={() => { onResetOpen(); setConfirmPhase(null); setResetRevision(snapshot.workshop.updated_at) }}>Reiniciar actividad</Button>
    {resetRevision !== null && <ResetDialog busy={busy === 'reset'} error={actionError} onCancel={() => setResetRevision(null)}
      onConfirm={() => { void reset(resetRevision).then(saved => { if (saved) setResetRevision(null) }) }} />}
  </section>
}

export default App
