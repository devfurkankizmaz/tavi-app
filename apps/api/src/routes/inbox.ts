import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db.js'
import { fail } from '../middleware.js'
import { accessibleProjectIds } from '../access.js'

export const inboxRouter = Router()

const PAGE = 40

/**
 * The inbox.
 *
 * What sets it apart from the bell is that it is built for finishing things:
 * notifications group by task (five comments on one task become one row), the
 * row carries the task as it stands *today* rather than when the notification
 * was written, and archiving is how the box gets emptied.
 *
 * Read and archived are separate states: read means "seen", archived means
 * "I am done with this".
 */

interface Group {
  /** The group's identity: its task if there is one, otherwise the notification. */
  key: string
  taskId: string | null
  projectId: string | null
  /** Ids in this group; read and archive actions apply to all of them. */
  ids: string[]
  types: string[]
  actors: string[]
  unread: number
  latestAt: Date
  /** The wording from when it was written; the only source once a task is gone. */
  fallbackTitle: string
  task: unknown | null
}

const filterSchema = z.enum(['unread', 'all', 'archived']).default('unread')

inboxRouter.get('/inbox', async (req, res) => {
  const parsed = filterSchema.safeParse(req.query.filter ?? 'unread')
  if (!parsed.success) return fail(res, 400, 'err.invalid', 'invalid')
  const filter = parsed.data

  const where = {
    userId: req.uid!,
    ...(filter === 'archived'
      ? { archivedAt: { not: null } }
      : { archivedAt: null, ...(filter === 'unread' ? { readAt: null } : {}) }),
  }

  const items = await prisma.notification.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: PAGE * 4,
  })

  // Notifications about one task collapse into a single row
  const groups = new Map<string, Group>()
  for (const item of items) {
    const payload = (item.payload ?? {}) as Record<string, string | undefined>
    const taskId = payload.taskId ?? null
    const key = taskId ?? item.id
    const group = groups.get(key)

    if (group) {
      group.ids.push(item.id)
      if (!group.types.includes(item.type)) group.types.push(item.type)
      if (payload.actorName && !group.actors.includes(payload.actorName)) {
        group.actors.push(payload.actorName)
      }
      if (!item.readAt) group.unread++
      continue
    }

    groups.set(key, {
      key,
      taskId,
      projectId: payload.projectId ?? null,
      ids: [item.id],
      types: [item.type],
      actors: payload.actorName ? [payload.actorName] : [],
      unread: item.readAt ? 0 : 1,
      latestAt: item.createdAt,
      fallbackTitle: payload.taskTitle ?? payload.targetTitle ?? payload.projectTitle ?? '',
      task: null,
    })
  }

  // Read the task as it stands now; without access the row falls back to text
  const taskIds = [...groups.values()].map(g => g.taskId).filter((x): x is string => !!x)
  if (taskIds.length) {
    const projectIds = await accessibleProjectIds(req.uid!)
    const tasks = await prisma.task.findMany({
      where: { id: { in: taskIds }, deletedAt: null, projectId: { in: projectIds } },
      select: {
        id: true, number: true, title: true, status: true, type: true,
        priority: true, done: true, dueDate: true, projectId: true,
        project: { select: { key: true, title: true } },
        assignees: { select: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } } },
      },
    })
    const byId = new Map(tasks.map(t => [t.id, t]))
    for (const group of groups.values()) {
      const task = group.taskId ? byId.get(group.taskId) : undefined
      if (!task) continue
      group.task = {
        id: task.id,
        key: `${task.project.key}-${task.number}`,
        title: task.title,
        status: task.status,
        type: task.type,
        priority: task.priority,
        done: task.done,
        dueDate: task.dueDate,
        projectId: task.projectId,
        projectTitle: task.project.title,
        assignees: task.assignees.map(a => a.user),
      }
    }
  }

  const [unread, archivedCount] = await Promise.all([
    prisma.notification.count({ where: { userId: req.uid!, readAt: null, archivedAt: null } }),
    prisma.notification.count({ where: { userId: req.uid!, archivedAt: { not: null } } }),
  ])

  res.json({
    filter,
    unread,
    archivedCount,
    groups: [...groups.values()].slice(0, PAGE),
  })
})

const idsSchema = z.object({ ids: z.array(z.string()).max(500).optional() })

/** Without ids this applies to the whole box, for "mark all read". */
function scope(uid: string, ids: string[] | undefined) {
  return { userId: uid, ...(ids ? { id: { in: ids } } : { archivedAt: null }) }
}

inboxRouter.post('/inbox/read', async (req, res) => {
  const body = idsSchema.safeParse(req.body ?? {})
  if (!body.success) return fail(res, 400, 'err.invalid', 'invalid')
  const result = await prisma.notification.updateMany({
    where: { ...scope(req.uid!, body.data.ids), readAt: null },
    data: { readAt: new Date() },
  })
  res.json({ updated: result.count })
})

inboxRouter.post('/inbox/unread', async (req, res) => {
  const body = idsSchema.safeParse(req.body ?? {})
  if (!body.success || !body.data.ids) return fail(res, 400, 'err.invalid', 'invalid')
  const result = await prisma.notification.updateMany({
    where: { userId: req.uid!, id: { in: body.data.ids } },
    data: { readAt: null },
  })
  res.json({ updated: result.count })
})

/** Archiving marks as read too: work leaving the box has been seen. */
inboxRouter.post('/inbox/archive', async (req, res) => {
  const body = idsSchema.safeParse(req.body ?? {})
  if (!body.success) return fail(res, 400, 'err.invalid', 'invalid')
  const now = new Date()
  const result = await prisma.notification.updateMany({
    where: { ...scope(req.uid!, body.data.ids), archivedAt: null },
    data: { archivedAt: now, readAt: now },
  })
  res.json({ updated: result.count })
})

inboxRouter.post('/inbox/unarchive', async (req, res) => {
  const body = idsSchema.safeParse(req.body ?? {})
  if (!body.success || !body.data.ids) return fail(res, 400, 'err.invalid', 'invalid')
  const result = await prisma.notification.updateMany({
    where: { userId: req.uid!, id: { in: body.data.ids } },
    data: { archivedAt: null },
  })
  res.json({ updated: result.count })
})
