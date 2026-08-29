import { Router } from 'express'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { prisma } from '../db.js'
import { fail } from '../middleware.js'
import { accessibleProjectsWhere, projectRole, atLeast } from '../access.js'

export const trashRouter = Router()

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.resolve('data/attachments')

/** How long deleted records stay recoverable. */
export const RETENTION_DAYS = 30

/**
 * Deleted records follow the same access rule as live ones: someone who
 * cannot see the project cannot see its trash either.
 */
async function deletedProjectRole(uid: string, projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      ownerId: true,
      members: { where: { userId: uid }, select: { role: true } },
      teamShares: { where: { team: { members: { some: { userId: uid } } } }, select: { role: true } },
    },
  })
  if (!project) return null
  if (project.ownerId === uid) return 'ADMIN' as const
  return project.members[0]?.role ?? project.teamShares[0]?.role ?? null
}

// ---- Listeleme ----

trashRouter.get('/trash', async (req, res) => {
  const uid = req.uid!
  const visible = await prisma.project.findMany({
    where: { ...accessibleProjectsWhere(uid), deletedAt: undefined },
    select: { id: true },
  })
  const projectIds = visible.map(p => p.id)

  const [projects, tasks, documents] = await Promise.all([
    prisma.project.findMany({
      where: { deletedAt: { not: null }, ownerId: uid },
      orderBy: { deletedAt: 'desc' },
      select: { id: true, key: true, title: true, color: true, deletedAt: true },
      take: 100,
    }),
    prisma.task.findMany({
      where: { deletedAt: { not: null }, projectId: { in: projectIds } },
      orderBy: { deletedAt: 'desc' },
      select: {
        id: true, number: true, title: true, deletedAt: true,
        project: { select: { id: true, key: true, title: true, color: true } },
      },
      take: 200,
    }),
    prisma.document.findMany({
      where: { deletedAt: { not: null }, projectId: { in: projectIds } },
      orderBy: { deletedAt: 'desc' },
      select: {
        id: true, title: true, icon: true, deletedAt: true,
        project: { select: { id: true, key: true, title: true, color: true } },
      },
      take: 100,
    }),
  ])

  res.json({
    retentionDays: RETENTION_DAYS,
    projects: projects.map(p => ({ kind: 'project' as const, ...p })),
    tasks: tasks.map(t => ({
      kind: 'task' as const,
      id: t.id,
      title: t.title,
      key: `${t.project.key}-${t.number}`,
      project: t.project,
      deletedAt: t.deletedAt,
    })),
    documents: documents.map(d => ({ kind: 'document' as const, ...d })),
  })
})

// ---- Geri alma ----

trashRouter.post('/trash/task/:id/restore', async (req, res) => {
  const task = await prisma.task.findUnique({ where: { id: req.params.id }, select: { projectId: true } })
  if (!task) return fail(res, 404, 'err.task_not_found', 'not_found')
  const role = await projectRole(req.uid!, task.projectId)
  if (!role || !atLeast(role, 'EDITOR')) return fail(res, 403, 'err.forbidden', 'forbidden')
  await prisma.task.updateMany({
    where: { OR: [{ id: req.params.id }, { parentId: req.params.id }] },
    data: { deletedAt: null },
  })
  res.json({ ok: true })
})

trashRouter.post('/trash/document/:id/restore', async (req, res) => {
  const doc = await prisma.document.findUnique({ where: { id: req.params.id }, select: { projectId: true } })
  if (!doc) return fail(res, 404, 'err.document_not_found', 'not_found')
  const role = await projectRole(req.uid!, doc.projectId)
  if (!role || !atLeast(role, 'EDITOR')) return fail(res, 403, 'err.forbidden', 'forbidden')
  await prisma.document.updateMany({
    where: { OR: [{ id: req.params.id }, { parentId: req.params.id }] },
    data: { deletedAt: null },
  })
  res.json({ ok: true })
})

trashRouter.post('/trash/project/:id/restore', async (req, res) => {
  const role = await deletedProjectRole(req.uid!, req.params.id)
  if (!role) return fail(res, 404, 'err.project_not_found', 'not_found')
  if (!atLeast(role, 'ADMIN')) return fail(res, 403, 'err.forbidden', 'forbidden')
  await prisma.project.update({ where: { id: req.params.id }, data: { deletedAt: null } })
  res.json({ ok: true })
})

// ---- Permanent deletion ----

async function purgeAttachments(where: { taskId?: string; documentId?: string; projectId?: string }) {
  const files = await prisma.attachment.findMany({
    where: where.projectId
      ? { OR: [{ task: { projectId: where.projectId } }, { document: { projectId: where.projectId } }] }
      : where,
    select: { storedName: true },
  })
  await Promise.all(files.map(f => unlink(path.join(UPLOAD_DIR, f.storedName)).catch(() => {})))
}

trashRouter.delete('/trash/task/:id', async (req, res) => {
  const task = await prisma.task.findUnique({ where: { id: req.params.id }, select: { projectId: true, deletedAt: true } })
  if (!task?.deletedAt) return fail(res, 404, 'err.task_not_found', 'not_found')
  const role = await projectRole(req.uid!, task.projectId)
  if (!role || !atLeast(role, 'EDITOR')) return fail(res, 403, 'err.forbidden', 'forbidden')
  await purgeAttachments({ taskId: req.params.id })
  await prisma.task.delete({ where: { id: req.params.id } })
  res.json({ ok: true })
})

trashRouter.delete('/trash/document/:id', async (req, res) => {
  const doc = await prisma.document.findUnique({ where: { id: req.params.id }, select: { projectId: true, deletedAt: true } })
  if (!doc?.deletedAt) return fail(res, 404, 'err.document_not_found', 'not_found')
  const role = await projectRole(req.uid!, doc.projectId)
  if (!role || !atLeast(role, 'EDITOR')) return fail(res, 403, 'err.forbidden', 'forbidden')
  await purgeAttachments({ documentId: req.params.id })
  await prisma.document.delete({ where: { id: req.params.id } })
  res.json({ ok: true })
})

trashRouter.delete('/trash/project/:id', async (req, res) => {
  const project = await prisma.project.findUnique({ where: { id: req.params.id }, select: { ownerId: true, deletedAt: true } })
  if (!project?.deletedAt) return fail(res, 404, 'err.project_not_found', 'not_found')
  if (project.ownerId !== req.uid) return fail(res, 403, 'err.forbidden', 'forbidden')
  await purgeAttachments({ projectId: req.params.id })
  await prisma.project.delete({ where: { id: req.params.id } })
  res.json({ ok: true })
})
