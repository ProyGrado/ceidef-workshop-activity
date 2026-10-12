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
]
export const MAX_IDEAS = 10
export const MAX_PARTICIPANTS = 100
export const IDEA_FIELDS = [
  { key: 'task', label: 'Tarea', placeholder: 'Buscar, filtrar y resumir literatura científica reciente sobre eficacia, seguridad e interacciones entre medicamentos.' },
  { key: 'position', label: 'Puesto', placeholder: 'Asistente de Búsqueda de Evidencia Farmacológica' },
  { key: 'information', label: 'Información que necesita', placeholder: '• Acceso a bases de datos bibliográficas (como PubMed, Cochrane, guías clínicas internacionales).\n• Normativas del Ministerio de Salud Pública (MSP) y protocolos internos del Hospital de Clínicas.' },
  { key: 'supervisor', label: 'Quién lo supervisa', placeholder: 'Coordinadores o farmacéuticos.' },
  { key: 'boundaries', label: 'Lo que nunca puede hacer', placeholder: '• Validar o enviar respuestas clínicas a los usuarios sin la revisión y aprobación de un profesional.\n• Prescribir, sugerir cambios de tratamiento a pacientes directamente o realizar diagnósticos.' },
  { key: 'success_criteria', label: 'Cómo sabremos que lo hace bien', placeholder: '• Si reduce significativamente el tiempo de búsqueda y armado de la estructura de las respuestas sin perder rigor científico.\n• Si el 100% de las referencias bibliográficas que aporta son reales, accesibles y pertinentes al caso clínico analizado.\n• Si el profesional valida sus borradores con mínimas correcciones estructurales o de contenido.' },
] as const
export type IdeaField = typeof IDEA_FIELDS[number]['key']
export type IdeaDraft = Record<IdeaField, string>
export function emptyIdeaDraft(): IdeaDraft {
  return { position: '', task: '', information: '', supervisor: '', boundaries: '', success_criteria: '' }
}
export function ideaDraft(idea: IdeaDraft): IdeaDraft {
  return Object.fromEntries(IDEA_FIELDS.map(({ key }) => [key, idea[key].trim()])) as IdeaDraft
}
export function isCompleteIdea(idea: IdeaDraft): boolean {
  return idea.task.trim().length > 0 && IDEA_FIELDS.every(({ key }) => idea[key].length <= 500)
}
export interface Workshop { id: number; title: string; phase: Phase; updated_at: string }
export interface Participant { user_id: string; name: string }
export interface Idea extends IdeaDraft { id: string; author_id: string | null; organizer: boolean; preset: boolean; title: string; created_at: string }
export interface Choice { idea_id: string; area_ids: number[] }
export interface Result { idea_id: string; area_id: number; votes: number; total: number; no_area: number }
export interface Progress extends Participant { completed: number; total: number }
export interface Snapshot {
  workshop: Workshop; participant: Participant | null; moderator: boolean;
  ideas: Idea[]; choices: Choice[]; results: Result[]; progress: Progress[];
}
export function indexResults(results: Result[]): Map<string, Result[]> {
  const grouped = new Map<string, Result[]>()
  for (const result of results) {
    const rows = grouped.get(result.idea_id) ?? []
    rows.push(result)
    grouped.set(result.idea_id, rows)
  }
  return grouped
}

// Neutraliza fórmulas al abrir CSV en Excel/Sheets, además de escapar comillas.
export function csvCell(value: unknown): string {
  const text = String(value ?? '')
  const safe = /^[\s\uFEFF]*[=+@-]/.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}
export function buildCsv(snapshot: Snapshot, withResults: boolean): string {
  const header = ['ID', 'Título', ...IDEA_FIELDS.map(field => field.label), 'Autor', ...(withResults ? [...AREAS, 'Sin áreas', 'Total de respuestas'] : [])]
  const names = new Map(snapshot.progress.map(p => [p.user_id, p.name]))
  const results = indexResults(snapshot.results)
  const rows = snapshot.ideas.map(idea => {
    const counts = results.get(idea.id) ?? []
    return [idea.id, idea.title, ...IDEA_FIELDS.map(({ key }) => idea[key]), idea.organizer ? 'Equipo organizador' : (idea.author_id && names.get(idea.author_id)) || 'Participante',
      ...(withResults ? [...AREAS.map((_, index) => counts.find(r => r.area_id === index + 1)?.votes ?? 0), counts[0]?.no_area ?? 0, counts[0]?.total ?? 0] : []),
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
  if (error && typeof error === 'object' && 'code' in error) {
    if (error.code === 'PGRST116') return 'La fase cambió o el dato ya no está disponible. Actualizá y volvé a intentar.'
    if (error.code === '42501') return 'No se pudo guardar: la fase está cerrada o tu sesión no tiene permiso para esta operación.'
  }
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return 'No pudimos completar la operación. Revisá tu conexión y volvé a intentar.'
}
