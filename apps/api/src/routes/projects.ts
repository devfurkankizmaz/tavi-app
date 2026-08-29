import { Router } from 'express'
import { z } from 'zod'
import type { Role } from '@prisma/client'
import { prisma } from '../db.js'
import { projectRole, atLeast, accessibleProjectsWhere } from '../access.js'
import { taskInclude, serializeTask, userLite } from '../serialize.js'
import { notify, actorName } from '../notify.js'
import { fail } from '../middleware.js'
import { DEFAULT_BUCKETS } from '../defaults.js'
import { t } from '../i18n.js'
import { uniqueProjectKey, KEY_PATTERN } from '../keys.js'

export const projectsRouter = Router()

const roleSchema = z.enum(['VIEWER', 'EDITOR', 'ADMIN'])

type RoleCheck =
  | { ok: true; role: Role }
  | { ok: false; status: number; key: string; code: string }

async function requireRole(uid: string, projectId: string, min: Role): Promise<RoleCheck> {
  const role = await projectRole(uid, projectId)
  if (!role) return { ok: false, status: 404, key: 'err.project_not_found', code: 'not_found' }
  if (!atLeast(role, min)) return { ok: false, status: 403, key: 'err.forbidden', code: 'forbidden' }
  return { ok: true, role }
}

// ---- Listing and creation ----

projectsRouter.get('/projects', async (req, res) => {
  const uid = req.uid!
  const [projects, favorites] = await Promise.all([
    prisma.project.findMany({
      where: accessibleProjectsWhere(uid),
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      include: {
        _count: { select: { tasks: { where: { done: false, deletedAt: null } } } },
        members: { where: { userId: uid }, select: { role: true } },
        teamShares: { where: { team: { members: { some: { userId: uid } } } }, select: { role: true } },
      },
    }),
    prisma.favorite.findMany({ where: { userId: uid, kind: 'project' }, select: { targetId: true } }),
  ])
  const favSet = new Set(favorites.map(f => f.targetId))
  res.json(projects.map(p => ({
    id: p.id,
    title: p.title,
    color: p.color,
    archived: p.archived,
    openTasks: p._count.tasks,
    isFavorite: favSet.has(p.id),
    role: p.ownerId === uid ? 'ADMIN' : (p.members[0]?.role ?? p.teamShares[0]?.role ?? 'VIEWER'),
  })))
})

const projectBody = z.object({
  title: z.string().trim().min(1).max(250),
  description: z.string().max(10000).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
})

projectsRouter.post('/projects', async (req, res) => {
  const body = projectBody.safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid_project', 'invalid')
  const last = await prisma.project.aggregate({ where: { ownerId: req.uid! }, _max: { position: true } })
  const project = await prisma.project.create({
    data: {
      ...body.data,
      key: await uniqueProjectKey(body.data.title),
      ownerId: req.uid!,
      position: (last._max.position ?? 0) + 100,
      buckets: { create: DEFAULT_BUCKETS },
    },
  })
  res.status(201).json(project)
})

// ---- Detail ----

projectsRouter.get('/projects/:id', async (req, res) => {
  const uid = req.uid!
  const role = await projectRole(uid, req.params.id)
  if (!role) return fail(res, 404, 'err.project_not_found', 'not_found')
  const [project, favorites] = await Promise.all([
    prisma.project.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: {
        owner: { select: userLite },
        buckets: { orderBy: { position: 'asc' } },
        tasks: { where: { deletedAt: null }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], include: taskInclude },
        members: { include: { user: { select: userLite } } },
        teamShares: { include: { team: { select: { id: true, name: true } } } },
        linkShares: atLeast(role, 'ADMIN'),
      },
    }),
    prisma.favorite.findMany({ where: { userId: uid, kind: { in: ['project', 'task'] } }, select: { kind: true, targetId: true } }),
  ])
  if (!project) return fail(res, 404, 'err.project_not_found', 'not_found')
  const favTasks = new Set(favorites.filter(f => f.kind === 'task').map(f => f.targetId))
  res.json({
    ...project,
    linkShares: atLeast(role, 'ADMIN') ? project.linkShares : [],
    tasks: project.tasks.map(t => ({ ...serializeTask(t), isFavorite: favTasks.has(t.id) })),
    role,
    isFavorite: favorites.some(f => f.kind === 'project' && f.targetId === project.id),
  })
})

