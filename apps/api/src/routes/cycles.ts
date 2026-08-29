import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db.js'
import { fail } from '../middleware.js'
import { taskInclude, serializeTask, userLite } from '../serialize.js'
import { broadcastToProjectTeams, postToSlack } from '../slack.js'
import { accessibleProjectsWhere } from '../access.js'

export const cyclesRouter = Router()

const isoDate = z.string().datetime({ offset: true }).or(z.string().datetime())

const cycleBody = z.object({
  name: z.string().trim().min(1).max(120),
  goal: z.string().max(2000).optional(),
  startsAt: isoDate,
  endsAt: isoDate,
})

async function memberOfTeam(uid: string, teamId: string) {
  return prisma.team.findFirst({
    where: { id: teamId, members: { some: { userId: uid } } },
    select: { id: true, name: true, slackWebhookUrl: true },
  })
}

async function reachableCycle(uid: string, cycleId: string) {
  return prisma.cycle.findFirst({
    where: { id: cycleId, team: { members: { some: { userId: uid } } } },
    include: { team: { select: { id: true, name: true, slackWebhookUrl: true } } },
  })
}

/** Progress by task count and points, the summary above the cycle board. */
function summarize(tasks: { status: string; done: boolean; estimate: number | null }[]) {
  const points = tasks.reduce((sum, t) => sum + (t.estimate ?? 0), 0)
  const donePoints = tasks.filter(t => t.done).reduce((sum, t) => sum + (t.estimate ?? 0), 0)
  const byStatus: Record<string, number> = {}
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1
  return {
    total: tasks.length,
    done: tasks.filter(t => t.done).length,
    points,
    donePoints,
    byStatus,
  }
}

// ---- Listing ----

cyclesRouter.get('/cycles', async (req, res) => {
  const cycles = await prisma.cycle.findMany({
    where: { team: { members: { some: { userId: req.uid! } } } },
    orderBy: [{ startsAt: 'desc' }],
    include: {
      team: { select: { id: true, name: true } },
      tasks: { where: { deletedAt: null }, select: { status: true, done: true, estimate: true } },
    },
  })
  res.json(cycles.map(c => ({
    id: c.id, name: c.name, goal: c.goal,
    startsAt: c.startsAt, endsAt: c.endsAt, closedAt: c.closedAt,
    team: c.team,
    summary: summarize(c.tasks),
  })))
})

cyclesRouter.post('/teams/:teamId/cycles', async (req, res) => {
  const team = await memberOfTeam(req.uid!, req.params.teamId)
  if (!team) return fail(res, 404, 'err.team_not_found', 'not_found')
  const body = cycleBody.safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid', 'invalid')
  const cycle = await prisma.cycle.create({
    data: {
      name: body.data.name,
      goal: body.data.goal ?? '',
      startsAt: new Date(body.data.startsAt),
      endsAt: new Date(body.data.endsAt),
      teamId: team.id,
    },
  })
  if (team.slackWebhookUrl) {
    await postToSlack(team.slackWebhookUrl, `:rocket: *${cycle.name}* has started${cycle.goal ? ` — ${cycle.goal}` : ''}`)
  }
  res.status(201).json(cycle)
})

// ---- Detail and board ----

