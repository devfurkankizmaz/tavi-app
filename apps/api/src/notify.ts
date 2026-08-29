import type { Prisma } from '@prisma/client'
import { prisma } from './db.js'
import { sendMail } from './mail.js'
import { renderMail } from './mail-template.js'
import { t } from './i18n.js'

/** The payload carries parameters only; wording comes from templates. */
export interface NotifyPayload {
  taskId?: string
  projectId?: string
  taskTitle?: string
  /** TAV-12, shown in the subject line and the fact list. */
  taskKey?: string
  dueDate?: string
  priority?: number
  projectTitle?: string
  targetTitle?: string
  actorName?: string
  invitationId?: string
  text?: string
}

/**
 * Every type that can reach a person, in the order the settings screen shows
 * them. Anything notify() is called with has to be here, or it becomes a
 * notification nobody can turn off.
 */
export const NOTIFICATION_TYPES = [
  'assigned',
  'comment',
  'status_changed',
  'unblocked',
  'reminder',
  'project_shared',
  'invite',
  'invite_accepted',
] as const

export type NotificationType = (typeof NOTIFICATION_TYPES)[number]

/** Types that also go out by email; the rest stay in the app. */
export const MAILED: ReadonlySet<string> = new Set([
  'assigned', 'comment', 'reminder', 'project_shared', 'invite', 'status_changed', 'unblocked',
])

export async function notify(
  userIds: string[],
  type: string,
  payload: NotifyPayload,
  actorId?: string,
): Promise<void> {
  const targets = [...new Set(userIds)].filter(u => u && u !== actorId)
  if (!targets.length) return

  // A row exists only for a preference somebody changed, so an account that
  // has never opened the settings screen behaves exactly as it always did.
  const preferences = await prisma.notificationPreference.findMany({
    where: { userId: { in: targets }, type },
  })
  const wants = (userId: string, channel: 'inApp' | 'email') =>
    preferences.find(p => p.userId === userId)?.[channel] ?? true

  const inbox = targets.filter(u => wants(u, 'inApp'))
  if (inbox.length) {
    await prisma.notification.createMany({
      data: inbox.map(userId => ({ userId, type, payload: payload as Prisma.InputJsonValue })),
    })
  }

  if (!MAILED.has(type)) return
  // The two channels are independent: silencing the inbox does not have to
  // silence the mail, and turning mail off still leaves the daily digest.
  const mailTo = targets.filter(u => wants(u, 'email'))
  if (!mailTo.length) return
  const users = await prisma.user.findMany({
    where: { id: { in: mailTo } },
    select: { email: true },
  })
  const origin = process.env.PUBLIC_ORIGIN ?? process.env.WEB_ORIGIN ?? 'http://localhost:5173'
  const path = payload.projectId
    ? `/projects/${payload.projectId}${payload.taskId ? `?task=${payload.taskId}` : ''}`
    : '/'
  // Signed out, the login screen returns here; signed in, it opens directly
  const link = `${origin}/go?to=${encodeURIComponent(path)}`

  const params: Record<string, string> = {
    taskTitle: payload.taskTitle ?? '',
    taskKey: payload.taskKey ?? '',
    projectTitle: payload.projectTitle ?? '',
    targetTitle: payload.targetTitle ?? '',
    text: payload.text ?? '',
    actorName: payload.actorName ?? t('someone'),
  }

  const facts: [string, string][] = []
  if (payload.taskKey) facts.push([t('mail.fact.task'), payload.taskKey])
  if (payload.projectTitle) facts.push([t('mail.fact.project'), payload.projectTitle])
  if (payload.dueDate) facts.push([t('mail.fact.due'), payload.dueDate.slice(0, 10)])
  if (payload.priority) facts.push([t('mail.fact.priority'), t(`priority.${payload.priority}` as 'priority.1')])

  const subject = t(`notif.${type}.subject`, params)
  const { html, text } = renderMail({
    heading: t(`notif.${type}.subject`, params),
    lines: [t(`notif.${type}.body`, params)],
    facts,
    action: payload.projectId
      ? { label: t(payload.taskId ? 'mail.openTask' : 'mail.openProject'), url: link }
      : undefined,
  })
  await Promise.all(users.map(u => sendMail(u.email, subject, text, html)))
}

/** The actor name that appears in notification text. */
export async function actorName(uid?: string): Promise<string | undefined> {
  if (!uid) return undefined
  const user = await prisma.user.findUnique({ where: { id: uid }, select: { name: true } })
  return user?.name
}
