import 'dotenv/config'
import express from 'express'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import pino from 'pino'
import { authRouter } from './auth.js'
import { importRouter } from './routes/import.js'
import { viewsRouter } from './routes/views.js'
import { requireUser, fail } from './middleware.js'
import { projectsRouter } from './routes/projects.js'
import { tasksRouter } from './routes/tasks.js'
import { teamsRouter } from './routes/teams.js'
import { cyclesRouter } from './routes/cycles.js'
import { documentsRouter } from './routes/documents.js'
import { trashRouter } from './routes/trash.js'
import { agentRouter } from './routes/agent.js'
import { labelsRouter } from './routes/labels.js'
import { searchRouter } from './routes/search.js'
import { inboxRouter } from './routes/inbox.js'
import { accountRouter } from './routes/account.js'
import { publicRouter } from './routes/public.js'
import { startWorker } from './worker.js'
import { t } from './i18n.js'

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' })

for (const key of ['DATABASE_URL', 'JWT_SECRET']) {
  if (!process.env[key]) {
    log.fatal(`${key} is not set — check your .env file`)
    process.exit(1)
  }
}

const app = express()
app.set('trust proxy', 1)
app.use(helmet())
// An export of a real workspace is far larger than any other request, so the
// import route gets its own parser. It is mounted first: body-parser marks
// the request as read, and the general limit below then leaves it alone.
app.use('/api/import', express.json({ limit: '25mb' }))
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())

app.get('/healthz', (_req, res) => res.json({ ok: true }))
app.use('/auth', authRouter)
app.use('/public', publicRouter)

const api = express.Router()
api.use(requireUser)
api.use(projectsRouter)
api.use(tasksRouter)
api.use(searchRouter)
api.use(inboxRouter)
api.use(teamsRouter)
api.use(cyclesRouter)
api.use(documentsRouter)
api.use(trashRouter)
api.use(agentRouter)
api.use(labelsRouter)
api.use(accountRouter)
api.use(viewsRouter)
api.use(importRouter)
app.use('/api', api)

app.use((_req, res) => fail(res, 404, 'err.not_found', 'not_found'))

app.use((err: Error & { type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err.type === 'entity.too.large') return fail(res, 413, 'err.too_large', 'too_large')
  log.error(err)
  res.status(500).json({ error: t('err.internal'), code: 'internal' })
})

const port = Number(process.env.API_PORT ?? 3457)
app.listen(port, () => {
  log.info(`tavi api: http://localhost:${port}`)
  startWorker()
})
