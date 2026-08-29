import type { Label, TaskType, User } from '../types'
import { TYPE_ORDER } from '../types'
import { useT } from '../i18n'
import { usePriorityLabel, useTypeLabel } from '../ui'

export interface Filters {
  q: string
  done: '' | 'false' | 'true'
  priority: string
  type: string
  labelId: string
  assigneeId: string
}

export const emptyFilters: Filters = { q: '', done: 'false', priority: '', type: '', labelId: '', assigneeId: '' }

export default function FilterBar({ filters, onChange, labels, members }: {
  filters: Filters
  onChange: (f: Filters) => void
  labels: Label[]
  members: User[]
}) {
  const t = useT()
  const priorityLabel = usePriorityLabel()
  const typeLabel = useTypeLabel()
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch })
  const dirty = filters.q || filters.priority || filters.type || filters.labelId || filters.assigneeId || filters.done !== 'false'

  return (
    <div className="filterbar">
      <input className="input sm" style={{ width: 208 }} placeholder={t('filter.searchInProject')}
        value={filters.q} onChange={e => set({ q: e.target.value })} />
      <select value={filters.done} onChange={e => set({ done: e.target.value as Filters['done'] })}>
        <option value="false">{t('filter.open')}</option>
        <option value="true">{t('filter.completed')}</option>
        <option value="">{t('common.all')}</option>
      </select>
      <select value={filters.priority} onChange={e => set({ priority: e.target.value })}>
        <option value="">{t('filter.priorityAll')}</option>
        {[1, 2, 3, 4, 5].map(p => (
          <option key={p} value={p}>{t('filter.priorityAtLeast', { label: priorityLabel(p) })}</option>
        ))}
      </select>
      <select value={filters.type} onChange={e => set({ type: e.target.value })}>
        <option value="">{t('type.all')}</option>
        {TYPE_ORDER.map(x => <option key={x} value={x}>{typeLabel(x)}</option>)}
      </select>
      <select value={filters.labelId} onChange={e => set({ labelId: e.target.value })}>
        <option value="">{t('filter.labelAll')}</option>
        {labels.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
      </select>
      <select value={filters.assigneeId} onChange={e => set({ assigneeId: e.target.value })}>
        <option value="">{t('filter.assigneeAll')}</option>
        {members.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
      {dirty && <button className="btn ghost sm" onClick={() => onChange(emptyFilters)}>{t('common.clear')}</button>}
    </div>
  )
}

export function applyFilters<T extends {
  title: string; done: boolean; priority: number; type: TaskType
  labels: { id: string }[]; assignees: { id: string }[]
}>(tasks: T[], f: Filters): T[] {
  return tasks.filter(task => {
    if (f.q && !task.title.toLocaleLowerCase().includes(f.q.toLocaleLowerCase())) return false
    if (f.done === 'false' && task.done) return false
    if (f.done === 'true' && !task.done) return false
    if (f.priority && task.priority < Number(f.priority)) return false
    if (f.type && task.type !== f.type) return false
    if (f.labelId && !task.labels.some(l => l.id === f.labelId)) return false
    if (f.assigneeId && !task.assignees.some(a => a.id === f.assigneeId)) return false
    return true
  })
}
