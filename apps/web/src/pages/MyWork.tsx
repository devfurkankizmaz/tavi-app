import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useApp } from '../store'
import { useT } from '../i18n'
import { EmptyState, useAction } from '../ui'
import type { Task } from '../types'
import TaskRow from '../components/TaskRow'
import { useCompletion } from '../completion'

type Scope = 'assigned' | 'watching' | 'created'
const SCOPES: Scope[] = ['assigned', 'watching', 'created']

const DAY = 86400_000
const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime() }

/** Groups tasks by horizon: overdue, today, this week, later, undated. */
function bucketize(tasks: Task[]) {
  const today = endOfToday()
  const week = today + 6 * DAY
  const groups = { overdue: [] as Task[], today: [] as Task[], week: [] as Task[], later: [] as Task[], none: [] as Task[] }
  for (const task of tasks) {
    if (!task.dueDate) { groups.none.push(task); continue }
    const due = Date.parse(task.dueDate)
    if (due < Date.now()) groups.overdue.push(task)
    else if (due <= today) groups.today.push(task)
    else if (due <= week) groups.week.push(task)
    else groups.later.push(task)
  }
  return groups
}

export default function MyWork() {
  const { me, refreshProjects } = useApp()
  const t = useT()
  const run = useAction()
  const navigate = useNavigate()
  const [scope, setScope] = useState<Scope>('assigned')
  const [tasks, setTasks] = useState<Task[]>([])

  const query = useMemo(() => {
    if (scope === 'watching') return 'watching=true&done=false&take=200'
    if (scope === 'created') return `done=false&take=200`
    return 'assignee=me&done=false&take=200'
  }, [scope])

  const load = useCallback(async () => {
    const all = await api.get<Task[]>(`/api/tasks?${query}`)
    // "Created by me" needs no server filter; narrowing on the client is enough
    setTasks(scope === 'created' ? all.filter(x => x.assignees.every(a => a.id !== me.id)) : all)
  }, [query, scope, me.id])

  useEffect(() => { void load() }, [load])

  const completion = useCompletion()
  const toggle = (task: Task) => void completion.toggle(task, {
    optimistic: done => setTasks(list => list.map(x => (x.id === task.id ? { ...x, done } : x))),
    reload: async () => { await load(); await refreshProjects() },
  })

  const open = (task: Task) => navigate(`/projects/${task.projectId}?task=${task.id}`)
  const groups = bucketize(tasks)
  const overdueCount = groups.overdue.length

  const section = (titleKey: Parameters<typeof t>[0], items: Task[], danger?: boolean) => {
    if (!items.length) return null
    return (
      <section key={titleKey}>
        <div className="section-title" style={danger ? { color: 'var(--danger)' } : undefined}>
          {t(titleKey)} <span className="chip count">{items.length}</span>
        </div>
        <div className="card task-list">
          {items.map(task => (
            <TaskRow key={task.id} task={task} showProject showStatus leaving={completion.leaving.has(task.id)}
              onToggle={toggle} onOpen={open} />
          ))}
        </div>
      </section>
    )
  }

  return (
    <div className="content-inner">
      <div className="page-head">
        <h2>{t('my.title')}</h2>
        <div className="segmented">
          {SCOPES.map(s => (
            <button key={s} className={scope === s ? 'active' : ''} onClick={() => setScope(s)}>
              {t(`my.${s}` as 'my.assigned')}
            </button>
          ))}
        </div>
      </div>

      <p className="lead">{t('my.summary', { open: tasks.length, overdue: overdueCount })}</p>

      {tasks.length === 0 && (
        <EmptyState
          illustrated
          title={scope === 'watching' ? t('empty.watching') : t('empty.myWork')}
          body={scope === 'watching' ? t('my.watchingEmpty') : t('my.empty')}
        />
      )}

      {section('my.overdue', groups.overdue, true)}
      {section('my.today', groups.today)}
      {section('my.thisWeek', groups.week)}
      {section('my.later', groups.later)}
      {section('my.noDate', groups.none)}
    </div>
  )
}
