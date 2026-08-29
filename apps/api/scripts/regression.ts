/**
 * End-to-end regression.
 *
 * Fires real HTTP requests at a running API, so authentication, authorisation,
 * validation and the database are all in play.
 * It creates four users — owner, editor, viewer and a complete outsider — and
 * tries every feature from both directions: that it works, and that it refuses.
 *
 *   npm run regression -w @tavi/api
 *
 * Checks do not stop at the first failure; everything runs so the whole picture
 * appears, and every record it creates is removed afterwards.
 */
import 'dotenv/config'
import { prisma } from '../src/db.js'

const BASE = process.env.REGRESSION_BASE ?? `http://localhost:${process.env.API_PORT ?? 3457}`

// ----------------------------------------------------------------- reporting

interface Result {
  suite: string
  name: string
  ok: boolean
  detail?: string
}

const results: Result[] = []
let current = 'general'

const suite = (name: string) => { current = name }

function record(name: string, ok: boolean, detail?: string) {
  results.push({ suite: current, name, ok, detail })
  if (!ok) console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Passes when the expectation holds, otherwise reports why and carries on. */
function check(name: string, ok: boolean, detail?: string) {
  record(name, ok, detail)
}

function checkEqual(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  record(name, ok, ok ? undefined : `beklenen ${JSON.stringify(expected)}, gelen ${JSON.stringify(actual)}`)
}

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn()
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err))
  }
}

// -------------------------------------------------------------------- client

interface Session {
  label: string
  cookie: string
  id: string
  email: string
}

interface Res<T> {
  status: number
  body: T
}

async function call<T = any>(
  session: Session | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(session ? { Cookie: session.cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  })
  const text = await res.text()
  let parsed: unknown = text
  try { parsed = text ? JSON.parse(text) : null } catch { /* text responses: ICS, export */ }
  return { status: res.status, body: parsed as T }
}

/** File upload: the multipart body is built the way a browser would. */
async function upload(
  session: Session,
  path: string,
  fileName: string,
  content: string,
  mime = 'text/plain',
): Promise<Res<any>> {
  const form = new FormData()
  form.append('file', new Blob([content], { type: mime }), fileName)
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Cookie: session.cookie },
    body: form,
  })
  const text = await res.text()
  let parsed: unknown = text
  try { parsed = text ? JSON.parse(text) : null } catch { /* a plain-text response */ }
  return { status: res.status, body: parsed }
}

/** Download: the body comes back as text, and the headers matter too. */
async function download(session: Session | null, id: string) {
  const res = await fetch(`${BASE}/api/attachments/${id}/download`, {
    headers: session ? { Cookie: session.cookie } : {},
  })
  return { status: res.status, body: await res.text(), headers: res.headers }
}

const get = <T = any>(s: Session | null, p: string) => call<T>(s, 'GET', p)
const post = <T = any>(s: Session | null, p: string, b?: unknown) => call<T>(s, 'POST', p, b)
const patch = <T = any>(s: Session | null, p: string, b?: unknown) => call<T>(s, 'PATCH', p, b)
const put = <T = any>(s: Session | null, p: string, b?: unknown) => call<T>(s, 'PUT', p, b)
const del = <T = any>(s: Session | null, p: string) => call<T>(s, 'DELETE', p)

const stamp = Date.now()
const created = { users: [] as string[], teams: [] as string[], projects: [] as string[] }

async function signUp(label: string): Promise<Session> {
  const email = `reg-${label}-${stamp}@local.test`
  const res = await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name: `Regression ${label}`, password: 'regression-pass-1' }),
  })
  if (!res.ok) throw new Error(`${label} could not sign up: ${res.status} ${await res.text()}`)
  const cookie = (res.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ')
  const me = await (await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } })).json()
  created.users.push(me.id)
  return { label, cookie, id: me.id, email }
}

// ----------------------------------------------------------------------- run

