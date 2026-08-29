import { useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useApp } from '../store'
import { useT } from '../i18n'
import { Avatar, CloseIcon, useAction } from '../ui'

const HomeIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3.5 10.5L12 4l8.5 6.5V19a1.5 1.5 0 01-1.5 1.5H5A1.5 1.5 0 013.5 19z" />
  </svg>
)
const InboxIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 13h4l1.5 3h5L16 13h4" /><path d="M4 13l2.2-7h11.6L20 13v5a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 18z" />
  </svg>
)
const CycleIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 12a8 8 0 11-2.6-5.9" /><path d="M20 4v4.5h-4.5" />
  </svg>
)
const MenuIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
)

/**
 * Primary navigation on mobile: a bottom bar within thumb reach.
 * Projects and secondary pages open in the sheet behind the "More" tab.
 */
export default function MobileNav({ onNewProject }: { onNewProject: () => void }) {
  const { me, projects, teams, invites, openProfile } = useApp()
  const run = useAction()
  const t = useT()
  const navigate = useNavigate()
  const [sheet, setSheet] = useState(false)

  const go = (path: string) => { setSheet(false); navigate(path) }
  const active = projects.filter(p => !p.archived)

  return (
    <>
      <nav className="mobile-nav" aria-label={t('nav.menu')}>
        <NavLink to="/" end className={({ isActive }) => `mnav-item${isActive ? ' active' : ''}`}>
          <HomeIcon /><span>{t('nav.overview')}</span>
        </NavLink>
        <NavLink to="/my" className={({ isActive }) => `mnav-item${isActive ? ' active' : ''}`}>
          <InboxIcon /><span>{t('nav.myWork')}</span>
        </NavLink>
        <NavLink to="/cycles" className={({ isActive }) => `mnav-item${isActive ? ' active' : ''}`}>
          <CycleIcon /><span>{t('nav.cycles')}</span>
        </NavLink>
        <button className={`mnav-item${sheet ? ' active' : ''}`} onClick={() => setSheet(true)}>
          <MenuIcon /><span>{t('nav.more')}</span>
          {invites.length > 0 && <span className="mnav-dot" />}
        </button>
      </nav>

      {sheet && (
        <div className="sheet-backdrop" onMouseDown={() => setSheet(false)}>
          <div className="sheet" onMouseDown={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="sheet-grabber" />
            <div className="sheet-head">
              <b>{t('nav.menu')}</b>
              <button className="icon-btn" onClick={() => setSheet(false)} aria-label={t('common.close')}>
                <CloseIcon />
              </button>
            </div>

            <div className="sheet-body">
              <button className="sheet-user" onClick={() => { setSheet(false); openProfile(me.id) }}>
                <Avatar user={me} size={38} static />
                <span className="grow">
                  <b>{me.name}</b>
                  <span className="mail">{me.email}</span>
                </span>
              </button>

              <button className="nav-item" onClick={() => go('/teams')}>
                <span className="grow">{t('nav.teams')}</span>
                {invites.length > 0 && <span className="count accent">{invites.length}</span>}
              </button>
              <button className="nav-item" onClick={() => go('/labels')}>{t('nav.labels')}</button>
              <button className="nav-item" onClick={() => go('/settings')}>{t('nav.settings')}</button>
              <button className="nav-item" onClick={() => go('/trash')}>{t('trash.nav')}</button>

              <div className="nav-section"><span>{t('nav.projects')}</span></div>
              {active.length === 0 && <div className="hint" style={{ padding: '0.3rem 0.55rem' }}>{t('home.noProjects')}</div>}
              {active.map(p => (
                <button key={p.id} className="nav-item" onClick={() => go(`/projects/${p.id}`)}>
                  <span className="swatch" style={{ background: p.color }} />
                  <span className="grow">{p.title}</span>
                  {p.openTasks > 0 && <span className="count">{p.openTasks}</span>}
                </button>
              ))}
              <button className="nav-item muted" onClick={() => { setSheet(false); onNewProject() }}>
                + {t('nav.newProject')}
              </button>

              {teams.length > 0 && (
                <>
                  <div className="nav-section"><span>{t('nav.teams')}</span></div>
                  {teams.map(team => (
                    <button key={team.id} className="nav-item" onClick={() => go('/teams')}>
                      <span className="grow">{team.name}</span>
                      <span className="count">{team.memberCount}</span>
                    </button>
                  ))}
                </>
              )}

              <div className="nav-section"><span>{t('nav.menu')}</span></div>
              <button className="nav-item" onClick={() => { setSheet(false); window.open('/api/export', '_blank') }}>
                {t('nav.export')}
              </button>
              <button className="nav-item" onClick={() =>
                void run(() => api.post('/auth/logout')).then(() => { window.location.href = '/' })
              }>{t('nav.logout')}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
