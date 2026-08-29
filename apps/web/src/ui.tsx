import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { LOCALE, useT } from './i18n'
import { useAppOptional } from './store'
import type { User, TaskStatus, TaskType } from './types'
import { STATUS_ORDER, TYPE_ORDER } from './types'

// ---------- Toast ----------

interface ToastItem {
  id: number
  text: string
  kind: 'ok' | 'err'
  action?: { label: string; run: () => void }
}
type ToastFn = (text: string, kind?: 'ok' | 'err', action?: ToastItem['action']) => void

const ToastCtx = createContext<ToastFn>(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const dismiss = useCallback((id: number) => setItems(list => list.filter(x => x.id !== id)), [])

  const push = useCallback<ToastFn>((text, kind = 'ok', action) => {
    const id = Date.now() + Math.random()
    setItems(list => [...list, { id, text, kind, action }])
    // Undoable actions get time to be read and reconsidered
    setTimeout(() => dismiss(id), action ? 8000 : 3600)
  }, [dismiss])

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map(x => (
          <div key={x.id} className={`toast ${x.kind}`}>
            <span>{x.text}</span>
            {x.action && (
              <button className="toast-action" onClick={() => { x.action!.run(); dismiss(x.id) }}>
                {x.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

/**
 * For reversible actions like deletion: do the work, then offer an
 * "Undo" in a toast, rather than blocking on a confirm dialog first.
 */
export function useUndoableAction() {
  const toast = useToast()
  const t = useT()
  return useCallback(async (opts: {
    run: () => Promise<unknown>
    undo: () => Promise<unknown>
    message: string
    onDone?: () => void
  }) => {
    try {
      await opts.run()
      opts.onDone?.()
      toast(opts.message, 'ok', {
        label: t('common.undo'),
        run: () => { void opts.undo().then(() => opts.onDone?.()) },
      })
      return true
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : t('common.error'), 'err')
      return false
    }
  }, [toast, t])
}

/** Wires async work to a toast; API errors already arrive in the user's language. */
export function useAction() {
  const toast = useToast()
  const t = useT()
  return useCallback(async (fn: () => Promise<unknown>, okMsg?: string) => {
    try {
      await fn()
      if (okMsg) toast(okMsg)
      return true
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : t('common.error'), 'err')
      return false
    }
  }, [toast, t])
}

/**
 * Errors from a form the user just submitted.
 *
 * A toast is the wrong home for these: it floats away from the field that
 * caused it, disappears on a timer, and reads as a system message rather
 * than an answer to what was just typed. Submission errors belong beside
 * the form, and they stay until the next attempt.
 *
 * `useAction` remains right for background work — deleting, restoring,
 * rescheduling — where there is no form to attach anything to.
 */
export function useFormAction() {
  const t = useT()
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
      return true
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('common.error'))
      return false
    }
  }, [t])

  return { run, error, clearError: useCallback(() => setError(null), []) }
}

/** The inline banner that goes with `useFormAction`. */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p className="form-error" role="alert">
      <AlertIcon />
      {message}
    </p>
  )
}

export const AlertIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
    <circle cx="8" cy="8" r="6.2" /><path d="M8 5v3.6M8 11h.01" />
  </svg>
)

// ---------- Modal ----------

