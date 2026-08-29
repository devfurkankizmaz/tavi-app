import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useApp } from '../store'
import { useT } from '../i18n'
import { Avatar, EmptyState, Modal, useAction } from '../ui'
import type { TeamDetail, Role } from '../types'

export default function Teams() {
  const { me, teams, invites, refreshTeams, refreshInbox, refreshProjects } = useApp()
  const t = useT()
  const run = useAction()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TeamDetail | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')

  const loadDetail = async (id: string) => setDetail(await api.get<TeamDetail>(`/api/teams/${id}`))
  useEffect(() => {
    if (openId) void loadDetail(openId)
    else setDetail(null)
  }, [openId])

  const create = async () => {
    const value = name.trim()
    if (!value) return
    const ok = await run(() => api.post('/api/teams', { name: value }), t('teams.created'))
    if (ok) { setName(''); setCreating(false); await refreshTeams() }
  }

  const invite = async () => {
    if (!detail || !inviteEmail.trim()) return
    const ok = await run(
      () => api.post(`/api/teams/${detail.id}/invites`, { email: inviteEmail.trim() }),
      t('share.inviteSent'),
    )
    if (ok) { setInviteEmail(''); await loadDetail(detail.id) }
  }

  const answerInvite = (id: string, accept: boolean) =>
    void run(async () => {
      await api.post(`/api/invites/${id}/${accept ? 'accept' : 'decline'}`)
      await Promise.all([refreshInbox(), refreshTeams(), refreshProjects()])
    }, accept ? t('home.acceptedToast') : t('home.declinedToast'))

  return (
    <div className="content-inner">
      <div className="page-head">
        <h2>{t('teams.title')}</h2>
        <button className="btn primary" onClick={() => setCreating(true)}>+ {t('teams.new')}</button>
      </div>

      {invites.filter(i => i.kind === 'team').map(invite => (
        <div key={invite.id} className="invite-card">
          <div className="grow">
            {t('home.inviteTeam', { team: invite.team?.name ?? '' })}
            <div className="sub">{t('home.inviteFrom', { name: invite.inviter?.name ?? '' })}</div>
          </div>
          <button className="btn primary sm" onClick={() => answerInvite(invite.id, true)}>{t('home.accept')}</button>
          <button className="btn ghost sm" onClick={() => answerInvite(invite.id, false)}>{t('home.decline')}</button>
        </div>
      ))}

      {teams.length === 0
        ? <EmptyState illustrated title={t('empty.teams')} body={t('teams.empty')}
            action={<button className="btn primary" onClick={() => setCreating(true)}>{t('teams.new')}</button>} />
        : (
          <div className="project-grid">
            {teams.map(team => (
              <a key={team.id} className="project-card" onClick={() => setOpenId(team.id)}>
                <div className="swatch" style={{
                  background: 'linear-gradient(140deg, var(--amber), var(--fur))',
                  display: 'grid', placeItems: 'center', color: '#2a1c06', fontWeight: 700,
                }}>
                  {team.name.slice(0, 1).toLocaleUpperCase()}
                </div>
                <div className="name">{team.name}</div>
                <div className="sub">{t('teams.summary', { members: team.memberCount, projects: team.projectCount })}</div>
              </a>
            ))}
          </div>
        )}

      {creating && (
        <Modal title={t('teams.new')} onClose={() => setCreating(false)}>
          <input className="input" autoFocus placeholder={t('teams.namePlaceholder')} value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void create() }} />
          <div className="actions">
            <button className="btn ghost" onClick={() => setCreating(false)}>{t('common.cancel')}</button>
            <button className="btn primary" onClick={create}>{t('common.create')}</button>
          </div>
        </Modal>
      )}

      {detail && (
        <Modal title={detail.name} onClose={() => setOpenId(null)} wide>
          {detail.isAdmin && (
            <div className="field">
              <label>{t('teams.inviteMember')}</label>
              <div style={{ display: 'flex', gap: '0.45rem' }}>
                <input className="input" type="email" placeholder={t('share.emailPlaceholder')} value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void invite() }} />
                <button className="btn primary" onClick={invite}>{t('share.invite')}</button>
              </div>
            </div>
          )}

          <div className="field">
            <label>{t('teams.members', { count: detail.members.length })}</label>
            {detail.members.map(member => (
              <div key={member.id} className="member-row">
                <Avatar user={member} size={28} />
                <div className="grow">
                  {member.name}{member.id === me.id ? ` (${t('common.you')})` : ''}
                  <div className="mail">{member.email}</div>
                </div>
                {member.admin && <span className="chip count">{t('teams.admin')}</span>}
                {detail.isAdmin && member.id !== detail.createdById && (
                  <>
                    <button className="btn ghost sm" onClick={() =>
                      void run(async () => {
                        await api.patch(`/api/teams/${detail.id}/members/${member.id}`, { admin: !member.admin })
                        await loadDetail(detail.id)
                      })
                    }>{member.admin ? t('teams.revokeAdmin') : t('teams.makeAdmin')}</button>
                    <button className="btn ghost sm danger" onClick={() =>
                      void run(async () => {
                        await api.del(`/api/teams/${detail.id}/members/${member.id}`)
                        await loadDetail(detail.id)
                        await refreshTeams()
                      })
                    }>{t('teams.removeMember')}</button>
                  </>
                )}
              </div>
            ))}
          </div>

          {detail.invitations.length > 0 && (
            <div className="field">
              <label>{t('teams.pendingInvites')}</label>
              {detail.invitations.map(invitation => (
                <div key={invitation.id} className="member-row">
                  <div className="grow">{invitation.email}</div>
                  <span className="chip count">{t('teams.pending')}</span>
                </div>
              ))}
            </div>
          )}

          {detail.projects.length > 0 && (
            <div className="field">
              <label>{t('teams.sharedProjects')}</label>
              {detail.projects.map(project => (
                <div key={project.id} className="member-row">
                  <span className="swatch" style={{ background: project.color, width: 12, height: 12, borderRadius: 4 }} />
                  <Link to={`/projects/${project.id}`} onClick={() => setOpenId(null)} className="grow"
                    style={{ color: 'var(--text)', textDecoration: 'none' }}>
                    {project.title}
                  </Link>
                  <span className="chip count">{t(`role.${project.role}` as 'role.VIEWER')}</span>
                </div>
              ))}
            </div>
          )}

          {detail.isAdmin && <SlackPanel teamId={detail.id} connected={detail.slackConnected} onSaved={() => loadDetail(detail.id)} />}

          {detail.isAdmin && (
            <div className="actions">
              <button className="btn danger ghost" onClick={() => {
                if (window.confirm(t('teams.deleteConfirm'))) {
                  void run(async () => {
                    await api.del(`/api/teams/${detail.id}`)
                    setOpenId(null)
                    await refreshTeams()
                  })
                }
              }}>{t('teams.delete')}</button>
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}

function SlackPanel({ teamId, connected, onSaved }: {
  teamId: string
  connected: boolean
  onSaved: () => Promise<void>
}) {
  const t = useT()
  const run = useAction()
  const [url, setUrl] = useState('')

  const save = async (webhookUrl: string | null) => {
    const ok = await run(
      () => api.put(`/api/teams/${teamId}/slack`, { webhookUrl }),
      webhookUrl ? t('slack.connectedToast') : t('slack.disconnected'),
    )
    if (ok) { setUrl(''); await onSaved() }
  }

  return (
    <div className="field">
      <label>{t('slack.title')}</label>
      {connected ? (
        <div className="member-row">
          <span className="chip" style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}>
            {t('slack.connected')}
          </span>
          <span className="grow" />
          <button className="btn ghost sm danger" onClick={() => void save(null)}>{t('slack.disconnect')}</button>
        </div>
      ) : (
        <>
          <p className="hint" style={{ margin: '0 0 0.4rem' }}>{t('slack.hint')}</p>
          <div style={{ display: 'flex', gap: '0.45rem' }}>
            <input className="input" placeholder="https://hooks.slack.com/services/…" value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && url.trim()) void save(url.trim()) }} />
            <button className="btn primary" disabled={!url.trim()} onClick={() => void save(url.trim())}>
              {t('slack.connect')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export type { Role }