async function run() {
  console.log(`Regression → ${BASE}\n`)

  const owner = await signUp('owner')
  const editor = await signUp('editor')
  const viewer = await signUp('viewer')
  const outsider = await signUp('outsider')

  // -------------------------------------------------------------------- auth
  suite('auth')
  await step('auth', async () => {
    const me = await get(owner, '/api/me')
    check('session identity is right', me.body.email === owner.email)

    const anon = await get(null, '/api/me')
    checkEqual('/me without a session returns 401', anon.status, 401)

    const badLogin = await post(null, '/auth/login', { email: owner.email, password: 'wrong-password' })
    checkEqual('a wrong password is refused', badLogin.status, 401)

    const badBody = await post(null, '/auth/register', { email: 'not-an-email', name: '', password: '123' })
    check('an invalid signup body is refused', badBody.status === 400, `got ${badBody.status}`)
  })

  // ---------------------------------------------------------------- projects
  suite('projects')
  const project = (await post(owner, '/api/projects', { title: 'Regression Project' })).body
  created.projects.push(project.id)

  await step('projects', async () => {
    check('a project key is generated', /^[A-Z]{2,}$/.test(project.key ?? ''), `key=${project.key}`)

    const renamed = await patch(owner, `/api/projects/${project.id}`, { title: 'Regression Renamed' })
    checkEqual('a project can be renamed', renamed.body.title, 'Regression Renamed')

    const seen = await get(outsider, `/api/projects/${project.id}`)
    checkEqual('an outsider cannot see the project', seen.status, 404)

    const list = await get(outsider, '/api/projects')
    check('the project is absent from an outsider list', !list.body.some((p: any) => p.id === project.id))
  })

  // -------------------------------------------------------------- membership
  suite('membership')
  await step('membership', async () => {
    const addEditor = await post(owner, `/api/projects/${project.id}/members`, {
      email: editor.email, role: 'EDITOR',
    })
    check('an editor can be added', addEditor.status < 300, `got ${addEditor.status}`)

    const addViewer = await post(owner, `/api/projects/${project.id}/members`, {
      email: viewer.email, role: 'VIEWER',
    })
    check('a viewer can be added', addViewer.status < 300, `got ${addViewer.status}`)

    const asEditor = await get(editor, `/api/projects/${project.id}`)
    checkEqual('an editor sees the project', asEditor.status, 200)

    const asViewer = await get(viewer, `/api/projects/${project.id}`)
    checkEqual('a viewer sees the project', asViewer.status, 200)

    const viewerRename = await patch(viewer, `/api/projects/${project.id}`, { title: 'Renamed by a viewer' })
    check('a viewer cannot change the project', viewerRename.status === 403 || viewerRename.status === 404,
      `got ${viewerRename.status}`)

    const outsiderJoin = await post(outsider, `/api/projects/${project.id}/members`, {
      email: outsider.email, role: 'ADMIN',
    })
    check('an outsider cannot add themselves', outsiderJoin.status >= 400, `got ${outsiderJoin.status}`)
  })

  // ------------------------------------------------------------------- tasks
  suite('tasks')
  const task = (await post(owner, `/api/projects/${project.id}/tasks`, {
    title: 'Regression task',
    type: 'BUG',
    priority: 3,
    description: 'A regression fixture with a searchable word: zibberish',
  })).body

  await step('tasks', async () => {
    checkEqual('the task key derives from the project key', task.key, `${project.key}-1`)
    checkEqual('the type is stored', task.type, 'BUG')
    checkEqual('the priority is stored', task.priority, 3)

    const second = await post(owner, `/api/projects/${project.id}/tasks`, { title: 'Second' })
    checkEqual('task numbers increment', second.body.key, `${project.key}-2`)

    const updated = await patch(owner, `/api/tasks/${task.id}`, {
      status: 'IN_PROGRESS', estimate: 5, dueDate: new Date(Date.now() + 86_400_000).toISOString(),
    })
    checkEqual('status updates', updated.body.status, 'IN_PROGRESS')
    checkEqual('the estimate updates', updated.body.estimate, 5)

    const done = await patch(owner, `/api/tasks/${task.id}`, { done: true })
    checkEqual('a completed task becomes DONE', done.body.status, 'DONE')
    check('the completion time is recorded', !!done.body.doneAt)
    await patch(owner, `/api/tasks/${task.id}`, { done: false })

    const badStatus = await patch(owner, `/api/tasks/${task.id}`, { status: 'YOK_BOYLE' })
    checkEqual('an invalid status is refused', badStatus.status, 400)

    const badPriority = await patch(owner, `/api/tasks/${task.id}`, { priority: 99 })
    checkEqual('an out-of-range priority is refused', badPriority.status, 400)

    const viewerWrite = await patch(viewer, `/api/tasks/${task.id}`, { title: 'Written by a viewer' })
    check('a viewer cannot change a task', viewerWrite.status >= 400, `got ${viewerWrite.status}`)

    const editorWrite = await patch(editor, `/api/tasks/${task.id}`, { percentDone: 40 })
    checkEqual('an editor can change a task', editorWrite.status, 200)

    const outsiderRead = await get(outsider, `/api/tasks/${task.id}`)
    checkEqual('an outsider cannot see the task', outsiderRead.status, 404)
  })

  // -------------------------------------------------- subtasks and relations
  suite('subtasks and relations')
  await step('subtasks and relations', async () => {
    const sub = await post(owner, `/api/projects/${project.id}/tasks`, {
      title: 'Regression subtask', parentId: task.id,
    })
    checkEqual('a subtask attaches to its parent', sub.body.parentId, task.id)

    const detail = await get(owner, `/api/tasks/${task.id}`)
    check('the parent lists its subtask', detail.body.subtasks?.some((s: any) => s.id === sub.body.id))

    const rel = await post(owner, `/api/tasks/${task.id}/relations`, {
      toId: sub.body.id, kind: 'blocked_by',
    })
    check('a relation can be created', rel.status < 300, `got ${rel.status}`)

    const withRel = await get(owner, `/api/tasks/${task.id}`)
    check('the relation shows on the task', (withRel.body.relations ?? []).length > 0)

    const selfParent = await patch(owner, `/api/tasks/${task.id}`, { parentId: task.id })
    checkEqual('a task cannot parent itself', selfParent.status, 400)

    // Blocking semantics: the parent stays locked until the subtask is done.
    // The editor starts watching so the news has somewhere to go; not notifying
    // a non-watcher is correct behaviour, hence this setup.
    await post(editor, `/api/tasks/${task.id}/watch`, {})

    const blocked = await get(owner, `/api/tasks/${task.id}`)
    checkEqual('an open blocker is counted', blocked.body.blockedBy, 1)

    const blockerDone = await patch(owner, `/api/tasks/${sub.body.id}`, { done: true })
    checkEqual('the blocker can be completed', blockerDone.body.done, true)

    const freed = await get(owner, `/api/tasks/${task.id}`)
    checkEqual('the count drops once the blocker is done', freed.body.blockedBy, 0)

    const feed = await get(owner, `/api/projects/${project.id}/activity`)
    check('unblocking reaches the activity feed', feed.body.some((a: any) => a.kind === 'unblocked'))

    // The watcher hears about it; the owner does not, being the actor
    const mateInbox = await get(editor, '/api/inbox?filter=all')
    check('watchers are told about unblocking',
      (mateInbox.body.groups ?? []).some((g: any) => g.types?.includes('unblocked')),
      JSON.stringify((mateInbox.body.groups ?? []).map((g: any) => g.types)))

    await del(editor, `/api/tasks/${task.id}/watch`)
    await patch(owner, `/api/tasks/${sub.body.id}`, { done: false })
  })

  // ------------------------------------------------------------------ labels
  suite('labels')
  await step('labels', async () => {
    const labels = await get(owner, '/api/labels')
    check('a new account has default labels', labels.body.length > 0, `count ${labels.body.length}`)

    const label = await post(owner, '/api/labels', { title: 'regression-label', color: '#ff8800' })
    check('a label can be created', label.status < 300, `got ${label.status}`)

    const tagged = await patch(owner, `/api/tasks/${task.id}`, { labelIds: [label.body.id] })
    check('a label attaches to a task', tagged.body.labels?.some((l: any) => l.id === label.body.id))

    const filtered = await get(owner, `/api/tasks?labelId=${label.body.id}`)
    check('filtering by label works', filtered.body.some((t: any) => t.id === task.id))

    const cleared = await patch(owner, `/api/tasks/${task.id}`, { labelIds: [] })
    checkEqual('a label can be removed', cleared.body.labels?.length, 0)
  })

  // ------------------------------------------ assignment, watching, comments
  suite('assignment and comments')
  await step('assignment and comments', async () => {
    const assigned = await patch(owner, `/api/tasks/${task.id}`, { assigneeIds: [editor.id] })
    check('a task can be assigned', assigned.body.assignees?.some((a: any) => a.id === editor.id))

    const notif = await get(editor, '/api/notifications')
    check('the assignee gets a notification', (notif.body.unread ?? 0) > 0, `unread ${notif.body.unread}`)

    const comment = await post(editor, `/api/tasks/${task.id}/comments`, { text: 'Regression comment' })
    check('a comment can be added', comment.status < 300, `got ${comment.status}`)

    const viewerComment = await post(viewer, `/api/tasks/${task.id}/comments`, { text: 'A viewer comment' })
    check('a viewer cannot comment', viewerComment.status >= 400, `got ${viewerComment.status}`)

    const watch = await post(viewer, `/api/tasks/${task.id}/watch`, {})
    check('a viewer can watch a task', watch.status < 300, `got ${watch.status}`)

    const detail = await get(viewer, `/api/tasks/${task.id}`)
    checkEqual('the watching state is visible', detail.body.isWatching, true)

    const unwatch = await del(viewer, `/api/tasks/${task.id}/watch`)
    check('watching can be stopped', unwatch.status < 300, `got ${unwatch.status}`)

    const activity = await get(owner, `/api/projects/${project.id}/activity`)
    check('the activity feed has entries', Array.isArray(activity.body) && activity.body.length > 0)

    const feed = await get(owner, '/api/activity?take=20')
    check('the cross-project feed works', Array.isArray(feed.body) && feed.body.length > 0)
    check('the feed carries each task project',
      feed.body.some((a: any) => a.task?.projectTitle))

    const outsiderFeed = await get(outsider, '/api/activity')
    checkEqual('an outsider feed is empty', (outsiderFeed.body ?? []).length, 0)

    // Activity on a deleted task must drop out of the feed
    const doomed = await post(owner, `/api/projects/${project.id}/tasks`, { title: 'Feed fixture' })
    await patch(owner, `/api/tasks/${doomed.body.id}`, { priority: 2 })
    await del(owner, `/api/tasks/${doomed.body.id}`)
    const afterDelete = await get(owner, '/api/activity?take=60')
    check('activity on a deleted task leaves the feed',
      !(afterDelete.body ?? []).some((a: any) => a.task?.id === doomed.body.id))
  })

  // --------------------------------------------------- filtering and sorting
  suite('filtering and sorting')
  await step('filtering and sorting', async () => {
    const byType = await get(owner, `/api/tasks?projectId=${project.id}&type=BUG`)
    check('filtering by type works', byType.body.every((t: any) => t.type === 'BUG'), `count ${byType.body.length}`)

    const byStatus = await get(owner, `/api/tasks?projectId=${project.id}&status=IN_PROGRESS`)
    check('filtering by status works', byStatus.body.every((t: any) => t.status === 'IN_PROGRESS'))

    const mine = await get(editor, '/api/tasks?assignee=me')
    check('assigned-to-me filtering works', mine.body.some((t: any) => t.id === task.id))

    const sorted = await get(owner, `/api/tasks?projectId=${project.id}&sort=priority`)
    const priorities = sorted.body.map((t: any) => t.priority)
    check('sorting by priority descends',
      priorities.every((p: number, i: number) => i === 0 || priorities[i - 1] >= p),
      JSON.stringify(priorities))

    const paged = await get(owner, `/api/tasks?projectId=${project.id}&take=1`)
    checkEqual('the page size is applied', paged.body.length, 1)
  })

  // ------------------------------------------------------------------ search
  suite('search')
  await step('search', async () => {
    const hit = await get(owner, '/api/search?q=zibberish')
    check('a description match is found', hit.body.tasks?.some((t: any) => t.id === task.id),
      `found ${hit.body.tasks?.length}`)

    const comment = await get(owner, '/api/search?q=Regression comment')
    check('a comment match is found', (comment.body.comments ?? []).length > 0)

    const leak = await get(outsider, '/api/search?q=zibberish')
    checkEqual('no result leaks to an outsider', (leak.body.tasks ?? []).length, 0)

    const injection = await get(owner, "/api/search?q='; DROP TABLE \"Task\"; --")
    checkEqual('an injection attempt is handled safely', injection.status, 200)

    const stillThere = await get(owner, `/api/tasks/${task.id}`)
    checkEqual('the table is still there', stillThere.status, 200)
  })

  // ------------------------------------------------------------------- teams
  suite('teams')
  const team = (await post(owner, '/api/teams', { name: `Regression Team ${stamp}` })).body
  if (team?.id) created.teams.push(team.id)

  await step('teams', async () => {
    check('a team can be created', !!team?.id, JSON.stringify(team).slice(0, 120))

    const invite = await post(owner, `/api/teams/${team.id}/invites`, { email: editor.email })
    check('an invitation can be sent', invite.status < 300, `got ${invite.status}`)

    const invites = await get(editor, '/api/invites')
    const mine = invites.body.find((i: any) => i.team?.id === team.id)
    check('the invitation reaches the recipient', !!mine)

    if (mine) {
      const accept = await post(editor, `/api/invites/${mine.id}/accept`, {})
      check('an invitation can be accepted', accept.status < 300, `got ${accept.status}`)
      const teams = await get(editor, '/api/teams')
      check('the accepter appears in the team', teams.body.some((t: any) => t.id === team.id))
    }

    const outsiderInvite = await post(outsider, `/api/teams/${team.id}/invites`, { email: 'x@local.test' })
    check('an outsider cannot invite to a team', outsiderInvite.status >= 400, `got ${outsiderInvite.status}`)

    const share = await post(owner, `/api/projects/${project.id}/team-shares`, { teamId: team.id })
    check('a project can be shared with a team', share.status < 300, `got ${share.status}`)
  })

  // ------------------------------------------------------------------ cycles
  suite('cycles')
  await step('cycles', async () => {
    const cycle = await post(owner, `/api/teams/${team.id}/cycles`, {
      name: 'Regression Cycle',
      goal: 'Ship the regression',
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    })
    check('a cycle can be created', cycle.status < 300, `got ${cycle.status} ${JSON.stringify(cycle.body).slice(0, 120)}`)
    if (cycle.status >= 300) return

    const add = await post(owner, `/api/cycles/${cycle.body.id}/tasks`, { taskIds: [task.id] })
    check('a task can be added to a cycle', (add.body.added ?? 0) > 0, JSON.stringify(add.body))

    const detail = await get(owner, `/api/cycles/${cycle.body.id}`)
    check('the cycle lists its task', detail.body.tasks?.some((t: any) => t.id === task.id))

    const outsiderRead = await get(outsider, `/api/cycles/${cycle.body.id}`)
    check('an outsider cannot see the cycle', outsiderRead.status >= 400, `got ${outsiderRead.status}`)

    const closed = await patch(owner, `/api/cycles/${cycle.body.id}`, { closed: true })
    check('a cycle can be closed', !!closed.body.closedAt)

    const removed = await del(owner, `/api/cycles/${cycle.body.id}/tasks/${task.id}`)
    check('a task can leave a cycle', removed.status < 300, `got ${removed.status}`)

    await del(owner, `/api/cycles/${cycle.body.id}`)
  })

  // --------------------------------------------------------------- documents
  suite('documents')
  await step('documents', async () => {
    const doc = await post(owner, `/api/projects/${project.id}/documents`, {
      title: 'Regression Spec', content: 'A spec containing flibbertigibbet as a marker.',
    })
    check('a document can be created', doc.status < 300, `got ${doc.status}`)
    if (doc.status >= 300) return

    const child = await post(owner, `/api/projects/${project.id}/documents`, {
      title: 'Nested page', parentId: doc.body.id,
    })
    checkEqual('documents can nest', child.body.parentId, doc.body.id)

    const link = await post(owner, `/api/documents/${doc.body.id}/tasks`, { taskIds: [task.id] })
    check('a task can be linked to a document', link.status < 300, `got ${link.status}`)

    const withTasks = await get(owner, `/api/documents/${doc.body.id}`)
    check('the document lists its linked task', withTasks.body.tasks?.some((t: any) => t.id === task.id))

    const comment = await post(editor, `/api/documents/${doc.body.id}/comments`, { text: 'Doc comment' })
    check('a document accepts comments', comment.status < 300, `got ${comment.status}`)

    const found = await get(owner, '/api/search?q=flibbertigibbet')
    check('document content is searchable', (found.body.documents ?? []).length > 0)

    const outsiderRead = await get(outsider, `/api/documents/${doc.body.id}`)
    checkEqual('an outsider cannot see the document', outsiderRead.status, 404)

    const viewerWrite = await patch(viewer, `/api/documents/${doc.body.id}`, { title: 'Viewer' })
    check('a viewer cannot change a document', viewerWrite.status >= 400, `got ${viewerWrite.status}`)

    await del(owner, `/api/documents/${child.body.id}`)
    await del(owner, `/api/documents/${doc.body.id}`)
  })

  // ------------------------------------------------------------- attachments
  suite('attachments')
  await step('attachments', async () => {
    const secret = `gizli-icerik-${stamp}`
    const added = await upload(owner, `/api/tasks/${task.id}/attachments`, 'notlar.txt', secret)
    check('a file can be uploaded', added.status === 201, `got ${added.status}`)
    if (added.status !== 201) return

    checkEqual('the file name is preserved', added.body.fileName, 'notlar.txt')
    check('the size is stored', added.body.size > 0)
    check('the stored name does not come from the client', added.body.storedName !== 'notlar.txt')

    const mine = await download(owner, added.body.id)
    checkEqual('the owner can download it', mine.status, 200)
    checkEqual('the content arrives intact', mine.body, secret)
    checkEqual('it downloads rather than rendering',
      mine.headers.get('content-disposition')?.startsWith('attachment'), true)
    checkEqual('content-type sniffing is off',
      mine.headers.get('x-content-type-options'), 'nosniff')

    const asViewer = await download(viewer, added.body.id)
    checkEqual('a viewer can download it too', asViewer.status, 200)

    // The point of this suite: no shared project means no access to the file
    const asOutsider = await download(outsider, added.body.id)
    check('an outsider cannot download it', asOutsider.status >= 400, `got ${asOutsider.status}`)
    check('no content leaks to an outsider', !asOutsider.body.includes(secret))

    const anon = await download(null, added.body.id)
    checkEqual('no download without a session', anon.status, 401)

    const viewerUpload = await upload(viewer, `/api/tasks/${task.id}/attachments`, 'x.txt', 'x')
    check('a viewer cannot upload', viewerUpload.status >= 400, `got ${viewerUpload.status}`)

    const outsiderUpload = await upload(outsider, `/api/tasks/${task.id}/attachments`, 'x.txt', 'x')
    check('an outsider cannot upload', outsiderUpload.status >= 400, `got ${outsiderUpload.status}`)

    const viewerDelete = await del(viewer, `/api/attachments/${added.body.id}`)
    check('a viewer cannot delete an attachment', viewerDelete.status >= 400, `got ${viewerDelete.status}`)

    const outsiderDelete = await del(outsider, `/api/attachments/${added.body.id}`)
    check('an outsider cannot delete an attachment', outsiderDelete.status >= 400, `got ${outsiderDelete.status}`)

    const stillThere = await download(owner, added.body.id)
    checkEqual('refused deletions leave the file alone', stillThere.status, 200)

    // The server must survive a file going missing from disk
    const orphan = await upload(owner, `/api/tasks/${task.id}/attachments`, 'lost.txt', 'about to go missing')
    if (orphan.status === 201) {
      await prisma.attachment.update({
        where: { id: orphan.body.id },
        data: { storedName: 'a-name-with-no-file-behind-it' },
      })
      const missing = await download(owner, orphan.body.id)
      check('a missing file does not take the server down', missing.status >= 400 && missing.status < 600,
        `got ${missing.status}`)
      const alive = await get(owner, '/api/me')
      checkEqual('the server is still up', alive.status, 200)
      await del(owner, `/api/attachments/${orphan.body.id}`)
    }

    const removed = await del(owner, `/api/attachments/${added.body.id}`)
    check('the owner can delete the attachment', removed.status < 300, `got ${removed.status}`)

    const afterDelete = await download(owner, added.body.id)
    checkEqual('a deleted attachment cannot be downloaded', afterDelete.status, 404)
  })

  // ------------------------------------------------------------------- trash
  suite('trash')
  await step('trash', async () => {
    const victim = await post(owner, `/api/projects/${project.id}/tasks`, { title: 'To be deleted' })
    await del(owner, `/api/tasks/${victim.body.id}`)

    const gone = await get(owner, `/api/tasks/${victim.body.id}`)
    checkEqual('a deleted task cannot be read', gone.status, 404)

    const list = await get(owner, `/api/tasks?projectId=${project.id}`)
    check('a deleted task is absent from lists', !list.body.some((t: any) => t.id === victim.body.id))

    const trash = await get(owner, '/api/trash')
    check('a deleted task is in trash', trash.body.tasks?.some((t: any) => t.id === victim.body.id))

    const outsiderTrash = await get(outsider, '/api/trash')
    check('an outsider sees nobody else work in trash',
      !(outsiderTrash.body.tasks ?? []).some((t: any) => t.id === victim.body.id))

    const restored = await post(owner, `/api/trash/task/${victim.body.id}/restore`, {})
    check('a task can be restored', restored.status < 300, `got ${restored.status}`)

    const back = await get(owner, `/api/tasks/${victim.body.id}`)
    checkEqual('a restored task can be read', back.status, 200)

    await del(owner, `/api/tasks/${victim.body.id}`)
    const purged = await del(owner, `/api/trash/task/${victim.body.id}`)
    check('permanent deletion works', purged.status < 300, `got ${purged.status}`)

    const reallyGone = await get(owner, '/api/trash')
    check('a purged task is gone from trash',
      !(reallyGone.body.tasks ?? []).some((t: any) => t.id === victim.body.id))
  })

  // ------------------------------------------------------------------- inbox
  suite('inbox')
  await step('inbox', async () => {
    // The editor assigns to the owner and comments twice; it should land in their inbox
    const target = await post(owner, `/api/projects/${project.id}/tasks`, { title: 'Inbox fixture' })
    await patch(editor, `/api/tasks/${target.body.id}`, { assigneeIds: [owner.id] })
    await post(editor, `/api/tasks/${target.body.id}/comments`, { text: 'Inbox comment one' })
    await post(editor, `/api/tasks/${target.body.id}/comments`, { text: 'Inbox comment two' })

    const unread = await get(owner, '/api/inbox?filter=unread')
    check('notifications reach the inbox', unread.body.unread > 0, `unread ${unread.body.unread}`)

    const group = unread.body.groups?.find((g: any) => g.taskId === target.body.id)
    check('notifications for one task group into a row', (group?.ids?.length ?? 0) > 1,
      `group size ${group?.ids?.length}`)
    check('the row carries the current task state', group?.task?.key === target.body.key,
      `got ${group?.task?.key}`)

    const mine = await get(editor, '/api/inbox?filter=unread')
    check('your own action never lands in your inbox',
      !(mine.body.groups ?? []).some((g: any) => g.taskId === target.body.id))

    const outsiderInbox = await get(outsider, '/api/inbox?filter=all')
    checkEqual('an outsider inbox is empty', (outsiderInbox.body.groups ?? []).length, 0)

    const read = await post(owner, '/api/inbox/read', { ids: group.ids })
    check('marking read works', (read.body.updated ?? 0) > 0)

    const afterRead = await get(owner, '/api/inbox?filter=unread')
    check('a read row leaves the unread list',
      !(afterRead.body.groups ?? []).some((g: any) => g.taskId === target.body.id))

    const back = await post(owner, '/api/inbox/unread', { ids: group.ids })
    check('marking unread works', (back.body.updated ?? 0) > 0)

    const archived = await post(owner, '/api/inbox/archive', { ids: group.ids })
    check('archiving works', (archived.body.updated ?? 0) > 0)

    const inArchive = await get(owner, '/api/inbox?filter=archived')
    check('it appears under archived',
      (inArchive.body.groups ?? []).some((g: any) => g.taskId === target.body.id))

    const notInUnread = await get(owner, '/api/inbox?filter=unread')
    check('archived rows are not counted as unread',
      !(notInUnread.body.groups ?? []).some((g: any) => g.taskId === target.body.id))

    const bell = await get(owner, '/api/notifications')
    check('the bell ignores archived rows',
      !(bell.body.items ?? []).some((n: any) => group.ids.includes(n.id)))

    const restored = await post(owner, '/api/inbox/unarchive', { ids: group.ids })
    check('it can be moved back from archive', (restored.body.updated ?? 0) > 0)

    const badFilter = await get(owner, '/api/inbox?filter=uydurma')
    checkEqual('an invalid filter is refused', badFilter.status, 400)

    const foreign = await post(outsider, '/api/inbox/archive', { ids: group.ids })
    check('an outsider cannot archive somebody else notifications', (foreign.body.updated ?? 0) === 0,
      `affected ${foreign.body.updated}`)
  })

  // ------------------------------------------------- sharing, ICS and export
  suite('sharing and export')
  await step('sharing and export', async () => {
    const share = await post(owner, `/api/projects/${project.id}/link-shares`, { role: 'VIEWER' })
    check('a link share can be created', share.status < 300, `got ${share.status}`)
    if (share.status < 300) {
      const token = share.body.token ?? share.body.hash
      const publicView = await get(null, `/public/share/${token}`)
      checkEqual('a share link opens without a session', publicView.status, 200)

      const bogus = await get(null, '/public/share/yok-boyle-bir-token')
      check('an invalid share link is refused', bogus.status >= 400, `got ${bogus.status}`)
    }

    const me = await get(owner, '/api/me')
    const ics = await get(null, `/public/ics/${me.body.icsToken}.ics`)
    checkEqual('the ICS feed reads without a session', ics.status, 200)
    check('the ICS feed is a calendar', String(ics.body).startsWith('BEGIN:VCALENDAR'),
      String(ics.body).slice(0, 40))

    const badIcs = await get(null, '/public/ics/not-a-real-token.ics')
    check('an invalid ICS token is refused', badIcs.status >= 400, `got ${badIcs.status}`)

    const exported = await get(owner, '/api/export')
    checkEqual('export works', exported.status, 200)
    check('the export contains projects', JSON.stringify(exported.body).includes(project.id))
  })

  // -------------------------------------------------------------- API tokens
  suite('API tokens')
  await step('API tokens', async () => {
    const token = await post(owner, '/api/me/tokens', { name: 'regression' })
    check('a token can be created', !!token.body.token, JSON.stringify(token.body).slice(0, 100))
    if (!token.body.token) return

    const withToken = await fetch(`${BASE}/api/me`, {
      headers: { Authorization: `Bearer ${token.body.token}` },
    })
    checkEqual('a token authenticates', withToken.status, 200)

    const badToken = await fetch(`${BASE}/api/me`, {
      headers: { Authorization: 'Bearer not-a-real-token' },
    })
    checkEqual('an invalid token is refused', badToken.status, 401)

    const revoked = await del(owner, `/api/me/tokens/${token.body.id}`)
    check('a token can be revoked', revoked.status < 300, `got ${revoked.status}`)

    const afterRevoke = await fetch(`${BASE}/api/me`, {
      headers: { Authorization: `Bearer ${token.body.token}` },
    })
    checkEqual('a revoked token stops working', afterRevoke.status, 401)
  })

  // ----------------------------------------------------------------- account
  suite('account')
  await step('account', async () => {
    const renamed = await patch(owner, '/api/me', { name: 'Regression Owner' })
    checkEqual('the name can be changed', renamed.body.name, 'Regression Owner')

    const wrongCurrent = await post(owner, '/api/me/password', {
      current: 'wrong-password', next: 'brand-new-password-1',
    })
    check('a wrong current password is refused', wrongCurrent.status >= 400, `got ${wrongCurrent.status}`)

    const shortPassword = await post(owner, '/api/me/password', {
      current: 'regression-pass-1', next: 'short',
    })
    checkEqual('a short password is refused', shortPassword.status, 400)

    const profile = await get(editor, `/api/users/${owner.id}`)
    checkEqual('someone sharing a project sees the profile', profile.status, 200)

    const stranger = await get(outsider, `/api/users/${owner.id}`)
    check('an outsider cannot see the profile', stranger.status >= 400, `got ${stranger.status}`)

    const fav = await post(owner, '/api/favorites', { kind: 'project', targetId: project.id })
    check('a favourite can be added', fav.status < 300, `got ${fav.status}`)
    const favList = await get(owner, '/api/projects')
    check('the project is marked as favourite', favList.body.find((p: any) => p.id === project.id)?.isFavorite === true)
    await del(owner, `/api/favorites/project/${project.id}`)
  })

  // -------------------------------------------------------- project deletion
  suite('project lifecycle')
  await step('project lifecycle', async () => {
    const archived = await patch(owner, `/api/projects/${project.id}`, { archived: true })
    checkEqual('a project can be archived', archived.body.archived, true)
    await patch(owner, `/api/projects/${project.id}`, { archived: false })

    const viewerDelete = await del(viewer, `/api/projects/${project.id}`)
    check('a viewer cannot delete the project', viewerDelete.status >= 400, `got ${viewerDelete.status}`)

    const editorDelete = await del(editor, `/api/projects/${project.id}`)
    check('an editor cannot delete the project', editorDelete.status >= 400, `got ${editorDelete.status}`)
  })

  suite('saved views')
  await step('saved views', async () => {
    const mine = await post(owner, '/api/views', {
      name: 'Regression private', query: 'view=kanban&type=BUG', projectId: project.id,
    })
    checkEqual('a view can be saved', mine.status, 201)
    checkEqual('the query is stored verbatim', mine.body.query, 'view=kanban&type=BUG')

    const shared = await post(owner, '/api/views', {
      name: 'Regression shared', query: 'priority=4', projectId: project.id, shared: true,
    })
    checkEqual('a view can be shared with the project', shared.status, 201)

    const unscoped = await post(owner, '/api/views', { name: 'Regression global', query: 'done=all' })
    checkEqual('a view outside any project can be saved', unscoped.status, 201)

    const badShare = await post(owner, '/api/views', { name: 'Nowhere', query: 'done=all', shared: true })
    checkEqual('a view with no project cannot be shared', badShare.status, 400)

    const viewerShare = await post(viewer, '/api/views', {
      name: 'Viewer share', query: 'type=BUG', projectId: project.id, shared: true,
    })
    check('a viewer cannot share a view', viewerShare.status === 403, `got ${viewerShare.status}`)

    const viewerOwn = await post(viewer, '/api/views', {
      name: 'Viewer private', query: 'type=BUG', projectId: project.id,
    })
    checkEqual('a viewer can still save one for themselves', viewerOwn.status, 201)

    const editorSees = await get(editor, `/api/views?projectId=${project.id}`)
    const names = editorSees.body.map((v: any) => v.name)
    check('a shared view reaches the rest of the project', names.includes('Regression shared'))
    check("someone else's private view stays private", !names.includes('Regression private'))

    const outsiderSees = await get(outsider, `/api/views?projectId=${project.id}`)
    check('an outsider gets nothing from the project', outsiderSees.status >= 400,
      `got ${outsiderSees.status}`)

    const hijackName = await patch(editor, `/api/views/${shared.body.id}`, { name: 'Hijacked' })
    check('only the author can rename a view', hijackName.status === 404, `got ${hijackName.status}`)

    const hijackDelete = await del(editor, `/api/views/${shared.body.id}`)
    check('only the author can delete a view', hijackDelete.status === 404, `got ${hijackDelete.status}`)

    const removed = await del(owner, `/api/views/${mine.body.id}`)
    checkEqual('the author can delete their own', removed.status, 200)
  })

  suite('notification preferences')
  await step('notification preferences', async () => {
    const defaults = await get(owner, '/api/me/notifications')
    checkEqual('every type has an effective setting', defaults.status, 200)
    check('defaults are on', defaults.body.preferences.every((p: any) => p.inApp))
    check('the digest starts off', defaults.body.digestHour === null)
    const inviteAccepted = defaults.body.preferences.find((p: any) => p.type === 'invite_accepted')
    check('a type that never mails says so', inviteAccepted?.canEmail === false)

    const badHour = await put(owner, '/api/me/notifications', { digestHour: 27 })
    checkEqual('an hour outside the day is refused', badHour.status, 400)

    const badType = await put(owner, '/api/me/notifications', {
      preferences: [{ type: 'not_a_type', inApp: false, email: false }],
    })
    checkEqual('an unknown type is refused', badType.status, 400)

    await put(owner, '/api/me/notifications', {
      digestHour: 7,
      preferences: [{ type: 'assigned', inApp: false, email: false }],
    })
    const saved = await get(owner, '/api/me/notifications')
    checkEqual('the digest hour is kept', saved.body.digestHour, 7)
    const assigned = saved.body.preferences.find((p: any) => p.type === 'assigned')
    check('the preference is kept', assigned.inApp === false && assigned.email === false)

    // Silenced, the assignment must not reach the inbox at all.
    const before = await get(owner, '/api/inbox')
    const silent = await post(owner, `/api/projects/${project.id}/tasks`, { title: 'Silent assignment' })
    await patch(editor, `/api/tasks/${silent.body.id}`, { assigneeIds: [owner.id] })
    const after = await get(owner, '/api/inbox')
    checkEqual('a silenced type creates no inbox entry',
      after.body.groups?.length ?? 0, before.body.groups?.length ?? 0)

    // Back on, so the rest of the run behaves normally.
    await put(owner, '/api/me/notifications', {
      digestHour: null,
      preferences: [{ type: 'assigned', inApp: true, email: true }],
    })
  })

  suite('import')
  await step('import', async () => {
    const exported = await get(owner, '/api/export')
    checkEqual('the export can be read back', exported.status, 200)
    check('the export carries documents', Array.isArray(exported.body.projects?.[0]?.documents))

    const report = await post(owner, '/api/import', exported.body)
    checkEqual('an export imports cleanly', report.status, 200)
    check('projects arrive', report.body.projects > 0, `got ${report.body.projects}`)
    check('unmatched people are a count, never addresses',
      typeof report.body.unmatchedPeople === 'number')

    const projectsAfter = await get(owner, '/api/projects')
    for (const p of projectsAfter.body) if (!created.projects.includes(p.id)) created.projects.push(p.id)

    // The list payload carries no key, so each one is read from its detail.
    const details = await Promise.all(
      projectsAfter.body.map((p: any) => get(owner, `/api/projects/${p.id}`)),
    )
    const keys = details.map(d => d.body.key).filter(Boolean)
    checkEqual('every project has a key', keys.length, projectsAfter.body.length)
    checkEqual('an imported project never reuses a key', new Set(keys).size, keys.length)

    const junk = await post(owner, '/api/import', { projects: [{ title: '' }] })
    checkEqual('a malformed file is refused', junk.status, 400)
    check('the refusal says where it failed', typeof junk.body.detail === 'string')

    const notAnObject = await post(owner, '/api/import', [1, 2, 3])
    checkEqual('something that is not an export is refused', notAnObject.status, 400)
  })

  await cleanup()
  report()
}

