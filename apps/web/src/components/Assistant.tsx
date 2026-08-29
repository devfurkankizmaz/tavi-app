import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { TaskStatus, TaskType, User } from '../types'
import { useApp } from '../store'
import { useT } from '../i18n'
import {
  AvatarStack, BrandMark, ChatMark, CloseIcon, DueChip, LabelChip, Markdown,
  PriorityChip, StatusPill, TaskKey, TypeIcon, useToast,
} from '../ui'

/** A task named in the reply; clicking it opens the task. */
interface TaskCard {
  id: string
  key: string
  title: string
  status: TaskStatus
  type: TaskType
  done: boolean
  priority: number
  dueDate: string | null
  projectId: string
  projectTitle: string
  assignees: User[]
  labels: { id: string; title: string; color: string }[]
}

interface Turn {
  role: 'user' | 'assistant'
  text: string
  cards?: TaskCard[]
  /** Next steps the model suggested; clicking one sends it straight away. */
  next?: string[]
  failed?: boolean
}

const STORAGE_KEY = 'tavi.assistant'
const KEY_PATTERN = /\b[A-Z][A-Z0-9]*-\d+\b/g
const NEXT_BLOCK = /```next\s*\n([\s\S]*?)```/

/**
 * The assistant ends a reply with a ```next block. It is split off from the
 * text and becomes buttons; if the model forgets it, only the suggestions are missing.
 */
function splitFollowUps(text: string): { body: string; next: string[] } {
  const match = NEXT_BLOCK.exec(text)
  if (!match) return { body: text, next: [] }
  const next = match[1].split('\n').map(line => line.replace(/^[-*\d.\s]+/, '').trim())
  return { body: text.replace(match[0], '').trimEnd(), next: next.filter(Boolean).slice(0, 3) }
}

const TOOL_LABELS: Record<string, string> = {
  list_projects: 'Reading projects',
  search_tasks: 'Searching tasks',
  get_task: 'Reading a task',
  list_team_members: 'Looking up teammates',
  list_cycles: 'Reading cycles',
  list_labels: 'Reading labels',
  list_documents: 'Reading docs',
  get_document: 'Reading a doc',
  create_task: 'Creating a task',
  update_task: 'Updating a task',
  add_comment: 'Posting a comment',
  create_document: 'Creating a doc',
  update_document: 'Updating a doc',
  link_tasks_to_document: 'Linking tasks',
  add_tasks_to_cycle: 'Adding to a cycle',
}

/**
 * Turns keys like TAV-12 into clickable badges. Only keys that actually have
 * a card are touched, and code blocks are left alone.
 */
