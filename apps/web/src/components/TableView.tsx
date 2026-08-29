import { useMemo, useState } from 'react'
import type { Task } from '../types'
import { TYPE_ORDER } from '../types'
import { useT } from '../i18n'
import { AvatarStack, Checkbox, DueChip, LabelChip, PriorityChip, TypeIcon } from '../ui'

type SortKey = 'number' | 'title' | 'type' | 'priority' | 'dueDate' | 'percentDone' | 'done'

export default function TableView({ tasks, onOpen, onToggle }: {
  tasks: Task[]
  onOpen: (task: Task) => void
  onToggle: (task: Task) => void
}) {
  const t = useT()
  const [sortKey, setSortKey] = useState<SortKey>('number')
  const [asc, setAsc] = useState(true)

  const sorted = useMemo(() => {
    const arr = [...tasks]
    arr.sort((a, b) => {
      let va: number | string, vb: number | string
      switch (sortKey) {
        case 'title': va = a.title.toLocaleLowerCase(); vb = b.title.toLocaleLowerCase(); break
        case 'type': va = TYPE_ORDER.indexOf(a.type); vb = TYPE_ORDER.indexOf(b.type); break
        case 'priority': va = a.priority; vb = b.priority; break
        case 'dueDate': va = a.dueDate ? Date.parse(a.dueDate) : Infinity; vb = b.dueDate ? Date.parse(b.dueDate) : Infinity; break
        case 'percentDone': va = a.percentDone; vb = b.percentDone; break
        case 'done': va = a.done ? 1 : 0; vb = b.done ? 1 : 0; break
        default: va = a.number; vb = b.number
      }
      const cmp = va < vb ? -1 : va > vb ? 1 : 0
      return asc ? cmp : -cmp
    })
    return arr
  }, [tasks, sortKey, asc])

  const header = (key: SortKey, label: string) => (
    <th onClick={() => { if (sortKey === key) setAsc(a => !a); else { setSortKey(key); setAsc(true) } }}>
      {label}{sortKey === key ? (asc ? ' ↑' : ' ↓') : ''}
    </th>
  )

  return (
    <div className="card tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            {header('done', '✓')}
            {header('type', t('type.label'))}
            {header('number', '#')}
            {header('title', t('table.title'))}
            <th style={{ cursor: 'default' }}>{t('table.assignees')}</th>
            <th style={{ cursor: 'default' }}>{t('table.labels')}</th>
            {header('priority', t('table.priority'))}
            {header('dueDate', t('table.due'))}
            {header('percentDone', t('table.progress'))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(task => (
            <tr key={task.id} onClick={() => onOpen(task)}>
              <td onClick={e => e.stopPropagation()}><Checkbox on={task.done} onToggle={() => onToggle(task)} /></td>
              <td><TypeIcon type={task.type} /></td>
              <td style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>#{task.number}</td>
              <td className="title-cell" style={task.done ? { textDecoration: 'line-through', color: 'var(--muted)' } : undefined}>
                {task.title}
              </td>
              <td><AvatarStack users={task.assignees} size={22} /></td>
              <td>{task.labels.slice(0, 3).map(l => <LabelChip key={l.id} label={l} />)}</td>
              <td><PriorityChip priority={task.priority} /></td>
              <td><DueChip dueDate={task.dueDate} done={task.done} /></td>
              <td style={{ minWidth: 92 }}>
                <div className="progress"><div style={{ width: `${task.percentDone}%` }} /></div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length === 0 && <div className="empty">{t('table.noTasks')}</div>}
    </div>
  )
}
