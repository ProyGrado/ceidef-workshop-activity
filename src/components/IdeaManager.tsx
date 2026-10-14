import { useEffect, useRef, useState } from 'react'
import type { Idea } from '../lib/workshop'

export function IdeaManager({ ideas, hiddenIds, busy, error, onClose, onChange }: {
  ideas: Idea[]; hiddenIds: string[]; busy: boolean; error: string;
  onClose: () => void; onChange: (idea: Idea, visible: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [view, setView] = useState<'visible' | 'hidden'>('visible')
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])
  function close() {
    if (busy) return
    dialog.current?.close()
    onClose()
  }
  const listed = ideas.filter(idea => hiddenIds.includes(idea.id) === (view === 'hidden'))
  return <dialog ref={dialog} className="idea-manager" aria-labelledby="idea-manager-title"
    onCancel={event => { event.preventDefault(); close() }}>
    <div className="manager-heading"><h2 id="idea-manager-title">Administrar ideas</h2><button type="button" className="text-button" disabled={busy} onClick={close}>Cerrar</button></div>
    <p>Ocultar una idea la retira del mural de todos. Sus respuestas se conservan y vuelven a aparecer al mostrarla.</p>
    <div className="manager-filters"><button type="button" className="secondary" aria-pressed={view === 'visible'} onClick={() => setView('visible')}>Visibles</button><button type="button" className="secondary" aria-pressed={view === 'hidden'} onClick={() => setView('hidden')}>Ocultas</button></div>
    {busy && <p role="status">Guardando…</p>}
    {error && <p className="reset-error" role="alert">{error}</p>}
    {listed.length === 0 ? <p>No hay ideas en esta lista.</p> : <ul className="manager-list">{listed.map(idea => <li key={idea.id}>
      <div>{idea.title && <strong>{idea.title}</strong>}<p>{idea.task}</p></div>
      <button type="button" className="secondary" disabled={busy} onClick={() => onChange(idea, view === 'hidden')}>{view === 'hidden' ? 'Mostrar' : 'Ocultar'}</button>
    </li>)}</ul>}
  </dialog>
}
