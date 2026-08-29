import type { Prisma } from '@prisma/client'
import { prisma } from './db.js'
import { notify } from './notify.js'
import { broadcastToProjectTeams, slackLink } from './slack.js'
import { taskKey } from './keys.js'

export type ActivityKind =
  | 'created' | 'title_changed' | 'status_changed' | 'priority_changed' | 'type_changed' | 'unblocked'
  | 'due_changed' | 'estimate_changed' | 'assigned' | 'unassigned'
  | 'cycle_changed' | 'commented' | 'attached' | 'labels_changed' | 'reopened'

export interface ActivityMeta {
  from?: string | number | null
  to?: string | number | null
  userName?: string
  text?: string
  fileName?: string
}

/** Writes one line to the audit trail. */
export async function logActivity(
  projectId: string,
  taskId: string | null,
  actorId: string | undefined,
  kind: ActivityKind,
  meta: ActivityMeta = {},
): Promise<void> {
  await prisma.activity.create({
    data: { projectId, taskId, actorId: actorId ?? null, kind, meta: meta as Prisma.InputJsonValue },
  })
}

/** Whoever creates, is assigned or comments starts watching automatically. */
export async function autoWatch(taskId: string, userIds: (string | undefined)[]): Promise<void> {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))]
  if (!ids.length) return
  await prisma.taskWatcher.createMany({
    data: ids.map(userId => ({ taskId, userId })),
    skipDuplicates: true,
  })
}

/** Everyone watching a task — watchers, assignees, creator — minus the actor. */
export async function watcherIds(taskId: string, actorId?: string): Promise<string[]> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      createdById: true,
      assignees: { select: { userId: true } },
      watchers: { select: { userId: true } },
    },
  })
  if (!task) return []
  const all = [
    ...task.watchers.map(w => w.userId),
    ...task.assignees.map(a => a.userId),
    task.createdById ?? '',
  ]
  return [...new Set(all)].filter(id => id && id !== actorId)
}

const SLACK_KINDS = new Set<ActivityKind>(['created', 'status_changed', 'assigned', 'commented'])

/**
 * One call does three things: audit record, watcher notifications, and a Slack
 * post if configured. Every meaningful task change goes through here.
 */
export async function recordChange(opts: {
  task: { id: string; number: number; title: string; projectId: string; dueDate?: Date | null; priority?: number }
  projectKey: string
  actorId?: string
  actorName?: string
  kind: ActivityKind
  meta?: ActivityMeta
  notifyType?: string
  slackText?: string
}): Promise<void> {
  const { task, projectKey, actorId, actorName, kind, meta = {}, notifyType, slackText } = opts

  await logActivity(task.projectId, task.id, actorId, kind, meta)

  if (notifyType) {
    const targets = await watcherIds(task.id, actorId)
    await notify(targets, notifyType, {
      taskId: task.id,
      projectId: task.projectId,
      taskTitle: task.title,
      taskKey: taskKey(projectKey, task.number),
      dueDate: task.dueDate ? task.dueDate.toISOString() : undefined,
      priority: task.priority,
      actorName,
      text: meta.text,
    }, actorId)
  }

  if (SLACK_KINDS.has(kind) && slackText) {
    const origin = process.env.PUBLIC_ORIGIN ?? process.env.WEB_ORIGIN ?? 'http://localhost:5173'
    const link = slackLink(`${origin}/projects/${task.projectId}?task=${task.id}`, `${taskKey(projectKey, task.number)} ${task.title}`)
    await broadcastToProjectTeams(task.projectId, `${slackText} — ${link}`)
  }
}
