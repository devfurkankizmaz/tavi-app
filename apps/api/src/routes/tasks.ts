import { Router } from 'express'
import { z } from 'zod'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { Prisma, TaskStatus, TaskType } from '@prisma/client'
import { prisma } from '../db.js'
import { projectRole, taskRole, atLeast, accessibleProjectIds, parentRole } from '../access.js'
import { taskInclude, serializeTask, countBlockers, userLite, projectLite } from '../serialize.js'
import { actorName } from '../notify.js'
import { fail } from '../middleware.js'
import { recordChange, autoWatch, logActivity } from '../activity.js'
import { taskKey } from '../keys.js'

export const tasksRouter = Router()

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.resolve('data/attachments')
await mkdir(UPLOAD_DIR, { recursive: true })
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, _file, cb) => cb(null, randomUUID()),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
})

const isoDate = z.string().datetime({ offset: true }).or(z.string().datetime())
const STATUSES = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'] as const
const statusSchema = z.enum(STATUSES)
const TYPES = ['FEATURE', 'BUG', 'TASK', 'CHORE'] as const
const typeSchema = z.enum(TYPES)

const taskBody = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().max(100000).optional(),
  status: statusSchema.optional(),
  type: typeSchema.optional(),
  done: z.boolean().optional(),
  priority: z.number().int().min(0).max(5).optional(),
  estimate: z.number().int().min(0).max(999).nullable().optional(),
  percentDone: z.number().int().min(0).max(100).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  startDate: isoDate.nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  repeatAfter: z.number().int().min(0).optional(),
  position: z.number().optional(),
  bucketId: z.string().nullable().optional(),
  cycleId: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  labelIds: z.array(z.string()).optional(),
  assigneeIds: z.array(z.string()).optional(),
  reminders: z.array(isoDate).optional(),
})

function forbidden(req: import('express').Request, res: import('express').Response, status: number) {
  return status === 404
    ? fail(res, 404, 'err.task_not_found', 'not_found')
    : fail(res, 403, 'err.forbidden', 'forbidden')
}

/** Cycles from the user's teams, the ones a task can be assigned to. */
async function reachableCycleIds(uid: string): Promise<string[]> {
  const cycles = await prisma.cycle.findMany({
    where: { team: { members: { some: { userId: uid } } } },
    select: { id: true },
  })
  return cycles.map(c => c.id)
}

// ---- Search and filtered listing ----

tasksRouter.get('/tasks', async (req, res) => {
  const uid = req.uid!
  const q = req.query
  const projectIds = q.projectId ? [String(q.projectId)] : await accessibleProjectIds(uid)
  if (q.projectId && !(await projectRole(uid, String(q.projectId)))) return forbidden(req, res, 404)

  const where: Prisma.TaskWhereInput = { projectId: { in: projectIds }, deletedAt: null }
  if (q.q) where.title = { contains: String(q.q), mode: 'insensitive' }
  if (q.done !== undefined && q.done !== '') where.done = q.done === 'true'
  if (q.status) where.status = { in: String(q.status).split(',') as TaskStatus[] }
  if (q.type) where.type = { in: String(q.type).split(',') as TaskType[] }
  if (q.priority) where.priority = { gte: Number(q.priority) }
  if (q.labelId) where.labels = { some: { labelId: String(q.labelId) } }
  if (q.cycleId) where.cycleId = String(q.cycleId)

  // assignee=me → "bana atananlar"
  const assignee = q.assignee === 'me' ? uid : q.assigneeId ? String(q.assigneeId) : null
  if (assignee) where.assignees = { some: { userId: assignee } }
  if (q.watching === 'true') where.watchers = { some: { userId: uid } }

  if (q.dueFrom || q.dueTo) {
    where.dueDate = {
      ...(q.dueFrom ? { gte: new Date(String(q.dueFrom)) } : {}),
      ...(q.dueTo ? { lte: new Date(String(q.dueTo)) } : {}),
    }
  }
  if (q.favorite === 'true') {
    const favs = await prisma.favorite.findMany({ where: { userId: uid, kind: 'task' }, select: { targetId: true } })
    where.id = { in: favs.map(f => f.targetId) }
  }

  const sort = String(q.sort ?? 'due')
  const orderBy: Prisma.TaskOrderByWithRelationInput[] =
    sort === 'priority' ? [{ priority: 'desc' }, { dueDate: { sort: 'asc', nulls: 'last' } }]
    : sort === 'created' ? [{ createdAt: 'desc' }]
    : sort === 'position' ? [{ position: 'asc' }]
    : sort === 'completed' ? [{ doneAt: { sort: 'desc', nulls: 'last' } }]
    : [{ dueDate: { sort: 'asc', nulls: 'last' } }, { priority: 'desc' }, { createdAt: 'asc' }]

  const tasks = await prisma.task.findMany({
    where,
    orderBy,
    take: Math.min(Number(q.take ?? 100), 500),
    skip: Number(q.skip ?? 0) || 0,
    include: taskInclude,
  })
  res.json(tasks.map(serializeTask))
})

