import type { Prisma } from '@prisma/client'

export const userLite = { id: true, name: true, email: true, avatarUrl: true } as const
export const projectLite = { id: true, key: true, title: true, color: true } as const

/**
 * Blockers arrive from two directions: a task can say "X is blocking me"
 * (relationsFrom, kind=blocked_by), or another task can say "I am blocking
 * this" (relationsTo, kind=blocks). Both say the same thing, so both count.
 */
const blockerSelect = { select: { id: true, done: true, deletedAt: true } }

export const taskInclude = {
  assignees: { include: { user: { select: userLite } } },
  labels: { include: { label: true } },
  reminders: { orderBy: { remindAt: 'asc' as const } },
  project: { select: projectLite },
  // `kind` is selected too and filtering happens in code, so this stays
  // correct under a different include
  relationsFrom: { select: { kind: true, to: blockerSelect } },
  relationsTo: { select: { kind: true, from: blockerSelect } },
  _count: { select: { comments: true, attachments: true, subtasks: { where: { deletedAt: null } } } },
} satisfies Prisma.TaskInclude

/** How many unfinished tasks stand in this one's way. */
export function countBlockers(task: {
  relationsFrom?: { kind: string; to?: { done: boolean; deletedAt: Date | null } | null }[]
  relationsTo?: { kind: string; from?: { done: boolean; deletedAt: Date | null } | null }[]
}): number {
  const blockers = [
    ...(task.relationsFrom ?? []).filter(r => r.kind === 'blocked_by').map(r => r.to),
    ...(task.relationsTo ?? []).filter(r => r.kind === 'blocks').map(r => r.from),
  ]
  // A deleted or finished task blocks nobody
  return blockers.filter(b => b && !b.done && !b.deletedAt).length
}

type TaskWithRels = Prisma.TaskGetPayload<{ include: typeof taskInclude }>

/** Flattens the join tables and builds the visible key (TAV-12). */
export function serializeTask(t: TaskWithRels) {
  const { assignees, labels, _count, project, relationsFrom, relationsTo, ...rest } = t
  const blockedBy = countBlockers({ relationsFrom, relationsTo })
  return {
    ...rest,
    key: `${project.key}-${t.number}`,
    project,
    assignees: assignees.map(a => a.user),
    labels: labels.map(l => l.label),
    blockedBy,
    commentCount: _count.comments,
    attachmentCount: _count.attachments,
    subtaskCount: _count.subtasks,
  }
}

export type SerializedTask = ReturnType<typeof serializeTask>
