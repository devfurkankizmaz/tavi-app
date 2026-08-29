import { Router } from 'express'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { prisma } from '../db.js'
import { sha256 } from '../middleware.js'
import { accessibleProjectsWhere } from '../access.js'
import { taskInclude, serializeTask, projectLite } from '../serialize.js'
import { notify, actorName, NOTIFICATION_TYPES, MAILED } from '../notify.js'
import { fail } from '../middleware.js'

export const accountRouter = Router()

accountRouter.get('/me', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.uid! } })
  if (!user) return fail(res, 401, 'err.unauthorized', 'unauthorized')
  res.json({
    id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl,
    icsToken: user.icsToken, hasPassword: !!user.passwordHash, hasGoogle: !!user.googleId,
  })
})

accountRouter.patch('/me', async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid_name', 'invalid')
  const user = await prisma.user.update({ where: { id: req.uid! }, data: body.data })
  res.json({ id: user.id, name: user.name })
})

accountRouter.post('/me/password', async (req, res) => {
  const body = z.object({ current: z.string().optional(), next: z.string().min(8).max(200) }).safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.password_min', 'invalid')
  const user = await prisma.user.findUnique({ where: { id: req.uid! } })
  if (user!.passwordHash) {
    if (!body.data.current || !(await bcrypt.compare(body.data.current, user!.passwordHash)))
      return fail(res, 403, 'err.password_wrong', 'forbidden')
  }
  await prisma.user.update({
    where: { id: req.uid! },
    data: { passwordHash: await bcrypt.hash(body.data.next, 12) },
  })
  res.json({ ok: true })
})

// ---- User search, for the assignment and sharing pickers ----

accountRouter.get('/users/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim()
  if (q.length < 2) return res.json([])
  const users = await prisma.user.findMany({
    where: { OR: [{ email: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] },
    select: { id: true, name: true, email: true, avatarUrl: true },
    take: 8,
  })
  res.json(users)
})

/**
 * A teammate's profile. Everything shown is bounded by the projects the
 * requester can reach, so unshared work never leaks.
 */
accountRouter.get('/users/:id', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: { id: true, name: true, email: true, avatarUrl: true, createdAt: true },
  })
  if (!user) return fail(res, 404, 'err.user_not_found', 'not_found')

  const visibleProjects = await prisma.project.findMany({
    where: accessibleProjectsWhere(req.uid!),
    select: { id: true },
  })
  const projectIds = visibleProjects.map(p => p.id)

  /*
   * Profiles are for people you work with. Someone with no shared project or
   * team should not even see the name and email: filtering the contents is not
   * enough, because an empty profile still reveals "a user with this id has
   * this email".
   */
  if (user.id !== req.uid) {
    const [sharesProject, sharesTeam] = await Promise.all([
      prisma.project.count({
        where: {
          id: { in: projectIds },
          OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
        },
      }),
      prisma.team.count({
        where: {
          members: { some: { userId: user.id } },
          AND: { members: { some: { userId: req.uid! } } },
        },
      }),
    ])
    if (!sharesProject && !sharesTeam) return fail(res, 404, 'err.user_not_found', 'not_found')
  }

  const [openTasks, doneCount, sharedProjects, sharedTeams, activity] = await Promise.all([
    prisma.task.findMany({
      where: { projectId: { in: projectIds }, deletedAt: null, done: false, assignees: { some: { userId: user.id } } },
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { priority: 'desc' }],
      take: 20,
      include: taskInclude,
    }),
    prisma.task.count({
      where: { projectId: { in: projectIds }, deletedAt: null, done: true, assignees: { some: { userId: user.id } } },
    }),
    prisma.project.findMany({
      where: {
        id: { in: projectIds },
        OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      },
      select: projectLite,
      take: 12,
    }),
    prisma.team.findMany({
      where: {
        members: { some: { userId: user.id } },
        AND: { members: { some: { userId: req.uid! } } },
      },
      select: { id: true, name: true },
    }),
    prisma.activity.findMany({
      where: { projectId: { in: projectIds }, actorId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 12,
      include: { task: { select: { id: true, number: true, title: true, projectId: true, project: { select: { key: true } } } } },
    }),
  ])

  res.json({
    user,
    isMe: user.id === req.uid,
    openTasks: openTasks.map(serializeTask),
    doneCount,
    projects: sharedProjects,
    teams: sharedTeams,
    activity: activity.map(a => ({
      id: a.id,
      kind: a.kind,
      meta: a.meta,
      createdAt: a.createdAt,
      task: a.task
        ? { id: a.task.id, projectId: a.task.projectId, title: a.task.title, key: `${a.task.project.key}-${a.task.number}` }
        : null,
    })),
  })
})