// ---- Creation ----

tasksRouter.post('/projects/:id/tasks', async (req, res) => {
  const role = await projectRole(req.uid!, req.params.id)
  if (!role) return forbidden(req, res, 404)
  if (!atLeast(role, 'EDITOR')) return forbidden(req, res, 403)
  const body = taskBody.safeParse(req.body)
  if (!body.success || !body.data.title) return fail(res, 400, 'err.task_title_required', 'invalid')
  const d = body.data

  const project = await prisma.project.findUnique({ where: { id: req.params.id }, select: projectLite })
  if (!project) return forbidden(req, res, 404)

  let bucketId = d.bucketId ?? null
  if (!bucketId) {
    const first = await prisma.bucket.findFirst({ where: { projectId: req.params.id }, orderBy: { position: 'asc' } })
    bucketId = first?.id ?? null
  }
  if (d.cycleId && !(await reachableCycleIds(req.uid!)).includes(d.cycleId)) {
    return fail(res, 404, 'err.cycle_not_found', 'not_found')
  }

  const task = await prisma.$transaction(async tx => {
    const agg = await tx.task.aggregate({ where: { projectId: req.params.id }, _max: { number: true, position: true } })
    return tx.task.create({
      data: {
        title: d.title!,
        description: d.description ?? '',
        status: d.status ?? 'TODO',
        type: d.type ?? 'TASK',
        priority: d.priority ?? 0,
        estimate: d.estimate ?? null,
        color: d.color ?? null,
        startDate: d.startDate ? new Date(d.startDate) : null,
        dueDate: d.dueDate ? new Date(d.dueDate) : null,
        repeatAfter: d.repeatAfter ?? 0,
        projectId: req.params.id,
        bucketId,
        cycleId: d.cycleId ?? null,
        parentId: d.parentId ?? null,
        createdById: req.uid!,
        number: (agg._max.number ?? 0) + 1,
        position: d.position ?? (agg._max.position ?? 0) + 100,
        labels: d.labelIds ? { create: d.labelIds.map(labelId => ({ labelId })) } : undefined,
        assignees: d.assigneeIds ? { create: d.assigneeIds.map(userId => ({ userId })) } : undefined,
        reminders: d.reminders ? { create: d.reminders.map(r => ({ remindAt: new Date(r) })) } : undefined,
      },
      include: taskInclude,
    })
  })

  // The creator and the assignees start watching automatically
  await autoWatch(task.id, [req.uid, ...(d.assigneeIds ?? [])])
  const actor = await actorName(req.uid)
  await recordChange({
    task, projectKey: project.key, actorId: req.uid, actorName: actor,
    kind: 'created',
    slackText: `*${actor}* created a task`,
  })
  if (d.assigneeIds?.length) {
    const names = await prisma.user.findMany({ where: { id: { in: d.assigneeIds } }, select: { name: true } })
    const list = names.map(n => n.name).join(', ')
    await recordChange({
      task, projectKey: project.key, actorId: req.uid, actorName: actor,
      kind: 'assigned', meta: { userName: list }, notifyType: 'assigned',
      slackText: `*${actor}* assigned it to *${list}*`,
    })
  }
  res.status(201).json(serializeTask(task))
})

// ---- Detail ----

