import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { api, UnauthorizedError } from './api'
import { ToastProvider } from './ui'
import { AppProvider } from './store'
import type { Me } from './types'
import Login from './pages/Login'
import Home from './pages/Home'
import MyWork from './pages/MyWork'
import Cycles from './pages/Cycles'
import Calendar from './pages/Calendar'
import Search from './pages/Search'
import Inbox from './pages/Inbox'
import CycleBoard from './pages/CycleBoard'
import Project from './pages/Project'
import Teams from './pages/Teams'
import Labels from './pages/Labels'
import Settings from './pages/Settings'
import Trash from './pages/Trash'
import PublicShare from './pages/PublicShare'
import Shell from './components/Shell'

const NEXT_KEY = 'tavi.next'

/**
 * Where to land after signing in. Only relative paths are accepted; a value
 * like "//evil.example" could carry the user off to another site.
 */
export function safeNext(value: string | null): string | null {
  if (!value || !value.startsWith('/')) return null
  if (value.startsWith('//') || value.startsWith('/\\')) return null
  return value.slice(0, 512)
}

export const takeNext = () => {
  try {
    const value = safeNext(sessionStorage.getItem(NEXT_KEY))
    sessionStorage.removeItem(NEXT_KEY)
    return value
  } catch { return null }
}

/**
 * The door email links land on: /go?to=/projects/x?task=y
 * Signed in, it goes straight there; signed out, App shows the login screen
 * and returns to the same destination afterwards.
 */
function Go() {
  const [params] = useSearchParams()
  const to = safeNext(params.get('to'))
  return <Navigate to={to ?? '/'} replace />
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [checked, setChecked] = useState(false)
  const location = useLocation()
  const isPublic = location.pathname.startsWith('/share/')

  useEffect(() => {
    if (isPublic) { setChecked(true); return }
    ;(async () => {
      try {
        setMe(await api.get<Me>('/api/me'))
      } catch (e) {
        if (!(e instanceof UnauthorizedError)) console.error(e)
      } finally {
        setChecked(true)
      }
    })()
  }, [isPublic])

  // Remember where they were heading, then take them there after sign-in
  useEffect(() => {
    if (!checked || me || isPublic) return
    const here = location.pathname + location.search
    const target = location.pathname === '/go'
      ? safeNext(new URLSearchParams(location.search).get('to'))
      : safeNext(here)
    try {
      if (target && target !== '/') sessionStorage.setItem(NEXT_KEY, target)
    } catch { /* private mode */ }
  }, [checked, me, isPublic, location])

  if (!checked) return null

  const content = isPublic ? (
    <Routes>
      <Route path="/share/:token" element={<PublicShare />} />
    </Routes>
  ) : !me ? (
    <Login />
  ) : (
    <AppProvider me={me} onMeChange={setMe}>
      <Shell>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/my" element={<MyWork />} />
          <Route path="/go" element={<Go />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/search" element={<Search />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/cycles" element={<Cycles />} />
          <Route path="/cycles/:id" element={<CycleBoard />} />
          <Route path="/projects/:id" element={<Project />} />
          <Route path="/teams" element={<Teams />} />
          <Route path="/labels" element={<Labels />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/trash" element={<Trash />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </AppProvider>
  )

  return <ToastProvider>{content}</ToastProvider>
}
