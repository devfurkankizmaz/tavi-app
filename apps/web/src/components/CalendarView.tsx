import { useCallback, useMemo, useState, type DragEvent } from 'react'
import { useT } from '../i18n'
import { Checkbox, TaskKey, TypeIcon, useFormat } from '../ui'
import type { Task } from '../types'

const DAY = 86_400_000
/** How many tasks a cell draws before the rest become "+N". */
const PER_DAY = 3

interface Props {
  tasks: Task[]
  onOpen: (task: Task) => void
  /** Dragging is off when rescheduling is not allowed. */
  onReschedule?: (task: Task, due: Date) => void
  onToggle?: (task: Task) => void
  /** With several projects in play, bars carry their project's colour. */
  showProject?: boolean
}

/** Local start of day, so time zones do not shift things into the wrong cell. */
const startOfDay = (d: Date | string | number) => {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}
const sameDay = (a: Date, b: Date) => a.getTime() === b.getTime()
const addDays = (d: Date, n: number) => startOfDay(d.getTime() + n * DAY)

/** A 6x7 grid starting on Monday, so every month is the same height. */
function monthGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const weekday = (first.getDay() + 6) % 7
  const start = addDays(startOfDay(first), -weekday)
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

/**
 * Ay takvimi.
 *
 * Work with a due date sits on its day; work with a start date too stretches
 * between the two as a bar, so "how long does this take" is answered at a
 * glance. Dragging something to another day moves its deadline. Undated work
 * takes up no space here; its place is the list.
 */
