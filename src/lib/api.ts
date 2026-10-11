import { supabase } from './supabase'
import type { Snapshot, Workshop, Participant, Idea, Choice, Result, Progress } from './workshop'

export async function loadSnapshot(userId: string): Promise<Snapshot> {
  if (!supabase) throw new Error('Falta configurar Supabase.')
  const [workshopResponse, roleResponse, participantResponse] = await Promise.all([
    supabase.from('workshops').select('id,title,phase').eq('id', 1).single(),
    supabase.rpc('is_moderator'),
    supabase.from('participants').select('user_id,name').eq('user_id', userId).maybeSingle(),
  ])
  for (const response of [workshopResponse, roleResponse, participantResponse]) if (response.error) throw response.error
  const workshop = workshopResponse.data as Workshop
  const moderator = roleResponse.data === true
  const participant = participantResponse.data as Participant | null
  if (!moderator && !participant) return { workshop, moderator, participant, ideas: [], choices: [], results: [], progress: [] }
  const [ideas, choices, results, progress] = await Promise.all([
    supabase.from('ideas').select('id,author_id,content,organizer,created_at').order('created_at').order('id'),
    participant ? supabase.from('classifications').select('idea_id,area_id').eq('user_id', userId) : Promise.resolve({ data: [], error: null }),
    workshop.phase === 'results' ? supabase.rpc('get_results') : Promise.resolve({ data: [], error: null }),
    moderator ? supabase.rpc('get_progress') : Promise.resolve({ data: [], error: null }),
  ])
  for (const response of [ideas, choices, results, progress]) if (response.error) throw response.error
  return { workshop, moderator, participant, ideas: ideas.data as Idea[], choices: choices.data as Choice[], results: results.data as Result[], progress: progress.data as Progress[] }
}
