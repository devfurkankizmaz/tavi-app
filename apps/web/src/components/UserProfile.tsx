import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useApp } from '../store'
import { useT } from '../i18n'
import { Avatar, CloseIcon, DueChip, PriorityChip, StatusPill, TaskKey, TypeIcon, useFormat, useStatusLabel } from '../ui'
import type { ActivityItem, ProjectSummary, Task, TaskStatus, User } from '../types'

interface Profile {
  user: User & { createdAt: string }
  isMe: boolean
  openTasks: Task[]
  doneCount: number
  projects: Pick<ProjectSummary, 'id' | 'key' | 'title' | 'color'>[]
  teams: { id: string; name: string }[]
  activity: (ActivityItem & { task: { id: string; projectId: string; title: string; key: string } | null })[]
}

/** The panel that opens when you click a teammate. */
export default function UserProfile({ userId, onClose }: { userId: string; onClose: () => void }) {
  const { me } = useApp()
  const t = useT()
  const fmt = useFormat()
  const statusLabel = useStatusLabel()
  const navigate = useNavigate()
  const [profile, setProfile] = useState<Profile | null>(null)

  useEffect(() => {
    setProfile(null)
    api.get<Profile>(`/api/users/${userId}`).then(setProfile).catch(() => onClose())
  }, [userId, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
      if (e.key === 'Escape' && !typing) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!profile) return null
  const { user } = profile

  const openTask = (task: { id: string; projectId: string }) => {
    onClose()
    navigate(`/projects/${task.projectId}?task=${task.id}`)
  }

  const describe = (item: Profile['activity'][number]) => {
    const meta = item.meta ?? {}
    const asStatus = (v: unknown) =>
      typeof v === 'string' && ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'].includes(v)
        ? statusLabel(v as TaskStatus)
        : String(v ?? '')
    return t(`act.${item.kind}` as 'act.created', {
      from: asStatus(meta.from),
      to: asStatus(meta.to),
      userName: meta.userName ?? '',
      fileName: meta.fileName ?? '',
    })
  }

  return (
    <>
      <div className="panel-backdrop" onMouseDown={onClose} />
      <aside className="task-panel" role="dialog" aria-modal="true" aria-label={user.name}>
        <div className="task-panel-head">
          <b style={{ fontSize: 'var(--t-sub)' }}>{t('profile.title')}</b>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}><CloseIcon /></button>
        </div>

        <div className="task-panel-body">
          <header className="profile-head">
            <Avatar user={user} size={64} static />
            <div>
              <h3 className="profile-name">
                {user.name}{profile.isMe && <span className="chip count">{t('common.you')}</span>}
              </h3>
              <a className="profile-mail" href={`mailto:${user.email}`}>{user.email}</a>
              <div className="hint">{t('profile.joined', { when: fmt.date(user.createdAt) })}</div>
            </div>
          </header>

          <div className="profile-stats">
            <div><b>{profile.openTasks.length}</b><span>{t('profile.open')}</span></div>
            <div><b>{profile.doneCount}</b><span>{t('profile.done')}</span></div>
            <div><b>{profile.projects.length}</b><span>{t('nav.projects')}</span></div>
            <div><b>{profile.teams.length}</b><span>{t('nav.teams')}</span></div>
          </div>

          {profile.teams.length > 0 && (
            <>
              <div className="subhead">{t('profile.sharedTeams')}</div>
              <div className="chip-row">
                {profile.teams.map(team => (
                  <Link key={team.id} className="chip count" to="/teams" onClick={onClose}>{team.name}</Link>
                ))}
              </div>
            </>
          )}

          {profile.projects.length > 0 && (
            <>
              <div className="subhead">{t('profile.sharedProjects')}</div>
              <div className="chip-row">
                {profile.projects.map(project => (
                  <Link key={project.id} className="chip count" to={`/projects/${project.id}`} onClick={onClose}>
                    <span className="swatch" style={{ background: project.color, width: 8, height: 8, borderRadius: 3 }} />
                    {project.title}
                  </Link>
                ))}
              </div>
            </>
          )}

          <div className="subhead">
            {profile.isMe ? t('my.assigned') : t('profile.working')}
            <span className="chip count">{profile.openTasks.length}</span>
          </div>
          {profile.openTasks.length === 0 && <p className="hint">{t('profile.noOpen')}</p>}
          {profile.openTasks.map(task => (
            <div key={task.id} className="doc-task" onClick={() => openTask(task)}>
              <TypeIcon type={task.type} />
              <TaskKey value={task.key} />
              <StatusPill status={task.status} />
              <span className="grow">{task.title}</span>
              <PriorityChip priority={task.priority} />
              <DueChip dueDate={task.dueDate} done={task.done} />
            </div>
          ))}

          <div className="subhead">{t('task.activity')}</div>
          {profile.activity.length === 0 && <p className="hint">{t('task.noActivity')}</p>}
          <ol className="activity">
            {profile.activity.map(item => (
              <li key={item.id}>
                <span className="dot" aria-hidden />
                <span className="what">
                  {describe(item)}
                  {item.task && (
                    <>
                      {' · '}
                      <a onClick={() => openTask(item.task!)} style={{ cursor: 'pointer' }}>{item.task.key}</a>
                    </>
                  )}
                </span>
                <span className="when">{fmt.timeAgo(item.createdAt)}</span>
              </li>
            ))}
          </ol>

          {profile.isMe && (
            <div style={{ marginTop: '1.4rem' }}>
              <Link className="btn" to="/settings" onClick={onClose}>{t('nav.settings')}</Link>
            </div>
          )}
          {!profile.isMe && me.id !== user.id && (
            <div style={{ marginTop: '1.4rem' }}>
              <a className="btn" href={`mailto:${user.email}`}>{t('profile.email')}</a>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
