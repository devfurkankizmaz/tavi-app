import { useMemo } from 'react'
import type { Task } from '../types'
import { useT } from '../i18n'
import { TypeIcon, useFormat } from '../ui'

const DAY = 86400_000
const PX_PER_DAY = 26

export default function GanttView({ tasks, onOpen }: { tasks: Task[]; onOpen: (task: Task) => void }) {
  const t = useT()
  const fmt = useFormat()
  const dated = tasks.filter(task => task.dueDate || task.startDate)

  const { start, days, months } = useMemo(() => {
    const times = dated.flatMap(task => [
      task.startDate ? Date.parse(task.startDate) : null,
      task.dueDate ? Date.parse(task.dueDate) : null,
    ]).filter((x): x is number => x !== null)
    const now = Date.now()
    const min = Math.min(...(times.length ? times : [now]), now) - 3 * DAY
    const max = Math.max(...(times.length ? times : [now]), now) + 7 * DAY
    const from = new Date(min)
    from.setHours(0, 0, 0, 0)
    const total = Math.ceil((max - from.getTime()) / DAY)
    const buckets: { at: Date; days: number }[] = []
    const cursor = new Date(from)
    let remaining = total
    while (remaining > 0) {
      const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
      const inMonth = Math.min(remaining, Math.round((monthEnd.getTime() - cursor.getTime()) / DAY))
      buckets.push({ at: new Date(cursor), days: inMonth })
      cursor.setTime(monthEnd.getTime())
      remaining -= inMonth
    }
    return { start: from.getTime(), days: total, months: buckets }
  }, [dated])

  if (!dated.length) {
    return <div className="card"><div className="empty">{t('gantt.empty')}</div></div>
  }

  const todayX = ((Date.now() - start) / DAY) * PX_PER_DAY

  return (
    <div className="card gantt">
      <div className="gantt-grid" style={{ width: 220 + days * PX_PER_DAY }}>
        <div className="gantt-months">
          {months.map((m, i) => (
            <div key={i} className="gantt-month" style={{ width: m.days * PX_PER_DAY }}>{fmt.monthYear(m.at)}</div>
          ))}
        </div>
        <div style={{ position: 'relative' }}>
          <div className="gantt-today" style={{ left: 220 + todayX }} />
          {dated.map(task => {
            const from = task.startDate ? Date.parse(task.startDate) : Date.parse(task.dueDate!) - DAY
            const to = task.dueDate ? Date.parse(task.dueDate) : from + DAY
            const left = Math.max(0, ((from - start) / DAY) * PX_PER_DAY)
            const width = Math.max(10, ((to - from) / DAY) * PX_PER_DAY)
            return (
              <div key={task.id} className="gantt-row">
                <div className="gantt-label" onClick={() => onOpen(task)} title={task.title}>
                  <TypeIcon type={task.type} /> #{task.number} {task.title}
                </div>
                <div className="gantt-track">
                  <div
                    className={`gantt-bar${task.done ? ' done' : ''}`}
                    style={{ left, width, background: task.color ?? undefined }}
                    onClick={() => onOpen(task)}
                    title={`${task.title} · ${fmt.date(new Date(from))} – ${fmt.date(new Date(to))}`}
                  >
                    {width > 62 ? task.title : ''}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
