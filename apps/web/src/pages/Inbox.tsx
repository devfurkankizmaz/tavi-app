import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useApp } from '../store'
import { useT } from '../i18n'
import {
  AvatarStack, EmptyState, StatusPill, TaskKey, TrashIcon, TypeIcon,
  useAction, useFormat,
} from '../ui'
import type { TaskStatus, TaskType, User } from '../types'

type Filter = 'unread' | 'all' | 'archived'
const FILTERS: Filter[] = ['unread', 'all', 'archived']

interface InboxTask {
  id: string
  key: string
  title: string
  status: TaskStatus
  type: TaskType
  priority: number
  done: boolean
  dueDate: string | null
  projectId: string
  projectTitle: string
  assignees: User[]
}

interface Group {
  key: string
  taskId: string | null
  projectId: string | null
  ids: string[]
  types: string[]
  actors: string[]
  unread: number
  latestAt: string
  fallbackTitle: string
  task: InboxTask | null
}

interface InboxData {
  filter: Filter
  unread: number
  archivedCount: number
  groups: Group[]
}

/**
 * Gelen kutusu.
 *
 * The bell answers "what happened?"; this screen answers "what needs me?".
 * Notifications about one task collapse into a single row, that row shows the
 * task as it stands today, and archiving is how you empty the box.
 */
export default function Inbox() {
  const { refreshInbox } = useApp()
  const t = useT()
  const fmt = useFormat()
  const run = useAction()
  const navigate = useNavigate()

  const [filter, setFilter] = useState<Filter>('unread')
  const [data, setData] = useState<InboxData | null>(null)

  const load = useCallback(async (next: Filter) => {
    setData(await api.get<InboxData>(`/api/inbox?filter=${next}`))
  }, [])

  useEffect(() => { void load(filter) }, [filter, load])

  const act = (path: string, ids?: string[]) =>
    void run(async () => {
      await api.post(`/api/inbox/${path}`, ids ? { ids } : {})
      await load(filter)
      await refreshInbox()
    })

  const open = (group: Group) =>
    void run(async () => {
      if (group.unread) await api.post('/api/inbox/read', { ids: group.ids })
      await refreshInbox()
      if (group.types.includes('invite')) { navigate('/teams'); return }
      if (group.task) { navigate(`/projects/${group.task.projectId}?task=${group.task.id}`); return }
      if (group.projectId) navigate(`/projects/${group.projectId}`)
    })

  /** Turns a group's notification types into one sentence. */
  const summarise = (group: Group) => {
    const who = group.actors.length === 0 ? t('inbox.someone')
      : group.actors.length === 1 ? group.actors[0]
      : t('inbox.andOthers', { name: group.actors[0], count: group.actors.length - 1 })

    // Mixed types read as "3 updates"; a single type keeps its name plus a count
    const kind = group.types.length > 1
      ? t('inbox.several', { count: group.ids.length })
      : t(`inbox.type.${group.types[0]}` as 'inbox.type.assigned')
        + (group.ids.length > 1 ? ` · ${group.ids.length}` : '')

    return `${who} · ${kind}`
  }

  if (!data) return null

  const empty = data.groups.length === 0

  return (
    <div className="content-inner">
      <div className="page-head">
        <h2>{t('inbox.title')}</h2>
        {filter !== 'archived' && data.unread > 0 && (
          <button className="btn ghost sm" onClick={() => act('read')}>{t('inbox.readAll')}</button>
        )}
        {filter !== 'archived' && data.groups.length > 0 && (
          <button className="btn sm" onClick={() => act('archive')}>{t('inbox.archiveAll')}</button>
        )}
      </div>

      <div className="inbox-tabs">
        {FILTERS.map(f => (
          <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
            {t(`inbox.filter.${f}` as 'inbox.filter.all')}
            {f === 'unread' && data.unread > 0 && <span className="chip count">{data.unread}</span>}
            {f === 'archived' && data.archivedCount > 0 && <span className="chip count">{data.archivedCount}</span>}
          </button>
        ))}
      </div>

      {empty ? (
        <EmptyState
          illustrated={filter === 'unread'}
          title={t(`inbox.empty.${filter}` as 'inbox.empty.all')}
          body={filter === 'unread' ? t('inbox.emptyBody') : undefined}
        />
      ) : (
        <div className="card inbox-list">
          {data.groups.map(group => (
            <div
              key={group.key}
              className={`inbox-row${group.unread ? ' unread' : ''}`}
              onClick={() => open(group)}
            >
              <span className="dot" aria-hidden />

              <div className="body">
                <div className="who">
                  {summarise(group)}
                  <span className="when">{fmt.timeAgo(group.latestAt)}</span>
                </div>

                {group.task ? (
                  <div className="what">
                    <TypeIcon type={group.task.type} />
                    <TaskKey value={group.task.key} />
                    <span className={`title${group.task.done ? ' done' : ''}`}>{group.task.title}</span>
                    <StatusPill status={group.task.status} />
                    <span className="where">{group.task.projectTitle}</span>
                    {group.task.assignees.length > 0 && (
                      <AvatarStack users={group.task.assignees} size={20} />
                    )}
                  </div>
                ) : (
                  /* Task deleted or access revoked: fall back to the notification's own text */
                  <div className="what gone">
                    <span className="title">{group.fallbackTitle || t('inbox.gone')}</span>
                  </div>
                )}
              </div>

              <div className="row-actions" onClick={e => e.stopPropagation()}>
                {filter === 'archived' ? (
                  <button className="btn ghost sm" onClick={() => act('unarchive', group.ids)}>
                    {t('inbox.unarchive')}
                  </button>
                ) : (
                  <>
                    <button className="btn ghost sm" onClick={() =>
                      act(group.unread ? 'read' : 'unread', group.ids)
                    }>
                      {group.unread ? t('inbox.markRead') : t('inbox.markUnread')}
                    </button>
                    <button className="icon-btn" aria-label={t('inbox.archive')} title={t('inbox.archive')}
                      onClick={() => act('archive', group.ids)}>
                      <TrashIcon />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
