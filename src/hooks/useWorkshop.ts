import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { loadSnapshot } from '../lib/api'
import { errorMessage } from '../lib/workshop'
import type { Snapshot } from '../lib/workshop'

export function useWorkshop(session: Session | null) {
  const [data, setData] = useState<{ userId: string; snapshot: Snapshot } | null>(null)
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [live, setLive] = useState(false)
  const version = useRef(0)
  const refresh = useCallback(async (userId?: string) => {
    const id = userId ?? session?.user.id
    if (!id) return
    const request = ++version.current
    try {
      const snapshot = await loadSnapshot(id)
      if (request !== version.current) return
      setData({ userId: id, snapshot })
      setError('')
      setUpdatedAt(new Date())
    } catch (cause) {
      if (request === version.current) setError(errorMessage(cause))
    }
  }, [session?.user.id])

  useEffect(() => {
    if (!session || !supabase) return
    let active = true
    const reread = () => { void refresh() }
    reread()
    const interval = window.setInterval(reread, 5000)
    window.addEventListener('focus', reread)
    window.addEventListener('online', reread)
    const channel = supabase.channel(`ceidef-phase-${session.user.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'workshops', filter: 'id=eq.1' }, reread)
      .subscribe(status => { if (active) setLive(status === 'SUBSCRIBED') })
    return () => {
      active = false
      // Es un contador de requests, no una referencia a un nodo del DOM.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      version.current++
      clearInterval(interval)
      window.removeEventListener('focus', reread)
      window.removeEventListener('online', reread)
      void supabase?.removeChannel(channel)
    }
  }, [session, refresh])

  return { snapshot: data?.userId === session?.user.id ? data?.snapshot ?? null : null, error, refresh, updatedAt, live }
}
