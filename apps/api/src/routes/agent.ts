import { Router } from 'express'
import { z } from 'zod'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { fail } from '../middleware.js'
import { agentConfig } from '../agent/config.js'
import { runAgent, isRateLimit, isAuthError, type HistoryTurn } from '../agent/runtime.js'
import { AssistError, suggestSubtasks, summarize } from '../agent/assist.js'

export const agentRouter = Router()

agentRouter.get('/agent/status', (_req, res) => {
  if (!agentConfig.enabled) return res.json({ enabled: false })
  // The key itself never leaves the server; only the limits it runs under
  // are visible, so a team can see what it allowed.
  res.json({
    enabled: true,
    model: agentConfig.model,
    effort: agentConfig.effort,
    limits: {
      steps: agentConfig.maxSteps,
      writes: agentConfig.maxWrites,
      bulk: agentConfig.maxBulk,
      timeoutMs: agentConfig.timeoutMs,
      requestsPer10Min: 40,
    },
  })
})

const chatBody = z.object({
  message: z.string().trim().min(1).max(4000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string().max(4000),
  })).max(24).optional(),
})

/** The assistant is an expensive resource; a few requests a minute is plenty. */
const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  /*
   * Counted per user when there is a session. Falling back to IP needs
   * `ipKeyGenerator`: a raw `req.ip` can differ per request over IPv6, which
   * let the limit be bypassed entirely.
   */
  keyGenerator: req => req.uid ?? ipKeyGenerator(req.ip ?? '') ?? 'anon',
})

/**
 * Touches outside the chat. These never write, they only suggest; applying
 * anything is the user's own doing, through the normal flows.
 */
agentRouter.post('/agent/suggest-subtasks', chatLimiter, async (req, res) => {
  if (!agentConfig.enabled) return fail(res, 503, 'err.agent_disabled', 'unavailable')
  const body = z.object({ taskId: z.string().min(1) }).safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid', 'invalid')
  return assist(req, res, () => suggestSubtasks(req.uid!, body.data.taskId).then(subtasks => ({ subtasks })))
})

agentRouter.post('/agent/summarize', chatLimiter, async (req, res) => {
  if (!agentConfig.enabled) return fail(res, 503, 'err.agent_disabled', 'unavailable')
  const body = z.object({
    kind: z.enum(['task', 'document', 'cycle']),
    id: z.string().min(1),
  }).safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid', 'invalid')
  return assist(req, res, () => summarize(req.uid!, body.data.kind, body.data.id))
})

/** Shared error translation for the non-chat calls. */
async function assist(
  req: import('express').Request,
  res: import('express').Response,
  run: () => Promise<unknown>,
) {
  try {
    res.json(await run())
  } catch (err) {
    if (err instanceof AssistError) return res.status(422).json({ error: err.message, code: 'assist' })
    if (isAuthError(err)) {
      console.error('agent auth error: the LLM key is not valid')
      return res.status(502).json({ error: 'The assistant key is not valid.', code: 'auth' })
    }
    if (isRateLimit(err)) {
      return res.status(429).json({ error: 'The assistant is rate limited right now.', code: 'rate_limit' })
    }
    console.error('assist error:', err)
    return res.status(500).json({ error: 'The assistant could not finish that.', code: 'internal' })
  }
}

agentRouter.post('/agent/chat', chatLimiter, async (req, res) => {
  if (!agentConfig.enabled) return fail(res, 503, 'err.agent_disabled', 'unavailable')
  const body = chatBody.safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.invalid', 'invalid')

  // Steps stream as they happen; a dropped connection stops the watching, not the work
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const send = (event: string, data: unknown) => {
    if (res.writableEnded) return
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  try {
    const turn = await runAgent({
      uid: req.uid!,
      message: body.data.message,
      history: (body.data.history ?? []) as HistoryTurn[],
      onStep: step => send('step', step),
    })
    send('done', turn)
  } catch (err) {
    if (isAuthError(err)) {
      console.error('agent auth error: the LLM key is not valid')
      send('error', { code: 'auth', message: 'The assistant key is not valid. Ask your admin to check it.' })
    } else if (isRateLimit(err)) {
      send('error', { code: 'rate_limit', message: 'The assistant is rate limited right now. Try again shortly.' })
    } else {
      console.error('agent error:', err)
      send('error', { code: 'internal', message: 'The assistant could not finish that. Nothing was left half-done.' })
    }
  } finally {
    res.end()
  }
})