function linkKeys(text: string, cards: TaskCard[]): string {
  if (!cards.length) return text
  const known = new Set(cards.map(c => c.key))
  return text
    .split(/(`[^`]*`|```[\s\S]*?```)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(KEY_PATTERN, key =>
      known.has(key) ? `<b class="key-inline" data-key="${key}">${key}</b>` : key)))
    .join('')
}

/**
 * The assistant chat. The server announces each tool call over SSE, so the
 * user can watch what is happening. The conversation lives only in the browser.
 */
export default function Assistant() {
  const { agent, refreshProjects } = useApp()
  const t = useT()
  const toast = useToast()
  const navigate = useNavigate()

  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<string | null>(null)
  const [turns, setTurns] = useState<Turn[]>(() => {
    // A stored conversation may come from an older version; drop cards missing
    // expected fields, or one of them takes the screen down.
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY)
      if (!saved) return []
      const parsed = JSON.parse(saved) as Turn[]
      if (!Array.isArray(parsed)) return []
      return parsed
        .filter(turn => turn && typeof turn.text === 'string')
        .map(turn => ({
          ...turn,
          cards: turn.cards?.filter(c => c && c.id && c.key && c.type && c.projectId),
        }))
    } catch { return [] }
  })

  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(turns.slice(-24))) } catch { /* private mode */ }
  }, [turns])

  useEffect(() => {
    if (open) {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
      inputRef.current?.focus()
    }
  }, [open, turns, step])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const openTask = useCallback((card: TaskCard) => {
    setOpen(false)
    navigate(`/projects/${card.projectId}?task=${card.id}`)
  }, [navigate])

  const send = useCallback(async (override?: string) => {
    const message = (override ?? input).trim()
    if (!message || busy) return
    setInput('')
    setBusy(true)
    setStep(null)

    const history = turns
      .filter(x => !x.failed && x.text)
      .slice(-12)
      .map(x => ({ role: x.role, text: x.text }))

    setTurns(prev => [...prev, { role: 'user', text: message }])

    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history }),
      })
      if (!res.ok || !res.body) throw new Error('assistant unavailable')

      // Parse the SSE body by hand, updating the step indicator as events arrive
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let finished = false

      while (!finished) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const chunks = buffer.split('\n\n')
        buffer = chunks.pop() ?? ''
        for (const chunk of chunks) {
          const event = /^event: (.+)$/m.exec(chunk)?.[1]
          const raw = /^data: (.+)$/m.exec(chunk)?.[1]
          if (!event || !raw) continue
          const data = JSON.parse(raw)

          if (event === 'step') {
            setStep(TOOL_LABELS[data.tool] ?? data.tool)
          } else if (event === 'done') {
            finished = true
            const { body, next } = splitFollowUps(data.reply || t('assistant.noAnswer'))
            setTurns(prev => [...prev, { role: 'assistant', text: body, cards: data.cards, next }])
            // Refresh the sidebar counts when something was written
            if (data.actions?.length) await refreshProjects()
          } else if (event === 'error') {
            finished = true
            setTurns(prev => [...prev, { role: 'assistant', text: data.message, failed: true }])
          }
        }
      }
    } catch {
      setTurns(prev => [...prev, { role: 'assistant', text: t('assistant.failed'), failed: true }])
    } finally {
      setBusy(false)
      setStep(null)
    }
  }, [input, busy, turns, refreshProjects, t])

  // Grows as you type: starts at one line, up to the ceiling set in CSS
  const grow = (el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }
  useEffect(() => { grow(inputRef.current) }, [input, open])

  const clear = () => {
    setTurns([])
    try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* private mode */ }
    toast(t('assistant.cleared'))
  }

  if (!agent.enabled) return null

  return (
    <>
      {!open && (
        <button className="assistant-bubble" onClick={() => setOpen(true)} aria-label={t('assistant.title')}>
          <span className="assistant-bubble-art">
            <ChatMark />
            <span className="assistant-bubble-dots"><i /><i /><i /></span>
          </span>
        </button>
      )}

      {open && (
        <>
        <div className="assistant-scrim" onClick={() => setOpen(false)} />
        <section className="assistant" role="dialog" aria-label={t('assistant.title')}>
          <header className="assistant-head">
            <BrandMark size={22} />
            <b>{t('assistant.title')}</b>
            <span style={{ flex: 1 }} />
            {turns.length > 0 && (
              <button className="btn ghost sm" onClick={clear}>{t('assistant.clear')}</button>
            )}
            <button className="icon-btn" onClick={() => setOpen(false)} aria-label={t('common.close')}>
              <CloseIcon />
            </button>
          </header>

          <div className="assistant-list" ref={listRef}>
            {turns.length === 0 && (
              <div className="assistant-intro">
                <BrandMark size={44} />
                <p>{t('assistant.intro')}</p>
                <div className="assistant-examples">
                  {[t('assistant.ex1'), t('assistant.ex2'), t('assistant.ex3')].map(example => (
                    <button key={example} onClick={() => { setInput(example); inputRef.current?.focus() }}>
                      {example}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {turns.map((turn, i) => (
              <AssistantTurn
                key={i}
                turn={turn}
                last={i === turns.length - 1}
                busy={busy}
                onOpenTask={openTask}
                onNavigate={path => { setOpen(false); navigate(path) }}
                onAsk={question => void send(question)}
              />
            ))}

            {busy && (
              <div className="assistant-turn agent working">
                <span className="dots"><i /><i /><i /></span>
                {step ?? t('assistant.thinking')}
              </div>
            )}
          </div>

          <div className="assistant-input">
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              placeholder={t('assistant.placeholder')}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
              }}
            />
            <button className="btn primary sm" onClick={() => void send()} disabled={!input.trim() || busy}>
              {t('assistant.send')}
            </button>
          </div>
          <p className="assistant-foot">{t('assistant.disclaimer')}</p>
        </section>
        </>
      )}
    </>
  )
}

/** One turn: text, clickable keys, task cards and suggestions. */
function AssistantTurn({ turn, last, busy, onOpenTask, onNavigate, onAsk }: {
  turn: Turn
  last: boolean
  busy: boolean
  onOpenTask: (card: TaskCard) => void
  onNavigate: (path: string) => void
  onAsk: (question: string) => void
}) {
  const cards = turn.cards ?? []
  const text = useMemo(
    () => (turn.role === 'assistant' ? linkKeys(turn.text, cards) : turn.text),
    [turn.role, turn.text, cards],
  )

  if (turn.role === 'user') {
    return <div className="assistant-turn me"><p>{turn.text}</p></div>
  }

  // Badges and links are born inside the Markdown, and one listener is simpler
  // than binding React to each of them.
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement

    const key = target.closest<HTMLElement>('.key-inline')?.dataset.key
    const card = key && cards.find(c => c.key === key)
    if (card) { onOpenTask(card); return }

    // In-app links open without a page reload
    const href = target.closest('a')?.getAttribute('href')
    if (href?.startsWith('/')) { e.preventDefault(); onNavigate(href) }
  }

  return (
    <div className={`assistant-turn agent${turn.failed ? ' failed' : ''}`}>
      <div onClick={onClick}><Markdown text={text} /></div>
      {cards.length > 0 && (
        <div className="assistant-cards">
          {cards.map(card => (
            <button key={card.id} className="assistant-card" onClick={() => onOpenTask(card)}>
              <div className="row">
                <TypeIcon type={card.type} />
                <TaskKey value={card.key} />
                <span className="title">{card.title}</span>
              </div>
              <div className="row meta">
                <StatusPill status={card.status} />
                <span className="project">{card.projectTitle}</span>
                {card.priority > 0 && <PriorityChip priority={card.priority} />}
                <DueChip dueDate={card.dueDate} done={card.done} />
                {card.labels.map(label => <LabelChip key={label.id} label={label} />)}
                <span style={{ flex: 1 }} />
                {card.assignees.length > 0 && <AvatarStack users={card.assignees} size={20} />}
              </div>
            </button>
          ))}
        </div>
      )}
      {last && !busy && turn.next && turn.next.length > 0 && (
        <div className="assistant-next">
          {turn.next.map(question => (
            <button key={question} onClick={() => onAsk(question)}>{question}</button>
          ))}
        </div>
      )}
    </div>
  )
}
