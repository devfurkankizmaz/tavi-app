/**
 * Sample data.
 *
 * So a fresh clone does not open onto an empty screen: a two-person team, a
 * project, believable tasks, a running cycle, a document and some comments.
 * Nobody should have to type twenty records to evaluate the product.
 *
 *   npm run db:seed
 *
 * Does nothing if those emails already exist: it never overwrites and never
 * duplicates. To rebuild from scratch: `npm run db:seed -- --reset`.
 */
import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { prisma } from '../src/db.js'
import { DEFAULT_BUCKETS, createDefaultLabels } from '../src/defaults.js'
import { uniqueProjectKey } from '../src/keys.js'

const PASSWORD = 'tavi-demo-1234'
const OWNER = 'ada@tavi.local'
const MATE = 'devrim@tavi.local'

const DAY = 86_400_000
const day = (offset: number) => new Date(Date.now() + offset * DAY)

async function main() {
  const reset = process.argv.includes('--reset')

  if (reset) {
    // Only what the demo accounts created is removed; nothing else is touched
    const demo = await prisma.user.findMany({ where: { email: { in: [OWNER, MATE] } }, select: { id: true } })
    const ids = demo.map(u => u.id)
    if (ids.length) {
      await prisma.project.deleteMany({ where: { ownerId: { in: ids } } })
      await prisma.team.deleteMany({ where: { createdById: { in: ids } } })
      await prisma.user.deleteMany({ where: { id: { in: ids } } })
      console.log('previous sample data removed')
    }
  }

  if (await prisma.user.findUnique({ where: { email: OWNER } })) {
    console.log(`sample data already present (${OWNER}). To rebuild: npm run db:seed -- --reset`)
    return
  }

  const passwordHash = await bcrypt.hash(PASSWORD, 10)
  const ada = await prisma.user.create({
    data: { email: OWNER, name: 'Ada Larsen', passwordHash },
  })
  const devrim = await prisma.user.create({
    data: { email: MATE, name: 'Devin Park', passwordHash },
  })
  await Promise.all([createDefaultLabels(ada.id), createDefaultLabels(devrim.id)])

  const team = await prisma.team.create({
    data: {
      name: 'Acme',
      createdById: ada.id,
      members: { create: [{ userId: ada.id, admin: true }, { userId: devrim.id, admin: false }] },
    },
  })

  const project = await prisma.project.create({
    data: {
      title: 'Tavi v1 Launch',
      description: '**Goal:** ship a self-hostable Tavi that a five-person team can live in.\n\n'
        + 'Scope: branding, docs, packaging, and the first onboarding pass.',
      key: await uniqueProjectKey('Tavi v1 Launch'),
      color: '#e09a34',
      ownerId: ada.id,
      buckets: { create: DEFAULT_BUCKETS },
      members: { create: [{ userId: devrim.id, role: 'EDITOR' }] },
      teamShares: { create: [{ teamId: team.id, role: 'EDITOR' }] },
    },
    include: { buckets: { orderBy: { position: 'asc' } } },
  })

  const labels = await prisma.label.findMany({ where: { ownerId: ada.id } })
  const label = (title: string) => labels.find(l => l.title === title)?.id

  const cycle = await prisma.cycle.create({
    data: {
      name: 'Sprint 1',
      goal: 'Everything a new self-hoster needs on day one.',
      startsAt: day(-3),
      endsAt: day(11),
      teamId: team.id,
    },
  })

  const backlog = project.buckets[0]
  const doing = project.buckets[1] ?? backlog
  const done = project.buckets.find(b => b.isDoneBucket) ?? backlog

  const spec = await prisma.document.create({
    data: {
      projectId: project.id,
      authorId: ada.id,
      title: 'Onboarding spec',
      content: '## Problem\n\nA new self-hoster clones the repo and sees an empty app.\n\n'
        + '## Proposed solution\n\nShip sample data and a ten-minute walkthrough in the README.\n\n'
        + '## Out of scope\n\nA hosted trial. Not this quarter.',
    },
  })

  /** Tasks are created one by one so numbering and defaults behave as they would in the app. */
  const seeds: {
    title: string
    type: 'FEATURE' | 'BUG' | 'TASK' | 'CHORE'
    status: 'BACKLOG' | 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE'
    priority: number
    estimate?: number
    dueOffset?: number
    startOffset?: number
    assignee?: string
    labels?: string[]
    bucket?: string
    inCycle?: boolean
    description?: string
  }[] = [
    {
      title: 'Ship the onboarding walkthrough',
      type: 'FEATURE', status: 'IN_PROGRESS', priority: 4, estimate: 5,
      startOffset: -2, dueOffset: 2, assignee: ada.id, labels: ['Docs'],
      bucket: doing.id, inCycle: true,
      description: 'A first-run tour that ends with the reader having a project, a task and a cycle.',
    },
    {
      title: 'Deploy pipeline drops the registry token',
      type: 'BUG', status: 'IN_PROGRESS', priority: 5, estimate: 3,
      dueOffset: -1, assignee: devrim.id, labels: ['Bug', 'Blocked'],
      bucket: doing.id, inCycle: true,
      description: 'Production builds fail on push. The registry credentials are not reaching the runner.',
    },
    {
      title: 'Write the self-hosting guide',
      type: 'TASK', status: 'TODO', priority: 3, estimate: 3,
      dueOffset: 5, assignee: ada.id, labels: ['Docs'], inCycle: true,
    },
    {
      title: 'Keyboard shortcuts for the board',
      type: 'FEATURE', status: 'TODO', priority: 2, estimate: 2,
      dueOffset: 8, labels: ['Improvement'], inCycle: true,
    },
    {
      title: 'Audit colour contrast in dark mode',
      type: 'CHORE', status: 'BACKLOG', priority: 1, estimate: 1,
      labels: ['Design'],
    },
    {
      title: 'Pick a licence and add CONTRIBUTING',
      type: 'CHORE', status: 'DONE', priority: 2, estimate: 1,
      dueOffset: -4, assignee: ada.id, bucket: done.id, inCycle: true,
    },
  ]

  const createdTasks = []
  for (const [index, seed] of seeds.entries()) {
    const task = await prisma.task.create({
      data: {
        projectId: project.id,
        number: index + 1,
        position: (index + 1) * 100,
        title: seed.title,
        description: seed.description ?? '',
        type: seed.type,
        status: seed.status,
        done: seed.status === 'DONE',
        doneAt: seed.status === 'DONE' ? day(-4) : null,
        priority: seed.priority,
        estimate: seed.estimate ?? null,
        startDate: seed.startOffset === undefined ? null : day(seed.startOffset),
        dueDate: seed.dueOffset === undefined ? null : day(seed.dueOffset),
        bucketId: seed.bucket ?? backlog.id,
        cycleId: seed.inCycle ? cycle.id : null,
        createdById: ada.id,
        documentId: seed.title.includes('onboarding') ? spec.id : null,
        assignees: seed.assignee ? { create: [{ userId: seed.assignee }] } : undefined,
        labels: seed.labels
          ? { create: seed.labels.map(l => label(l)).filter(Boolean).map(labelId => ({ labelId: labelId! })) }
          : undefined,
        watchers: { create: [{ userId: ada.id }] },
      },
    })
    createdTasks.push(task)
  }

  // A subtask and a blocking relation, so nesting is not left empty
  await prisma.task.create({
    data: {
      projectId: project.id,
      number: seeds.length + 1,
      position: (seeds.length + 1) * 100,
      title: 'Draft the ten-minute tour copy',
      type: 'TASK',
      status: 'TODO',
      priority: 2,
      parentId: createdTasks[0].id,
      bucketId: backlog.id,
      createdById: ada.id,
    },
  })
  await prisma.taskRelation.create({
    data: { fromId: createdTasks[0].id, toId: createdTasks[1].id, kind: 'blocked_by' },
  })

  /*
   * Activity rows are written explicitly. Seeding goes straight through
   * Prisma rather than the API, so nothing would otherwise record that any
   * of this happened, and Overview would open onto an empty feed.
   */
  await prisma.activity.createMany({
    data: [
      { projectId: project.id, taskId: createdTasks[0].id, actorId: ada.id, kind: 'created', meta: {} },
      { projectId: project.id, taskId: createdTasks[1].id, actorId: devrim.id, kind: 'created', meta: {} },
      { projectId: project.id, taskId: createdTasks[1].id, actorId: devrim.id, kind: 'status_changed',
        meta: { from: 'TODO', to: 'IN_PROGRESS' } },
      { projectId: project.id, taskId: createdTasks[1].id, actorId: ada.id, kind: 'assigned',
        meta: { userName: 'Devin Park' } },
      { projectId: project.id, taskId: createdTasks[5].id, actorId: ada.id, kind: 'status_changed',
        meta: { from: 'IN_REVIEW', to: 'DONE' } },
      { projectId: project.id, taskId: createdTasks[0].id, actorId: devrim.id, kind: 'commented', meta: {} },
      { projectId: project.id, taskId: createdTasks[2].id, actorId: ada.id, kind: 'due_changed',
        meta: { to: day(5).toISOString() } },
    ],
  })

  await prisma.comment.createMany({
    data: [
      { taskId: createdTasks[1].id, authorId: devrim.id, text: 'Runner logs show the token is empty at build time.' },
      { taskId: createdTasks[1].id, authorId: ada.id, text: 'Can you check whether the secret is scoped to the branch?' },
      { taskId: createdTasks[0].id, authorId: devrim.id, text: 'Draft reads well. I would cut the second paragraph.' },
      { documentId: spec.id, authorId: devrim.id, text: 'Agreed on leaving the hosted trial out of scope.' },
    ],
  })

  console.log(`
Sample data ready.

  Sign in    ${OWNER}  /  ${PASSWORD}
  Teammate   ${MATE}   /  ${PASSWORD}

  Project    ${project.title} (${project.key}) — ${seeds.length + 1} tasks
  Cycle      ${cycle.name}
  Document   ${spec.title}
`)
}

main()
  .catch(err => {
    console.error('could not seed sample data:', err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
