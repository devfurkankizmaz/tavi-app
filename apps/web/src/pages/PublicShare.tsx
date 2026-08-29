import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../api'
import { useT } from '../i18n'
import { BrandMark, Markdown } from '../ui'
import type { Bucket, Task } from '../types'
import TaskRow from '../components/TaskRow'

interface SharedProject {
  id: string
  title: string
  description: string
  color: string
  buckets: Bucket[]
  tasks: Task[]
}

export default function PublicShare() {
  const { token } = useParams<{ token: string }>()
  const t = useT()
  const [project, setProject] = useState<SharedProject | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    api.get<SharedProject>(`/public/share/${token}`).then(setProject).catch(() => setError(true))
  }, [token])

  if (error) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-brand">
            <BrandMark size={64} />
            <span className="wordmark">Tavi</span>
          </div>
          <h1>{t('public.notFound')}</h1>
          <p style={{ color: 'var(--muted)', fontSize: '0.88rem', textAlign: 'center', margin: 0 }}>
            {t('public.notFoundHint')}
          </p>
        </div>
      </div>
    )
  }
  if (!project) return null

  const open = project.tasks.filter(task => !task.done)
  const done = project.tasks.filter(task => task.done)
  const noop = () => {}

  return (
    <div className="content" style={{ minHeight: '100%' }}>
      <div className="content-inner">
        <div className="brand" style={{ padding: '0 0 1.2rem' }}>
          <BrandMark size={28} /> <span className="wordmark">Tavi</span>
          <span className="chip count" style={{ marginLeft: '0.5rem' }}>{t('public.readonly')}</span>
        </div>

        <div className="page-head">
          <h2><span className="swatch" style={{ background: project.color }} />{project.title}</h2>
        </div>

        {project.description.trim() && (
          <div className="card" style={{ padding: '0.9rem 1.1rem', marginBottom: '1rem' }}>
            <Markdown text={project.description} />
          </div>
        )}

        <div className="card task-list">
          {open.length === 0 && <div className="empty">{t('public.noOpenTasks')}</div>}
          {open.map(task => <TaskRow key={task.id} task={task} readOnly onToggle={noop} onOpen={noop} />)}
        </div>

        {done.length > 0 && (
          <>
            <div className="section-title">{t('public.completed')}</div>
            <div className="card task-list">
              {done.map(task => <TaskRow key={task.id} task={task} readOnly onToggle={noop} onOpen={noop} />)}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
