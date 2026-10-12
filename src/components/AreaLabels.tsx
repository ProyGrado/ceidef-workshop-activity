import { createContext, useContext, useRef, useState } from 'react'
import type { PointerEvent, ReactNode } from 'react'
import { AREAS } from '../lib/workshop'

interface LabelContext {
  picked: number | null; over: string | null; busy: boolean;
  assign: (ideaId: string, area: number) => void;
}
const Context = createContext<LabelContext | null>(null)

export function AreaLabels({ children, busy, onAssign, active }: {
  children: ReactNode; busy: boolean; active: boolean; onAssign: (ideaId: string, area: number) => void;
}) {
  const [picked, setPicked] = useState<number | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [ghost, setGhost] = useState<{ area: number; x: number; y: number } | null>(null)
  const drag = useRef<{ area: number; x: number; y: number; moved: boolean } | null>(null)
  function targetAt(x: number, y: number) {
    return document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-idea-drop]')?.dataset.ideaDrop ?? null
  }
  function start(event: PointerEvent<HTMLButtonElement>, area: number) {
    if (busy || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { area, x: event.clientX, y: event.clientY, moved: false }
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current
    if (!current) return
    if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 7) return
    current.moved = true
    setGhost({ area: current.area, x: event.clientX, y: event.clientY })
    setOver(targetAt(event.clientX, event.clientY))
    // Permite desplazar el mural cuando el arrastre llega a un borde.
    if (event.clientY > innerHeight - 70) window.scrollBy(0, 22)
    else if (event.clientY < 55) window.scrollBy(0, -22)
  }
  function finish(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current
    drag.current = null
    setGhost(null); setOver(null)
    if (!current) return
    if (!current.moved) { setPicked(current.area); return }
    const target = targetAt(event.clientX, event.clientY)
    if (target && !busy) onAssign(target, current.area)
  }
  function cancel() { drag.current = null; setGhost(null); setOver(null) }
  return <Context.Provider value={{ picked, over, busy, assign: onAssign }}>
    {active && <aside className="area-palette" aria-label="Etiquetas de áreas">
      <p><strong>Conectá cada idea con sus áreas</strong><span>Arrastrá las etiquetas a una idea, o elegí una etiqueta y tocá su espacio. También podés usar los botones de cada tarjeta.</span></p>
      <div className="area-palette-labels">{AREAS.map((area, i) => <button key={area} type="button"
        className={`area-chip area-color-${i + 1} ${picked === i + 1 ? 'picked' : ''}`}
        aria-label={`Etiqueta: ${area}`} aria-pressed={picked === i + 1} disabled={busy}
        onPointerDown={event => start(event, i + 1)} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel}
        onClick={() => setPicked(i + 1)}>
        <span aria-hidden="true">⠿</span>{area}
      </button>)}</div>
    </aside>}
    {children}
    {active && ghost && <div className={`area-chip area-color-${ghost.area} drag-ghost`} aria-hidden="true"
      style={{ left: ghost.x + 10, top: ghost.y + 10 }}>{AREAS[ghost.area - 1]}</div>}
  </Context.Provider>
}

export function IdeaAreas({ ideaId, selected, onChange }: {
  ideaId: string; selected: number[] | undefined; onChange: (areas: number[]) => void;
}) {
  const context = useContext(Context)
  if (!context) return null
  const { picked, over, busy, assign } = context
  const values = selected ?? []
  const toggle = (area: number) => onChange(values.includes(area) ? values.filter(value => value !== area) : [...values, area].sort((a, b) => a - b))
  return <section className="classification" aria-label="Clasificar esta idea">
    <h3>¿Con qué áreas se relaciona?</h3>
    <div data-idea-drop={ideaId} className={`label-dropzone ${over === ideaId ? 'is-over' : ''}`}>
      <button className="drop-hint" type="button" disabled={busy || !picked} onClick={() => { if (picked) assign(ideaId, picked) }}>
        {picked ? `+ Agregar ${AREAS[picked - 1]}` : 'Soltá aquí las etiquetas de áreas'}
      </button>
      {values.length > 0 && <div className="chosen-labels">{values.map(area => <button key={area} type="button"
        className={`area-chip area-color-${area}`} disabled={busy} onClick={() => toggle(area)} aria-label={`Quitar ${AREAS[area - 1]}`}>
        {AREAS[area - 1]}<span aria-hidden="true">×</span>
      </button>)}</div>}
    </div>
    <div className="area-toggles" aria-label="Elegir áreas sin arrastrar">{AREAS.map((area, i) => <button type="button" key={area}
      className={`area-option ${values.includes(i + 1) ? `selected area-color-${i + 1}` : ''}`}
      aria-pressed={values.includes(i + 1)} disabled={busy} onClick={() => toggle(i + 1)}>
      <span aria-hidden="true">{values.includes(i + 1) ? '✓' : '+'}</span>{area}
    </button>)}</div>
    <div className="classification-footer"><button type="button" className="none-button" disabled={busy || (!!selected && values.length === 0)} onClick={() => onChange([])}>
      {selected && values.length === 0 ? 'Sin áreas · guardado' : 'Guardar sin áreas'}
    </button><small>{selected ? values.length ? `✓ ${values.length} ${values.length === 1 ? 'área guardada' : 'áreas guardadas'}` : '✓ Respuesta guardada sin áreas' : 'Pendiente de clasificar'}</small></div>
  </section>
}
