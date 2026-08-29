import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useApp } from '../store'
import { useT } from '../i18n'
import { EmptyState, Modal, useAction, useFormat } from '../ui'
import type { Cycle } from '../types'

const DAY = 86400_000
const iso = (d: Date) => d.toISOString()

/** Defaults to a two-week cycle starting today. */
function defaultRange() {
  const start = new Date()
  start.setHours(9, 0, 0, 0)
  const end = new Date(start.getTime() + 13 * DAY)
  end.setHours(18, 0, 0, 0)
  return { start, end }
}

export function cycleState(cycle: Cycle): 'active' | 'upcoming' | 'closed' {
  if (cycle.closedAt || Date.parse(cycle.endsAt) < Date.now()) return 'closed'
  if (Date.parse(cycle.startsAt) > Date.now()) return 'upcoming'
  return 'active'
}

export default function Cycles() {
  const { teams } = useApp()
  const t = useT()
  const fmt = useFormat()
  const run = useAction()
  const [cycles, setCycles] = useState<Cycle[]>([])
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState(() => {
    const { start, end } = defaultRange()
    return { name: '', goal: '', teamId: '', startsAt: iso(start), endsAt: iso(end) }
  })

  const load = async () => setCycles(await api.get<Cycle[]>('/api/cycles'))
  useEffect(() => { void load() }, [])

  useEffect(() => {
    if (teams.length && !form.teamId) setForm(f => ({ ...f, teamId: teams[0].id }))
  }, [teams, form.teamId])

  const create = async () => {
    if (!form.name.trim() || !form.teamId) return
    const ok = await run(
      () => api.post(`/api/teams/${form.teamId}/cycles`, {
        name: form.name.trim(), goal: form.goal.trim(), startsAt: form.startsAt, endsAt: form.endsAt,
      }),
      t('cycle.created'),
    )
    if (ok) {
      setCreating(false)
      setForm(f => ({ ...f, name: '', goal: '' }))
      await load()
    }
  }

  const groups: { key: 'active' | 'upcoming' | 'closed'; items: Cycle[] }[] = [
    { key: 'active', items: cycles.filter(c => cycleState(c) === 'active') },
    { key: 'upcoming', items: cycles.filter(c => cycleState(c) === 'upcoming') },
    { key: 'closed', items: cycles.filter(c => cycleState(c) === 'closed') },
  ]

  return (
    <div className="content-inner">
      <div className="page-head">
        <h2>{t('cycle.title')}</h2>
        <button className="btn primary" onClick={() => setCreating(true)} disabled={!teams.length}>
          + {t('cycle.new')}
        </button>
      </div>

      {!teams.length && (
        <EmptyState illustrated title={t('empty.cycles')} body={t('cycle.needTeam')}
          action={<Link className="btn primary" to="/teams">{t('teams.new')}</Link>} />
      )}
      {teams.length > 0 && cycles.length === 0 && (
        <EmptyState illustrated title={t('empty.cycles')} body={t('cycle.empty')}
          action={<button className="btn primary" onClick={() => setCreating(true)}>{t('cycle.new')}</button>} />
      )}

      {groups.map(group => group.items.length > 0 && (
        <section key={group.key}>
          <div className="section-title">{t(`cycle.${group.key}` as 'cycle.active')}</div>
          <div className="cycle-grid">
            {group.items.map(cycle => {
              const daysLeft = Math.ceil((Date.parse(cycle.endsAt) - Date.now()) / DAY)
              const pct = cycle.summary.total
                ? Math.round((cycle.summary.done / cycle.summary.total) * 100)
                : 0
              return (
                <Link key={cycle.id} to={`/cycles/${cycle.id}`} className="cycle-card">
                  <div className="cycle-card-head">
                    <span className="name">{cycle.name}</span>
                    <span className="chip count">{cycle.team.name}</span>
                  </div>
                  {cycle.goal && <p className="goal">{cycle.goal}</p>}
                  <div className="range">
                    {fmt.date(cycle.startsAt)} – {fmt.date(cycle.endsAt)}
                    {group.key === 'active' && daysLeft >= 0 && ` · ${t('cycle.daysLeft', { count: daysLeft })}`}
                  </div>
                  <div className="progress"><div style={{ width: `${pct}%` }} /></div>
                  <div className="range">
                    {t('cycle.progress', { done: cycle.summary.done, total: cycle.summary.total })}
                    {cycle.summary.points > 0 && ` · ${t('cycle.points', { done: cycle.summary.donePoints, total: cycle.summary.points })}`}
                  </div>
                </Link>
              )
            })}
          </div>
        </section>
      ))}

      {creating && (
        <Modal title={t('cycle.new')} onClose={() => setCreating(false)}>
          <div className="field">
            <label>{t('cycle.name')}</label>
            <input className="input" autoFocus value={form.name}
              placeholder="Sprint 12" onChange={e => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field">
            <label>{t('cycle.goal')}</label>
            <input className="input" value={form.goal} placeholder={t('cycle.goalPlaceholder')}
              onChange={e => setForm({ ...form, goal: e.target.value })} />
          </div>
          <div className="field">
            <label>{t('cycle.team')}</label>
            <select className="select" value={form.teamId} onChange={e => setForm({ ...form, teamId: e.target.value })}>
              {teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <div className="field" style={{ flex: 1 }}>
              <label>{t('cycle.start')}</label>
              <input className="input" type="date" value={form.startsAt.slice(0, 10)}
                onChange={e => setForm({ ...form, startsAt: iso(new Date(`${e.target.value}T09:00`)) })} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>{t('cycle.end')}</label>
              <input className="input" type="date" value={form.endsAt.slice(0, 10)}
                onChange={e => setForm({ ...form, endsAt: iso(new Date(`${e.target.value}T18:00`)) })} />
            </div>
          </div>
          <div className="actions">
            <button className="btn ghost" onClick={() => setCreating(false)}>{t('common.cancel')}</button>
            <button className="btn primary" onClick={create}>{t('common.create')}</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