export default function CalendarView({ tasks, onOpen, onReschedule, onToggle, showProject }: Props) {
  const t = useT()
  const fmt = useFormat()
  const today = useMemo(() => startOfDay(new Date()), [])
  const [anchor, setAnchor] = useState(today)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)

  const days = useMemo(() => monthGrid(anchor), [anchor])
  const month = anchor.getMonth()

  /** What falls on each day: single-day work and the bars crossing it. */
  const byDay = useMemo(() => {
    const map = new Map<number, Task[]>()
    for (const task of tasks) {
      if (!task.dueDate) continue
      const due = startOfDay(task.dueDate)
      const from = task.startDate ? startOfDay(task.startDate) : due
      // A start after the end means the data is wrong; collapse it to one day
      const begin = from.getTime() > due.getTime() ? due : from
      for (let d = begin; d.getTime() <= due.getTime(); d = addDays(d, 1)) {
        const key = d.getTime()
        const list = map.get(key)
        if (list) list.push(task)
        else map.set(key, [task])
        // Do not let an absurdly long task lock up the calendar
        if (map.get(key)!.length > 200) break
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => Number(a.done) - Number(b.done) || b.priority - a.priority)
    }
    return map
  }, [tasks])

  const undated = useMemo(() => tasks.filter(x => !x.dueDate), [tasks])

  /**
   * Unlike the grid, the agenda never repeats a bar: work appears on the day
   * it is due, or a four-day task would fill the list four times.
   */
  const agenda = useMemo(() => {
    const map = new Map<number, Task[]>()
    for (const task of tasks) {
      if (!task.dueDate) continue
      const key = startOfDay(task.dueDate).getTime()
      const list = map.get(key)
      if (list) list.push(task)
      else map.set(key, [task])
    }
    return map
  }, [tasks])

  const drop = useCallback((e: DragEvent, day: Date) => {
    e.preventDefault()
    setDragOver(null)
    const id = e.dataTransfer.getData('text/task-id')
    const task = tasks.find(x => x.id === id)
    if (!task || !onReschedule) return
    // The time of day is kept; only the date moves
    const next = new Date(task.dueDate ?? day)
    next.setFullYear(day.getFullYear(), day.getMonth(), day.getDate())
    if (task.dueDate && sameDay(startOfDay(task.dueDate), day)) return
    onReschedule(task, next)
  }, [tasks, onReschedule])

  const weekdays = useMemo(() => {
    // Weekday headings starting on Monday, independent of the month
    const base = startOfDay(new Date(2024, 0, 1))
    return Array.from({ length: 7 }, (_, i) =>
      addDays(base, i).toLocaleDateString(undefined, { weekday: 'short' }))
  }, [])

  return (
    <div className="calendar">
      <div className="cal-head">
        <button className="icon-btn" aria-label={t('calendar.prev')}
          onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))}>‹</button>
        <h3>{fmt.monthYear(anchor)}</h3>
        <button className="icon-btn" aria-label={t('calendar.next')}
          onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))}>›</button>
        <button className="btn ghost sm" onClick={() => setAnchor(today)}>{t('calendar.today')}</button>
        <span style={{ flex: 1 }} />
        {undated.length > 0 && (
          <span className="chip count">{t('calendar.undated', { count: undated.length })}</span>
        )}
      </div>

      <div className="cal-weekdays">
        {weekdays.map(label => <div key={label}>{label}</div>)}
      </div>

      <div className="cal-grid">
        {days.map(day => {
          const key = day.getTime()
          const items = byDay.get(key) ?? []
          const isToday = sameDay(day, today)
          const outside = day.getMonth() !== month
          const open = expanded === key
          const shown = open ? items : items.slice(0, PER_DAY)

          return (
            <div
              key={key}
              className={`cal-day${outside ? ' outside' : ''}${isToday ? ' today' : ''}${dragOver === key ? ' drag-over' : ''}`}
              onDragOver={onReschedule ? e => { e.preventDefault(); setDragOver(key) } : undefined}
              onDragLeave={onReschedule ? () => setDragOver(null) : undefined}
              onDrop={onReschedule ? e => drop(e, day) : undefined}
            >
              <div className="cal-date">
                <span className="n">{day.getDate()}</span>
                {isToday && <span className="dot" aria-label={t('calendar.today')} />}
              </div>

              <div className="cal-items">
                {shown.map(task => {
                  const due = startOfDay(task.dueDate!)
                  const from = task.startDate ? startOfDay(task.startDate) : due
                  const spans = from.getTime() < due.getTime()
                  const overdue = !task.done && due.getTime() < today.getTime()
                  return (
                    <button
                      key={task.id}
                      className={[
                        'cal-item',
                        task.done ? 'done' : '',
                        overdue ? 'overdue' : '',
                        spans ? (sameDay(day, due) ? 'span-end' : sameDay(day, from) ? 'span-start' : 'span-mid') : '',
                      ].filter(Boolean).join(' ')}
                      style={showProject && task.project ? { borderLeftColor: task.project.color } : undefined}
                      draggable={!!onReschedule}
                      onDragStart={e => e.dataTransfer.setData('text/task-id', task.id)}
                      onClick={() => onOpen(task)}
                      title={`${task.key} · ${task.title}`}
                    >
                      <TypeIcon type={task.type} size={11} />
                      <span className="label">{task.title}</span>
                    </button>
                  )
                })}
                {items.length > PER_DAY && (
                  <button className="cal-more" onClick={() => setExpanded(open ? null : key)}>
                    {open ? t('calendar.less') : t('calendar.more', { count: items.length - PER_DAY })}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* The grid is unreadable on a narrow screen; the month becomes a day-by-day agenda */}
      <div className="cal-agenda">
        {days.filter(d => d.getMonth() === month && (agenda.get(d.getTime()) ?? []).length > 0).map(day => (
          <section key={day.getTime()}>
            <div className={`cal-agenda-day${sameDay(day, today) ? ' today' : ''}`}>
              {day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
            </div>
            {(agenda.get(day.getTime()) ?? []).map(task => (
              <div key={task.id} className="cal-agenda-item" onClick={() => onOpen(task)}>
                {onToggle && <Checkbox on={task.done} onToggle={() => onToggle(task)} />}
                <TypeIcon type={task.type} />
                <TaskKey value={task.key} />
                <span className="label">{task.title}</span>
              </div>
            ))}
          </section>
        ))}
        {days.every(d => d.getMonth() !== month || (agenda.get(d.getTime()) ?? []).length === 0) && (
          <div className="empty">{t('calendar.emptyMonth')}</div>
        )}
      </div>
    </div>
  )
}
