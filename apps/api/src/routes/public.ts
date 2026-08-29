import { Router } from 'express'
import { prisma } from '../db.js'
import { fail } from '../middleware.js'
import { t } from '../i18n.js'
import { taskInclude, serializeTask } from '../serialize.js'
import { accessibleProjectsWhere } from '../access.js'

export const publicRouter = Router()

// ---- Link shares: no sign-in, read only ----

publicRouter.get('/share/:token', async (req, res) => {
  const share = await prisma.linkShare.findUnique({
    where: { token: req.params.token, project: { deletedAt: null } },
    include: {
      project: {
        include: {
          buckets: { orderBy: { position: 'asc' } },
          tasks: { where: { deletedAt: null }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], include: taskInclude },
        },
      },
    },
  })
  if (!share) return fail(res, 404, 'err.share_not_found', 'not_found')
  const p = share.project
  res.json({
    id: p.id,
    title: p.title,
    description: p.description,
    color: p.color,
    buckets: p.buckets,
    tasks: p.tasks.map(serializeTask),
  })
})

// ---- ICS calendar feed, keyed by a personal secret token ----

function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')
}

function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

publicRouter.get('/ics/:icsToken.ics', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { icsToken: req.params.icsToken } })
  if (!user) return res.status(404).send('not found')
  const projects = await prisma.project.findMany({
    where: accessibleProjectsWhere(user.id),
    select: { id: true, title: true },
  })
  const tasks = await prisma.task.findMany({
    where: { projectId: { in: projects.map(p => p.id) }, deletedAt: null, dueDate: { not: null }, done: false },
    select: { id: true, title: true, dueDate: true, startDate: true, projectId: true, updatedAt: true },
    take: 1000,
  })
  const titles = new Map(projects.map(p => [p.id, p.title]))
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Tavi//TR',
    `X-WR-CALNAME:${t('ics.calendar_name')}`,
  ]
  for (const t of tasks) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${t.id}@tavi`,
      `DTSTAMP:${icsDate(t.updatedAt)}`,
      `DTSTART:${icsDate(t.startDate ?? t.dueDate!)}`,
      `DTEND:${icsDate(t.dueDate!)}`,
      `SUMMARY:${icsEscape(t.title)}`,
      `CATEGORIES:${icsEscape(titles.get(t.projectId) ?? 'Tavi')}`,
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
  res.send(lines.join('\r\n'))
})
