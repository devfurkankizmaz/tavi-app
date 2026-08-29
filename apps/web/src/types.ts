export type Role = 'VIEWER' | 'EDITOR' | 'ADMIN'

export interface User {
  id: string
  email: string
  name: string
  avatarUrl: string | null
}

export interface Me extends User {
  icsToken: string
  hasPassword: boolean
  hasGoogle: boolean
}

export type TaskStatus = 'BACKLOG' | 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE'
export const STATUS_ORDER: TaskStatus[] = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE']

/** The kind of work, so different things in one list stop looking alike. */
export type TaskType = 'FEATURE' | 'BUG' | 'TASK' | 'CHORE'
export const TYPE_ORDER: TaskType[] = ['FEATURE', 'BUG', 'TASK', 'CHORE']

/**
 * A skeleton per type for filling an empty description. Never forced: one
 * click in the task panel adds it, and it stays out of the way otherwise.
 */
export const TYPE_TEMPLATES: Record<TaskType, string> = {
  FEATURE: '## Problem\n\n## Proposed solution\n\n## Out of scope\n',
  BUG: '## What happens\n\n## What should happen\n\n## Steps to reproduce\n\n1. \n\n## Where\n\nBrowser / version:\n',
  CHORE: '## Why now\n\n## Done when\n',
  TASK: '',
}

export interface ProjectSummary {
  id: string
  key: string
  title: string
  color: string
  archived: boolean
  openTasks: number
  isFavorite: boolean
  role: Role
}

export interface Bucket {
  id: string
  title: string
  position: number
  limit: number
  isDoneBucket: boolean
  projectId: string
}

export interface Label {
  id: string
  title: string
  color: string
}

export interface Reminder {
  id: string
  remindAt: string
  sent: boolean
}

export interface Task {
  id: string
  number: number
  /** Visible identity: TAV-12 */
  key: string
  title: string
  description: string
  status: TaskStatus
  type: TaskType
  estimate: number | null
  cycleId: string | null
  documentId: string | null
  done: boolean
  doneAt: string | null
  priority: number
  percentDone: number
  color: string | null
  startDate: string | null
  dueDate: string | null
  repeatAfter: number
  position: number
  projectId: string
  bucketId: string | null
  parentId: string | null
  createdAt: string
  updatedAt: string
  assignees: User[]
  labels: Label[]
  reminders: Reminder[]
  /** How many unfinished tasks stand in this one's way. */
  blockedBy: number
  commentCount: number
  attachmentCount: number
  subtaskCount: number
  isFavorite?: boolean
  project: { id: string; key: string; title: string; color: string }
}

export interface Comment {
  id: string
  text: string
  author: User | null
  createdAt: string
  updatedAt: string
}

export interface Attachment {
  id: string
  fileName: string
  mime: string
  size: number
  uploader: User | null
  createdAt: string
}

export interface TaskRelationOut {
  id: string
  kind: string
  task: { id: string; title: string; done: boolean; number: number; key: string; projectId: string }
}

export interface DocSummary {
  id: string
  title: string
  icon: string | null
  parentId: string | null
  position: number
  updatedAt: string
  taskCount: number
  commentCount: number
  childCount: number
}

export interface DocDetail {
  id: string
  title: string
  content: string
  icon: string | null
  parentId: string | null
  projectId: string
  author: User | null
  project: { id: string; key: string; title: string; color: string }
  parent: { id: string; title: string; icon: string | null } | null
  children: { id: string; title: string; icon: string | null }[]
  tasks: Task[]
  comments: Comment[]
  attachments: Attachment[]
  updatedAt: string
  role: Role
}

export interface ActivityItem {
  id: string
  kind: string
  meta: { from?: string | number | null; to?: string | number | null; userName?: string; text?: string; fileName?: string }
  actor: User | null
  createdAt: string
  task?: { id: string; key: string; title: string } | null
}

export interface CycleSummary {
  total: number
  done: number
  points: number
  donePoints: number
  byStatus: Partial<Record<TaskStatus, number>>
}

export interface Cycle {
  id: string
  name: string
  goal: string
  startsAt: string
  endsAt: string
  closedAt: string | null
  team: { id: string; name: string }
  summary: CycleSummary
}

export interface CycleDetail extends Omit<Cycle, 'summary'> {
  tasks: Task[]
  summary: CycleSummary
  workload: { user: User; total: number; done: number; points: number; inProgress: number }[]
}

export interface TaskDetail extends Task {
  cycle: { id: string; name: string; startsAt: string; endsAt: string; closedAt: string | null } | null
  parent: { id: string; title: string; done: boolean; number: number } | null
  comments: Comment[]
  attachments: Attachment[]
  subtasks: Task[]
  relations: TaskRelationOut[]
  watchers: User[]
  isWatching: boolean
  activity: ActivityItem[]
  role: Role
}

export interface ProjectMemberOut {
  userId: string
  role: Role
  user: User
}

export interface LinkShare {
  id: string
  token: string
  role: Role
}

export interface Invitation {
  id: string
  email: string
  role: Role
  kind: 'project' | 'team'
  status: string
  project?: { id: string; title: string; color: string } | null
  team?: { id: string; name: string } | null
  inviter?: { id: string; name: string } | null
  createdAt?: string
}

export interface ProjectDetail {
  id: string
  key: string
  title: string
  description: string
  color: string
  archived: boolean
  owner: User
  buckets: Bucket[]
  tasks: Task[]
  members: ProjectMemberOut[]
  teamShares: { teamId: string; role: Role; team: { id: string; name: string } }[]
  linkShares: LinkShare[]
  role: Role
  isFavorite: boolean
}

export interface TeamSummary {
  id: string
  name: string
  createdById: string
  memberCount: number
  projectCount: number
}

export interface TeamDetail {
  id: string
  name: string
  createdById: string
  isAdmin: boolean
  slackConnected: boolean
  members: (User & { admin: boolean })[]
  invitations: Invitation[]
  projects: { id: string; title: string; color: string; role: Role }[]
}

/**
 * Whether the assistant is on and the limits it runs under. The key never
 * reaches here; only what the server is allowed to do is visible.
 */
export interface AgentStatus {
  enabled: boolean
  model?: string
  effort?: 'low' | 'medium' | 'high'
  limits?: {
    steps: number
    writes: number
    bulk: number
    timeoutMs: number
    requestsPer10Min: number
  }
}

export interface Notification {
  id: string
  type: string
  payload: {
    taskId?: string
    projectId?: string
    taskTitle?: string
    projectTitle?: string
    targetTitle?: string
    actorName?: string
    invitationId?: string
    text?: string
  }
  readAt: string | null
  createdAt: string
}

export interface ApiTokenOut {
  id: string
  name: string
  lastUsedAt: string | null
  createdAt: string
  token?: string
}
