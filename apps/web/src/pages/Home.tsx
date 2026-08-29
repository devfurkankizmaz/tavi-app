import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useApp } from '../store'
import { useT } from '../i18n'
import { Avatar, Mascot, Star, TaskKey, TypeIcon, useAction, useFormat, useStatusLabel } from '../ui'
import { MOD } from '../components/Shortcuts'
import type { Task, User, TaskStatus, TaskType } from '../types'
import { STATUS_ORDER } from '../types'

const DAY = 86_400_000

/** One row from /api/activity. */
interface ActivityFeedItem {
  id: string
  kind: string
  meta: Record<string, unknown>
  actor: User | null
  createdAt: string
  task: {
    id: string
    projectId: string
    projectTitle: string
    title: string
    type: TaskType
    status: TaskStatus
    key: string
  } | null
}

export default function Home() {
  const { me, projects, teams, cycles, invites, refreshProjects, refreshInbox, refreshTeams, openNewProject } = useApp()
  const t = useT()
  const run = useAction()
  const fmt = useFormat()
  const statusLabel = useStatusLabel()
  const navigate = useNavigate()
  /*
   * Overview is not a task list, it is the shape of the workspace. Your own
   * queue lives in My work, events in Inbox; here you see where the team is.
   * The counts stay, but clicking them takes you to your own queue.
   */
  const [counts, setCounts] = useState({ open: 0, overdue: 0 })
  const [activity, setActivity] = useState<ActivityFeedItem[]>([])

  const load = useCallback(async () => {
    const [open, feed] = await Promise.all([
      api.get<Task[]>('/api/tasks?assignee=me&done=false&take=200'),
      api.get<ActivityFeedItem[]>('/api/activity?take=12'),
    ])
    const nowMs = Date.now()
    setCounts({
      open: open.length,
      overdue: open.filter(x => x.dueDate && Date.parse(x.dueDate) < nowMs).length,
    })
    setActivity(feed)
  }, [])
  useEffect(() => { void load() }, [load])

  const answerInvite = (id: string, accept: boolean) =>
    void run(async () => {
      await api.post(`/api/invites/${id}/${accept ? 'accept' : 'decline'}`)
      await Promise.all([refreshInbox(), refreshProjects(), refreshTeams()])
    }, accept ? t('home.acceptedToast') : t('home.declinedToast'))

  const toggleFav = (projectId: string, on: boolean) =>
    void run(async () => {
      if (on) await api.del(`/api/favorites/project/${projectId}`)
      else await api.post('/api/favorites', { kind: 'project', targetId: projectId })
      await refreshProjects()
    })

  /**
   * Turns an activity kind into one clause. Status changes print the label
   * a person sees rather than the raw enum: "Done", not "DONE".
   */
  const activityText = (item: ActivityFeedItem) => {
    const meta = (item.meta ?? {}) as { from?: unknown; to?: unknown }
    const label = (value: unknown) => {
      if (typeof value !== 'string' || !value) return ''
      return STATUS_ORDER.includes(value as TaskStatus) ? statusLabel(value as TaskStatus) : value
    }
    return t(`act.${item.kind}` as 'act.created', { from: label(meta.from), to: label(meta.to) })
  }

  const now = Date.now()
  const active = projects.filter(p => !p.archived)
  const openCycles = cycles.filter(c => !c.closedAt).slice(0, 3)
  const firstName = me.name.split(' ')[0]

  // First run: with no projects, show the setup tour instead
  if (active.length === 0 && invites.length === 0) {
    return (
      <div className="content-inner">
        <section className="welcome">
          <Mascot size={148} />
          <h2>{t('home.welcomeTitle', { name: firstName })}</h2>
          <p>{t('home.welcomeBody', { key: `${MOD} K` })}</p>
          <div className="welcome-actions">
            <button className="btn primary" onClick={openNewProject}>{t('home.startProject')}</button>
            <Link className="btn" to="/teams">{t('home.startTeam')}</Link>
          </div>

          <div className="welcome-tour">
            <article><b>{t('home.tourTasks')}</b><span>{t('home.tourTasksBody')}</span></article>
            <article><b>{t('home.tourCycles')}</b><span>{t('home.tourCyclesBody')}</span></article>
            <article><b>{t('home.tourTeam')}</b><span>{t('home.tourTeamBody')}</span></article>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="content-inner">
      <header className="hello">
        <Mascot size={92} />
        <div>
          {/* This is the team's home, not one person's: say which workspace first */}
          <Link className="workspace" to="/teams">
            {teams.length === 0
              ? t('home.noWorkspace')
              : teams.length === 1 ? teams[0].name : t('home.workspaces', { count: teams.length })}
          </Link>
          <h2 className="greeting">{t('home.greeting', { name: firstName })}</h2>
          <p className="lead" style={{ margin: 0 }}>
            <Link to="/my" className="stat-link">
              {t('my.summary', { open: counts.open, overdue: counts.overdue })}
            </Link>
            {` · ${t('home.projectsCount', { count: active.length })}`}
          </p>
        </div>
      </header>

      {invites.length > 0 && (
        <>
          <div className="section-title">{t('home.invites')}</div>
          {invites.map(invite => (
            <div key={invite.id} className="invite-card">
              <div className="grow">
                {invite.kind === 'team'
                  ? t('home.inviteTeam', { team: invite.team?.name ?? '' })
                  : t('home.inviteProject', { project: invite.project?.title ?? '' })}
                <div className="sub">{t('home.inviteFrom', { name: invite.inviter?.name ?? '' })}</div>
              </div>
              <button className="btn primary sm" onClick={() => answerInvite(invite.id, true)}>{t('home.accept')}</button>
              <button className="btn ghost sm" onClick={() => answerInvite(invite.id, false)}>{t('home.decline')}</button>
            </div>
          ))}
        </>
      )}

      <div className="section-title">{t('nav.projects')}</div>
      {active.length === 0
        ? <div className="empty">{t('home.noProjects')}</div>
        : (
          <div className="project-grid">
            {active.map(project => (
              <Link key={project.id} to={`/projects/${project.id}`} className="project-card">
                <span className="fav" onClick={e => { e.preventDefault(); toggleFav(project.id, project.isFavorite) }}>
                  <Star on={project.isFavorite} onToggle={() => toggleFav(project.id, project.isFavorite)} />
                </span>
                <div className="swatch" style={{ background: project.color }} />
                <div className="name">{project.title}</div>
                <div className="sub">{t('home.openTasks', { count: project.openTasks })}</div>
              </Link>
            ))}
          </div>
        )}

      {openCycles.length > 0 && (
        <>
          <div className="section-title">{t('home.cycles')}</div>
          <div className="cycle-strip">
            {openCycles.map(cycle => {
              const total = cycle.summary.total || 1
              const done = cycle.summary.done
              const days = Math.ceil((Date.parse(cycle.endsAt) - now) / DAY)
              return (
                <Link key={cycle.id} to={`/cycles/${cycle.id}`} className="cycle-chip">
                  <div className="head">
                    <b>{cycle.name}</b>
                    <span className="team">{cycle.team.name}</span>
                  </div>
                  <div className="bar"><span style={{ width: `${Math.round((done / total) * 100)}%` }} /></div>
                  <div className="sub">
                    {t('home.cycleProgress', { done, total })}
                    {' · '}
                    {days >= 0 ? t('cycle.daysLeft', { count: days }) : t('cycle.ended')}
                  </div>
                </Link>
              )
            })}
          </div>
        </>
      )}

      {activity.length > 0 && (
        <>
          <div className="section-title">{t('home.activity')}</div>
          <div className="card feed">
            {activity.map(item => (
              <div
                key={item.id}
                className={`feed-row${item.task ? '' : ' flat'}`}
                onClick={() => item.task && navigate(`/projects/${item.task.projectId}?task=${item.task.id}`)}
              >
                {item.actor && <Avatar user={item.actor} size={22} static />}
                <span className="what">
                  <b>{item.actor?.name ?? t('inbox.someone')}</b> {activityText(item)}
                </span>
                {item.task && (
                  <>
                    <TypeIcon type={item.task.type} />
                    <TaskKey value={item.task.key} />
                    <span className="title">{item.task.title}</span>
                  </>
                )}
                <span className="when">{fmt.timeAgo(item.createdAt)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
