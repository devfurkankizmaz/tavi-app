import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { prisma } from './db.js'
import { notify } from './notify.js'
import { sendMail } from './mail.js'
import { renderMail } from './mail-template.js'
import { t } from './i18n.js'
import { RETENTION_DAYS } from './routes/trash.js'

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.resolve('data/attachments')

/** Turns due reminders into notifications, once a minute. */
async function processReminders(): Promise<void> {
  const due = await prisma.reminder.findMany({
    where: { sent: false, remindAt: { lte: new Date() } },
    include: {
      task: {
        select: {
          id: true, title: true, projectId: true, createdById: true, done: true,
          assignees: { select: { userId: true } },
        },
      },
    },
    take: 200,
  })
  for (const r of due) {
    await prisma.reminder.update({ where: { id: r.id }, data: { sent: true } })
    if (r.task.done) continue
    const targets = r.task.assignees.length
      ? r.task.assignees.map(a => a.userId)
      : r.task.createdById ? [r.task.createdById] : []
    await notify(targets, 'reminder', {
      taskId: r.task.id, projectId: r.task.projectId, taskTitle: r.task.title,
    })
  }
}

/** At most this many lines in one digest; the rest become a count. */
const DIGEST_LINES = 12

/**
 * The daily digest: one email summarising what is still unread in the inbox.
 *
 * Runs hourly and picks up whoever asked for this hour, so a person who wants
 * 07:00 gets it at 07:00 UTC. It is deliberately independent of the immediate
 * emails — turning those off and leaving the digest on is the setting most
 * people actually want, and it still works when every type is silenced,
 * because it reads the inbox rather than the mail settings.
 */
async function sendDigests(): Promise<void> {
  const now = new Date()
  const recipients = await prisma.user.findMany({
    where: {
      digestHour: now.getUTCHours(),
      // A restart inside the same hour must not send a second copy.
      OR: [{ lastDigestAt: null }, { lastDigestAt: { lt: new Date(now.getTime() - 23 * 3600_000) } }],
    },
    select: { id: true, email: true },
  })

  for (const user of recipients) {
    const unread = await prisma.notification.findMany({
      where: { userId: user.id, readAt: null, archivedAt: null },
      orderBy: { createdAt: 'desc' },
      take: DIGEST_LINES + 1,
    })

    // Stamped even when there is nothing to send, so the hour is not
    // reconsidered on every tick for the rest of the day.
    await prisma.user.update({ where: { id: user.id }, data: { lastDigestAt: now } })
    if (!unread.length) continue

    const total = await prisma.notification.count({
      where: { userId: user.id, readAt: null, archivedAt: null },
    })

    const lines = unread.slice(0, DIGEST_LINES).map(item => {
      const payload = (item.payload ?? {}) as Record<string, unknown>
      const params = {
        taskTitle: String(payload.taskTitle ?? ''),
        taskKey: String(payload.taskKey ?? ''),
        projectTitle: String(payload.projectTitle ?? ''),
        targetTitle: String(payload.targetTitle ?? ''),
        text: String(payload.text ?? ''),
        actorName: String(payload.actorName ?? t('someone')),
      }
      // The same sentence the individual email would have used, so the digest
      // never invents wording of its own.
      const sentence = t(`notif.${item.type}.body`, params)
      return params.taskKey ? `${params.taskKey} — ${sentence}` : sentence
    })
    if (total > DIGEST_LINES) lines.push(t('digest.more', { count: total - DIGEST_LINES }))

    const origin = process.env.PUBLIC_ORIGIN ?? process.env.WEB_ORIGIN ?? 'http://localhost:5173'
    const { html, text } = renderMail({
      heading: t('digest.heading'),
      lines: [t('digest.intro'), ...lines],
      action: { label: t('digest.open'), url: `${origin}/go?to=${encodeURIComponent('/inbox')}` },
    })
    const noun = t(total === 1 ? 'digest.noun.one' : 'digest.noun.many')
    await sendMail(user.email, t('digest.subject', { count: total, noun }), text, html)
  }
}

/** Purges expired trash for good; daily is often enough. */
async function purgeExpired(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000)
  const where = { deletedAt: { lt: cutoff } }

  const files = await prisma.attachment.findMany({
    where: {
      OR: [
        { task: where },
        { document: where },
        { task: { project: where } },
        { document: { project: where } },
      ],
    },
    select: { storedName: true },
  })

  const [tasks, docs, projects] = await Promise.all([
    prisma.task.deleteMany({ where }),
    prisma.document.deleteMany({ where }),
    prisma.project.deleteMany({ where }),
  ])
  await Promise.all(files.map(f => unlink(path.join(UPLOAD_DIR, f.storedName)).catch(() => {})))

  const total = tasks.count + docs.count + projects.count
  if (total) console.log(`trash purged: ${total} records past ${RETENTION_DAYS} days`)
}

export function startWorker(): void {
  const tick = () => {
    processReminders().catch(err => console.error('reminder worker failed:', err))
  }
  tick()
  setInterval(tick, 60_000)

  // Hourly, not daily: the hour a person chose is the whole point.
  const digest = () => {
    sendDigests().catch(err => console.error('digest worker failed:', err))
  }
  digest()
  setInterval(digest, 3600_000)

  const purge = () => {
    purgeExpired().catch(err => console.error('trash purge failed:', err))
  }
  purge()
  setInterval(purge, 24 * 3600_000)
}
