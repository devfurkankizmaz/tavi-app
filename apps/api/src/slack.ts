import { prisma } from './db.js'

/**
 * Posts to a Slack incoming webhook. A network failure changes nothing here;
 * the same notifications are already in the app.
 */
export async function postToSlack(webhookUrl: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, unfurl_links: false }),
      signal: AbortSignal.timeout(6000),
    })
    return res.ok
  } catch (err) {
    console.error('could not post to Slack:', err)
    return false
  }
}

/** Broadcasts to every team that can see the project and has a webhook. */
export async function broadcastToProjectTeams(projectId: string, text: string): Promise<void> {
  const shares = await prisma.projectTeamShare.findMany({
    where: { projectId, team: { slackWebhookUrl: { not: null } } },
    select: { team: { select: { slackWebhookUrl: true } } },
  })
  const urls = [...new Set(shares.map(s => s.team.slackWebhookUrl).filter((u): u is string => !!u))]
  await Promise.all(urls.map(url => postToSlack(url, text)))
}

export const slackLink = (url: string, label: string) => `<${url}|${label}>`