projectsRouter.patch('/projects/:id', async (req, res) => {
  const check = await requireRole(req.uid!, req.params.id, 'ADMIN')
  if (!check.ok) return fail(res, check.status, check.key, check.code)
  const body = projectBody.partial().extend({
    archived: z.boolean().optional(),
    position: z.number().optional(),
    key: z.string().trim().toUpperCase().regex(KEY_PATTERN).optional(),
  }).safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid_project', 'invalid')
  try {
    const updated = await prisma.project.update({ where: { id: req.params.id }, data: body.data })
    res.json(updated)
  } catch {
    return fail(res, 409, 'err.key_taken', 'conflict')
  }
})

/** Moves a project to trash; its tasks and docs go out of sight with it. */
projectsRouter.delete('/projects/:id', async (req, res) => {
  const check = await requireRole(req.uid!, req.params.id, 'ADMIN')
  if (!check.ok) return fail(res, check.status, check.key, check.code)
  const now = new Date()
  await prisma.project.update({ where: { id: req.params.id }, data: { deletedAt: now } })
  res.json({ ok: true, deletedAt: now })
})

// ---- Sharing with people ----

projectsRouter.post('/projects/:id/members', async (req, res) => {
  const check = await requireRole(req.uid!, req.params.id, 'ADMIN')
  if (!check.ok) return fail(res, check.status, check.key, check.code)
  const body = z.object({ email: z.string().email(), role: roleSchema.default('EDITOR') }).safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid', 'invalid')
  const user = await prisma.user.findUnique({ where: { email: body.data.email } })
  if (!user) return fail(res, 404, 'err.user_not_found', 'not_found')
  const project = await prisma.project.findUnique({ where: { id: req.params.id }, select: { ownerId: true, title: true } })
  if (project!.ownerId === user.id) return fail(res, 409, 'err.owner_has_access', 'conflict')
  const member = await prisma.projectMember.upsert({
    where: { projectId_userId: { projectId: req.params.id, userId: user.id } },
    update: { role: body.data.role },
    create: { projectId: req.params.id, userId: user.id, role: body.data.role },
    include: { user: { select: userLite } },
  })
  await notify([user.id], 'project_shared', { projectId: req.params.id, projectTitle: project!.title, actorName: await actorName(req.uid) }, req.uid)
  res.status(201).json(member)
})

projectsRouter.patch('/projects/:id/members/:userId', async (req, res) => {
  const check = await requireRole(req.uid!, req.params.id, 'ADMIN')
  if (!check.ok) return fail(res, check.status, check.key, check.code)
  const body = z.object({ role: roleSchema }).safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid_role', 'invalid')
  const member = await prisma.projectMember.update({
    where: { projectId_userId: { projectId: req.params.id, userId: req.params.userId } },
    data: { role: body.data.role },
  })
  res.json(member)
})

projectsRouter.delete('/projects/:id/members/:userId', async (req, res) => {
  const check = await requireRole(req.uid!, req.params.id, 'ADMIN')
  if (!check.ok) return fail(res, check.status, check.key, check.code)
  await prisma.projectMember.delete({
    where: { projectId_userId: { projectId: req.params.id, userId: req.params.userId } },
  })
  res.json({ ok: true })
})

// ---- Invitations by email; membership starts when they accept ----

projectsRouter.post('/projects/:id/invites', async (req, res) => {
  const check = await requireRole(req.uid!, req.params.id, 'ADMIN')
  if (!check.ok) return fail(res, check.status, check.key, check.code)
  const body = z.object({ email: z.string().email(), role: roleSchema.default('EDITOR') }).safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid_email', 'invalid')
  const email = body.data.email.toLowerCase()
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    select: { title: true, ownerId: true, members: { select: { user: { select: { email: true } } } } },
  })
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing && (project!.ownerId === existing.id || project!.members.some(m => m.user.email === email)))
    return fail(res, 409, 'err.already_member', 'conflict')
  const invitation = await prisma.invitation.create({
    data: { email, role: body.data.role, kind: 'project', projectId: req.params.id, inviterId: req.uid! },
  })
  if (existing) {
    await notify([existing.id], 'invite', {
      invitationId: invitation.id,
      projectId: req.params.id,
      projectTitle: project!.title,
      targetTitle: project!.title,
      actorName: await actorName(req.uid),
    }, req.uid)
  }
  res.status(201).json(invitation)
})

projectsRouter.delete('/projects/:id/invites/:inviteId', async (req, res) => {
  const check = await requireRole(req.uid!, req.params.id, 'ADMIN')
  if (!check.ok) return fail(res, check.status, check.key, check.code)
  await prisma.invitation.deleteMany({ where: { id: req.params.inviteId, projectId: req.params.id } })
  res.json({ ok: true })
})

// ---- Sharing with a team ----

