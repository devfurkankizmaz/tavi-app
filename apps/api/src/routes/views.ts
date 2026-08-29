/**
 * Saved views: a named filter set, stored as the query string the screen
 * already puts in the URL.
 *
 * The server never parses `query`. That is deliberate — adding a filter to
 * the UI would otherwise mean a migration here, and a saved view whose
 * filters the server half-understood would be worse than one it treats as
 * opaque text. The screen that wrote it is the only thing that reads it.
 */
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db.js'
import { fail } from '../middleware.js'
import { atLeast, projectRole } from '../access.js'

export const viewsRouter = Router()

const MAX_PER_USER = 100

const bodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  query: z.string().max(2000),
  projectId: z.string().nullish(),
  shared: z.boolean().default(false),
})

/**
 * Own views, plus anything shared by someone else on the same project.
 * Without `projectId` this returns the views that belong to no project —
 * the ones the cross-project screens use.
 */
viewsRouter.get('/views', async (req, res) => {
  const uid = req.uid!
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : null

  if (projectId) {
    const role = await projectRole(uid, projectId)
    if (!role) return fail(res, 404, 'err.project_not_found', 'not_found')
  }

  const views = await prisma.savedView.findMany({
    where: {
      projectId,
      OR: [{ ownerId: uid }, { shared: true }],
    },
    orderBy: [{ name: 'asc' }],
    include: { owner: { select: { id: true, name: true } } },
  })

  res.json(views.map(v => ({
    id: v.id,
    name: v.name,
    query: v.query,
    projectId: v.projectId,
    shared: v.shared,
    mine: v.ownerId === uid,
    ownerName: v.owner.name,
  })))
})

viewsRouter.post('/views', async (req, res) => {
  const body = bodySchema.safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid_request', 'invalid')
  const uid = req.uid!
  const { name, query, shared } = body.data
  const projectId = body.data.projectId ?? null

  // Sharing a view puts your name on somebody else's screen, so it takes the
  // same standing as changing the project: a viewer can save, not share.
  if (projectId) {
    const role = await projectRole(uid, projectId)
    if (!role) return fail(res, 404, 'err.project_not_found', 'not_found')
    if (shared && !atLeast(role, 'EDITOR')) return fail(res, 403, 'err.forbidden', 'forbidden')
  } else if (shared) {
    // Nothing scopes a shared view that belongs to no project, so it would
    // land on every account in the instance.
    return fail(res, 400, 'err.view_share_needs_project', 'invalid')
  }

  const count = await prisma.savedView.count({ where: { ownerId: uid } })
  if (count >= MAX_PER_USER) return fail(res, 400, 'err.view_limit', 'invalid')

  const view = await prisma.savedView.create({
    data: { name, query, projectId, shared, ownerId: uid },
  })
  res.status(201).json({ id: view.id, name: view.name, query: view.query, projectId: view.projectId, shared: view.shared, mine: true })
})

viewsRouter.patch('/views/:id', async (req, res) => {
  const body = bodySchema.partial().safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid_request', 'invalid')
  const uid = req.uid!

  const view = await prisma.savedView.findUnique({ where: { id: req.params.id } })
  // Only the author edits a view. Someone else's shared view is theirs to
  // change; copying it is the way to make it yours.
  if (!view || view.ownerId !== uid) return fail(res, 404, 'err.view_not_found', 'not_found')

  if (body.data.shared && !view.projectId) {
    return fail(res, 400, 'err.view_share_needs_project', 'invalid')
  }
  if (body.data.shared && view.projectId) {
    const role = await projectRole(uid, view.projectId)
    if (!atLeast(role, 'EDITOR')) return fail(res, 403, 'err.forbidden', 'forbidden')
  }

  const updated = await prisma.savedView.update({
    where: { id: view.id },
    data: {
      ...(body.data.name !== undefined ? { name: body.data.name } : {}),
      ...(body.data.query !== undefined ? { query: body.data.query } : {}),
      ...(body.data.shared !== undefined ? { shared: body.data.shared } : {}),
    },
  })
  res.json({ id: updated.id, name: updated.name, query: updated.query, projectId: updated.projectId, shared: updated.shared, mine: true })
})

viewsRouter.delete('/views/:id', async (req, res) => {
  const uid = req.uid!
  const deleted = await prisma.savedView.deleteMany({ where: { id: req.params.id, ownerId: uid } })
  if (!deleted.count) return fail(res, 404, 'err.view_not_found', 'not_found')
  res.json({ ok: true })
})
