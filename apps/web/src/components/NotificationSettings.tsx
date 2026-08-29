/**
 * Per-type notification preferences, plus the daily digest.
 *
 * The two channels are independent on purpose: silencing the inbox is not the
 * same request as silencing the mail, and the digest keeps working when every
 * immediate email is off — which is the combination most people end up
 * wanting once a team gets busy.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import { useAction, useToast } from '../ui'

interface Preference {
  type: string
  inApp: boolean
  email: boolean
  /** Some types only ever reach the inbox; a dead switch would be a lie. */
  canEmail: boolean
}

interface Settings {
  digestHour: number | null
  preferences: Preference[]
}

/** What "07:00 UTC" is on this machine, so nobody has to do the arithmetic. */
function localEquivalent(hour: number): string {
  const utc = new Date(Date.UTC(2000, 0, 1, hour))
  return utc.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export default function NotificationSettings() {
  const t = useT()
  const run = useAction()
  const toast = useToast()
  const [settings, setSettings] = useState<Settings | null>(null)

  const load = useCallback(async () => {
    setSettings(await api.get<Settings>('/api/me/notifications'))
  }, [])

  useEffect(() => { void load() }, [load])

  if (!settings) return null

  // Saved on every switch rather than behind a button: there is nothing to
  // review before applying, and a settings screen that can be left half-saved
  // is a settings screen people stop trusting.
  const save = (next: Settings, changed?: Preference) => run(async () => {
    setSettings(next)
    await api.put('/api/me/notifications', {
      digestHour: next.digestHour,
      preferences: changed ? [{ type: changed.type, inApp: changed.inApp, email: changed.email }] : [],
    })
    toast(t('notif.saved'))
  })

  const toggle = (pref: Preference, channel: 'inApp' | 'email') => {
    const updated = { ...pref, [channel]: !pref[channel] }
    void save(
      { ...settings, preferences: settings.preferences.map(p => p.type === pref.type ? updated : p) },
      updated,
    )
  }

  return (
    <div className="settings-section">
      <h3>{t('notif.title')}</h3>
      <p>{t('notif.intro')}</p>

      <table className="tbl notif-table">
        <thead>
          <tr>
            <th />
            <th>{t('notif.col.inbox')}</th>
            <th>{t('notif.col.email')}</th>
          </tr>
        </thead>
        <tbody>
          {settings.preferences.map(pref => (
            <tr key={pref.type}>
              <td>{t(`notif.type.${pref.type}` as 'notif.type.assigned')}</td>
              <td>
                <input
                  type="checkbox"
                  checked={pref.inApp}
                  onChange={() => toggle(pref, 'inApp')}
                  aria-label={t('notif.col.inbox')}
                />
              </td>
              <td>
                {pref.canEmail ? (
                  <input
                    type="checkbox"
                    checked={pref.email}
                    onChange={() => toggle(pref, 'email')}
                    aria-label={t('notif.col.email')}
                  />
                ) : <span className="hint">{t('notif.never')}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="digest-row">
        <label>{t('notif.digest')}</label>
        <select
          value={settings.digestHour ?? ''}
          onChange={e => void save({
            ...settings,
            digestHour: e.target.value === '' ? null : Number(e.target.value),
          })}
        >
          <option value="">{t('notif.digestOff')}</option>
          {Array.from({ length: 24 }, (_, hour) => (
            <option key={hour} value={hour}>
              {t('notif.digestAt', { hour: String(hour).padStart(2, '0') })} · {localEquivalent(hour)}
            </option>
          ))}
        </select>
      </div>
      <p className="settings-note">{t('notif.digestHelp')}</p>
    </div>
  )
}