// ---- API tokens ----

accountRouter.get('/me/tokens', async (req, res) => {
  const tokens = await prisma.apiToken.findMany({
    where: { userId: req.uid! },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, lastUsedAt: true, createdAt: true },
  })
  res.json(tokens)
})

accountRouter.post('/me/tokens', async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.token_name_required', 'invalid')
  const plain = 'sct_' + randomBytes(32).toString('hex')
  const token = await prisma.apiToken.create({
    data: { name: body.data.name, tokenHash: sha256(plain), userId: req.uid! },
  })
  // The plain token appears in this response only and is never stored
  res.status(201).json({ id: token.id, name: token.name, token: plain })
})

accountRouter.delete('/me/tokens/:id', async (req, res) => {
  await prisma.apiToken.deleteMany({ where: { id: req.params.id, userId: req.uid! } })
  res.json({ ok: true })
})

// ---- Notifications ----

accountRouter.get('/notifications', async (req, res) => {
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: req.uid!, archivedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.notification.count({ where: { userId: req.uid!, readAt: null, archivedAt: null } }),
  ])
  res.json({ items, unread })
})

accountRouter.post('/notifications/read', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : null
  await prisma.notification.updateMany({
    where: { userId: req.uid!, readAt: null, archivedAt: null, ...(ids ? { id: { in: ids } } : {}) },
    data: { readAt: new Date() },
  })
  res.json({ ok: true })
})

// ---- Favourites ----

accountRouter.post('/favorites', async (req, res) => {
  const body = z.object({ kind: z.enum(['project', 'task']), targetId: z.string() }).safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid', 'invalid')
  await prisma.favorite.upsert({
    where: { userId_kind_targetId: { userId: req.uid!, ...body.data } },
    update: {},
    create: { userId: req.uid!, ...body.data },
  })
  res.status(201).json({ ok: true })
})

accountRouter.delete('/favorites/:kind/:targetId', async (req, res) => {
  await prisma.favorite.deleteMany({
    where: { userId: req.uid!, kind: req.params.kind, targetId: req.params.targetId },
  })
  res.json({ ok: true })
})

// ---- Invitations (inbox) ----

accountRouter.get('/invites', async (req, res) => {
  const me = await prisma.user.findUnique({ where: { id: req.uid! }, select: { email: true } })
  const invites = await prisma.invitation.findMany({
    where: { email: me!.email.toLowerCase(), status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    include: {
      project: { select: { id: true, title: true, color: true } },
      team: { select: { id: true, name: true } },
      inviter: { select: { id: true, name: true } },
    },
  })
  res.json(invites)
})

accountRouter.post('/invites/:id/accept', async (req, res) => {
  const me = await prisma.user.findUnique({ where: { id: req.uid! }, select: { id: true, email: true, name: true } })
  const invite = await prisma.invitation.findFirst({
    where: { id: req.params.id, email: me!.email.toLowerCase(), status: 'PENDING' },
  })
  if (!invite) return fail(res, 404, 'err.invite_not_found', 'not_found')
  let team: { name: string } | null = null
  let project: { title: string } | null = null
  if (invite.kind === 'team' && invite.teamId) {
    team = await prisma.team.findUnique({ where: { id: invite.teamId }, select: { name: true } })
    await prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: invite.teamId, userId: me!.id } },
      update: {},
      create: { teamId: invite.teamId, userId: me!.id },
    })
  } else if (invite.kind === 'project' && invite.projectId) {
    project = await prisma.project.findUnique({ where: { id: invite.projectId }, select: { title: true } })
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: invite.projectId, userId: me!.id } },
      update: { role: invite.role },
      create: { projectId: invite.projectId, userId: me!.id, role: invite.role },
    })
  }
  await prisma.invitation.update({ where: { id: invite.id }, data: { status: 'ACCEPTED' } })
  if (invite.inviterId) {
    await notify([invite.inviterId], 'invite_accepted', {
      actorName: me!.name,
      targetTitle: invite.kind === 'team' ? (team?.name ?? '') : (project?.title ?? ''),
    }, me!.id)
  }
  res.json({ ok: true })
})