cyclesRouter.get('/cycles/:id', async (req, res) => {
  const cycle = await reachableCycle(req.uid!, req.params.id)
  if (!cycle) return fail(res, 404, 'err.cycle_not_found', 'not_found')
  const tasks = await prisma.task.findMany({
    where: { cycleId: cycle.id, deletedAt: null },
    orderBy: [{ status: 'asc' }, { priority: 'desc' }, { position: 'asc' }],
    include: taskInclude,
  })
  const members = await prisma.teamMember.findMany({
    where: { teamId: cycle.teamId },
    include: { user: { select: userLite } },
  })

  // Workload per person: who is carrying what
  const serialized = tasks.map(serializeTask)
  const workload = members.map(m => {
    const own = serialized.filter(t => t.assignees.some(a => a.id === m.userId))
    return {
      user: m.user,
      total: own.length,
      done: own.filter(t => t.done).length,
      points: own.reduce((s, t) => s + (t.estimate ?? 0), 0),
      inProgress: own.filter(t => t.status === 'IN_PROGRESS').length,
    }
  })

  res.json({
    id: cycle.id,
    name: cycle.name,
    goal: cycle.goal,
    startsAt: cycle.startsAt,
    endsAt: cycle.endsAt,
    closedAt: cycle.closedAt,
    team: { id: cycle.team.id, name: cycle.team.name },
    tasks: serialized,
    summary: summarize(tasks),
    workload,
  })
})

cyclesRouter.patch('/cycles/:id', async (req, res) => {
  const cycle = await reachableCycle(req.uid!, req.params.id)
  if (!cycle) return fail(res, 404, 'err.cycle_not_found', 'not_found')
  const body = cycleBody.partial().extend({ closed: z.boolean().optional() }).safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid', 'invalid')
  const { closed, startsAt, endsAt, ...rest } = body.data
  const updated = await prisma.cycle.update({
    where: { id: cycle.id },
    data: {
      ...rest,
      ...(startsAt ? { startsAt: new Date(startsAt) } : {}),
      ...(endsAt ? { endsAt: new Date(endsAt) } : {}),
      ...(closed === undefined ? {} : { closedAt: closed ? new Date() : null }),
    },
  })
  if (closed && cycle.team.slackWebhookUrl) {
    const tasks = await prisma.task.findMany({ where: { cycleId: cycle.id, deletedAt: null }, select: { status: true, done: true, estimate: true } })
    const s = summarize(tasks)
    await postToSlack(
      cycle.team.slackWebhookUrl,
      `:checkered_flag: *${updated.name}* closed — ${s.done}/${s.total} tasks, ${s.donePoints}/${s.points} points`,
    )
  }
  res.json(updated)
})

cyclesRouter.delete('/cycles/:id', async (req, res) => {
  const cycle = await reachableCycle(req.uid!, req.params.id)
  if (!cycle) return fail(res, 404, 'err.cycle_not_found', 'not_found')
  await prisma.cycle.delete({ where: { id: cycle.id } })
  res.json({ ok: true })
})

/** Bulk add and remove for the planning screen. */
cyclesRouter.post('/cycles/:id/tasks', async (req, res) => {
  const cycle = await reachableCycle(req.uid!, req.params.id)
  if (!cycle) return fail(res, 404, 'err.cycle_not_found', 'not_found')
  const body = z.object({ taskIds: z.array(z.string()).max(200) }).safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid', 'invalid')

  // Team membership grants the cycle, project access grants the task, so
  // only tasks the user can already reach may be pulled in.
  const allowed = await prisma.task.findMany({
    where: {
      id: { in: body.data.taskIds },
      deletedAt: null,
      project: accessibleProjectsWhere(req.uid!),
    },
    select: { id: true, projectId: true },
  })
  await prisma.task.updateMany({
    where: { id: { in: allowed.map(t => t.id) } },
    data: { cycleId: cycle.id },
  })
  const skipped = body.data.taskIds.length - allowed.length
  if (allowed.length) {
    await broadcastToProjectTeams(allowed[0].projectId, `:dart: ${allowed.length} tasks added to *${cycle.name}*`)
  }
  res.json({ added: allowed.length, skipped })
})

cyclesRouter.delete('/cycles/:id/tasks/:taskId', async (req, res) => {
  const cycle = await reachableCycle(req.uid!, req.params.id)
  if (!cycle) return fail(res, 404, 'err.cycle_not_found', 'not_found')
  await prisma.task.updateMany({ where: { id: req.params.taskId, cycleId: cycle.id }, data: { cycleId: null } })
  res.json({ ok: true })
})
