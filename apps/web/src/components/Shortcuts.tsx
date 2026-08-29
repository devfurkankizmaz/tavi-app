import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useT } from '../i18n'
import { Modal } from '../ui'

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform)
export const MOD = isMac ? '⌘' : 'Ctrl'

/** Shortcuts must stay out of the way while you are typing in a field. */
function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable)
}

/**
 * Global shortcuts: Cmd/Ctrl+K palette, "/" search, "c" new task,
 * "g" then h/m/c to jump, "?" for help.
 */
export function useShortcuts(handlers: {
  openPalette: () => void
  focusSearch: () => void
  newTask: () => void
  showHelp: () => void
}) {
  const navigate = useNavigate()

  useEffect(() => {
    let awaitingGoto = false
    let gotoTimer: ReturnType<typeof setTimeout> | undefined

    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        handlers.openPalette()
        return
      }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return

      if (awaitingGoto) {
        const map: Record<string, string> = { h: '/', m: '/my', c: '/cycles', t: '/teams', l: '/labels', s: '/settings' }
        const path = map[e.key.toLowerCase()]
        awaitingGoto = false
        clearTimeout(gotoTimer)
        if (path) { e.preventDefault(); navigate(path) }
        return
      }

      switch (e.key) {
        case 'g':
          awaitingGoto = true
          gotoTimer = setTimeout(() => { awaitingGoto = false }, 1200)
          break
        case '/':
          e.preventDefault()
          handlers.focusSearch()
          break
        case 'c':
          e.preventDefault()
          handlers.newTask()
          break
        case '?':
          e.preventDefault()
          handlers.showHelp()
          break
      }
    }

    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(gotoTimer) }
  }, [handlers, navigate])
}

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const t = useT()
  const rows: [string, string][] = [
    [`${MOD} K`, t('keys.palette')],
    ['/', t('keys.search')],
    ['C', t('keys.newTask')],
    ['G H', t('keys.goHome')],
    ['G M', t('keys.goMy')],
    ['G C', t('keys.goCycles')],
    ['Esc', t('keys.close')],
    ['?', t('keys.help')],
  ]
  return (
    <Modal title={t('keys.title')} onClose={onClose}>
      <div className="keys">
        {rows.map(([combo, label]) => (
          <div key={combo} className="keys-row">
            <span className="label">{label}</span>
            <span className="combo">{combo.split(' ').map(k => <kbd key={k}>{k}</kbd>)}</span>
          </div>
        ))}
      </div>
    </Modal>
  )
}
