import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import { BrandMark, FormError, GoogleLogo, useFormAction } from '../ui'
import { takeNext } from '../App'

interface AuthConfig { googleEnabled: boolean; registrationEnabled: boolean; devLogin: boolean }

export default function Login() {
  const t = useT()
  const { run, error, clearError } = useFormAction()
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const [unreachable, setUnreachable] = useState(false)

  /*
   * An unreachable server used to fall back to googleEnabled: false, which
   * hid the Google button and made an outage look like a missing feature.
   * Say the server cannot be reached instead, and offer a retry.
   */
  const loadConfig = useCallback(() => {
    setUnreachable(false)
    api.get<AuthConfig>('/auth/config')
      .then(next => { setConfig(next); setUnreachable(false) })
      .catch(() => setUnreachable(true))
  }, [])

  useEffect(loadConfig, [loadConfig])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const ok = await run(() =>
      mode === 'login'
        ? api.post('/auth/login', { email, password })
        : api.post('/auth/register', { email, name, password }),
    )
    setBusy(false)
    if (ok) window.location.href = takeNext() ?? '/'
  }

  /** Switching between sign in and sign up clears whatever failed before. */
  const switchMode = (next: 'login' | 'register') => {
    setMode(next)
    clearError()
  }

  if (unreachable) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-brand">
            <BrandMark size={76} />
            <div className="wordmark">Tavi</div>
          </div>
          <p className="login-error">{t('login.unreachable')}</p>
          <button className="btn primary" onClick={loadConfig}>{t('login.retry')}</button>
        </div>
      </div>
    )
  }

  if (!config) return null

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <BrandMark size={76} />
          <span className="wordmark">Tavi</span>
          <span className="tagline">{t('app.tagline')}</span>
        </div>
        <h1>{mode === 'login' ? t('login.signIn') : t('login.signUp')}</h1>

        {config.googleEnabled && (
          <>
            <button className="btn-google" onClick={() => {
              const next = takeNext()
              window.location.href = next
                ? `/auth/google/login?next=${encodeURIComponent(next)}`
                : '/auth/google/login'
            }}>
              <GoogleLogo /> {t('login.google')}
            </button>
            <div className="login-divider">{t('login.orEmail')}</div>
          </>
        )}

        <form onSubmit={submit}>
          {mode === 'register' && (
            <input className="input" placeholder={t('login.name')} value={name}
              onChange={e => setName(e.target.value)} required autoComplete="name" />
          )}
          <input className={`input${error ? ' invalid' : ''}`} type="email" placeholder={t('login.email')}
            value={email} onChange={e => { setEmail(e.target.value); clearError() }}
            required autoComplete="email" aria-invalid={!!error} />
          <input className={`input${error ? ' invalid' : ''}`} type="password" placeholder={t('login.password')}
            value={password} onChange={e => { setPassword(e.target.value); clearError() }} required
            minLength={mode === 'register' ? 8 : undefined}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            aria-invalid={!!error} />

          <FormError message={error} />

          <button className="btn primary" type="submit" style={{ height: 44 }} disabled={busy}>
            {mode === 'login' ? t('login.signIn') : t('login.register')}
          </button>
        </form>

        {config.registrationEnabled && (
          <div className="login-alt">
            {mode === 'login' ? (
              <>{t('login.noAccount')} <button onClick={() => switchMode('register')}>{t('login.register')}</button></>
            ) : (
              <>{t('login.haveAccount')} <button onClick={() => switchMode('login')}>{t('login.signIn')}</button></>
            )}
          </div>
        )}

        {config.devLogin && (
          <button
            className="btn-dev"
            onClick={() => void run(() => api.post('/auth/dev-login')).then(ok => { if (ok) window.location.href = takeNext() ?? '/' })}
          >
            {t('login.dev')}
          </button>
        )}
      </div>
    </div>
  )
}