tasksRouter.get('/tasks/:id', async (req, res) => {
  const tr = await taskRole(req.uid!, req.params.id)
  if (!tr?.role) return forbidden(req, res, 404)
  const task = await prisma.task.findFirst({
    where: { id: req.params.id, deletedAt: null },
    include: {
      ...taskInclude,
      cycle: { select: { id: true, name: true, startsAt: true, endsAt: true, closedAt: true } },
      parent: { select: { id: true, title: true, done: true, number: true } },
      subtasks: { where: { deletedAt: null }, orderBy: { position: 'asc' }, include: taskInclude },
      comments: { orderBy: { createdAt: 'asc' }, include: { author: { select: userLite } } },
      attachments: { orderBy: { createdAt: 'asc' }, include: { uploader: { select: userLite } } },
      relationsFrom: { include: { to: { select: { id: true, title: true, done: true, deletedAt: true, number: true, projectId: true, project: { select: { key: true } } } } } },
      relationsTo: { include: { from: { select: { id: true, title: true, done: true, deletedAt: true, number: true, projectId: true, project: { select: { key: true } } } } } },
      watchers: { include: { user: { select: userLite } } },
      activities: { orderBy: { createdAt: 'desc' }, take: 50, include: { actor: { select: userLite } } },
    },
  })
  if (!task) return forbidden(req, res, 404)
  const isFavorite = !!(await prisma.favorite.findUnique({
    where: { userId_kind_targetId: { userId: req.uid!, kind: 'task', targetId: task.id } },
  }))
  const { subtasks, relationsFrom, relationsTo, watchers, activities, ...rest } = task
  const rel = (r: { id: string; kind: string }, other: { id: string; title: string; done: boolean; number: number; projectId: string; project: { key: string } }) =>
    ({ id: r.id, kind: r.kind, task: { ...other, key: taskKey(other.project.key, other.number) } })

  res.json({
    // Detail carries richer relation data than the list, so count blockers here
    ...serializeTask({ ...rest, relationsFrom: [], relationsTo: [] } as never),
    blockedBy: countBlockers({ relationsFrom, relationsTo }),
    cycle: task.cycle,
    parent: task.parent,
    comments: task.comments,
    attachments: task.attachments,
    subtasks: subtasks.map(serializeTask),
    relations: [
      ...relationsFrom.map(r => rel(r, r.to)),
      ...relationsTo.map(r => rel(r, r.from)),
    ],
    watchers: watchers.map(w => w.user),
    isWatching: watchers.some(w => w.userId === req.uid),
    activity: activities.map(a => ({
      id: a.id, kind: a.kind, meta: a.meta, actor: a.actor, createdAt: a.createdAt,
    })),
    isFavorite,
    role: tr.role,
  })
})

// ---- Updating ----

