import {
  createContext, useCallback, useContext, useEffect, useState, type ReactNode,
} from 'react'
import { api } from './api'
import type { Me, ProjectSummary, TeamSummary, Label, Invitation, Cycle, AgentStatus } from './types'

interface AppState {
  me: Me
  projects: ProjectSummary[]
  teams: TeamSummary[]
  labels: Label[]
  invites: Invitation[]
  cycles: Cycle[]
  unread: number
  /** Whether the assistant is on; every LLM-touching surface reads this. */
  agent: AgentStatus
  refreshProjects: () => Promise<void>
  refreshTeams: () => Promise<void>
  refreshLabels: () => Promise<void>
  refreshInbox: () => Promise<void>
  refreshCycles: () => Promise<void>
  setMe: (me: Me) => void
  /** So the new-project dialog can be opened from anywhere */
  newProjectOpen: boolean
  openNewProject: () => void
  closeNewProject: () => void
  /** Opens a teammate's profile panel */
  profileUserId: string | null
  openProfile: (userId: string) => void
  closeProfile: () => void
}

const AppCtx = createContext<AppState | null>(null)
export const useApp = () => useContext(AppCtx) as AppState
/** Safe to call outside the provider, e.g. from the public share page. */
export const useAppOptional = () => useContext(AppCtx)

export function AppProvider({ me, onMeChange, children }: {
  me: Me
  onMeChange: (me: Me) => void
  children: ReactNode
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [teams, setTeams] = useState<TeamSummary[]>([])
  const [labels, setLabels] = useState<Label[]>([])
  const [invites, setInvites] = useState<Invitation[]>([])
  const [cycles, setCycles] = useState<Cycle[]>([])
  const [unread, setUnread] = useState(0)
  const [agent, setAgent] = useState<AgentStatus>({ enabled: false })
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [profileUserId, setProfileUserId] = useState<string | null>(null)

  const refreshProjects = useCallback(async () => {
    setProjects(await api.get<ProjectSummary[]>('/api/projects'))
  }, [])
  const refreshTeams = useCallback(async () => {
    setTeams(await api.get<TeamSummary[]>('/api/teams'))
  }, [])
  const refreshLabels = useCallback(async () => {
    setLabels(await api.get<Label[]>('/api/labels'))
  }, [])
  const refreshCycles = useCallback(async () => {
    setCycles(await api.get<Cycle[]>('/api/cycles'))
  }, [])
  const refreshInbox = useCallback(async () => {
    const [inv, notif] = await Promise.all([
      api.get<Invitation[]>('/api/invites'),
      api.get<{ unread: number }>('/api/notifications'),
    ])
    setInvites(inv)
    setUnread(notif.unread)
  }, [])

  useEffect(() => {
    // With no key configured, no assistant surface is ever drawn
    api.get<AgentStatus>('/api/agent/status')
      .then(setAgent)
      .catch(() => setAgent({ enabled: false }))
  }, [])

  useEffect(() => {
    void refreshProjects()
    void refreshTeams()
    void refreshLabels()
    void refreshCycles()
    void refreshInbox()
    const timer = setInterval(() => void refreshInbox(), 60_000)
    return () => clearInterval(timer)
  }, [refreshProjects, refreshTeams, refreshLabels, refreshCycles, refreshInbox])

  return (
    <AppCtx.Provider value={{
      me, projects, teams, labels, invites, cycles, unread, agent,
      refreshProjects, refreshTeams, refreshLabels, refreshCycles, refreshInbox, setMe: onMeChange,
      newProjectOpen,
      openNewProject: () => setNewProjectOpen(true),
      closeNewProject: () => setNewProjectOpen(false),
      profileUserId,
      openProfile: setProfileUserId,
      closeProfile: () => setProfileUserId(null),
    }}>
      {children}
    </AppCtx.Provider>
  )
}
