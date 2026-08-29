import { Router } from 'express'
import { prisma } from '../db.js'
import { accessibleProjectIds } from '../access.js'

export const searchRouter = Router()

/** How many results of each kind one query returns. */
const DEFAULT_LIMIT = 6
const MAX_LIMIT = 30

/**
 * Highlight markers, deliberately not HTML. `ts_headline` hands back text the
 * user wrote; wrapping it in `<b>` would invite the client to render it as
 * markup and open an XSS door. The client splits on these markers and builds
 * its own elements. Control characters were chosen so they cannot collide
 * with anything a person would type.
 */
export const MARK_START = '\u0001'
export const MARK_STOP = '\u0002'
const HEADLINE = `StartSel=${MARK_START}, StopSel=${MARK_STOP}, MaxWords=20, MinWords=8, ShortWord=2, MaxFragments=1, FragmentDelimiter= … `

/**
 * Turns what the user typed into something `to_tsquery` understands.
 *
 * Everything but letters and digits is dropped, so tsquery operators like
 * `&`, `|`, `!` and `:` cannot leak in and there is no injection surface.
 * The last word gets `:*` so that mid-typing, "dep" already finds "deploy".
 * The 'simple' dictionary does no stemming, and prefix matching stands in
 * for it.
 */
export function toTsQuery(input: string): string | null {
  const terms = input
    .toLocaleLowerCase()
    .split(/\s+/)
    .map(x => x.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean)
    .slice(0, 8)
  if (!terms.length) return null
  return terms.map((term, i) => (i === terms.length - 1 ? `${term}:*` : term)).join(' & ')
}

interface TaskHit {
  id: string
  number: number
  title: string
  status: string
  type: string
  priority: number
  done: boolean
  dueDate: Date | null
  projectId: string
  projectKey: string
  projectTitle: string
  snippet: string
}

interface DocHit {
  id: string
  title: string
  projectId: string
  projectTitle: string
  snippet: string
}

interface CommentHit {
  id: string
  taskId: string | null
  documentId: string | null
  createdAt: Date
  authorName: string | null
  projectId: string
  projectKey: string
  parentTitle: string
  taskNumber: number | null
  snippet: string
}

/**
 * Full-text search across tasks, documents and comments.
 *
 * Every query is bounded by what the user can reach: project ids come from
 * `accessibleProjectIds` and are passed as parameters, so not one word of an
 * unshared project can reach the results.
 */
searchRouter.get('/search', async (req, res) => {
  const raw = String(req.query.q ?? '').trim()
  const query = toTsQuery(raw)
  const limit = Math.min(Number(req.query.limit) || DEFAULT_LIMIT, MAX_LIMIT)

  if (!query) return res.json({ query: raw, tasks: [], documents: [], comments: [] })

  const projectIds = await accessibleProjectIds(req.uid!)
  if (!projectIds.length) return res.json({ query: raw, tasks: [], documents: [], comments: [] })

  const [tasks, documents, comments] = await Promise.all([
    prisma.$queryRawUnsafe<TaskHit[]>(`
      SELECT t."id", t."number", t."title", t."status"::text, t."type"::text,
             t."priority", t."done", t."dueDate",
             t."projectId", p."key" AS "projectKey", p."title" AS "projectTitle",
             ts_headline('simple', t."description", q, $4) AS "snippet"
      FROM "Task" t
      JOIN "Project" p ON p."id" = t."projectId",
           to_tsquery('simple', $1) q
      WHERE t."deletedAt" IS NULL
        AND t."projectId" = ANY($2)
        AND t."search" @@ q
      ORDER BY ts_rank(t."search", q) DESC, t."updatedAt" DESC
      LIMIT $3
    `, query, projectIds, limit, HEADLINE),

    prisma.$queryRawUnsafe<DocHit[]>(`
      SELECT d."id", d."title", d."projectId", p."title" AS "projectTitle",
             ts_headline('simple', d."content", q, $4) AS "snippet"
      FROM "Document" d
      JOIN "Project" p ON p."id" = d."projectId",
           to_tsquery('simple', $1) q
      WHERE d."deletedAt" IS NULL
        AND d."projectId" = ANY($2)
        AND d."search" @@ q
      ORDER BY ts_rank(d."search", q) DESC, d."updatedAt" DESC
      LIMIT $3
    `, query, projectIds, limit, HEADLINE),

    // A comment's project comes from the task or doc it hangs off, and the
    // joins are filtered so comments on deleted parents stay out
    prisma.$queryRawUnsafe<CommentHit[]>(`
      SELECT c."id", c."taskId", c."documentId", c."createdAt",
             u."name" AS "authorName",
             COALESCE(t."projectId", d."projectId") AS "projectId",
             p."key" AS "projectKey",
             COALESCE(t."title", d."title") AS "parentTitle",
             t."number" AS "taskNumber",
             ts_headline('simple', c."text", q, $4) AS "snippet"
      FROM "Comment" c
      LEFT JOIN "Task" t ON t."id" = c."taskId" AND t."deletedAt" IS NULL
      LEFT JOIN "Document" d ON d."id" = c."documentId" AND d."deletedAt" IS NULL
      LEFT JOIN "User" u ON u."id" = c."authorId"
      JOIN "Project" p ON p."id" = COALESCE(t."projectId", d."projectId"),
           to_tsquery('simple', $1) q
      WHERE COALESCE(t."projectId", d."projectId") = ANY($2)
        AND c."search" @@ q
      ORDER BY ts_rank(c."search", q) DESC, c."createdAt" DESC
      LIMIT $3
    `, query, projectIds, limit, HEADLINE),
  ])

  res.json({
    query: raw,
    tasks: tasks.map(x => ({
      ...x,
      key: `${x.projectKey}-${x.number}`,
      snippet: x.snippet || null,
    })),
    documents: documents.map(x => ({ ...x, snippet: x.snippet || null })),
    comments: comments.map(x => ({
      ...x,
      taskKey: x.taskNumber ? `${x.projectKey}-${x.taskNumber}` : null,
      snippet: x.snippet || null,
    })),
  })
})
