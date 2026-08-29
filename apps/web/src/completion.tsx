import { useCallback, useRef, useState } from 'react'
import { api } from './api'
import { useT } from './i18n'
import { useToast } from './ui'
import type { Task } from './types'

/** How long a completed row lingers before it leaves the list. */
const LINGER_MS = 2600

interface ToggleOpts {
  /** Moves the row to its new state at once, without waiting on the server. */
  optimistic?: (done: boolean) => void
  /** Bekleme bitince listeyi tazeler. */
  reload?: () => void | Promise<unknown>
}

/**
 * What completing a task should feel like.
 *
 * The moment the box is ticked the row looks done, but it does not vanish:
 * it sits struck through for a few seconds, a toast offers "Undo", and then
 * it slides away. A mistaken click costs nothing, and a deliberate one still
 * shows you what you did.
 */
export function useCompletion() {
  const toast = useToast()
  const t = useT()
  // Rows still on screen that no longer belong to the list
  const [leaving, setLeaving] = useState<Set<string>>(new Set())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  /** Tasks confirmed with "complete anyway"; never asked about twice. */
  const confirmedBlocked = useRef(new Set<string>())

  const settle = useCallback((id: string) => {
    const timer = timers.current.get(id)
    if (timer) { clearTimeout(timer); timers.current.delete(id) }
    setLeaving(prev => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  const toggle = useCallback(async (task: Task, opts: ToggleOpts = {}) => {
    const done = !task.done

    /*
     * Completing blocked work is usually a mistake, but not always. So it is
     * not forbidden: we ask once, and if the answer is yes we do it. Silently
     * completing and flatly refusing would both be wrong.
     */
    if (done && task.blockedBy > 0 && !confirmedBlocked.current.has(task.id)) {
      toast(t('task.blockedWarn', { key: task.key }), 'err', {
        label: t('task.completeAnyway'),
        run: () => {
          confirmedBlocked.current.add(task.id)
          void toggle(task, opts)
        },
      })
      return
    }
    confirmedBlocked.current.delete(task.id)

    opts.optimistic?.(done)

    try {
      await api.patch(`/api/tasks/${task.id}`, { done })
    } catch (e) {
      opts.optimistic?.(!done)
      toast(e instanceof Error && e.message ? e.message : t('common.error'), 'err')
      return
    }

    // Reopening is visible on its own; no need to linger
    if (!done) { settle(task.id); await opts.reload?.(); return }

    setLeaving(prev => new Set(prev).add(task.id))
    toast(t('task.completedToast', { key: task.key }), 'ok', {
      label: t('common.undo'),
      run: () => void (async () => {
        settle(task.id)
        await api.patch(`/api/tasks/${task.id}`, { done: false })
        await opts.reload?.()
      })(),
    })

    timers.current.set(task.id, setTimeout(() => {
      settle(task.id)
      void opts.reload?.()
    }, LINGER_MS))
  }, [toast, t, settle])

  return { toggle, leaving }
}
