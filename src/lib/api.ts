import { supabase } from './supabase'
import { fetchAll } from './pagination'
import { IDEA_FIELDS } from './workshop'
import type { Snapshot, Workshop, Participant, Idea, Choice, Result, Progress } from './workshop'

export async function loadSnapshot(userId: string, previous?: Snapshot): Promise<Snapshot> {
  if (!supabase) throw new Error('Falta configurar Supabase.')
  const [workshopResponse, roleResponse, participantResponse] = await Promise.all([
    supabase.from('workshops').select('id,title,phase,updated_at').eq('id', 1).single(),
    supabase.rpc('is_moderator'),
    supabase.from('participants').select('user_id,name').eq('user_id', userId).maybeSingle(),
  ])
  for (const response of [workshopResponse, roleResponse, participantResponse]) if (response.error) throw response.error
  const workshop = workshopResponse.data as Workshop
  const moderator = roleResponse.data === true
  const participant = participantResponse.data as Participant | null
  if (!moderator && !participant) return { workshop, moderator, participant, ideas: [], choices: [], results: [], progress: [] }
  const samePhase = previous?.workshop.updated_at === workshop.updated_at && previous?.workshop.phase === workshop.phase
    && previous?.moderator === moderator && previous?.participant?.user_id === participant?.user_id
  // Con resultados cerrados no hay más escrituras: se conserva el mural.
  // La fase y los permisos se siguen consultando, también tras un reinicio.
  if (samePhase && workshop.phase === 'results') return previous!
  const [ideas, choices, results, progress] = await Promise.all([
    samePhase && workshop.phase === 'classification' ? Promise.resolve(previous!.ideas) :
      fetchAll<Idea>((from, to) => supabase!.from('ideas').select(`id,author_id,${IDEA_FIELDS.map(f => f.key).join(',')},organizer,preset,title,created_at`).order('created_at').order('id').range(from, to)),
    participant ? fetchAll<Choice>((from, to) => supabase!.from('classifications').select('idea_id,area_ids').eq('user_id', userId).order('idea_id').range(from, to)) : Promise.resolve([]),
    workshop.phase === 'results' ? fetchAll<Result>((from, to) => supabase!.rpc('get_results').range(from, to)) : Promise.resolve([]),
    moderator ? fetchAll<Progress>((from, to) => supabase!.rpc('get_progress').range(from, to)) : Promise.resolve([]),
  ])
  return { workshop, moderator, participant, ideas, choices, results, progress }
}
