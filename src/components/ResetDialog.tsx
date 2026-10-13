import { useEffect, useRef } from 'react'

export function ResetDialog({ busy, error, onCancel, onConfirm }: {
  busy: boolean; error: string; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])
  function cancel() {
    if (busy) return
    dialog.current?.close()
    onCancel()
  }
  return <dialog ref={dialog} className="reset-dialog" aria-labelledby="reset-title" aria-describedby="reset-description"
    onCancel={event => { event.preventDefault(); cancel() }}>
    <h2 id="reset-title">¿Reiniciar la actividad?</h2>
    <p id="reset-description">Se borrarán definitivamente los participantes, las ideas creadas durante la actividad y todas las clasificaciones. Se conservarán las tres ideas predeterminadas y la actividad volverá a Espera.</p>
    <p>Descargá los CSV antes de continuar. Esta acción no se puede deshacer.</p>
    {error && <p className="reset-error" role="alert">{error}</p>}
    <div className="reset-actions">
      <button type="button" className="secondary" autoFocus disabled={busy} onClick={cancel}>Cancelar</button>
      <button type="button" className="danger-button" disabled={busy} onClick={onConfirm}>{busy ? 'Reiniciando…' : 'Sí, reiniciar actividad'}</button>
    </div>
  </dialog>
}