// ------------------------------------------------------------------- cleanup

async function cleanup() {
  // Straight from the database, so soft-deleted rows leave no trace either
  for (const id of created.projects) {
    await prisma.project.deleteMany({ where: { id } }).catch(() => {})
  }
  for (const id of created.teams) {
    await prisma.team.deleteMany({ where: { id } }).catch(() => {})
  }
  await prisma.user.deleteMany({ where: { email: { contains: `-${stamp}@local.test` } } }).catch(() => {})
}

function report() {
  const failed = results.filter(r => !r.ok)
  const bySuite = new Map<string, { ok: number; total: number }>()
  for (const r of results) {
    const entry = bySuite.get(r.suite) ?? { ok: 0, total: 0 }
    entry.total++
    if (r.ok) entry.ok++
    bySuite.set(r.suite, entry)
  }

  console.log('\n─────────────────────────────────')
  for (const [name, { ok, total }] of bySuite) {
    console.log(`${ok === total ? '✓' : '✗'} ${name.padEnd(24)} ${ok}/${total}`)
  }
  console.log('─────────────────────────────────')
  console.log(`${results.length - failed.length}/${results.length} passed`)

  if (failed.length) {
    console.log('\nFailures:')
    for (const f of failed) console.log(`  [${f.suite}] ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
  }
  process.exitCode = failed.length ? 1 : 0
}

run()
  .catch(async err => {
    console.error('regression crashed:', err)
    await cleanup()
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
