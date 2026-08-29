import { useEffect, useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import { useT } from '../i18n'
import { FormError, useAction, useFormAction, useToast, useFormat } from '../ui'
import type { ApiTokenOut, Me } from '../types'
import NotificationSettings from '../components/NotificationSettings'
import ImportPanel from '../components/ImportPanel'

export default function Settings() {
  const { me, setMe, agent, refreshProjects } = useApp()
  const t = useT()
  const fmt = useFormat()
  const run = useAction()
  const toast = useToast()
  const password = useFormAction()
  const [name, setName] = useState(me.name)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [tokens, setTokens] = useState<ApiTokenOut[]>([])
  const [newTokenName, setNewTokenName] = useState('')
  const [createdToken, setCreatedToken] = useState<string | null>(null)

  const loadTokens = async () => setTokens(await api.get<ApiTokenOut[]>('/api/me/tokens'))
  useEffect(() => { void loadTokens() }, [])

  const saveName = () =>
    void run(async () => {
      await api.patch('/api/me', { name: name.trim() })
      setMe({ ...me, name: name.trim() } as Me)
    }, t('settings.nameSaved'))

  const changePassword = () =>
    void password.run(async () => {
      await api.post('/api/me/password', { current: current || undefined, next })
      setCurrent('')
      setNext('')
      toast(t('settings.passwordSaved'))
    })

  const createToken = async () => {
    const value = newTokenName.trim()
    if (!value) return
    await run(async () => {
      const token = await api.post<ApiTokenOut>('/api/me/tokens', { name: value })
      setCreatedToken(token.token ?? null)
      setNewTokenName('')
      await loadTokens()
    })
  }

  const icsUrl = `${window.location.origin}/public/ics/${me.icsToken}.ics`

  return (
    <div className="content-inner">
      <div className="page-head"><h2>{t('settings.title')}</h2></div>

      <div className="card" style={{ padding: '1.4rem' }}>
        <div className="settings-section">
          <h3>{t('settings.profile')}</h3>
          <div className="field">
            <label>{t('settings.name')}</label>
            <div style={{ display: 'flex', gap: '0.45rem' }}>
              <input className="input" style={{ maxWidth: 300 }} value={name} onChange={e => setName(e.target.value)} />
              <button className="btn" onClick={saveName} disabled={!name.trim() || name.trim() === me.name}>
                {t('common.save')}
              </button>
            </div>
          </div>
          <div className="field">
            <label>{t('settings.email')}</label>
            <div style={{ color: 'var(--muted)', fontSize: '0.89rem' }}>
              {me.email} {me.hasGoogle && <span className="chip count">{t('settings.googleLinked')}</span>}
            </div>
          </div>
        </div>

        <div className="settings-section">
          <h3>{t('settings.password')}</h3>
          {!me.hasPassword && <p>{t('settings.passwordHint')}</p>}
          <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap' }}>
            {me.hasPassword && (
              <input className="input" style={{ maxWidth: 220 }} type="password" autoComplete="current-password"
                placeholder={t('settings.currentPassword')} value={current} onChange={e => setCurrent(e.target.value)} />
            )}
            <input className="input" style={{ maxWidth: 220 }} type="password" autoComplete="new-password"
              placeholder={t('settings.newPassword')} value={next} onChange={e => setNext(e.target.value)} />
            <button className="btn" onClick={changePassword} disabled={next.length < 8}>
              {me.hasPassword ? t('settings.changePassword') : t('settings.setPassword')}
            </button>
          </div>
          <FormError message={password.error} />
        </div>

        <NotificationSettings />

        <div className="settings-section">
          <h3>{t('settings.calendar')}</h3>
          <p>{t('settings.calendarHint')}</p>
          <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center' }}>
            <span className="token-value" style={{ flex: 1 }}>{icsUrl}</span>
            <button className="btn sm" onClick={() => {
              void navigator.clipboard.writeText(icsUrl)
              toast(t('common.copied'))
            }}>{t('common.copy')}</button>
          </div>
        </div>

        <div className="settings-section">
          <h3>{t('settings.assistant')}</h3>
          {agent.enabled ? (
            <>
              <p>{t('settings.assistantOn')}</p>
              <div className="settings-facts">
                <div><span>{t('settings.assistantModel')}</span><b>{agent.model}</b></div>
                <div><span>{t('settings.assistantEffort')}</span><b>{agent.effort}</b></div>
                <div><span>{t('settings.assistantWrites')}</span><b>{agent.limits?.writes}</b></div>
                <div><span>{t('settings.assistantSteps')}</span><b>{agent.limits?.steps}</b></div>
                <div><span>{t('settings.assistantBulk')}</span><b>{agent.limits?.bulk}</b></div>
                <div><span>{t('settings.assistantRate')}</span><b>{agent.limits?.requestsPer10Min}</b></div>
              </div>
              <p className="settings-note">{t('settings.assistantGuardrails')}</p>
            </>
          ) : (
            <>
              <p>{t('settings.assistantOff')}</p>
              <p className="settings-note">{t('settings.assistantHowTo')}</p>
            </>
          )}
        </div>

        <div className="settings-section">
          <h3>{t('settings.tokens')}</h3>
          <p>{t('settings.tokensHint')}</p>
          <div style={{ display: 'flex', gap: '0.45rem', marginBottom: '0.7rem' }}>
            <input className="input" style={{ maxWidth: 260 }} placeholder={t('settings.tokenName')}
              value={newTokenName} onChange={e => setNewTokenName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void createToken() }} />
            <button className="btn" onClick={createToken}>{t('common.create')}</button>
          </div>
          {createdToken && (
            <div className="invite-card" style={{ borderColor: 'var(--ok)' }}>
              <div className="grow">
                <div className="sub">{t('settings.tokenOnce')}</div>
                <div className="token-value">{createdToken}</div>
              </div>
              <button className="btn sm" onClick={() => {
                void navigator.clipboard.writeText(createdToken)
                toast(t('common.copied'))
              }}>{t('common.copy')}</button>
            </div>
          )}
          {tokens.map(token => (
            <div key={token.id} className="member-row">
              <div className="grow">
                {token.name}
                <div className="mail">
                  {token.lastUsedAt
                    ? t('settings.tokenLastUsed', { when: fmt.timeAgo(token.lastUsedAt) })
                    : t('settings.tokenNeverUsed')}
                </div>
              </div>
              <button className="btn ghost sm danger" onClick={() =>
                void run(async () => { await api.del(`/api/me/tokens/${token.id}`); await loadTokens() }, t('settings.tokenDeleted'))
              }>{t('common.delete')}</button>
            </div>
          ))}
        </div>

        <div className="settings-section">
          <h3>{t('settings.data')}</h3>
          <button className="btn" onClick={() => window.open('/api/export', '_blank')}>
            {t('settings.exportAll')}
          </button>
        </div>

        {/* Next to the export, because they are one pair of doors. */}
        <ImportPanel onDone={() => void refreshProjects()} />
      </div>
    </div>
  )
}