export function Modal({ title, onClose, children, wide }: {
  title: string; onClose: () => void; children: ReactNode; wide?: boolean
}) {
  const t = useT()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ---------- Popover ----------

export function Popover({ trigger, children, align = 'left' }: {
  trigger: ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="popover-wrap" ref={ref}>
      <div onClick={() => setOpen(o => !o)}>{trigger}</div>
      {open && <div className={`popover ${align}`}>{children(() => setOpen(false))}</div>}
    </div>
  )
}

// ---------- Icons ----------

export const CloseIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
)
export const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 4h10M6.5 4V2.8h3V4M5 4l.6 9h4.8L11 4" />
  </svg>
)
export const BellIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 01-3.4 0" />
  </svg>
)
export const DotsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
    <circle cx="3.2" cy="8" r="1.35" /><circle cx="8" cy="8" r="1.35" /><circle cx="12.8" cy="8" r="1.35" />
  </svg>
)
export const SearchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
    <circle cx="7" cy="7" r="4.4" /><path d="M10.4 10.4L14 14" />
  </svg>
)
/** The same spark wherever the assistant touches something. */
export const SparkIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6.4 1.9l1.2 3.3 3.3 1.2-3.3 1.2-1.2 3.3-1.2-3.3L1.9 6.4l3.3-1.2z" />
    <path d="M12.1 9.6l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z" />
  </svg>
)
export const GoogleLogo = () => (
  <svg className="g-logo" viewBox="0 0 48 48" aria-hidden>
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
)

// ---------- Marka ----------

/** The forward-facing mascot used in the welcome. */
export function Mascot({ size = 132 }: { size?: number }) {
  return <img className="mascot" src="/mascot.png" alt="" width={size} height={size} style={{ width: size, height: size }} />
}

/**
 * Empty state. The illustration appears only where it truly means "nothing
 * here yet"; a fruitless search or filter deserves one line of text instead.
 */
export function EmptyState({ illustrated, title, body, action }: {
  illustrated?: boolean
  title: string
  body?: string
  action?: ReactNode
}) {
  return (
    <div className={`empty-state${illustrated ? ' illustrated' : ''}`}>
      {illustrated && <img className="empty-art" src="/empty.png" alt="" width={132} height={132} />}
      <p className="empty-title">{title}</p>
      {body && <p className="empty-body">{body}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  )
}

/** The mascot on the assistant button, speech bubble over its shoulder. */
export function ChatMark({ size = 84 }: { size?: number }) {
  return <img className="chat-mark" src="/chat.png" alt="" width={size} height={size} />
}

export function BrandMark({ size = 30 }: { size?: number }) {
  return <img className="logo" src="/logo.png" alt="Tavi" width={size} height={size} style={{ width: size, height: size }} />
}

// ---------- Avatar ----------

/** The avatar becomes clickable wherever the profile panel can open. */
export function Avatar({ user, size = 28, static: isStatic }: {
  user: User
  size?: number
  static?: boolean
}) {
  const app = useAppOptional()
  const style = { width: size, height: size, fontSize: size * 0.42 }
  const face = user.avatarUrl
    ? <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" />
    : user.name.slice(0, 1).toLocaleUpperCase()

  if (!app || isStatic) {
    return <span className="avatar" style={style} title={`${user.name} · ${user.email}`}>{face}</span>
  }
  // Avatars often sit inside another button (a task row, a notification), and
  // buttons cannot nest, so this is a clickable span instead.
  const open = (e: React.SyntheticEvent) => {
    e.stopPropagation()
    e.preventDefault()
    app.openProfile(user.id)
  }
  return (
    <span
      role="button"
      tabIndex={0}
      className="avatar interactive"
      style={style}
      title={`${user.name} · ${user.email}`}
      aria-label={user.name}
      onClick={open}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') open(e) }}
    >{face}</span>
  )
}

export function AvatarStack({ users, size = 23, max = 4 }: { users: User[]; size?: number; max?: number }) {
  if (!users.length) return null
  return (
    <span className="avatar-stack">
      {users.slice(0, max).map(u => <Avatar key={u.id} user={u} size={size} />)}
      {users.length > max && (
        <span className="avatar more" style={{ width: size, height: size }}>+{users.length - max}</span>
      )}
    </span>
  )
}

// ---------- Markdown ----------

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    if (!text.trim()) return ''
    return DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true }))
  }, [text])
  if (!html) return null
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
}

// ---------- Locale-aware formatting ----------