tasksRouter.patch('/tasks/:id', async (req, res) => {
  const tr = await taskRole(req.uid!, req.params.id)
  if (!tr?.role) return forbidden(req, res, 404)
  if (!atLeast(tr.role, 'EDITOR')) return forbidden(req, res, 403)
  const body = taskBody.safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid_task', 'invalid')
  const d = body.data

  const current = await prisma.task.findFirst({
    where: { id: req.params.id, deletedAt: null },
    include: {
      assignees: true,
      project: { select: { ...projectLite, buckets: { where: { isDoneBucket: true } } } },
    },
  })
  if (!current) return forbidden(req, res, 404)
  const projectKey = current.project.key
  const actor = await actorName(req.uid)

  const data: Prisma.TaskUpdateInput = {}
  if (d.title !== undefined) data.title = d.title
  if (d.description !== undefined) data.description = d.description
  if (d.type !== undefined) data.type = d.type
  if (d.priority !== undefined) data.priority = d.priority
  if (d.estimate !== undefined) data.estimate = d.estimate
  if (d.percentDone !== undefined) data.percentDone = d.percentDone
  if (d.color !== undefined) data.color = d.color
  if (d.startDate !== undefined) data.startDate = d.startDate ? new Date(d.startDate) : null
  if (d.dueDate !== undefined) data.dueDate = d.dueDate ? new Date(d.dueDate) : null
  if (d.repeatAfter !== undefined) data.repeatAfter = d.repeatAfter
  if (d.position !== undefined) data.position = d.position
  if (d.parentId !== undefined) {
    if (d.parentId === req.params.id) return fail(res, 400, 'err.self_parent', 'invalid')
    data.parent = d.parentId ? { connect: { id: d.parentId } } : { disconnect: true }
  }
  if (d.cycleId !== undefined) {
    if (d.cycleId && !(await reachableCycleIds(req.uid!)).includes(d.cycleId)) {
      return fail(res, 404, 'err.cycle_not_found', 'not_found')
    }
    data.cycle = d.cycleId ? { connect: { id: d.cycleId } } : { disconnect: true }
  }

  const doneBucket = current.project.buckets[0]
  if (d.bucketId !== undefined) {
    data.bucket = d.bucketId ? { connect: { id: d.bucketId } } : { disconnect: true }
    if (d.bucketId && doneBucket && d.bucketId === doneBucket.id && d.done === undefined && d.status === undefined) d.done = true
    if (current.bucketId === doneBucket?.id && d.bucketId !== doneBucket?.id && d.done === undefined && d.status === undefined) d.done = false
  }

  // `done` and `status` are two faces of one truth; changing either aligns the other
  let nextStatus: TaskStatus | undefined = d.status
  if (d.done !== undefined && d.status === undefined) {
    nextStatus = d.done ? 'DONE' : (current.status === 'DONE' ? 'TODO' : current.status)
  }
  const becomesDone = nextStatus === 'DONE'
  const wasDone = current.done

  if (nextStatus !== undefined && nextStatus !== current.status) {
    if (becomesDone && current.repeatAfter > 0) {
      // A repeating task never completes; its dates shift forward instead
      const shift = current.repeatAfter * 1000
      data.startDate = current.startDate ? new Date(current.startDate.getTime() + shift) : undefined
      data.dueDate = current.dueDate ? new Date(current.dueDate.getTime() + shift) : undefined
      data.percentDone = 0
      const reminders = await prisma.reminder.findMany({ where: { taskId: current.id } })
      await Promise.all(reminders.map(r =>
        prisma.reminder.update({ where: { id: r.id }, data: { remindAt: new Date(r.remindAt.getTime() + shift), sent: false } }),
      ))
      nextStatus = current.status
    } else {
      data.status = nextStatus
      data.done = becomesDone
      data.doneAt = becomesDone ? new Date() : null
      if (becomesDone && doneBucket && d.bucketId === undefined) data.bucket = { connect: { id: doneBucket.id } }
    }
  }

  if (d.labelIds) {
    await prisma.taskLabel.deleteMany({ where: { taskId: current.id } })
    await prisma.taskLabel.createMany({ data: d.labelIds.map(labelId => ({ taskId: current.id, labelId })), skipDuplicates: true })
  }

  let addedAssignees: string[] = []
  if (d.assigneeIds) {
    const existing = new Set(current.assignees.map(a => a.userId))
    addedAssignees = d.assigneeIds.filter(id => !existing.has(id))
    await prisma.taskAssignee.deleteMany({ where: { taskId: current.id } })
    await prisma.taskAssignee.createMany({ data: d.assigneeIds.map(userId => ({ taskId: current.id, userId })), skipDuplicates: true })
    await autoWatch(current.id, addedAssignees)
  }
  if (d.reminders) {
    await prisma.reminder.deleteMany({ where: { taskId: current.id } })
    await prisma.reminder.createMany({ data: d.reminders.map(r => ({ taskId: current.id, remindAt: new Date(r) })) })
  }

  const updated = await prisma.task.update({ where: { id: current.id }, data, include: taskInclude })
  const base = { task: updated, projectKey, actorId: req.uid, actorName: actor }

  // Reflect the change in the audit trail and to the watchers
  if (data.status && nextStatus && nextStatus !== current.status) {
    await recordChange({
      ...base, kind: becomesDone && !wasDone ? 'status_changed' : nextStatus === 'TODO' && wasDone ? 'reopened' : 'status_changed',
      meta: { from: current.status, to: nextStatus },
      notifyType: 'status_changed',
      slackText: `*${actor}* moved it \`${current.status}\` → \`${nextStatus}\``,
    })
  }
  // If finishing this cleared someone else's path, tell that task's watchers
  if (becomesDone && !wasDone) await announceUnblocked(current.id, req.uid, actor)

  if (addedAssignees.length) {
    const names = await prisma.user.findMany({ where: { id: { in: addedAssignees } }, select: { name: true } })
    await recordChange({
      ...base, kind: 'assigned', meta: { userName: names.map(n => n.name).join(', ') },
      notifyType: 'assigned',
      slackText: `*${actor}* assigned it to *${names.map(n => n.name).join(', ')}*`,
    })
  }
  if (d.title !== undefined && d.title !== current.title) {
    await recordChange({ ...base, kind: 'title_changed', meta: { from: current.title, to: d.title } })
  }
  if (d.priority !== undefined && d.priority !== current.priority) {
    await recordChange({ ...base, kind: 'priority_changed', meta: { from: current.priority, to: d.priority } })
  }
  if (d.type !== undefined && d.type !== current.type) {
    await recordChange({ ...base, kind: 'type_changed', meta: { from: current.type, to: d.type } })
  }
  if (d.dueDate !== undefined) {
    await recordChange({ ...base, kind: 'due_changed', meta: { to: d.dueDate ?? null } })
  }
  if (d.estimate !== undefined && d.estimate !== current.estimate) {
    await recordChange({ ...base, kind: 'estimate_changed', meta: { from: current.estimate, to: d.estimate } })
  }
  if (d.cycleId !== undefined && d.cycleId !== current.cycleId) {
    await recordChange({ ...base, kind: 'cycle_changed', meta: { to: d.cycleId } })
  }

  res.json(serializeTask(updated))
})