projectsRouter.post('/projects/:id/team-shares', async (req, res) => {
  const check = await requireRole(req.uid!, req.params.id, 'ADMIN')
  if (!check.ok) return fail(res, check.status, check.key, check.code)
  const body = z.object({ teamId: z.string(), role: roleSchema.default('EDITOR') }).safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid', 'invalid')
  const team = await prisma.team.findFirst({
    where: { id: body.data.teamId, members: { some: { userId: req.uid! } } },
    include: { members: { select: { userId: true } } },
  })
  if (!team) return fail(res, 404, 'err.team_membership_required', 'not_found')
  const share = await prisma.projectTeamShare.upsert({
    where: { projectId_teamId: { projectId: req.params.id, teamId: team.id } },
    update: { role: body.data.role },
    create: { projectId: req.params.id, teamId: team.id, role: body.data.role },
    include: { team: { select: { id: true, name: true } } },
  })
  const project = await prisma.project.findUnique({ where: { id: req.params.id }, select: { title: true } })
  await notify(team.members.map(m => m.userId), 'project_shared', { projectId: req.params.id, projectTitle: project!.title, actorName: await actorName(req.uid) }, req.uid)
  res.status(201).json(share)
})

projectsRouter.delete('/projects/:id/team-shares/:teamId', async (req, res) => {
  const check = await requireRole(req.uid!, req.params.id, 'ADMIN')
  if (!check.ok) return fail(res, check.status, check.key, check.code)
  await prisma.projectTeamShare.delete({
    where: { projectId_teamId: { projectId: req.params.id, teamId: req.params.teamId } },
  })
  res.json({ ok: true })
})

// ---- Link sharing ----

projectsRouter.post('/projects/:id/link-shares', async (req, res) => {
  const check = await requireRole(req.uid!, req.params.id, 'ADMIN')
  if (!check.ok) return fail(res, check.status, check.key, check.code)
  const share = await prisma.linkShare.create({ data: { projectId: req.params.id } })
  res.status(201).json(share)
})

projectsRouter.delete('/projects/:id/link-shares/:shareId', async (req, res) => {
  const check = await requireRole(req.uid!, req.params.id, 'ADMIN')
  if (!check.ok) return fail(res, check.status, check.key, check.code)
  await prisma.linkShare.delete({ where: { id: req.params.shareId } })
  res.json({ ok: true })
})

// ---- Kanban columns ----

const bucketBody = z.object({
  title: z.string().trim().min(1).max(250).optional(),
  position: z.number().optional(),
  limit: z.number().int().min(0).max(1000).optional(),
  isDoneBucket: z.boolean().optional(),
})

projectsRouter.post('/projects/:id/buckets', async (req, res) => {
  const check = await requireRole(req.uid!, req.params.id, 'EDITOR')
  if (!check.ok) return fail(res, check.status, check.key, check.code)
  const body = bucketBody.safeParse(req.body)
  if (!body.success || !body.data.title) return fail(res, 400, 'err.bucket_title_required', 'invalid')
  const last = await prisma.bucket.aggregate({ where: { projectId: req.params.id }, _max: { position: true } })
  const bucket = await prisma.bucket.create({
    data: {
      title: body.data.title,
      limit: body.data.limit ?? 0,
      position: body.data.position ?? (last._max.position ?? 0) + 100,
      projectId: req.params.id,
    },
  })
  res.status(201).json(bucket)
})

projectsRouter.patch('/buckets/:bucketId', async (req, res) => {
  const bucket = await prisma.bucket.findUnique({ where: { id: req.params.bucketId } })
  if (!bucket) return fail(res, 404, 'err.bucket_not_found', 'not_found')
  const check = await requireRole(req.uid!, bucket.projectId, 'EDITOR')
  if (!check.ok) return fail(res, check.status, check.key, check.code)
  const body = bucketBody.safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid_bucket', 'invalid')
  if (body.data.isDoneBucket) {
    await prisma.bucket.updateMany({ where: { projectId: bucket.projectId }, data: { isDoneBucket: false } })
  }
  const updated = await prisma.bucket.update({ where: { id: bucket.id }, data: body.data })
  res.json(updated)
})

projectsRouter.delete('/buckets/:bucketId', async (req, res) => {
  const bucket = await prisma.bucket.findUnique({ where: { id: req.params.bucketId } })
  if (!bucket) return fail(res, 404, 'err.bucket_not_found', 'not_found')
  const check = await requireRole(req.uid!, bucket.projectId, 'EDITOR')
  if (!check.ok) return fail(res, check.status, check.key, check.code)
  const count = await prisma.bucket.count({ where: { projectId: bucket.projectId } })
  if (count <= 1) return fail(res, 400, 'err.last_bucket', 'invalid')
  await prisma.bucket.delete({ where: { id: bucket.id } })
  res.json({ ok: true })
})
