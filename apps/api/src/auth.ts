import { Router, type Response } from 'express'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { OAuth2Client } from 'google-auth-library'
import { prisma } from './db.js'
import { fail } from './middleware.js'
import { createDefaultLabels } from './defaults.js'

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173'
const REDIRECT_URI = `${WEB_ORIGIN}/auth/google/callback`

const oauth = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI,
)

function issueSession(res: Response, userId: string) {
  const token = jwt.sign({ uid: userId }, process.env.JWT_SECRET!, { expiresIn: '30d' })
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === '1',
    maxAge: 30 * 24 * 3600 * 1000,
  })
}

export const authRouter = Router()

authRouter.use(rateLimit({ windowMs: 10 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false }))

// Which sign-in methods the login screen should offer; readable without a session
authRouter.get('/config', (_req, res) => {
  res.json({
    googleEnabled: !!process.env.GOOGLE_CLIENT_ID,
    registrationEnabled: process.env.REGISTRATION_ENABLED !== '0',
    devLogin: process.env.DEV_LOGIN === '1',
  })
})

// ---- Google OIDC ----

/**
 * Where to return after signing in. Only relative paths on this site are
 * accepted: "//evil.example" or "https://…" is ignored, otherwise a link in
 * an email could carry the reader off to somebody else's site.
 */
export function safeNext(value: unknown): string | null {
  const next = typeof value === 'string' ? value : ''
  if (!next.startsWith('/')) return null
  if (next.startsWith('//') || next.startsWith('/\\')) return null
  return next.slice(0, 512)
}

authRouter.get('/google/login', (req, res) => {
  const next = safeNext(req.query.next)
  res.redirect(oauth.generateAuthUrl({
    scope: ['openid', 'email', 'profile'],
    prompt: 'select_account',
    // The destination rides through OAuth in `state` and is revalidated on return
    state: next ?? undefined,
  }))
})

authRouter.get('/google/callback', async (req, res) => {
  try {
    const code = String(req.query.code ?? '')
    if (!code) return res.status(400).send('Google response is missing the code parameter')
    const { tokens } = await oauth.getToken(code)
    const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token!, audience: process.env.GOOGLE_CLIENT_ID })
    const p = ticket.getPayload()
    if (!p?.sub || !p.email) return res.status(400).send('Google profile is missing an id or email')

    // If a local account already uses this email, attach the Google identity to it
    const existing = await prisma.user.findUnique({ where: { email: p.email } })
    let user
    if (existing) {
      user = await prisma.user.update({
        where: { id: existing.id },
        data: { googleId: p.sub, avatarUrl: existing.avatarUrl ?? p.picture ?? null },
      })
    } else {
      user = await prisma.user.create({
        data: { googleId: p.sub, email: p.email, name: p.name ?? p.email, avatarUrl: p.picture ?? null },
      })
      await createDefaultLabels(user.id)
    }
    issueSession(res, user.id)
    res.redirect(safeNext(req.query.state) ?? '/')
  } catch (err) {
    console.error('Google callback failed:', err)
    res.status(500).send('Google sign-in failed — please try again')
  }
})

// ---- Local account ----

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(200),
})

authRouter.post('/register', async (req, res) => {
  if (process.env.REGISTRATION_ENABLED === '0')
    return fail(res, 403, 'err.registration_closed', 'forbidden')
  const body = registerSchema.safeParse(req.body)
  if (!body.success) return fail(res, 400, 'err.password_min', 'invalid')
  const { email, name, password } = body.data
  const exists = await prisma.user.findUnique({ where: { email } })
  if (exists) return fail(res, 409, 'err.email_taken', 'conflict')
  const user = await prisma.user.create({
    data: { email, name, passwordHash: await bcrypt.hash(password, 12) },
  })
  await createDefaultLabels(user.id)
  issueSession(res, user.id)
  res.status(201).json({ ok: true })
})

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {}
  if (typeof email !== 'string' || typeof password !== 'string')
    return fail(res, 400, 'err.credentials_required', 'invalid')
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user?.passwordHash || !(await bcrypt.compare(password, user.passwordHash)))
    return fail(res, 401, 'err.credentials', 'unauthorized')
  issueSession(res, user.id)
  res.json({ ok: true })
})

authRouter.post('/logout', (_req, res) => {
  res.clearCookie('token')
  res.json({ ok: true })
})

// Local development only: sign in without a round trip to Google (DEV_LOGIN=1)
if (process.env.DEV_LOGIN === '1') {
  authRouter.post('/dev-login', async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email : 'dev@local.test'
    const name = typeof req.body?.name === 'string' ? req.body.name : 'Dev User'
    const existing = await prisma.user.findUnique({ where: { email } })
    const user = existing ?? await prisma.user.create({ data: { email, name } })
    if (!existing) await createDefaultLabels(user.id)
    issueSession(res, user.id)
    res.json({ ok: true })
  })
}