/** Deletion is not permanent: the task goes to trash and is recoverable for 30 days. */
tasksRouter.delete('/tasks/:id', async (req, res) => {
  const tr = await taskRole(req.uid!, req.params.id)
  if (!tr?.role) return forbidden(req, res, 404)
  if (!atLeast(tr.role, 'EDITOR')) return forbidden(req, res, 403)
  const now = new Date()
  // Subtasks follow their parent so none are orphaned in the list
  await prisma.task.updateMany({
    where: { OR: [{ id: req.params.id }, { parentId: req.params.id }], deletedAt: null },
    data: { deletedAt: now },
  })
  res.json({ ok: true, deletedAt: now })
})

// ---- Watching ----

tasksRouter.post('/tasks/:id/watch', async (req, res) => {
  const tr = await taskRole(req.uid!, req.params.id)
  if (!tr?.role) return forbidden(req, res, 404)
  await prisma.taskWatcher.upsert({
    where: { taskId_userId: { taskId: req.params.id, userId: req.uid! } },
    update: {},
    create: { taskId: req.params.id, userId: req.uid! },
  })
  res.status(201).json({ ok: true })
})

tasksRouter.delete('/tasks/:id/watch', async (req, res) => {
  const tr = await taskRole(req.uid!, req.params.id)
  if (!tr?.role) return forbidden(req, res, 404)
  await prisma.taskWatcher.deleteMany({ where: { taskId: req.params.id, userId: req.uid! } })
  res.json({ ok: true })
})

// ---- Comments ----

tasksRouter.post('/tasks/:id/comments', async (req, res) => {
  const tr = await taskRole(req.uid!, req.params.id)
  if (!tr?.role) return forbidden(req, res, 404)
  if (!atLeast(tr.role, 'EDITOR')) return forbidden(req, res, 403)
  const text = String(req.body?.text ?? '').trim()
  if (!text) return fail(res, 400, 'err.comment_empty', 'invalid')

  const comment = await prisma.comment.create({
    data: { taskId: req.params.id, authorId: req.uid!, text },
    include: { author: { select: userLite } },
  })
  const task = await prisma.task.findUnique({
    where: { id: req.params.id },
    select: { id: true, number: true, title: true, projectId: true, project: { select: { key: true } } },
  })
  if (task) {
    await autoWatch(task.id, [req.uid])
    const actor = await actorName(req.uid)
    await recordChange({
      task, projectKey: task.project.key, actorId: req.uid, actorName: actor,
      kind: 'commented', meta: { text: text.slice(0, 200) },
      notifyType: 'comment',
      slackText: `*${actor}* commented: “${text.slice(0, 140)}”`,
    })
  }
  res.status(201).json(comment)
})

tasksRouter.patch('/comments/:id', async (req, res) => {
  const comment = await prisma.comment.findUnique({ where: { id: req.params.id } })
  if (!comment) return fail(res, 404, 'err.comment_not_found', 'not_found')
  const tr = await parentRole(req.uid!, comment)
  if (!tr?.role) return forbidden(req, res, 404)
  if (comment.authorId !== req.uid && !atLeast(tr.role, 'ADMIN')) return forbidden(req, res, 403)
  const text = String(req.body?.text ?? '').trim()
  if (!text) return fail(res, 400, 'err.comment_empty', 'invalid')
  const updated = await prisma.comment.update({
    where: { id: comment.id },
    data: { text },
    include: { author: { select: userLite } },
  })
  res.json(updated)
})

