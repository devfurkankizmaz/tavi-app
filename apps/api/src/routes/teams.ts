import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db.js'
import { userLite } from '../serialize.js'
import { notify, actorName } from '../notify.js'
import { postToSlack } from '../slack.js'
import { fail } from '../middleware.js'

export const teamsRouter = Router()

async function teamAccess(uid: string, teamId: string) {
  const team = await prisma.team.findFirst({
    where: { id: teamId, members: { some: { userId: uid } } },
    include: { members: { include: { user: { select: userLite } } } },
  })
  if (!team) return null
  const me = team.members.find(m => m.userId === uid)
  return { team, isAdmin: team.createdById === uid || !!me?.admin }
}

teamsRouter.get('/teams', async (req, res) => {
  const teams = await prisma.team.findMany({
    where: { members: { some: { userId: req.uid! } } },
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { members: true, projectShares: true } } },
  })
  res.json(teams.map(t => ({
    id: t.id, name: t.name, createdById: t.createdById,
    memberCount: t._count.members, projectCount: t._count.projectShares,
  })))
})

teamsRouter.post('/teams', async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.team_name_required', 'invalid')
  const team = await prisma.team.create({
    data: {
      name: body.data.name,
      createdById: req.uid!,
      members: { create: { userId: req.uid!, admin: true } },
    },
  })
  res.status(201).json(team)
})

teamsRouter.get('/teams/:id', async (req, res) => {
  const access = await teamAccess(req.uid!, req.params.id)
  if (!access) return fail(res, 404, 'err.team_not_found', 'not_found')
  const invitations = access.isAdmin
    ? await prisma.invitation.findMany({ where: { teamId: req.params.id, status: 'PENDING' } })
    : []
  const shares = await prisma.projectTeamShare.findMany({
    where: { teamId: req.params.id },
    include: { project: { select: { id: true, title: true, color: true } } },
  })
  res.json({
    id: access.team.id,
    name: access.team.name,
    createdById: access.team.createdById,
    isAdmin: access.isAdmin,
    slackConnected: !!access.team.slackWebhookUrl,
    members: access.team.members.map(m => ({ ...m.user, admin: m.admin })),
    invitations,
    projects: shares.map(s => ({ ...s.project, role: s.role })),
  })
})

teamsRouter.patch('/teams/:id', async (req, res) => {
  const access = await teamAccess(req.uid!, req.params.id)
  if (!access) return fail(res, 404, 'err.team_not_found', 'not_found')
  if (!access.isAdmin) return fail(res, 403, 'err.team_admin_required', 'forbidden')
  const body = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.team_name_required', 'invalid')
  res.json(await prisma.team.update({ where: { id: req.params.id }, data: { name: body.data.name } }))
})

teamsRouter.delete('/teams/:id', async (req, res) => {
  const access = await teamAccess(req.uid!, req.params.id)
  if (!access) return fail(res, 404, 'err.team_not_found', 'not_found')
  if (!access.isAdmin) return fail(res, 403, 'err.team_admin_required', 'forbidden')
  await prisma.team.delete({ where: { id: req.params.id } })
  res.json({ ok: true })
})

// ---- Davet ----

teamsRouter.post('/teams/:id/invites', async (req, res) => {
  const access = await teamAccess(req.uid!, req.params.id)
  if (!access) return fail(res, 404, 'err.team_not_found', 'not_found')
  if (!access.isAdmin) return fail(res, 403, 'err.team_admin_required', 'forbidden')
  const body = z.object({ email: z.string().email() }).safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid_email', 'invalid')
  const email = body.data.email.toLowerCase()
  if (access.team.members.some(m => m.user.email === email))
    return fail(res, 409, 'err.already_member', 'conflict')
  const invitation = await prisma.invitation.create({
    data: { email, kind: 'team', teamId: req.params.id, inviterId: req.uid! },
  })
  const invitee = await prisma.user.findUnique({ where: { email } })
  if (invitee) {
    await notify([invitee.id], 'invite', {
      invitationId: invitation.id,
      targetTitle: access.team.name,
      actorName: await actorName(req.uid),
    }, req.uid)
  }
  res.status(201).json(invitation)
})

teamsRouter.delete('/teams/:id/members/:userId', async (req, res) => {
  const access = await teamAccess(req.uid!, req.params.id)
  if (!access) return fail(res, 404, 'err.team_not_found', 'not_found')
  const self = req.params.userId === req.uid
  if (!access.isAdmin && !self) return fail(res, 403, 'err.team_admin_required', 'forbidden')
  if (req.params.userId === access.team.createdById)
    return fail(res, 400, 'err.team_owner_remove', 'invalid')
  await prisma.teamMember.delete({
    where: { teamId_userId: { teamId: req.params.id, userId: req.params.userId } },
  })
  res.json({ ok: true })
})

teamsRouter.patch('/teams/:id/members/:userId', async (req, res) => {
  const access = await teamAccess(req.uid!, req.params.id)
  if (!access) return fail(res, 404, 'err.team_not_found', 'not_found')
  if (!access.isAdmin) return fail(res, 403, 'err.team_admin_required', 'forbidden')
  const admin = !!req.body?.admin
  res.json(await prisma.teamMember.update({
    where: { teamId_userId: { teamId: req.params.id, userId: req.params.userId } },
    data: { admin },
  }))
})

// ---- Slack entegrasyonu ----

teamsRouter.put('/teams/:id/slack', async (req, res) => {
  const access = await teamAccess(req.uid!, req.params.id)
  if (!access) return fail(res, 404, 'err.team_not_found', 'not_found')
  if (!access.isAdmin) return fail(res, 403, 'err.team_admin_required', 'forbidden')
  const body = z.object({
    webhookUrl: z.string().url().startsWith('https://hooks.slack.com/').nullable(),
  }).safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid_slack_url', 'invalid')

  await prisma.team.update({
    where: { id: access.team.id },
    data: { slackWebhookUrl: body.data.webhookUrl },
  })
  // Post a confirmation on connect so a wrong URL fails loudly, not silently
  if (body.data.webhookUrl) {
    const ok = await postToSlack(body.data.webhookUrl, `:white_check_mark: *${access.team.name}* is connected to Tavi. Task notifications will land here.`)
    if (!ok) {
      await prisma.team.update({ where: { id: access.team.id }, data: { slackWebhookUrl: null } })
      return fail(res, 400, 'err.slack_failed', 'invalid')
    }
  }
  res.json({ connected: !!body.data.webhookUrl })
})
