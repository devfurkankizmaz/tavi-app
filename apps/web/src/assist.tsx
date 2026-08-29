import { useCallback, useState } from 'react'
import { api } from './api'
import { useT } from './i18n'
import { SparkIcon } from './ui'

/**
 * Assistant touches outside the chat.
 *
 * These endpoints never write, they suggest. The interface behaves the same
 * way: a result appears as a draft and needs a second, deliberate action to
 * apply. With no key configured the caller never draws these buttons at all
 * (`useApp().agent.enabled`).
 */
export function useAssist<T>(path: string) {
  const t = useT()
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (body: unknown) => {
    setLoading(true)
    setError(null)
    try {
      setData(await api.post<T>(path, body))
    } catch (e) {
      setData(null)
      setError(e instanceof Error && e.message ? e.message : t('common.error'))
    } finally {
      setLoading(false)
    }
  }, [path, t])

  const reset = useCallback(() => { setData(null); setError(null) }, [])
  return { data, loading, error, run, reset }
}

/** The small button that calls the assistant, shared so it looks alike everywhere. */
export function AssistButton({ label, busy, onClick, disabled }: {
  label: string
  busy?: boolean
  onClick: () => void
  disabled?: boolean
}) {
  const t = useT()
  return (
    <button className="btn ghost sm assist-btn" onClick={onClick} disabled={busy || disabled}>
      <SparkIcon />
      {busy ? t('assist.working') : label}
    </button>
  )
}

/** Suggestion box: shared heading, dismissal and error display. */
export function AssistBox({ title, error, onDismiss, children, actions }: {
  title: string
  error?: string | null
  onDismiss: () => void
  children?: React.ReactNode
  actions?: React.ReactNode
}) {
  const t = useT()
  return (
    <div className="assist-box">
      <div className="assist-box-head">
        <SparkIcon />
        <b>{title}</b>
        <span style={{ flex: 1 }} />
        {actions}
        <button className="btn ghost sm" onClick={onDismiss}>{t('common.dismiss')}</button>
      </div>
      {error ? <p className="assist-error">{error}</p> : children}
    </div>
  )
}