tasksRouter.delete('/comments/:id', async (req, res) => {
  const comment = await prisma.comment.findUnique({ where: { id: req.params.id } })
  if (!comment) return fail(res, 404, 'err.comment_not_found', 'not_found')
  const tr = await parentRole(req.uid!, comment)
  if (!tr?.role) return forbidden(req, res, 404)
  if (comment.authorId !== req.uid && !atLeast(tr.role, 'ADMIN')) return forbidden(req, res, 403)
  await prisma.comment.delete({ where: { id: comment.id } })
  res.json({ ok: true })
})

// ---- Attachments ----

tasksRouter.post('/tasks/:id/attachments', upload.single('file'), async (req, res) => {
  const tr = await taskRole(req.uid!, req.params.id)
  if (!tr?.role || !atLeast(tr.role, 'EDITOR')) {
    if (req.file) await unlink(req.file.path).catch(() => {})
    return forbidden(req, res, tr?.role ? 403 : 404)
  }
  if (!req.file) return fail(res, 400, 'err.file_required', 'invalid')
  const fileName = Buffer.from(req.file.originalname, 'latin1').toString('utf8')
  const attachment = await prisma.attachment.create({
    data: {
      taskId: req.params.id,
      fileName,
      mime: req.file.mimetype,
      size: req.file.size,
      storedName: req.file.filename,
      uploaderId: req.uid!,
    },
    include: { uploader: { select: userLite } },
  })
  const task = await prisma.task.findUnique({
    where: { id: req.params.id },
    select: { id: true, number: true, title: true, projectId: true, project: { select: { key: true } } },
  })
  if (task) {
    await recordChange({
      task, projectKey: task.project.key, actorId: req.uid, actorName: await actorName(req.uid),
      kind: 'attached', meta: { fileName },
    })
  }
  res.status(201).json(attachment)
})

