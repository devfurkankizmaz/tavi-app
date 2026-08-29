/**
 * Filters and the chosen view, carried in the URL.
 *
 * Two things fall out of putting them there rather than in component state:
 * a filtered board survives a reload and the back button, and the address bar
 * becomes something you can paste into Slack. Saved views are then only a
 * name attached to one of these query strings — the server stores the text
 * and never parses it.
 *
 * Only values that differ from the default are written, so an untouched
 * screen has a clean URL and two people who set the same filters produce
 * byte-identical links.
 */
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { emptyFilters, type Filters } from './components/FilterBar'

export const VIEWS = ['list', 'kanban', 'table', 'calendar', 'gantt', 'docs'] as const
export type View = (typeof VIEWS)[number]

/** Everything this module owns. `task` is not here: it is panel state. */
const KEYS = ['view', 'q', 'done', 'priority', 'type', 'labelId', 'assigneeId'] as const

export interface ViewState {
  view: View
  filters: Filters
}

/**
 * `done` is the one filter whose default is not empty — a project opens on
 * its open work — so the query string spells out the two other cases and
 * stays silent on the default.
 */
function readDone(raw: string | null): Filters['done'] {
  if (raw === 'true') return 'true'
  if (raw === 'all') return ''
  return 'false'
}

function writeDone(done: Filters['done']): string | null {
  if (done === 'true') return 'true'
  if (done === '') return 'all'
  return null
}

export function parseViewState(params: URLSearchParams): ViewState {
  const view = params.get('view')
  return {
    view: VIEWS.includes(view as View) ? (view as View) : 'list',
    filters: {
      q: params.get('q') ?? '',
      done: readDone(params.get('done')),
      priority: params.get('priority') ?? '',
      type: params.get('type') ?? '',
      labelId: params.get('labelId') ?? '',
      assigneeId: params.get('assigneeId') ?? '',
    },
  }
}

/** The canonical query string for a state — what a saved view stores. */
export function serializeViewState({ view, filters }: ViewState): string {
  const out = new URLSearchParams()
  if (view !== 'list') out.set('view', view)
  if (filters.q) out.set('q', filters.q)
  const done = writeDone(filters.done)
  if (done) out.set('done', done)
  if (filters.priority) out.set('priority', filters.priority)
  if (filters.type) out.set('type', filters.type)
  if (filters.labelId) out.set('labelId', filters.labelId)
  if (filters.assigneeId) out.set('assigneeId', filters.assigneeId)
  return out.toString()
}

export function isDefaultViewState(state: ViewState): boolean {
  return serializeViewState(state) === ''
}

/**
 * Reads the state out of the URL and writes it back, leaving every other
 * parameter — the open task, above all — exactly where it was.
 *
 * Navigation replaces rather than pushes: changing a filter six times should
 * not cost six presses of the back button to leave the screen.
 */
export function useViewState(): {
  state: ViewState
  setView: (view: View) => void
  setFilters: (filters: Filters) => void
  applyQuery: (query: string) => void
  reset: () => void
} {
  const [params, setParams] = useSearchParams()
  const state = useMemo(() => parseViewState(params), [params])

  const write = useCallback((next: ViewState) => {
    setParams(current => {
      const out = new URLSearchParams(current)
      for (const key of KEYS) out.delete(key)
      for (const [key, value] of new URLSearchParams(serializeViewState(next))) out.set(key, value)
      return out
    }, { replace: true })
  }, [setParams])

  return {
    state,
    setView: useCallback((view: View) => write({ ...parseViewState(params), view }), [params, write]),
    setFilters: useCallback((filters: Filters) => write({ ...parseViewState(params), filters }), [params, write]),
    // A saved view replaces the filters wholesale; anything it does not
    // mention goes back to its default rather than lingering from before.
    applyQuery: useCallback((query: string) => write(parseViewState(new URLSearchParams(query))), [write]),
    reset: useCallback(() => write({ view: parseViewState(params).view, filters: emptyFilters }), [params, write]),
  }
}
