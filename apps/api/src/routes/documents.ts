import { Router } from 'express'
import { z } from 'zod'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { prisma } from '../db.js'
import { fail } from '../middleware.js'
import { projectRole, documentRole, atLeast } from '../access.js'
import { taskInclude, serializeTask, userLite } from '../serialize.js'
import { actorName } from '../notify.js'
import { logActivity } from '../activity.js'

export const documentsRouter = Router()

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.resolve('data/attachments')
await mkdir(UPLOAD_DIR, { recursive: true })
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, _file, cb) => cb(null, randomUUID()),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
})

const docBody = z.object({
  title: z.string().trim().min(1).max(250),
  content: z.string().max(400000).optional(),
  icon: z.string().max(8).nullable().optional(),
  parentId: z.string().nullable().optional(),
  position: z.number().optional(),
})

// ---- A project's document tree ----

documentsRouter.get('/projects/:id/documents', async (req, res) => {
  const role = await projectRole(req.uid!, req.params.id)
  if (!role) return fail(res, 404, 'err.project_not_found', 'not_found')
  const docs = await prisma.document.findMany({
    where: { projectId: req.params.id, deletedAt: null },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true, title: true, icon: true, parentId: true, position: true, updatedAt: true,
      _count: { select: { tasks: { where: { deletedAt: null } }, comments: true, children: { where: { deletedAt: null } } } },
    },
  })
  res.json(docs.map(d => ({
    id: d.id, title: d.title, icon: d.icon, parentId: d.parentId, position: d.position,
    updatedAt: d.updatedAt,
    taskCount: d._count.tasks, commentCount: d._count.comments, childCount: d._count.children,
  })))
})

documentsRouter.post('/projects/:id/documents', async (req, res) => {
  const role = await projectRole(req.uid!, req.params.id)
  if (!role) return fail(res, 404, 'err.project_not_found', 'not_found')
  if (!atLeast(role, 'EDITOR')) return fail(res, 403, 'err.forbidden', 'forbidden')
  const body = docBody.safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.title_required', 'invalid')

  const last = await prisma.document.aggregate({
    where: { projectId: req.params.id, parentId: body.data.parentId ?? null },
    _max: { position: true },
  })
  const doc = await prisma.document.create({
    data: {
      title: body.data.title,
      content: body.data.content ?? '',
      icon: body.data.icon ?? null,
      parentId: body.data.parentId ?? null,
      projectId: req.params.id,
      authorId: req.uid!,
      position: (last._max.position ?? 0) + 100,
    },
  })
  await logActivity(req.params.id, null, req.uid, 'created', { text: doc.title })
  res.status(201).json(doc)
})

// ---- Document detail ----

documentsRouter.get('/documents/:id', async (req, res) => {
  const dr = await documentRole(req.uid!, req.params.id)
  if (!dr?.role) return fail(res, 404, 'err.document_not_found', 'not_found')
  const doc = await prisma.document.findFirst({
    where: { id: req.params.id, deletedAt: null },
    include: {
      author: { select: userLite },
      project: { select: { id: true, key: true, title: true, color: true } },
      parent: { select: { id: true, title: true, icon: true } },
      children: { where: { deletedAt: null }, orderBy: { position: 'asc' }, select: { id: true, title: true, icon: true } },
      tasks: { where: { deletedAt: null }, orderBy: [{ done: 'asc' }, { position: 'asc' }], include: taskInclude },
      comments: { orderBy: { createdAt: 'asc' }, include: { author: { select: userLite } } },
      attachments: { orderBy: { createdAt: 'asc' }, include: { uploader: { select: userLite } } },
    },
  })
  if (!doc) return fail(res, 404, 'err.document_not_found', 'not_found')
  const { tasks, ...rest } = doc
  res.json({ ...rest, tasks: tasks.map(serializeTask), role: dr.role })
})

