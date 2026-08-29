/**
 * Importing an export back into an account.
 *
 * Everything created here belongs to the person importing: no ownership,
 * membership or permission travels with the file. That is the whole safety
 * model — a hand-edited export can add work to your own account and nothing
 * else, so the file never has to be trusted.
 *
 * Ids in the file are treated as labels within the file, not as database
 * keys: each one is remapped to a freshly created record. Importing the same
 * file twice therefore produces two copies rather than a merge, which is the
 * honest behaviour when nothing in the format identifies a record across
 * installations.
 */
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db.js'
import { fail } from '../middleware.js'
import { DEFAULT_BUCKETS } from '../defaults.js'
import { uniqueProjectKey } from '../keys.js'

export const importRouter = Router()

/** Bounds on one request, so a malformed file cannot fill the database. */
const LIMITS = { projects: 200, tasksPerProject: 2000, documents: 500, comments: 5000 }

const RELATION_KINDS = ['blocked_by', 'blocks', 'related', 'duplicates'] as const

const isoDate = z.string().datetime({ offset: true }).nullish()

const taskSchema = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(50_000).default(''),
  type: z.enum(['FEATURE', 'BUG', 'TASK', 'CHORE']).default('TASK'),
  status: z.enum(['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE']).default('TODO'),
  done: z.boolean().default(false),
  doneAt: isoDate,
  priority: z.number().int().min(0).max(5).default(0),
  percentDone: z.number().int().min(0).max(100).default(0),
  estimate: z.number().int().min(0).nullish(),
  repeatAfter: z.number().int().min(0).default(0),
  startDate: isoDate,
  dueDate: isoDate,
  position: z.number().default(0),
  bucketId: z.string().nullish(),
  parentId: z.string().nullish(),
  labels: z.array(z.object({ label: z.object({ title: z.string(), color: z.string().optional() }) })).default([]),
  assignees: z.array(z.object({ user: z.object({ email: z.string() }) })).default([]),
  comments: z.array(z.object({
    text: z.string().max(50_000),
    createdAt: isoDate,
    author: z.object({ email: z.string(), name: z.string().optional() }).nullish(),
  })).default([]),
  relationsFrom: z.array(z.object({ toId: z.string(), kind: z.string() })).default([]),
})

const projectSchema = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(50_000).default(''),
  color: z.string().max(32).default('#e09a34'),
  archived: z.boolean().default(false),
  buckets: z.array(z.object({
    id: z.string().optional(),
    title: z.string().trim().min(1).max(100),
    position: z.number().default(0),
    isDoneBucket: z.boolean().default(false),
  })).default([]),
  documents: z.array(z.object({
    title: z.string().trim().min(1).max(300),
    content: z.string().max(500_000).default(''),
  })).default([]),
  tasks: z.array(taskSchema).default([]),
})

const payloadSchema = z.object({
  projects: z.array(projectSchema).max(LIMITS.projects).default([]),
  labels: z.array(z.object({ title: z.string().trim().min(1).max(100), color: z.string().optional() })).default([]),
})

interface Report {
  projects: number
  tasks: number
  documents: number
  comments: number
  labels: number
  /**
   * How many people in the file have no account here — a count, never the
   * addresses. The importer already holds every address in the file, so
   * naming the ones that did not match would tell them, by omission, exactly
   * which addresses do have accounts on this instance.
   */
  unmatchedPeople: number
  skipped: string[]
}

