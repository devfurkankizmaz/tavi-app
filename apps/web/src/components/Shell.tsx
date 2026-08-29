import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useApp } from '../store'
import { useT } from '../i18n'
import {
  Avatar, BellIcon, BrandMark, Modal, Popover, TaskKey, TypeIcon,
  useAction, useFormat, useTypeLabel,
} from '../ui'
import type { Task, Notification, TaskType } from '../types'
import { TYPE_ORDER } from '../types'
import { Snippet, isEmpty, type SearchResults } from '../search'
import CommandPalette from './CommandPalette'
import { ShortcutsHelp, useShortcuts, MOD } from './Shortcuts'
import MobileNav from './MobileNav'
import UserProfile from './UserProfile'
import Assistant from './Assistant'

export default function Shell({ children }: { children: ReactNode }) {
  const {
    me, projects, cycles, invites, unread,
    refreshProjects, refreshInbox, refreshTeams,
    newProjectOpen, openNewProject, closeNewProject,
    profileUserId, closeProfile,
  } = useApp()
  const t = useT()
  const run = useAction()
  const navigate = useNavigate()
  const location = useLocation()

  const [title, setTitle] = useState('')
  const [quickTask, setQuickTask] = useState(false)
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults | null>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout>>()
  const searchInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    clearTimeout(searchTimer.current)
    if (!query.trim()) { setResults(null); return }
    searchTimer.current = setTimeout(async () => {
      setResults(await api.get<SearchResults>(`/api/search?q=${encodeURIComponent(query)}&limit=4`))
    }, 250)
  }, [query])

  useShortcuts({
    openPalette: useCallback(() => setPalette(true), []),
    focusSearch: useCallback(() => searchInput.current?.focus(), []),
    newTask: useCallback(() => setQuickTask(true), []),
    showHelp: useCallback(() => setHelp(true), []),
  })

  const createProject = async () => {
    const value = title.trim()
    if (!value) return
    let created: { id: string } | null = null
    const ok = await run(async () => { created = await api.post<{ id: string }>('/api/projects', { title: value }) })
    if (ok && created) {
      setTitle('')
      closeNewProject()
      await refreshProjects()
      navigate(`/projects/${(created as { id: string }).id}`)
    }
  }

  const visible = projects.filter(p => showArchived || !p.archived)
  const favorites = visible.filter(p => p.isFavorite)
  const activeCycles = cycles.filter(c => !c.closedAt && Date.parse(c.startsAt) <= Date.now())

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <BrandMark size={44} />
          <span className="wordmark">Tavi</span>
        </div>

        <NavLink to="/" end className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          {t('nav.overview')}
        </NavLink>
        <NavLink to="/my" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          {t('nav.myWork')}
        </NavLink>
        <NavLink to="/inbox" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          <span className="grow">{t('nav.inbox')}</span>
          {unread > 0 && <span className="chip count">{unread}</span>}
        </NavLink>
        <NavLink to="/calendar" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          <span className="grow">{t('nav.calendar')}</span>
        </NavLink>
        <NavLink to="/cycles" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          <span className="grow">{t('nav.cycles')}</span>
          {activeCycles.length > 0 && <span className="count">{activeCycles.length}</span>}
        </NavLink>
        <NavLink to="/teams" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          <span className="grow">{t('nav.teams')}</span>
          {invites.length > 0 && (
            <span className="count accent">{invites.length}</span>
          )}
        </NavLink>
        <NavLink to="/labels" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          {t('nav.labels')}
        </NavLink>

        {favorites.length > 0 && (
          <>
            <div className="nav-section"><span>{t('nav.favorites')}</span></div>
            {favorites.map(p => (
              <NavLink key={`fav-${p.id}`} to={`/projects/${p.id}`}
                className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
                <span className="swatch" style={{ background: p.color }} />
                <span className="grow">{p.title}</span>
              </NavLink>
            ))}
          </>
        )}

        <div className="nav-section">
          <span>{t('nav.projects')}</span>
          <button
            onClick={() => setShowArchived(a => !a)}
            title={showArchived ? t('nav.hideArchived') : t('nav.showArchived')}
            aria-label={showArchived ? t('nav.hideArchived') : t('nav.showArchived')}
          >
            {showArchived ? '▾' : '▸'}
          </button>
        </div>
        {visible.map(p => (
          <NavLink key={p.id} to={`/projects/${p.id}`}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            style={p.archived ? { opacity: 0.55 } : undefined}>
            <span className="swatch" style={{ background: p.color }} />
            <span className="grow">{p.title}</span>
            {p.openTasks > 0 && <span className="count">{p.openTasks}</span>}
          </NavLink>
        ))}
        <button className="nav-item muted" onClick={() => openNewProject()}>+ {t('nav.newProject')}</button>

        <button className="nav-hint" onClick={() => setHelp(true)}>
          <kbd>{MOD}</kbd><kbd>K</kbd> {t('cmd.shortcuts')}
        </button>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="global-search">
            <input
              ref={searchInput}
              className="input"
              placeholder={t('nav.searchPlaceholder')}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur() } }}
              aria-label={t('nav.searchPlaceholder')}
            />
            <kbd className="search-kbd">/</kbd>
            {results && (
              <div className="search-results">
                {isEmpty(results) && (
                  <div className="empty" style={{ padding: '0.9rem' }}>{t('common.noResults')}</div>
                )}

                {results.tasks.length > 0 && <div className="search-group">{t('search.tasks')}</div>}
                {results.tasks.map(hit => (
                  <div key={hit.id} className="row"
                    onClick={() => { setQuery(''); navigate(`/projects/${hit.projectId}?task=${hit.id}`) }}>
                    <TypeIcon type={hit.type} />
                    <TaskKey value={hit.key} />
                    <span className="grow">{hit.title}</span>
                  </div>
                ))}

                {results.documents.length > 0 && <div className="search-group">{t('search.documents')}</div>}
                {results.documents.map(hit => (
                  <div key={hit.id} className="row"
                    onClick={() => { setQuery(''); navigate(`/projects/${hit.projectId}`) }}>
                    <span className="grow">{hit.title}</span>
                    <Snippet text={hit.snippet} />
                  </div>
                ))}

                {results.comments.length > 0 && <div className="search-group">{t('search.comments')}</div>}
                {results.comments.map(hit => (
                  <div key={hit.id} className="row"
                    onClick={() => {
                      setQuery('')
                      navigate(hit.taskId
                        ? `/projects/${hit.projectId}?task=${hit.taskId}`
                        : `/projects/${hit.projectId}`)
                    }}>
                    <Snippet text={hit.snippet} />
                  </div>
                ))}

                {!isEmpty(results) && (
                  <button className="row search-all"
                    onClick={() => { const q = query; setQuery(''); navigate(`/search?q=${encodeURIComponent(q)}`) }}>
                    {t('search.seeAll', { q: query })}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="topbar-right">
            <button className="btn sm" onClick={() => setQuickTask(true)}>
              + {t('keys.newTask')} <kbd>C</kbd>
            </button>
            <NotificationsBell />
            <Popover align="right" trigger={
              <button className="icon-btn" style={{ width: 34 }} aria-label={me.name}>
                <Avatar user={me} size={27} static />
              </button>
            }>
              {close => (
                <>
                  <div style={{ padding: '0.35rem 0.5rem 0.5rem', fontSize: '0.85rem' }}>
                    <b>{me.name}</b>
                    <div style={{ color: 'var(--muted)', fontSize: '0.77rem' }}>{me.email}</div>
                  </div>
                  <button className="row" onClick={() => { close(); navigate('/settings') }}>{t('nav.settings')}</button>
                  <button className="row" onClick={() => { close(); navigate('/trash') }}>{t('trash.nav')}</button>
                  <button className="row" onClick={() => { close(); setHelp(true) }}>{t('cmd.shortcuts')}</button>
                  <button className="row" onClick={() => { close(); window.open('/api/export', '_blank') }}>{t('nav.export')}</button>
                  <button className="row" onClick={() =>
                    void run(() => api.post('/auth/logout')).then(() => { window.location.href = '/' })
                  }>{t('nav.logout')}</button>
                </>
              )}
            </Popover>
          </div>
        </header>

        <div className="content">{children}</div>
      </div>

      {newProjectOpen && (
        <Modal title={t('nav.newProject')} onClose={closeNewProject}>
          <input className="input" autoFocus placeholder={t('nav.projectName')} value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void createProject() }} />
          <div className="actions">
            <button className="btn ghost" onClick={closeNewProject}>{t('common.cancel')}</button>
            <button className="btn primary" onClick={createProject}>{t('common.create')}</button>
          </div>
        </Modal>
      )}

      <Assistant />
      <MobileNav onNewProject={openNewProject} />

      {profileUserId && <UserProfile userId={profileUserId} onClose={closeProfile} />}

      {quickTask && <QuickTask onClose={() => setQuickTask(false)} />}
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}
      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        onNewProject={openNewProject}
        onShowShortcuts={() => setHelp(true)}
      />
    </div>
  )

  /** The "C" shortcut: preselects the project you are in, or the first one. */
  function QuickTask({ onClose }: { onClose: () => void }) {
    const fromUrl = location.pathname.startsWith('/projects/') ? location.pathname.split('/')[2] : ''
    const usable = projects.filter(p => !p.archived && p.role !== 'VIEWER')
    const [projectId, setProjectId] = useState(fromUrl || usable[0]?.id || '')
    const [type, setType] = useState<TaskType>('TASK')
    const typeLabel = useTypeLabel()
    const [value, setValue] = useState('')

    const submit = async () => {
      const text = value.trim()
      if (!text || !projectId) return
      const ok = await run(() => api.post(`/api/projects/${projectId}/tasks`, { title: text, type }))
      if (ok) {
        onClose()
        await refreshProjects()
        navigate(`/projects/${projectId}`)
      }
    }

    return (
      <Modal title={t('keys.newTask')} onClose={onClose}>
        <div className="field">
          <label>{t('nav.projects')}</label>
          <select className="select" value={projectId} onChange={e => setProjectId(e.target.value)}>
            {usable.map(p => <option key={p.id} value={p.id}>{p.key} · {p.title}</option>)}
          </select>
        </div>
        <div className="field">
          <label>{t('type.label')}</label>
          <div className="type-choice">
            {TYPE_ORDER.map(x => (
              <button key={x} className={`type-chip${x === type ? ' on' : ''}`} onClick={() => setType(x)}>
                <TypeIcon type={x} /> {typeLabel(x)}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label>{t('table.title')}</label>
          <input className="input" autoFocus value={value} placeholder={t('project.newTask')}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void submit() }} />
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn primary" onClick={submit} disabled={!value.trim() || !projectId}>
            {t('common.create')}
          </button>
        </div>
      </Modal>
    )
  }

  function NotificationsBell() {
    const fmt = useFormat()
    const [items, setItems] = useState<Notification[]>([])

    const load = async () => {
      const data = await api.get<{ items: Notification[]; unread: number }>('/api/notifications')
      setItems(data.items)
    }

    const open = async (n: Notification, close: () => void) => {
      await api.post('/api/notifications/read', { ids: [n.id] })
      await refreshInbox()
      close()
      if (n.type === 'invite') { await refreshTeams(); navigate('/teams'); return }
      if (n.payload.projectId) {
        navigate(`/projects/${n.payload.projectId}${n.payload.taskId ? `?task=${n.payload.taskId}` : ''}`)
      }
    }

    const text = (n: Notification) => {
      const p = {
        actor: n.payload.actorName ?? '',
        task: n.payload.taskTitle ?? '',
        project: n.payload.projectTitle ?? '',
        target: n.payload.targetTitle ?? '',
      }
      switch (n.type) {
        case 'assigned': return t('notif.assigned', p)
        case 'comment': return t('notif.comment', p)
        case 'reminder': return t('notif.reminder', p)
        case 'status_changed': return t('notif.status_changed', p)
        case 'project_shared': return t('notif.project_shared', p)
        case 'invite': return t('notif.invite', p)
        case 'invite_accepted': return t('notif.invite_accepted', p)
        default: return t('notif.generic')
      }
    }

    return (
      <Popover align="right" trigger={
        <button className="icon-btn" onClick={() => void load()} aria-label={t('nav.notifications')}>
          <BellIcon />
          {unread > 0 && <span className="badge">{unread > 9 ? '9+' : unread}</span>}
        </button>
      }>
        {close => (
          <div style={{ width: 336, maxHeight: 390, overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.2rem 0.35rem 0.5rem' }}>
              <b style={{ fontSize: '0.88rem' }}>{t('nav.notifications')}</b>
              <button className="btn ghost sm" onClick={() =>
                void run(() => api.post('/api/notifications/read', {}))
                  .then(() => refreshInbox()).then(() => load())
              }>{t('nav.markAllRead')}</button>
            </div>
            {items.length === 0 && <div className="empty" style={{ padding: '1.1rem' }}>{t('nav.noNotifications')}</div>}
            {items.map(n => (
              <div key={n.id} className={`notif-item${n.readAt ? '' : ' unread'}`} onClick={() => void open(n, close)}>
                <div style={{ flex: 1 }}>
                  {text(n)}
                  <div className="when">{fmt.timeAgo(n.createdAt)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Popover>
    )
  }
}