documentsRouter.patch('/documents/:id', async (req, res) => {
  const dr = await documentRole(req.uid!, req.params.id)
  if (!dr?.role) return fail(res, 404, 'err.document_not_found', 'not_found')
  if (!atLeast(dr.role, 'EDITOR')) return fail(res, 403, 'err.forbidden', 'forbidden')
  const body = docBody.partial().safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid', 'invalid')
  if (body.data.parentId === req.params.id) return fail(res, 400, 'err.self_parent', 'invalid')
  const doc = await prisma.document.update({ where: { id: req.params.id }, data: body.data })
  res.json(doc)
})

/** Moves a doc to trash, taking its child pages with it. */
documentsRouter.delete('/documents/:id', async (req, res) => {
  const dr = await documentRole(req.uid!, req.params.id)
  if (!dr?.role) return fail(res, 404, 'err.document_not_found', 'not_found')
  if (!atLeast(dr.role, 'EDITOR')) return fail(res, 403, 'err.forbidden', 'forbidden')
  const now = new Date()
  await prisma.document.updateMany({
    where: { OR: [{ id: req.params.id }, { parentId: req.params.id }], deletedAt: null },
    data: { deletedAt: now },
  })
  res.json({ ok: true, deletedAt: now })
})

// ---- Tasks linked to a document ----

documentsRouter.post('/documents/:id/tasks', async (req, res) => {
  const dr = await documentRole(req.uid!, req.params.id)
  if (!dr?.role) return fail(res, 404, 'err.document_not_found', 'not_found')
  if (!atLeast(dr.role, 'EDITOR')) return fail(res, 403, 'err.forbidden', 'forbidden')
  const body = z.object({ taskIds: z.array(z.string()).max(200) }).safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid', 'invalid')
  // Only tasks from the same project can be linked
  const result = await prisma.task.updateMany({
    where: { id: { in: body.data.taskIds }, projectId: dr.projectId },
    data: { documentId: req.params.id },
  })
  res.json({ linked: result.count })
})

documentsRouter.delete('/documents/:id/tasks/:taskId', async (req, res) => {
  const dr = await documentRole(req.uid!, req.params.id)
  if (!dr?.role) return fail(res, 404, 'err.document_not_found', 'not_found')
  if (!atLeast(dr.role, 'EDITOR')) return fail(res, 403, 'err.forbidden', 'forbidden')
  await prisma.task.updateMany({
    where: { id: req.params.taskId, documentId: req.params.id },
    data: { documentId: null },
  })
  res.json({ ok: true })
})

// ---- Comments ----

documentsRouter.post('/documents/:id/comments', async (req, res) => {
  const dr = await documentRole(req.uid!, req.params.id)
  if (!dr?.role) return fail(res, 404, 'err.document_not_found', 'not_found')
  if (!atLeast(dr.role, 'EDITOR')) return fail(res, 403, 'err.forbidden', 'forbidden')
  const text = String(req.body?.text ?? '').trim()
  if (!text) return fail(res, 400, 'err.comment_empty', 'invalid')
  const comment = await prisma.comment.create({
    data: { documentId: req.params.id, authorId: req.uid!, text },
    include: { author: { select: userLite } },
  })
  await logActivity(dr.projectId, null, req.uid, 'commented', { text: text.slice(0, 200) })
  void actorName(req.uid)
  res.status(201).json(comment)
})

// ---- Attachments ----

documentsRouter.post('/documents/:id/attachments', upload.single('file'), async (req, res) => {
  const dr = await documentRole(req.uid!, req.params.id)
  if (!dr?.role || !atLeast(dr.role, 'EDITOR')) {
    if (req.file) await unlink(req.file.path).catch(() => {})
    return fail(res, dr?.role ? 403 : 404, dr?.role ? 'err.forbidden' : 'err.document_not_found', dr?.role ? 'forbidden' : 'not_found')
  }
  if (!req.file) return fail(res, 400, 'err.file_required', 'invalid')
  const attachment = await prisma.attachment.create({
    data: {
      documentId: req.params.id,
      fileName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
      mime: req.file.mimetype,
      size: req.file.size,
      storedName: req.file.filename,
      uploaderId: req.uid!,
    },
    include: { uploader: { select: userLite } },
  })
  res.status(201).json(attachment)
})
