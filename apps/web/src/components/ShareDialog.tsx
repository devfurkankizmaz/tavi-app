import { useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import { useT } from '../i18n'
import { Avatar, Modal, useAction, useToast } from '../ui'
import type { ProjectDetail, Role } from '../types'

const ROLES: Role[] = ['VIEWER', 'EDITOR', 'ADMIN']

export default function ShareDialog({ project, onClose, onChanged }: {
  project: ProjectDetail
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const { teams, me } = useApp()
  const t = useT()
  const run = useAction()
  const toast = useToast()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('EDITOR')
  const [teamId, setTeamId] = useState('')

  const roleName = (r: Role) => t(`role.${r}` as 'role.VIEWER')

  const invite = async () => {
    if (!email.trim()) return
    const ok = await run(
      () => api.post(`/api/projects/${project.id}/invites`, { email: email.trim(), role }),
      t('share.inviteSent'),
    )
    if (ok) { setEmail(''); await onChanged() }
  }

  const shareTeam = async () => {
    if (!teamId) return
    const ok = await run(
      () => api.post(`/api/projects/${project.id}/team-shares`, { teamId, role }),
      t('share.sharedWithTeam'),
    )
    if (ok) { setTeamId(''); await onChanged() }
  }

  const copyLink = (token: string) => {
    void navigator.clipboard.writeText(`${window.location.origin}/share/${token}`)
    toast(t('share.linkCopied'))
  }

  return (
    <Modal title={t('share.title', { title: project.title })} onClose={onClose} wide>
      <div className="field">
        <label>{t('share.inviteByEmail')}</label>
        <div style={{ display: 'flex', gap: '0.45rem' }}>
          <input className="input" type="email" placeholder={t('share.emailPlaceholder')} value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void invite() }} />
          <select className="select" style={{ width: 150 }} value={role} onChange={e => setRole(e.target.value as Role)}>
            {ROLES.map(r => <option key={r} value={r}>{roleName(r)}</option>)}
          </select>
          <button className="btn primary" onClick={invite}>{t('share.invite')}</button>
        </div>
      </div>

      {teams.length > 0 && (
        <div className="field">
          <label>{t('share.withTeam')}</label>
          <div style={{ display: 'flex', gap: '0.45rem' }}>
            <select className="select" value={teamId} onChange={e => setTeamId(e.target.value)}>
              <option value="">{t('share.selectTeam')}</option>
              {teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
            </select>
            <button className="btn" onClick={shareTeam}>{t('common.share')}</button>
          </div>
        </div>
      )}

      <div className="field">
        <label>{t('share.whoHasAccess')}</label>
        <div>
          <div className="member-row">
            <Avatar user={project.owner} size={28} />
            <div className="grow">
              {project.owner.name}{project.owner.id === me.id ? ` (${t('common.you')})` : ''}
              <div className="mail">{project.owner.email}</div>
            </div>
            <span className="chip count">{t('share.owner')}</span>
          </div>

          {project.members.map(member => (
            <div key={member.userId} className="member-row">
              <Avatar user={member.user} size={28} />
              <div className="grow">
                {member.user.name}{member.userId === me.id ? ` (${t('common.you')})` : ''}
                <div className="mail">{member.user.email}</div>
              </div>
              <select value={member.role} onChange={e =>
                void run(async () => {
                  await api.patch(`/api/projects/${project.id}/members/${member.userId}`, { role: e.target.value })
                  await onChanged()
                })
              }>
                {ROLES.map(r => <option key={r} value={r}>{roleName(r)}</option>)}
              </select>
              <button className="btn ghost sm danger" onClick={() =>
                void run(async () => {
                  await api.del(`/api/projects/${project.id}/members/${member.userId}`)
                  await onChanged()
                })
              }>{t('teams.removeMember')}</button>
            </div>
          ))}

          {project.teamShares.map(share => (
            <div key={share.teamId} className="member-row">
              <span className="avatar" style={{ width: 28, height: 28, fontSize: 12 }}>
                {share.team.name.slice(0, 1).toLocaleUpperCase()}
              </span>
              <div className="grow">{share.team.name}<div className="mail">{t('share.team')}</div></div>
              <span className="chip count">{roleName(share.role)}</span>
              <button className="btn ghost sm danger" onClick={() =>
                void run(async () => {
                  await api.del(`/api/projects/${project.id}/team-shares/${share.teamId}`)
                  await onChanged()
                })
              }>{t('common.remove')}</button>
            </div>
          ))}
        </div>
      </div>

      <div className="field">
        <label>{t('share.publicLink')}</label>
        {project.linkShares.map(share => (
          <div key={share.id} className="member-row">
            <span className="token-value" style={{ flex: 1 }}>{window.location.origin}/share/{share.token}</span>
            <button className="btn sm" onClick={() => copyLink(share.token)}>{t('common.copy')}</button>
            <button className="btn ghost sm danger" onClick={() =>
              void run(async () => {
                await api.del(`/api/projects/${project.id}/link-shares/${share.id}`)
                await onChanged()
              })
            }>{t('common.delete')}</button>
          </div>
        ))}
        {project.linkShares.length === 0 && (
          <button className="btn sm" onClick={() =>
            void run(async () => {
              await api.post(`/api/projects/${project.id}/link-shares`)
              await onChanged()
            }, t('share.linkCreated'))
          }>+ {t('share.createLink')}</button>
        )}
      </div>
    </Modal>
  )
}
