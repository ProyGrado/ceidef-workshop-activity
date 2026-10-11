export const PHASES = ['waiting', 'ideas', 'classification', 'results'] as const
export type Phase = typeof PHASES[number]
export const PHASE_NAMES: Record<Phase, string> = {
  waiting: 'Espera', ideas: 'Ideas', classification: 'Clasificación', results: 'Resultados',
}
export const AREAS = [
  'Individualización de tratamientos',
  'Farmacovigilancia',
  'Seguimiento farmacoterapéutico',
  'Acceso y sostenibilidad',
  'Estandarización de procesos',
  'Información de medicamentos',
  'Transversal / no estoy seguro',
]
export interface Workshop { id: number; title: string; phase: Phase }
export interface Participant { user_id: string; name: string }
export interface Idea { id: string; author_id: string; content: string; organizer: boolean; created_at: string }
export interface Choice { idea_id: string; area_id: number }
export interface Result { idea_id: string; area_id: number; votes: number; total: number }
export interface Progress extends Participant { completed: number; total: number }
export interface Snapshot {
  workshop: Workshop; participant: Participant | null; moderator: boolean;
  ideas: Idea[]; choices: Choice[]; results: Result[]; progress: Progress[];
}

// Neutraliza fórmulas al abrir CSV en Excel/Sheets, además de escapar comillas.
export function csvCell(value: unknown): string {
  const text = String(value ?? '')
  const safe = /^[\s\uFEFF]*[=+@-]/.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}
export function buildCsv(snapshot: Snapshot, withResults: boolean): string {
  const header = ['ID', 'Idea', 'Autor', ...(withResults ? [...AREAS, 'Total de respuestas'] : [])]
  const names = new Map(snapshot.progress.map(p => [p.user_id, p.name]))
  const rows = snapshot.ideas.map(idea => {
    const counts = snapshot.results.filter(r => r.idea_id === idea.id)
    return [idea.id, idea.content, idea.organizer ? 'Equipo organizador' : names.get(idea.author_id) ?? 'Participante',
      ...(withResults ? [...AREAS.map((_, index) => counts.find(r => r.area_id === index + 1)?.votes ?? 0), counts[0]?.total ?? 0] : []),
    ]
  })
  return '\uFEFF' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')
}
export function downloadCsv(snapshot: Snapshot, withResults: boolean) {
  const url = URL.createObjectURL(new Blob([buildCsv(snapshot, withResults)], { type: 'text/csv;charset=utf-8;' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `ceidef-${withResults ? 'resultados' : 'ideas'}.csv`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return 'No pudimos completar la operación. Revisá tu conexión y volvé a intentar.'
}