export function useFormat() {
  const t = useT()
  const locale = LOCALE
  return useMemo(() => ({
    date: (iso: string | Date) =>
      new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short' }),
    dateTime: (iso: string | Date) =>
      new Date(iso).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
    monthYear: (iso: string | Date) =>
      new Date(iso).toLocaleDateString(locale, { month: 'long', year: 'numeric' }),
    timeAgo: (iso: string) => {
      const s = (Date.now() - new Date(iso).getTime()) / 1000
      if (s < 60) return t('time.now')
      if (s < 3600) return t('time.minutes', { count: Math.floor(s / 60) })
      if (s < 86400) return t('time.hours', { count: Math.floor(s / 3600) })
      return new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short' })
    },
    bytes: (n: number) => {
      if (n < 1024) return `${n} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
      return `${(n / 1024 / 1024).toFixed(1)} MB`
    },
  }), [locale, t])
}

export const usePriorityLabel = () => {
  const t = useT()
  return useCallback((p: number) => {
    const key = `priority.${p}` as 'priority.1'
    return p >= 1 && p <= 5 ? t(key) : ''
  }, [t])
}

// ---------- Small pieces ----------

export function PriorityChip({ priority }: { priority: number }) {
  const label = usePriorityLabel()(priority)
  if (!priority) return null
  return <span className={`chip p${priority}`}>{label}</span>
}

export function DueChip({ dueDate, done }: { dueDate: string | null; done: boolean }) {
  const fmt = useFormat()
  if (!dueDate) return null
  const overdue = !done && new Date(dueDate).getTime() < Date.now()
  return <span className={`chip due${overdue ? ' overdue' : ''}`}>{fmt.date(dueDate)}</span>
}

export function LabelChip({ label, onRemove }: {
  label: { title: string; color: string }; onRemove?: () => void
}) {
  return (
    <span className="chip label" style={{ background: `${label.color}22`, color: label.color }}>
      {label.title}
      {onRemove && <button className="chip-x" onClick={onRemove} aria-label="×">×</button>}
    </span>
  )
}

export function Checkbox({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const t = useT()
  return (
    <button
      className={`checkbox${on ? ' on' : ''}`}
      onClick={e => { e.stopPropagation(); onToggle() }}
      aria-label={t('task.done')}
      aria-pressed={on}
    >
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
        <path d="M2 6.4L4.6 9 10 3.4" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

export function Star({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const t = useT()
  return (
    <button
      className={`star${on ? ' on' : ''}`}
      onClick={e => { e.stopPropagation(); onToggle() }}
      aria-label={t('task.favorite')}
      aria-pressed={on}
      title={t('task.favorite')}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" aria-hidden>
        <path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.4l6.5-.9z" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

/** Converts between ISO and datetime-local, preserving the local zone. */
export const toLocalInput = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null)

// ---------- Durum ----------

/** Status colours mean something: grey waiting, blue running, amber in review, green done. */
const STATUS_TONE: Record<TaskStatus, string> = {
  BACKLOG: 'st-backlog',
  TODO: 'st-todo',
  IN_PROGRESS: 'st-progress',
  IN_REVIEW: 'st-review',
  DONE: 'st-done',
}

export const useStatusLabel = () => {
  const t = useT()
  return useCallback((s: TaskStatus) => t(`status.${s}` as 'status.TODO'), [t])
}

export function StatusDot({ status }: { status: TaskStatus }) {
  return <span className={`status-dot ${STATUS_TONE[status]}`} aria-hidden />
}

export function StatusPill({ status, compact }: { status: TaskStatus; compact?: boolean }) {
  const label = useStatusLabel()(status)
  return (
    <span className={`status-pill ${STATUS_TONE[status]}`} title={label}>
      <StatusDot status={status} />
      {!compact && label}
    </span>
  )
}

/** Popover status picker, shared by the panel, the table and the palette. */
export function StatusSelect({ status, onChange, disabled }: {
  status: TaskStatus
  onChange: (next: TaskStatus) => void
  disabled?: boolean
}) {
  const label = useStatusLabel()
  if (disabled) return <StatusPill status={status} />
  return (
    <Popover trigger={
      <button className={`status-pill interactive ${STATUS_TONE[status]}`}>
        <StatusDot status={status} /> {label(status)}
      </button>
    }>
      {close => (
        <>
          {STATUS_ORDER.map(s => (
            <button key={s} className={`row${s === status ? ' on' : ''}`}
              onClick={() => { onChange(s); close() }}>
              <StatusDot status={s} /> {label(s)}
            </button>
          ))}
        </>
      )}
    </Popover>
  )
}

// ---------- Kind of work ----------

const TYPE_TONE: Record<TaskType, string> = {
  FEATURE: 'tp-feature',
  BUG: 'tp-bug',
  TASK: 'tp-task',
  CHORE: 'tp-chore',
}

/** An unknown type — an old record, a schema change — counts as TASK. */
const knownType = (x: TaskType | undefined): TaskType =>
  x && TYPE_ORDER.includes(x) ? x : 'TASK'

export const useTypeLabel = () => {
  const t = useT()
  return useCallback((x: TaskType) => t(`type.${knownType(x)}` as 'type.TASK'), [t])
}

/**
 * The type's icon. Shape and colour both change so a bug and a feature never
 * look alike, and shape alone is enough for anyone who cannot use colour.
 */
export function TypeIcon({ type: raw, size = 14 }: { type: TaskType; size?: number }) {
  const type = knownType(raw)
  const label = useTypeLabel()(type)
  const common = {
    width: size, height: size, viewBox: '0 0 16 16',
    fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  }
  return (
    <span className={`type-icon ${TYPE_TONE[type]}`} title={label} aria-label={label} role="img">
      {type === 'FEATURE' && (
        <svg {...common}>
          <path d="M8 1.8l1.5 3.9 3.9 1.5-3.9 1.5L8 12.6 6.5 8.7 2.6 7.2l3.9-1.5z" />
          <path d="M12.8 11.6l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" />
        </svg>
      )}
      {type === 'BUG' && (
        <svg {...common}>
          <rect x="5" y="5.4" width="6" height="7.4" rx="3" />
          <path d="M6.2 4.1L5.2 2.7M9.8 4.1l1-1.4M5 7.4H2.4M11 7.4h2.6M5 10.4H2.8M11 10.4h2.2" />
        </svg>
      )}
      {type === 'TASK' && (
        <svg {...common}>
          <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="3" />
          <path d="M5.6 8.2l1.7 1.7 3.2-3.4" />
        </svg>
      )}
      {type === 'CHORE' && (
        <svg {...common}>
          <path d="M10.6 2.6a3.3 3.3 0 00-3.9 4.3l-4 4a1.3 1.3 0 001.9 1.9l4-4a3.3 3.3 0 004.3-3.9l-1.9 1.9-1.9-.4-.4-1.9z" />
        </svg>
      )}
    </span>
  )
}

/** Popover type picker, built on the same pattern as StatusSelect. */
export function TypeSelect({ type, onChange, disabled }: {
  type: TaskType
  onChange: (next: TaskType) => void
  disabled?: boolean
}) {
  const label = useTypeLabel()
  if (disabled) {
    return <span className="type-chip"><TypeIcon type={type} /> {label(type)}</span>
  }
  return (
    <Popover trigger={
      <button className="type-chip interactive"><TypeIcon type={type} /> {label(type)}</button>
    }>
      {close => (
        <>
          {TYPE_ORDER.map(x => (
            <button key={x} className={`row${x === type ? ' on' : ''}`}
              onClick={() => { onChange(x); close() }}>
              <TypeIcon type={x} /> {label(x)}
            </button>
          ))}
        </>
      )}
    </Popover>
  )
}

/** The task key: TAV-12 */
export function TaskKey({ value }: { value: string }) {
  return <span className="task-key">{value}</span>
}
