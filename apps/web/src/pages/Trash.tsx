import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useApp } from '../store'
import { useT } from '../i18n'
import { EmptyState, TaskKey, TrashIcon, useAction, useFormat } from '../ui'

type Kind = 'task' | 'document' | 'project'

interface TrashItem {
  kind: Kind
  id: string
  title: string
  key?: string
  icon?: string | null
  color?: string
  deletedAt: string
  project?: { id: string; key: string; title: string; color: string }
}

interface TrashData {
  retentionDays: number
  projects: TrashItem[]
  tasks: TrashItem[]
  documents: TrashItem[]
}

export default function Trash() {
  const { refreshProjects } = useApp()
  const t = useT()
  const fmt = useFormat()
  const run = useAction()
  const navigate = useNavigate()
  const [data, setData] = useState<TrashData | null>(null)

  const load = useCallback(async () => setData(await api.get<TrashData>('/api/trash')), [])
  useEffect(() => { void load() }, [load])

  const restore = (item: TrashItem) =>
    void run(async () => {
      await api.post(`/api/trash/${item.kind}/${item.id}/restore`)
      await load()
      await refreshProjects()
    }, t('trash.restored'))

  const purge = (item: TrashItem) => {
    if (!window.confirm(t('trash.purgeConfirm', { title: item.title }))) return
    void run(async () => { await api.del(`/api/trash/${item.kind}/${item.id}`); await load() }, t('trash.purged'))
  }

  if (!data) return null
  const groups: { key: 'deletedTasks' | 'deletedDocs' | 'deletedProjects'; items: TrashItem[] }[] = [
    { key: 'deletedTasks', items: data.tasks },
    { key: 'deletedDocs', items: data.documents },
    { key: 'deletedProjects', items: data.projects },
  ]
  const total = data.tasks.length + data.documents.length + data.projects.length

  return (
    <div className="content-inner">
      <div className="page-head"><h2>{t('trash.title')}</h2></div>
      <p className="lead">{t('trash.hint', { days: data.retentionDays })}</p>

      {total === 0 && <EmptyState illustrated title={t('trash.empty')} body={t('trash.emptyBody')} />}

      {groups.map(group => group.items.length > 0 && (
        <section key={group.key}>
          <div className="section-title">
            {t(`trash.${group.key}` as 'trash.deletedTasks')} <span className="chip count">{group.items.length}</span>
          </div>
          <div className="card task-list">
            {group.items.map(item => (
              <div key={`${item.kind}-${item.id}`} className="task-row">
                {item.kind === 'task' && item.key && <TaskKey value={item.key} />}
                {item.kind === 'document' && <span className="doc-icon">{item.icon ?? '📄'}</span>}
                {item.kind === 'project' && (
                  <span className="swatch" style={{ background: item.color, width: 9, height: 9, borderRadius: 3 }} />
                )}
                <span className="title">{item.title}</span>
                <span className="meta">
                  {item.project && (
                    <span className="chip count" onClick={() => navigate(`/projects/${item.project!.id}`)}>
                      {item.project.title}
                    </span>
                  )}
                  <span className="chip count">{t('trash.deletedAt', { when: fmt.timeAgo(item.deletedAt) })}</span>
                </span>
                <button className="btn sm" onClick={() => restore(item)}>{t('common.restore')}</button>
                <button className="btn sm ghost danger" onClick={() => purge(item)}
                  title={t('common.deletePermanently')} aria-label={t('common.deletePermanently')}>
                  <TrashIcon />
                </button>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