accountRouter.post('/invites/:id/decline', async (req, res) => {
  const me = await prisma.user.findUnique({ where: { id: req.uid! }, select: { email: true } })
  const updated = await prisma.invitation.updateMany({
    where: { id: req.params.id, email: me!.email.toLowerCase(), status: 'PENDING' },
    data: { status: 'DECLINED' },
  })
  if (!updated.count) return fail(res, 404, 'err.invite_not_found', 'not_found')
  res.json({ ok: true })
})

// ---- Notification preferences ----

/**
 * A missing row means the default, so this returns the effective setting for
 * every type rather than only the ones somebody has touched. `canEmail` says
 * whether the type ever sends mail at all — showing a switch that does
 * nothing would be a lie.
 */
accountRouter.get('/me/notifications', async (req, res) => {
  const [user, rows] = await Promise.all([
    prisma.user.findUnique({ where: { id: req.uid! }, select: { digestHour: true } }),
    prisma.notificationPreference.findMany({ where: { userId: req.uid! } }),
  ])
  res.json({
    digestHour: user?.digestHour ?? null,
    preferences: NOTIFICATION_TYPES.map(type => {
      const row = rows.find(r => r.type === type)
      return {
        type,
        inApp: row?.inApp ?? true,
        email: MAILED.has(type) ? row?.email ?? true : false,
        canEmail: MAILED.has(type),
      }
    }),
  })
})

accountRouter.put('/me/notifications', async (req, res) => {
  const body = z.object({
    // Null turns the digest off; 0–23 is the hour, read as UTC.
    digestHour: z.number().int().min(0).max(23).nullable().optional(),
    preferences: z.array(z.object({
      type: z.enum(NOTIFICATION_TYPES),
      inApp: z.boolean(),
      email: z.boolean(),
    })).max(NOTIFICATION_TYPES.length).optional(),
  }).safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid_request', 'invalid')

  const uid = req.uid!
  if (body.data.digestHour !== undefined) {
    await prisma.user.update({ where: { id: uid }, data: { digestHour: body.data.digestHour } })
  }
  for (const p of body.data.preferences ?? []) {
    // Types that never email are stored with email off, so the row cannot
    // later start mailing if the type joins MAILED.
    const email = MAILED.has(p.type) && p.email
    await prisma.notificationPreference.upsert({
      where: { userId_type: { userId: uid, type: p.type } },
      create: { userId: uid, type: p.type, inApp: p.inApp, email },
      update: { inApp: p.inApp, email },
    })
  }
  res.json({ ok: true })
})

// ---- Export ----

accountRouter.get('/export', async (req, res) => {
  const uid = req.uid!
  const [user, projects, teams, labels] = await Promise.all([
    prisma.user.findUnique({ where: { id: uid }, select: { email: true, name: true, createdAt: true } }),
    prisma.project.findMany({
      where: accessibleProjectsWhere(uid),
      include: {
        buckets: true,
        // Without these two an export could not be imported back without
        // losing the specs and every blocking relation.
        documents: { where: { deletedAt: null } },
        tasks: {
          where: { deletedAt: null },
          include: {
            labels: { include: { label: true } },
            assignees: { include: { user: { select: { email: true, name: true } } } },
            comments: { include: { author: { select: { email: true, name: true } } } },
            reminders: true,
            subtasks: { select: { id: true } },
            relationsFrom: { select: { toId: true, kind: true } },
          },
        },
      },
    }),
    prisma.team.findMany({ where: { members: { some: { userId: uid } } }, include: { members: { include: { user: { select: { email: true, name: true } } } } } }),
    prisma.label.findMany({ where: { ownerId: uid } }),
  ])
  res.setHeader('Content-Disposition', 'attachment; filename="tavi-export.json"')
  res.json({ exportedAt: new Date().toISOString(), user, projects, teams, labels })
})
