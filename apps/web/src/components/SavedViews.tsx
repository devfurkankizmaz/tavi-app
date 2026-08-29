/**
 * Named filter sets, sitting next to the filter bar.
 *
 * A view is the current query string under a name, so saving one asks for
 * nothing but the name — whatever is on screen is already the definition.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import { Popover, TrashIcon, useAction, useToast } from '../ui'
import { isDefaultViewState, serializeViewState, type ViewState } from '../views'

export interface SavedView {
  id: string
  name: string
  query: string
  projectId: string | null
  shared: boolean
  mine: boolean
  ownerName?: string
}

export default function SavedViews({ projectId, state, onApply, canShare }: {
  /** Null for the screens that span projects; those views cannot be shared. */
  projectId: string | null
  state: ViewState
  onApply: (query: string) => void
  canShare: boolean
}) {
  const t = useT()
  const run = useAction()
  const toast = useToast()
  const [views, setViews] = useState<SavedView[]>([])
  const [name, setName] = useState('')

  const load = useCallback(async () => {
    const query = projectId ? `?projectId=${projectId}` : ''
    setViews(await api.get<SavedView[]>(`/api/views${query}`))
  }, [projectId])

  useEffect(() => { void load() }, [load])

  const current = serializeViewState(state)
  // The name of whichever view matches the screen right now, so it is obvious
  // when you are looking at a saved one and when you have drifted off it.
  const active = views.find(v => v.query === current)

  const save = (shared: boolean, close: () => void) => run(async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    await api.post('/api/views', { name: trimmed, query: current, projectId, shared })
    setName('')
    close()
    await load()
    toast(t('views.saved', { name: trimmed }))
  })

  const remove = (view: SavedView) => run(async () => {
    await api.del(`/api/views/${view.id}`)
    await load()
    toast(t('views.deleted', { name: view.name }))
  })

  return (
    <Popover
      align="right"
      trigger={
        <button className={`btn ghost sm${active ? ' active' : ''}`} title={t('views.title')}>
          {active ? active.name : t('views.title')}
          {views.length > 0 && !active && <span className="chip count">{views.length}</span>}
        </button>
      }
    >
      {close => (
        <div className="views-menu">
          {views.length === 0 && <p className="hint views-note">{t('views.empty')}</p>}

          {views.map(view => (
            <div key={view.id} className={`row${view.query === current ? ' on' : ''}`}>
              <button className="grow views-name" onClick={() => { onApply(view.query); close() }}>
                {view.name}
                {view.shared && <span className="chip">{t('views.shared')}</span>}
                {!view.mine && <span className="hint"> · {view.ownerName}</span>}
              </button>
              {view.mine && (
                <button className="views-remove" title={t('common.delete')} onClick={() => void remove(view)}>
                  <TrashIcon />
                </button>
              )}
            </div>
          ))}

          <div className="views-sep" />

          {isDefaultViewState(state) ? (
            // Saving "no filters at all" would produce a view that does
            // nothing, which is more confusing than not offering it.
            <p className="hint views-note">{t('views.needFilters')}</p>
          ) : (
            <div className="views-save">
              <input
                className="input sm"
                placeholder={t('views.namePlaceholder')}
                value={name}
                maxLength={80}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void save(false, close) }}
              />
              <div className="views-actions">
                <button className="btn sm" disabled={!name.trim()} onClick={() => void save(false, close)}>
                  {t('views.saveMine')}
                </button>
                {canShare && projectId && (
                  <button className="btn ghost sm" disabled={!name.trim()} onClick={() => void save(true, close)}>
                    {t('views.saveShared')}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </Popover>
  )
}
