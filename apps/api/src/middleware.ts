import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { createHash } from 'node:crypto'
import { prisma } from './db.js'
import { t } from './i18n.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      uid?: string
    }
  }
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** One error shape everywhere: a message for people, a code for clients. */
export function fail(
  res: Response,
  status: number,
  key: string,
  code: string,
  /** Where the failure was, when a message alone would not be actionable. */
  detail?: string,
) {
  return res.status(status).json({ error: t(key), code, ...(detail ? { detail } : {}) })
}

/** Accepts either the cookie JWT or `Authorization: Bearer <api-token>`. */
export async function requireUser(req: Request, res: Response, next: NextFunction) {
  const cookieToken = req.cookies?.token as string | undefined
  if (cookieToken) {
    try {
      const payload = jwt.verify(cookieToken, process.env.JWT_SECRET!) as { uid: string }
      req.uid = payload.uid
      return next()
    } catch {
      /* fall through to bearer */
    }
  }
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]
  if (bearer) {
    const token = await prisma.apiToken.findUnique({ where: { tokenHash: sha256(bearer) } })
    if (token) {
      req.uid = token.userId
      void prisma.apiToken
        .update({ where: { id: token.id }, data: { lastUsedAt: new Date() } })
        .catch(() => {})
      return next()
    }
  }
  return fail(res, 401, 'err.unauthorized', 'unauthorized')
}
