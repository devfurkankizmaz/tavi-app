import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useApp } from '../store'
import { useT } from '../i18n'
import { useAction, useFormat, useToast } from '../ui'
import { useCompletion } from '../completion'
import CalendarView from '../components/CalendarView'
import type { Task } from '../types'

/**
 * One calendar across every project. Same component as the project tab;
 * the difference is that bars carry their project's colour here.
 */
export default function Calendar() {
  const { refreshProjects } = useApp()
  const t = useT()
  const run = useAction()
  const toast = useToast()
  const fmt = useFormat()
  const navigate = useNavigate()
  const completion = useCompletion()
  const [tasks, setTasks] = useState<Task[]>([])

  const load = useCallback(async () => {
    // Completed work stays visible: on a calendar, the past is the story
    setTasks(await api.get<Task[]>('/api/tasks?take=500'))
  }, [])
  useEffect(() => { void load() }, [load])

  const toggle = (task: Task) => void completion.toggle(task, {
    optimistic: done => setTasks(list => list.map(x => (x.id === task.id ? { ...x, done } : x))),
    reload: async () => { await load(); await refreshProjects() },
  })

  const reschedule = (task: Task, due: Date) => {
    const previous = task.dueDate
    void run(async () => {
      await api.patch(`/api/tasks/${task.id}`, { dueDate: due.toISOString() })
      await load()
      toast(t('calendar.rescheduled', { key: task.key, date: fmt.date(due) }), 'ok', {
        label: t('common.undo'),
        run: () => void run(async () => {
          await api.patch(`/api/tasks/${task.id}`, { dueDate: previous })
          await load()
        }),
      })
    })
  }

  return (
    <div className="content-inner wide">
      <div className="page-head"><h2>{t('calendar.title')}</h2></div>
      <CalendarView
        tasks={tasks}
        showProject
        onOpen={task => navigate(`/projects/${task.projectId}?task=${task.id}`)}
        onToggle={toggle}
        onReschedule={reschedule}
      />
    </div>
  )
}
