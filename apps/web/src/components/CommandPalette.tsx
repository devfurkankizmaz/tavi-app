import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useApp } from '../store'
import { useT } from '../i18n'
import { StatusDot, TaskKey, TypeIcon } from '../ui'
import type { Task } from '../types'

interface Command {
  id: string
  group: 'navigate' | 'actions' | 'tasks' | 'projects'
  label: string
  hint?: string
  icon?: React.ReactNode
  run: () => void
}

/** Loose subsequence match, so "ov" still finds "Overview". */
function fuzzy(haystack: string, needle: string): boolean {
  if (!needle) return true
  const h = haystack.toLocaleLowerCase()
  const n = needle.toLocaleLowerCase()
  if (h.includes(n)) return true
  let i = 0
  for (const ch of h) if (ch === n[i]) i++
  return i === n.length
}

export default function CommandPalette({ open, onClose, onNewProject, onShowShortcuts }: {
  open: boolean
  onClose: () => void
  onNewProject: () => void
  onShowShortcuts: () => void
}) {
  const { projects, cycles } = useApp()
  const t = useT()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [remote, setRemote] = useState<Task[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      setRemote([])
      setTimeout(() => inputRef.current?.focus(), 10)
    }
  }, [open])

  // Task search hits the server, but only past two characters
  useEffect(() => {
    if (!open || query.trim().length < 2) { setRemote([]); return }
    const timer = setTimeout(async () => {
      try {
        setRemote(await api.get<Task[]>(`/api/tasks?q=${encodeURIComponent(query)}&take=6`))
      } catch { setRemote([]) }
    }, 200)
    return () => clearTimeout(timer)
  }, [query, open])

  const commands = useMemo<Command[]>(() => {
    const go = (path: string) => () => { onClose(); navigate(path) }
    const base: Command[] = [
      { id: 'nav-home', group: 'navigate', label: t('nav.overview'), hint: 'G H', run: go('/') },
      { id: 'nav-my', group: 'navigate', label: t('nav.myWork'), hint: 'G M', run: go('/my') },
      { id: 'nav-inbox', group: 'navigate', label: t('nav.inbox'), run: go('/inbox') },
      { id: 'nav-calendar', group: 'navigate', label: t('nav.calendar'), run: go('/calendar') },
      { id: 'nav-cycles', group: 'navigate', label: t('nav.cycles'), hint: 'G C', run: go('/cycles') },
      { id: 'nav-teams', group: 'navigate', label: t('nav.teams'), run: go('/teams') },
      { id: 'nav-labels', group: 'navigate', label: t('nav.labels'), run: go('/labels') },
      { id: 'nav-settings', group: 'navigate', label: t('nav.settings'), run: go('/settings') },
      { id: 'nav-trash', group: 'navigate', label: t('trash.nav'), run: go('/trash') },
      { id: 'act-project', group: 'actions', label: t('cmd.newProject'), run: () => { onClose(); onNewProject() } },
      { id: 'act-cycle', group: 'actions', label: t('cmd.newCycle'), run: go('/cycles') },
      { id: 'act-keys', group: 'actions', label: t('cmd.shortcuts'), hint: '?', run: () => { onClose(); onShowShortcuts() } },
    ]
    const projectCmds: Command[] = projects.filter(p => !p.archived).map(p => ({
      id: `p-${p.id}`,
      group: 'projects',
      label: p.title,
      hint: p.key,
      icon: <span className="swatch" style={{ background: p.color, width: 9, height: 9, borderRadius: 3 }} />,
      run: go(`/projects/${p.id}`),
    }))
    const cycleCmds: Command[] = cycles.filter(c => !c.closedAt).map(c => ({
      id: `c-${c.id}`,
      group: 'navigate',
      label: c.name,
      hint: c.team.name,
      run: go(`/cycles/${c.id}`),
    }))
    return [...base, ...cycleCmds, ...projectCmds]
  }, [projects, cycles, t, navigate, onClose, onNewProject, onShowShortcuts])

  const filtered = useMemo(() => {
    const local = commands.filter(c => fuzzy(`${c.label} ${c.hint ?? ''}`, query))
    const taskCmds: Command[] = remote.map(task => ({
      id: `t-${task.id}`,
      group: 'tasks',
      label: task.title,
      hint: task.project.title,
      icon: <TypeIcon type={task.type} />,
      run: () => { onClose(); navigate(`/projects/${task.projectId}?task=${task.id}`) },
    }))
    return [...local, ...taskCmds]
  }, [commands, query, remote, navigate, onClose])

  useEffect(() => { setActive(0) }, [query, remote.length])

  useEffect(() => {
    listRef.current?.querySelector('.cmd-row.active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  const groups: Command['group'][] = ['navigate', 'actions', 'projects', 'tasks']
  const groupLabel: Record<Command['group'], string> = {
    navigate: t('cmd.navigate'),
    actions: t('cmd.actions'),
    projects: t('nav.projects'),
    tasks: t('cmd.tasks'),
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, filtered.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)) }
    if (e.key === 'Enter') { e.preventDefault(); filtered[active]?.run() }
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  let index = -1
  return (
    <div className="cmd-backdrop" onMouseDown={onClose}>
      <div className="cmd" onMouseDown={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <input
          ref={inputRef}
          className="cmd-input"
          placeholder={t('cmd.placeholder')}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label={t('cmd.placeholder')}
        />
        <div className="cmd-list" ref={listRef}>
          {filtered.length === 0 && <div className="empty" style={{ padding: '1.4rem' }}>{t('cmd.noResults')}</div>}
          {groups.map(group => {
            const items = filtered.filter(c => c.group === group)
            if (!items.length) return null
            return (
              <div key={group}>
                <div className="cmd-group">{groupLabel[group]}</div>
                {items.map(cmd => {
                  index++
                  const i = index
                  return (
                    <button
                      key={cmd.id}
                      className={`cmd-row${i === active ? ' active' : ''}`}
                      onMouseEnter={() => setActive(i)}
                      onClick={cmd.run}
                    >
                      {cmd.icon}
                      <span className="grow">{cmd.label}</span>
                      {cmd.hint && (group === 'projects'
                        ? <TaskKey value={cmd.hint} />
                        : <span className="cmd-hint">{cmd.hint}</span>)}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