tasksRouter.get('/attachments/:id/download', async (req, res) => {
  const attachment = await prisma.attachment.findUnique({ where: { id: req.params.id } })
  if (!attachment) return fail(res, 404, 'err.attachment_not_found', 'not_found')
  const tr = await parentRole(req.uid!, attachment)
  if (!tr?.role) return forbidden(req, res, 404)
  /*
   * A file row can exist in the database while the file does not: a restored
   * backup, a moved volume, a half-finished upload. On its own, `pipe` left
   * the ReadStream's 'error' event unhandled and Node killed the process, so
   * a single missing file could take the whole server down.
   */
  const filePath = path.join(UPLOAD_DIR, attachment.storedName)
  const stream = createReadStream(filePath)

  stream.on('error', err => {
    console.error('could not read attachment:', attachment.id, err)
    if (!res.headersSent) return fail(res, 404, 'err.attachment_not_found', 'not_found')
    res.destroy()
  })

  // Headers are written only once the file really opens; otherwise 404
  stream.once('open', () => {
    res.setHeader('Content-Type', attachment.mime)
    res.setHeader('Content-Length', String(attachment.size))
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`)
    stream.pipe(res)
  })

  // Do not leak a file descriptor when the client disconnects mid-download
  res.on('close', () => stream.destroy())
})

tasksRouter.delete('/attachments/:id', async (req, res) => {
  const attachment = await prisma.attachment.findUnique({ where: { id: req.params.id } })
  if (!attachment) return fail(res, 404, 'err.attachment_not_found', 'not_found')
  const tr = await parentRole(req.uid!, attachment)
  if (!tr?.role || !atLeast(tr.role, 'EDITOR')) return forbidden(req, res, tr?.role ? 403 : 404)
  await prisma.attachment.delete({ where: { id: attachment.id } })
  await unlink(path.join(UPLOAD_DIR, attachment.storedName)).catch(() => {})
  res.json({ ok: true })
})

// ---- Relations ----

tasksRouter.post('/tasks/:id/relations', async (req, res) => {
  const tr = await taskRole(req.uid!, req.params.id)
  if (!tr?.role || !atLeast(tr.role, 'EDITOR')) return forbidden(req, res, tr?.role ? 403 : 404)
  const body = z.object({
    toId: z.string(),
    kind: z.enum(['related', 'blocks', 'blocked_by']).default('related'),
  }).safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid_relation', 'invalid')
  if (body.data.toId === req.params.id) return fail(res, 400, 'err.self_relation', 'invalid')
  const other = await taskRole(req.uid!, body.data.toId)
  if (!other?.role) return fail(res, 404, 'err.target_task_not_found', 'not_found')
  const relation = await prisma.taskRelation.create({
    data: { fromId: req.params.id, toId: body.data.toId, kind: body.data.kind },
    include: { to: { select: { id: true, title: true, done: true, number: true, projectId: true, project: { select: { key: true } } } } },
  })
  res.status(201).json({
    id: relation.id,
    kind: relation.kind,
    task: { ...relation.to, key: taskKey(relation.to.project.key, relation.to.number) },
  })
})

tasksRouter.delete('/relations/:id', async (req, res) => {
  const relation = await prisma.taskRelation.findUnique({ where: { id: req.params.id } })
  if (!relation) return fail(res, 404, 'err.relation_not_found', 'not_found')
  const tr = await taskRole(req.uid!, relation.fromId)
  if (!tr?.role || !atLeast(tr.role, 'EDITOR')) return forbidden(req, res, tr?.role ? 403 : 404)
  await prisma.taskRelation.delete({ where: { id: relation.id } })
  res.json({ ok: true })
})

// ---- Per-project activity feed ----

/**
 * Recent activity across every project the user can reach.
 *
 * Overview answers "what is the team doing"; unlike the per-project feed,
 * this one also says which project each task belongs to.
 */
/**
 * Finishing a task can free the work it was blocking. When something is
 * freed, its watchers hear about it: "your turn" is the one piece of news
 * nobody should have to poll for. Only tasks whose *last* blocker cleared
 * are announced; anything still waiting would be a false alarm.
 */
async function announceUnblocked(doneTaskId: string, actorId?: string, actorName?: string): Promise<void> {
  const relations = await prisma.taskRelation.findMany({
    where: {
      OR: [
        { toId: doneTaskId, kind: 'blocked_by' },
        { fromId: doneTaskId, kind: 'blocks' },
      ],
    },
    select: { fromId: true, toId: true, kind: true },
  })

  const candidateIds = relations.map(r => (r.kind === 'blocked_by' ? r.fromId : r.toId))
  if (!candidateIds.length) return

  const candidates = await prisma.task.findMany({
    where: { id: { in: candidateIds }, deletedAt: null, done: false },
    include: taskInclude,
  })

  for (const candidate of candidates) {
    // serializeTask counts open blockers; zero means the path is fully clear
    if (serializeTask(candidate).blockedBy > 0) continue
    await recordChange({
      task: candidate,
      projectKey: candidate.project.key,
      actorId,
      actorName,
      kind: 'unblocked',
      meta: {},
      notifyType: 'unblocked',
      slackText: `*${actorName ?? 'Someone'}* cleared the last blocker`,
    })
  }
}

tasksRouter.get('/activity', async (req, res) => {
  const projectIds = await accessibleProjectIds(req.uid!)
  if (!projectIds.length) return res.json([])

  const items = await prisma.activity.findMany({
    // Activity on a deleted task stays out: there would be nowhere to click through to
    where: {
      projectId: { in: projectIds },
      OR: [{ taskId: null }, { task: { deletedAt: null } }],
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Number(req.query.take ?? 20), 60),
    include: {
      actor: { select: userLite },
      task: {
        select: {
          id: true, number: true, title: true, projectId: true, type: true, status: true,
          project: { select: { key: true, title: true } },
        },
      },
    },
  })

  res.json(items.map(a => ({
    id: a.id,
    kind: a.kind,
    meta: a.meta,
    actor: a.actor,
    createdAt: a.createdAt,
    task: a.task
      ? {
          id: a.task.id,
          projectId: a.task.projectId,
          projectTitle: a.task.project.title,
          title: a.task.title,
          type: a.task.type,
          status: a.task.status,
          key: taskKey(a.task.project.key, a.task.number),
        }
      : null,
  })))
})

tasksRouter.get('/projects/:id/activity', async (req, res) => {
  const role = await projectRole(req.uid!, req.params.id)
  if (!role) return fail(res, 404, 'err.project_not_found', 'not_found')
  const items = await prisma.activity.findMany({
    where: { projectId: req.params.id },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Number(req.query.take ?? 60), 200),
    include: {
      actor: { select: userLite },
      task: { select: { id: true, number: true, title: true, project: { select: { key: true } } } },
    },
  })
  res.json(items.map(a => ({
    id: a.id,
    kind: a.kind,
    meta: a.meta,
    actor: a.actor,
    createdAt: a.createdAt,
    task: a.task ? { id: a.task.id, title: a.task.title, key: taskKey(a.task.project.key, a.task.number) } : null,
  })))
})

export { logActivity }