importRouter.post('/import', async (req, res) => {
  const parsed = payloadSchema.safeParse(req.body)
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join('.') || 'body'
    return fail(res, 400, 'err.import_invalid', 'invalid', where)
  }

  const uid = req.uid!
  const report: Report = {
    projects: 0, tasks: 0, documents: 0, comments: 0, labels: 0,
    unmatchedPeople: 0, skipped: [],
  }
  const unmatched = new Set<string>()

  // Labels belong to a person, not a project, so they are resolved once for
  // the whole file and reused. An existing label with the same title wins:
  // importing twice must not leave two labels called "Bug".
  const existing = await prisma.label.findMany({ where: { ownerId: uid } })
  const labelIds = new Map(existing.map(l => [l.title.toLocaleLowerCase(), l.id]))

  const ensureLabel = async (title: string, color?: string): Promise<string> => {
    const key = title.toLocaleLowerCase()
    const found = labelIds.get(key)
    if (found) return found
    const created = await prisma.label.create({
      data: { title, ...(color ? { color } : {}), ownerId: uid },
    })
    labelIds.set(key, created.id)
    report.labels++
    return created.id
  }

  for (const label of parsed.data.labels) await ensureLabel(label.title, label.color)

  // Only people who already have an account here can be assigned work; an
  // assignment to a stranger would be a task nobody is actually holding.
  const emails = [...new Set(parsed.data.projects.flatMap(p =>
    p.tasks.flatMap(t => [
      ...t.assignees.map(a => a.user.email),
      ...t.comments.map(c => c.author?.email).filter((e): e is string => !!e),
    ])))]
  const known = emails.length
    ? await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, email: true } })
    : []
  const userIds = new Map(known.map(u => [u.email, u.id]))

  for (const project of parsed.data.projects) {
    if (project.tasks.length > LIMITS.tasksPerProject) {
      report.skipped.push(`${project.title}: ${project.tasks.length} tasks is over the limit`)
      continue
    }

    const buckets = project.buckets.length
      ? project.buckets.map(b => ({ title: b.title, position: b.position, isDoneBucket: b.isDoneBucket }))
      : DEFAULT_BUCKETS

    const created = await prisma.project.create({
      data: {
        title: project.title,
        description: project.description,
        color: project.color,
        archived: project.archived,
        // A key is derived here rather than carried over: the old one may
        // already be taken by a project this account can see.
        key: await uniqueProjectKey(project.title),
        ownerId: uid,
        buckets: { create: buckets },
      },
      include: { buckets: { orderBy: { position: 'asc' } } },
    })
    report.projects++

    const bucketIds = new Map<string, string>()
    project.buckets.forEach((b, i) => {
      const match = created.buckets[i]
      if (b.id && match) bucketIds.set(b.id, match.id)
    })
    const fallbackBucket = created.buckets[0]?.id ?? null

    for (const doc of project.documents.slice(0, LIMITS.documents)) {
      await prisma.document.create({
        data: { projectId: created.id, authorId: uid, title: doc.title, content: doc.content },
      })
      report.documents++
    }

    // Two passes: every task has to exist before parents and relations can
    // point at one, and a file may well list a child before its parent.
    const taskIds = new Map<string, string>()
    let number = 0
    let comments = 0

    for (const task of project.tasks) {
      number++
      const row = await prisma.task.create({
        data: {
          projectId: created.id,
          number,
          position: task.position || number * 100,
          title: task.title,
          description: task.description,
          type: task.type,
          status: task.status,
          done: task.done,
          doneAt: task.done ? task.doneAt ? new Date(task.doneAt) : new Date() : null,
          priority: task.priority,
          percentDone: task.percentDone,
          estimate: task.estimate ?? null,
          repeatAfter: task.repeatAfter,
          startDate: task.startDate ? new Date(task.startDate) : null,
          dueDate: task.dueDate ? new Date(task.dueDate) : null,
          bucketId: (task.bucketId && bucketIds.get(task.bucketId)) || fallbackBucket,
          createdById: uid,
        },
      })
      if (task.id) taskIds.set(task.id, row.id)
      report.tasks++

      for (const { label } of task.labels) {
        await prisma.taskLabel.create({
          data: { taskId: row.id, labelId: await ensureLabel(label.title, label.color) },
        })
      }

      for (const { user } of task.assignees) {
        const userId = userIds.get(user.email)
        if (!userId) {
          unmatched.add(user.email)
          continue
        }
        await prisma.taskAssignee.create({ data: { taskId: row.id, userId } })
      }

      for (const comment of task.comments) {
        if (comments >= LIMITS.comments) break
        const authorId = comment.author?.email ? userIds.get(comment.author.email) : undefined
        if (!authorId && comment.author?.email) unmatched.add(comment.author.email)
        // Attribution is never invented: a comment whose author has no
        // account here is filed under the importer with the original name
        // kept in the text, rather than silently becoming theirs.
        const attributed = authorId
          ? comment.text
          : `${comment.author?.name ?? comment.author?.email ?? 'Unknown'}: ${comment.text}`
        await prisma.comment.create({
          data: {
            taskId: row.id,
            authorId: authorId ?? uid,
            text: attributed,
            ...(comment.createdAt ? { createdAt: new Date(comment.createdAt) } : {}),
          },
        })
        comments++
        report.comments++
      }
    }

    for (const task of project.tasks) {
      const fromId = task.id && taskIds.get(task.id)
      if (!fromId) continue

      if (task.parentId) {
        const parentId = taskIds.get(task.parentId)
        // A parent outside this project is dropped rather than guessed at.
        if (parentId && parentId !== fromId) {
          await prisma.task.update({ where: { id: fromId }, data: { parentId } })
        }
      }

      for (const relation of task.relationsFrom) {
        const toId = taskIds.get(relation.toId)
        if (!toId || toId === fromId) continue
        if (!RELATION_KINDS.includes(relation.kind as (typeof RELATION_KINDS)[number])) continue
        await prisma.taskRelation.create({
          data: { fromId, toId, kind: relation.kind },
        }).catch(() => { /* the file may list a relation from both ends */ })
      }
    }
  }

  report.unmatchedPeople = unmatched.size
  res.json(report)
})
