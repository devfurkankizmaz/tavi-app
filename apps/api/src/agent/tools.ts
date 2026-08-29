import type Anthropic from '@anthropic-ai/sdk'
import type { Prisma, Role, TaskStatus, TaskType } from '@prisma/client'
import { prisma } from '../db.js'
import { projectRole, taskRole, documentRole, atLeast, accessibleProjectIds } from '../access.js'
import { taskInclude, serializeTask } from '../serialize.js'
import { actorName } from '../notify.js'
import { recordChange, autoWatch } from '../activity.js'
import { agentConfig } from './config.js'

/** The context of a tool call: who is asking, and what budget is left. */
export interface ToolContext {
  uid: string
  writes: number
  /** A summary of what was done, so the reply can link to it. */
  actions: AgentAction[]
  /** Tasks seen this turn, keyed TAV-12, ready to become cards. */
  cards: Map<string, TaskCard>
}

/**
 * A task drawn as a card in the reply. Distinct from the `brief` summary the
 * model sees: this one also carries the ids and colours the interface needs.
 */
export interface TaskCard {
  id: string
  key: string
  title: string
  status: TaskStatus
  type: TaskType
  done: boolean
  priority: number
  dueDate: string | null
  projectId: string
  projectTitle: string
  assignees: { id: string; name: string; email: string; avatarUrl: string | null }[]
  labels: { id: string; title: string; color: string }[]
}

export interface AgentAction {
  kind: 'created' | 'updated' | 'commented' | 'linked'
  taskId?: string
  taskKey?: string
  documentId?: string
  projectId: string
  title: string
}

export class ToolError extends Error {}

const STATUSES: TaskStatus[] = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE']
const TYPES: TaskType[] = ['FEATURE', 'BUG', 'TASK', 'CHORE']

// ------------------------------------------------------------------ helpers

/** TAV-12 to a task. Anyone without access is told "not found". */
async function resolveTask(uid: string, ref: string) {
  const match = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(ref.trim())
  const task = match
    ? await prisma.task.findFirst({
        where: {
          number: Number(match[2]),
          deletedAt: null,
          project: { key: match[1].toUpperCase(), deletedAt: null },
        },
        include: taskInclude,
      })
    : await prisma.task.findFirst({ where: { id: ref, deletedAt: null }, include: taskInclude })

  if (!task) throw new ToolError(`Task ${ref} not found.`)
  const role = await projectRole(uid, task.projectId)
  if (!role) throw new ToolError(`Task ${ref} not found.`)
  return { task, role }
}

async function resolveProject(uid: string, ref: string) {
  const project = await prisma.project.findFirst({
    where: { deletedAt: null, OR: [{ key: ref.trim().toUpperCase() }, { id: ref }] },
    select: { id: true, key: true, title: true },
  })
  if (!project) throw new ToolError(`Project ${ref} not found.`)
  const role = await projectRole(uid, project.id)
  if (!role) throw new ToolError(`Project ${ref} not found.`)
  return { project, role }
}

/** Finds a person by name or email, among those sharing a project. */
async function resolvePeople(uid: string, refs: string[]): Promise<string[]> {
  if (!refs.length) return []
  const projectIds = await accessibleProjectIds(uid)
  const candidates = await prisma.user.findMany({
    where: {
      OR: [
        { ownedProjects: { some: { id: { in: projectIds } } } },
        { memberships: { some: { projectId: { in: projectIds } } } },
        { teamMemberships: { some: { team: { members: { some: { userId: uid } } } } } },
      ],
    },
    select: { id: true, name: true, email: true },
  })
  return refs.map(ref => {
    const needle = ref.trim().toLocaleLowerCase()
    if (needle === 'me' || needle === 'myself') return uid
    const found = candidates.find(c =>
      c.email.toLocaleLowerCase() === needle || c.name.toLocaleLowerCase() === needle)
      ?? candidates.find(c => c.name.toLocaleLowerCase().includes(needle))
    if (!found) throw new ToolError(`No teammate matches "${ref}". Use list_team_members first.`)
    return found.id
  })
}

async function resolveLabels(uid: string, names: string[]): Promise<string[]> {
  if (!names.length) return []
  const labels = await prisma.label.findMany({ where: { ownerId: uid } })
  return names.map(name => {
    const found = labels.find(l => l.title.toLocaleLowerCase() === name.trim().toLocaleLowerCase())
    if (!found) throw new ToolError(`No label named "${name}". Use list_labels to see the available ones.`)
    return found.id
  })
}

function requireEditor(role: Role | null, what: string) {
  if (!role) throw new ToolError(`${what} not found.`)
  if (!atLeast(role, 'EDITOR')) {
    throw new ToolError(`You only have read access to ${what}, so I can't change it.`)
  }
}

function budget(ctx: ToolContext) {
  if (ctx.writes >= agentConfig.maxWrites) {
    throw new ToolError('Too many changes in one request. Ask me again to continue.')
  }
  ctx.writes++
}

/**
 * The compact task summary sent to the model, to keep context small.
 * It also records the task as a card, so every TAV-12 the model names in its
 * reply can be drawn as something clickable.
 */
const brief = (ctx: ToolContext, t: ReturnType<typeof serializeTask>) => {
  ctx.cards.set(t.key, {
    id: t.id,
    key: t.key,
    title: t.title,
    status: t.status,
    type: t.type,
    done: t.done,
    priority: t.priority,
    dueDate: t.dueDate ? new Date(t.dueDate).toISOString() : null,
    projectId: t.projectId,
    projectTitle: t.project.title,
    assignees: t.assignees.map(a => ({ id: a.id, name: a.name, email: a.email, avatarUrl: a.avatarUrl })),
    labels: t.labels.map(l => ({ id: l.id, title: l.title, color: l.color })),
  })
  return {
  key: t.key,
  title: t.title,
  status: t.status,
  type: t.type,
  priority: t.priority,
  estimate: t.estimate,
  dueDate: t.dueDate,
  assignees: t.assignees.map(a => a.name),
  labels: t.labels.map(l => l.title),
  project: t.project.title,
  done: t.done,
  }
}

// -------------------------------------------------------------------- tools

interface ToolDef {
  name: string
  write: boolean
  description: string
  input_schema: Anthropic.Tool['input_schema']
  run: (ctx: ToolContext, input: Record<string, unknown>) => Promise<unknown>
}

const str = (description: string) => ({ type: 'string' as const, description })
const strArray = (description: string) => ({
  type: 'array' as const,
  items: { type: 'string' as const },
  description,
})

export const TOOLS: ToolDef[] = [
  {
    name: 'list_projects',
    write: false,
    description: 'List the projects the user can see, with their key (used in task ids like TAV-12) and open task counts.',
    input_schema: { type: 'object', properties: {} },
    async run(ctx) {
      const ids = await accessibleProjectIds(ctx.uid)
      const projects = await prisma.project.findMany({
        where: { id: { in: ids }, archived: false },
        select: {
          id: true, key: true, title: true, description: true,
          _count: { select: { tasks: { where: { done: false, deletedAt: null } } } },
        },
        orderBy: { position: 'asc' },
      })
      return projects.map(p => ({
        key: p.key, title: p.title, openTasks: p._count.tasks,
        description: p.description.slice(0, 200),
      }))
    },
  },

  {
    name: 'search_tasks',
    write: false,
    description:
      'Find tasks across every project the user can see. Use it before updating anything so you act on the right task. '
      + 'Filters combine with AND.',
    input_schema: {
      type: 'object',
      properties: {
        query: str('Text to look for in the task title'),
        projectKey: str('Restrict to one project, e.g. TAV'),
        status: { type: 'array', items: { type: 'string', enum: STATUSES }, description: 'Only these statuses' },
        type: { type: 'array', items: { type: 'string', enum: TYPES }, description: 'Only these kinds of work' },
        assignee: str('Email, full name, or "me". Omit for anyone.'),
        includeDone: { type: 'boolean', description: 'Include completed tasks (default false)' },
        overdue: { type: 'boolean', description: 'Only tasks past their due date' },
        limit: { type: 'number', description: 'Max results, default 20, max 50' },
      },
    },
    async run(ctx, input) {
      const ids = await accessibleProjectIds(ctx.uid)
      const where: Prisma.TaskWhereInput = { projectId: { in: ids }, deletedAt: null }
      if (input.query) where.title = { contains: String(input.query), mode: 'insensitive' }
      if (input.projectKey) {
        const { project } = await resolveProject(ctx.uid, String(input.projectKey))
        where.projectId = project.id
      }
      if (Array.isArray(input.status) && input.status.length) {
        where.status = { in: input.status as TaskStatus[] }
      }
      if (Array.isArray(input.type) && input.type.length) {
        where.type = { in: input.type as TaskType[] }
      }
      if (!input.includeDone) where.done = false
      if (input.overdue) where.dueDate = { lt: new Date() }
      if (input.assignee) {
        const [userId] = await resolvePeople(ctx.uid, [String(input.assignee)])
        where.assignees = { some: { userId } }
      }
      const tasks = await prisma.task.findMany({
        where,
        orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { priority: 'desc' }],
        take: Math.min(Number(input.limit) || 20, 50),
        include: taskInclude,
      })
      return { count: tasks.length, tasks: tasks.map(t => brief(ctx, serializeTask(t))) }
    },
  },

  {
    name: 'get_task',
    write: false,
    description: 'Read one task in full: description, subtasks, comments and recent activity.',
    input_schema: {
      type: 'object',
      properties: { task: str('Task key like TAV-12') },
      required: ['task'],
    },
    async run(ctx, input) {
      const { task } = await resolveTask(ctx.uid, String(input.task))
      const [subtasks, comments, activity] = await Promise.all([
        prisma.task.findMany({ where: { parentId: task.id, deletedAt: null }, include: taskInclude }),
        prisma.comment.findMany({
          where: { taskId: task.id },
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { author: { select: { name: true } } },
        }),
        prisma.activity.findMany({
          where: { taskId: task.id },
          orderBy: { createdAt: 'desc' },
          take: 8,
          include: { actor: { select: { name: true } } },
        }),
      ])
      const full = serializeTask(task)
      return {
        ...brief(ctx, full),
        description: full.description.slice(0, 4000),
        cycleId: full.cycleId,
        subtasks: subtasks.map(s => brief(ctx, serializeTask(s))),
        comments: comments.map(c => ({ author: c.author?.name, text: c.text.slice(0, 500), at: c.createdAt })),
        activity: activity.map(a => ({ who: a.actor?.name, what: a.kind, at: a.createdAt })),
      }
    },
  },

  {
    name: 'list_team_members',
    write: false,
    description: 'People the user works with. Use it to map a name to the right person before assigning work.',
    input_schema: { type: 'object', properties: {} },
    async run(ctx) {
      const projectIds = await accessibleProjectIds(ctx.uid)
      const people = await prisma.user.findMany({
        where: {
          OR: [
            { ownedProjects: { some: { id: { in: projectIds } } } },
            { memberships: { some: { projectId: { in: projectIds } } } },
            { teamMemberships: { some: { team: { members: { some: { userId: ctx.uid } } } } } },
          ],
        },
        select: {
          id: true, name: true, email: true,
          _count: { select: { assignments: { where: { task: { done: false, deletedAt: null } } } } },
        },
        take: 50,
      })
      return people.map(p => ({
        name: p.name, email: p.email, openTasks: p._count.assignments, isMe: p.id === ctx.uid,
      }))
    },
  },

  {
    name: 'list_cycles',
    write: false,
    description: 'Cycles (sprints) of the teams the user belongs to, with progress.',
    input_schema: { type: 'object', properties: {} },
    async run(ctx) {
      const cycles = await prisma.cycle.findMany({
        where: { team: { members: { some: { userId: ctx.uid } } } },
        orderBy: { startsAt: 'desc' },
        take: 10,
        include: {
          team: { select: { name: true } },
          tasks: { where: { deletedAt: null }, select: { done: true } },
        },
      })
      return cycles.map(c => ({
        id: c.id, name: c.name, goal: c.goal, team: c.team.name,
        startsAt: c.startsAt, endsAt: c.endsAt, closed: !!c.closedAt,
        total: c.tasks.length, done: c.tasks.filter(t => t.done).length,
      }))
    },
  },

  {
    name: 'list_labels',
    write: false,
    description: "The user's labels. Labels must exist before you can put them on a task.",
    input_schema: { type: 'object', properties: {} },
    async run(ctx) {
      const labels = await prisma.label.findMany({ where: { ownerId: ctx.uid }, select: { title: true } })
      return labels.map(l => l.title)
    },
  },

  {
    name: 'list_documents',
    write: false,
    description: 'Docs of a project: feature specs, decisions and notes.',
    input_schema: {
      type: 'object',
      properties: { projectKey: str('Project key, e.g. TAV') },
      required: ['projectKey'],
    },
    async run(ctx, input) {
      const { project } = await resolveProject(ctx.uid, String(input.projectKey))
      const docs = await prisma.document.findMany({
        where: { projectId: project.id, deletedAt: null },
        select: { id: true, title: true, icon: true, updatedAt: true, _count: { select: { tasks: true } } },
        orderBy: { position: 'asc' },
      })
      return docs.map(d => ({ id: d.id, title: d.title, linkedTasks: d._count.tasks, updatedAt: d.updatedAt }))
    },
  },

  {
    name: 'get_document',
    write: false,
    description: 'Read one doc in full, including the tasks linked to it.',
    input_schema: {
      type: 'object',
      properties: { documentId: str('Document id from list_documents') },
      required: ['documentId'],
    },
    async run(ctx, input) {
      const dr = await documentRole(ctx.uid, String(input.documentId))
      if (!dr?.role) throw new ToolError('Document not found.')
      const doc = await prisma.document.findFirst({
        where: { id: String(input.documentId), deletedAt: null },
        include: {
          tasks: { where: { deletedAt: null }, include: taskInclude },
          comments: { orderBy: { createdAt: 'desc' }, take: 10, include: { author: { select: { name: true } } } },
        },
      })
      if (!doc) throw new ToolError('Document not found.')
      return {
        id: doc.id,
        title: doc.title,
        content: doc.content.slice(0, 8000),
        tasks: doc.tasks.map(t => brief(ctx, serializeTask(t))),
        comments: doc.comments.map(c => ({ author: c.author?.name, text: c.text.slice(0, 300) })),
      }
    },
  },

  // ------------------------------------------------------------- yazma

  {
    name: 'create_task',
    write: true,
    description:
      'Create a task in a project. Only set the fields the user actually asked for. '
      + 'Returns the new task key so you can reference it as TAV-12 in your reply.',
    input_schema: {
      type: 'object',
      properties: {
        projectKey: str('Project key, e.g. TAV'),
        title: str('Short, action-oriented title'),
        description: str('Optional markdown body'),
        status: { type: 'string', enum: STATUSES, description: 'Defaults to TODO' },
        type: { type: 'string', enum: TYPES, description: 'FEATURE for new capability, BUG for something broken, CHORE for upkeep, TASK otherwise. Defaults to TASK.' },
        priority: { type: 'number', description: '0 none, 1 low … 5 highest' },
        estimate: { type: 'number', description: 'Story points' },
        dueDate: str('ISO 8601 date-time'),
        assignees: strArray('Emails, names, or "me"'),
        labels: strArray('Existing label names'),
        parentTask: str('Task key to make this a subtask of'),
        cycleId: str('Cycle id from list_cycles'),
      },
      required: ['projectKey', 'title'],
    },
    async run(ctx, input) {
      budget(ctx)
      const { project, role } = await resolveProject(ctx.uid, String(input.projectKey))
      requireEditor(role, `project ${project.key}`)

      const assigneeIds = await resolvePeople(ctx.uid, (input.assignees as string[]) ?? [])
      const labelIds = await resolveLabels(ctx.uid, (input.labels as string[]) ?? [])
      const parent = input.parentTask ? await resolveTask(ctx.uid, String(input.parentTask)) : null
      const firstBucket = await prisma.bucket.findFirst({
        where: { projectId: project.id }, orderBy: { position: 'asc' },
      })

      const created = await prisma.$transaction(async tx => {
        const agg = await tx.task.aggregate({
          where: { projectId: project.id }, _max: { number: true, position: true },
        })
        return tx.task.create({
          data: {
            title: String(input.title),
            description: input.description ? String(input.description) : '',
            status: (input.status as TaskStatus) ?? 'TODO',
            type: (input.type as TaskType) ?? 'TASK',
            priority: Number(input.priority) || 0,
            estimate: input.estimate == null ? null : Number(input.estimate),
            dueDate: input.dueDate ? new Date(String(input.dueDate)) : null,
            projectId: project.id,
            bucketId: firstBucket?.id ?? null,
            parentId: parent?.task.id ?? null,
            cycleId: input.cycleId ? String(input.cycleId) : null,
            createdById: ctx.uid,
            number: (agg._max.number ?? 0) + 1,
            position: (agg._max.position ?? 0) + 100,
            labels: labelIds.length ? { create: labelIds.map(labelId => ({ labelId })) } : undefined,
            assignees: assigneeIds.length ? { create: assigneeIds.map(userId => ({ userId })) } : undefined,
          },
          include: taskInclude,
        })
      })

      await autoWatch(created.id, [ctx.uid, ...assigneeIds])
      const actor = await actorName(ctx.uid)
      await recordChange({
        task: created, projectKey: project.key, actorId: ctx.uid, actorName: actor,
        kind: 'created', meta: { text: 'via assistant' },
        slackText: `*${actor}* (via assistant) created a task`,
      })
      if (assigneeIds.length) {
        await recordChange({
          task: created, projectKey: project.key, actorId: ctx.uid, actorName: actor,
          kind: 'assigned', notifyType: 'assigned',
        })
      }

      const out = serializeTask(created)
      ctx.actions.push({ kind: 'created', taskId: out.id, taskKey: out.key, projectId: project.id, title: out.title })
      return brief(ctx, out)
    },
  },

  {
    name: 'update_task',
    write: true,
    description:
      'Change an existing task. Only the fields you pass are changed; everything else is left alone. '
      + 'Assignees and labels replace the current set, so include the ones that should stay.',
    input_schema: {
      type: 'object',
      properties: {
        task: str('Task key like TAV-12'),
        title: str('New title'),
        description: str('New markdown body'),
        status: { type: 'string', enum: STATUSES },
        type: { type: 'string', enum: TYPES },
        priority: { type: 'number' },
        estimate: { type: 'number' },
        dueDate: str('ISO 8601 date-time, or empty string to clear'),
        assignees: strArray('Full replacement set: emails, names, or "me"'),
        labels: strArray('Full replacement set of existing label names'),
        cycleId: str('Cycle id, or empty string to remove from its cycle'),
      },
      required: ['task'],
    },
    async run(ctx, input) {
      budget(ctx)
      const { task, role } = await resolveTask(ctx.uid, String(input.task))
      const projectKey = task.project.key
      requireEditor(role, `task ${projectKey}-${task.number}`)

      const data: Prisma.TaskUpdateInput = {}
      if (input.title !== undefined) data.title = String(input.title)
      if (input.description !== undefined) data.description = String(input.description)
      if (input.priority !== undefined) data.priority = Number(input.priority)
      if (input.type !== undefined) data.type = input.type as TaskType
      if (input.estimate !== undefined) data.estimate = input.estimate === null ? null : Number(input.estimate)
      if (input.dueDate !== undefined) data.dueDate = input.dueDate ? new Date(String(input.dueDate)) : null
      if (input.cycleId !== undefined) {
        data.cycle = input.cycleId ? { connect: { id: String(input.cycleId) } } : { disconnect: true }
      }

      const nextStatus = input.status as TaskStatus | undefined
      if (nextStatus && nextStatus !== task.status) {
        data.status = nextStatus
        data.done = nextStatus === 'DONE'
        data.doneAt = nextStatus === 'DONE' ? new Date() : null
      }

      let added: string[] = []
      if (input.assignees !== undefined) {
        const ids = await resolvePeople(ctx.uid, (input.assignees as string[]) ?? [])
        const existing = new Set(task.assignees.map(a => a.user.id))
        added = ids.filter(id => !existing.has(id))
        await prisma.taskAssignee.deleteMany({ where: { taskId: task.id } })
        await prisma.taskAssignee.createMany({
          data: ids.map(userId => ({ taskId: task.id, userId })), skipDuplicates: true,
        })
        await autoWatch(task.id, added)
      }
      if (input.labels !== undefined) {
        const ids = await resolveLabels(ctx.uid, (input.labels as string[]) ?? [])
        await prisma.taskLabel.deleteMany({ where: { taskId: task.id } })
        await prisma.taskLabel.createMany({
          data: ids.map(labelId => ({ taskId: task.id, labelId })), skipDuplicates: true,
        })
      }

      const updated = await prisma.task.update({ where: { id: task.id }, data, include: taskInclude })
      const actor = await actorName(ctx.uid)
      const base = { task: updated, projectKey, actorId: ctx.uid, actorName: actor }

      if (data.status && nextStatus) {
        await recordChange({
          ...base, kind: 'status_changed', meta: { from: task.status, to: nextStatus },
          notifyType: 'status_changed',
          slackText: `*${actor}* (via assistant) moved \`${task.status}\` → \`${nextStatus}\``,
        })
      }
      if (added.length) {
        const names = await prisma.user.findMany({ where: { id: { in: added } }, select: { name: true } })
        await recordChange({
          ...base, kind: 'assigned', meta: { userName: names.map(n => n.name).join(', ') },
          notifyType: 'assigned',
          slackText: `*${actor}* (via assistant) assigned it to *${names.map(n => n.name).join(', ')}*`,
        })
      }
      if (input.dueDate !== undefined) {
        await recordChange({ ...base, kind: 'due_changed', meta: { to: String(input.dueDate ?? '') } })
      }

      const out = serializeTask(updated)
      ctx.actions.push({ kind: 'updated', taskId: out.id, taskKey: out.key, projectId: out.projectId, title: out.title })
      return brief(ctx, out)
    },
  },

  {
    name: 'add_comment',
    write: true,
    description: 'Post a comment on a task. Watchers get notified. Markdown is supported.',
    input_schema: {
      type: 'object',
      properties: { task: str('Task key like TAV-12'), text: str('Comment body') },
      required: ['task', 'text'],
    },
    async run(ctx, input) {
      budget(ctx)
      const { task, role } = await resolveTask(ctx.uid, String(input.task))
      const projectKey = task.project.key
      requireEditor(role, `task ${projectKey}-${task.number}`)
      const text = String(input.text).trim()
      if (!text) throw new ToolError('Comment text is empty.')

      await prisma.comment.create({ data: { taskId: task.id, authorId: ctx.uid, text } })
      await autoWatch(task.id, [ctx.uid])
      const actor = await actorName(ctx.uid)
      await recordChange({
        task, projectKey, actorId: ctx.uid, actorName: actor,
        kind: 'commented', meta: { text: text.slice(0, 200) }, notifyType: 'comment',
        slackText: `*${actor}* (via assistant) commented`,
      })
      ctx.actions.push({
        kind: 'commented', taskId: task.id, taskKey: `${projectKey}-${task.number}`,
        projectId: task.projectId, title: task.title,
      })
      return { ok: true }
    },
  },

  {
    name: 'create_document',
    write: true,
    description: 'Create a doc in a project — a feature spec, a decision record or a note.',
    input_schema: {
      type: 'object',
      properties: {
        projectKey: str('Project key, e.g. TAV'),
        title: str('Doc title'),
        content: str('Markdown body'),
        icon: str('One emoji'),
      },
      required: ['projectKey', 'title'],
    },
    async run(ctx, input) {
      budget(ctx)
      const { project, role } = await resolveProject(ctx.uid, String(input.projectKey))
      requireEditor(role, `project ${project.key}`)
      const last = await prisma.document.aggregate({
        where: { projectId: project.id, parentId: null }, _max: { position: true },
      })
      const doc = await prisma.document.create({
        data: {
          title: String(input.title),
          content: input.content ? String(input.content) : '',
          icon: input.icon ? String(input.icon).slice(0, 4) : null,
          projectId: project.id,
          authorId: ctx.uid,
          position: (last._max.position ?? 0) + 100,
        },
      })
      ctx.actions.push({ kind: 'created', documentId: doc.id, projectId: project.id, title: doc.title })
      return { id: doc.id, title: doc.title }
    },
  },

  {
    name: 'update_document',
    write: true,
    description: 'Change a doc title or body. Pass the full new body — it replaces the old one.',
    input_schema: {
      type: 'object',
      properties: {
        documentId: str('Document id'),
        title: str('New title'),
        content: str('New markdown body'),
      },
      required: ['documentId'],
    },
    async run(ctx, input) {
      budget(ctx)
      const dr = await documentRole(ctx.uid, String(input.documentId))
      requireEditor(dr?.role ?? null, 'that document')
      const doc = await prisma.document.update({
        where: { id: String(input.documentId) },
        data: {
          ...(input.title !== undefined ? { title: String(input.title) } : {}),
          ...(input.content !== undefined ? { content: String(input.content) } : {}),
        },
      })
      ctx.actions.push({ kind: 'updated', documentId: doc.id, projectId: doc.projectId, title: doc.title })
      return { id: doc.id, title: doc.title }
    },
  },

  {
    name: 'link_tasks_to_document',
    write: true,
    description: 'Attach existing tasks to a doc so the spec and its work sit together.',
    input_schema: {
      type: 'object',
      properties: {
        documentId: str('Document id'),
        tasks: strArray('Task keys like TAV-12'),
      },
      required: ['documentId', 'tasks'],
    },
    async run(ctx, input) {
      budget(ctx)
      const keys = (input.tasks as string[]) ?? []
      if (keys.length > agentConfig.maxBulk) {
        throw new ToolError(`That would touch ${keys.length} tasks; I can do at most ${agentConfig.maxBulk} at once.`)
      }
      const dr = await documentRole(ctx.uid, String(input.documentId))
      requireEditor(dr?.role ?? null, 'that document')
      const resolved = await Promise.all(keys.map(k => resolveTask(ctx.uid, k)))
      const sameProject = resolved.filter(r => r.task.projectId === dr!.projectId)
      await prisma.task.updateMany({
        where: { id: { in: sameProject.map(r => r.task.id) } },
        data: { documentId: String(input.documentId) },
      })
      ctx.actions.push({
        kind: 'linked', documentId: String(input.documentId), projectId: dr!.projectId,
        title: `${sameProject.length} tasks`,
      })
      return { linked: sameProject.length, skipped: keys.length - sameProject.length }
    },
  },

  {
    name: 'add_tasks_to_cycle',
    write: true,
    description: 'Put existing tasks into a cycle for planning.',
    input_schema: {
      type: 'object',
      properties: {
        cycleId: str('Cycle id from list_cycles'),
        tasks: strArray('Task keys like TAV-12'),
      },
      required: ['cycleId', 'tasks'],
    },
    async run(ctx, input) {
      budget(ctx)
      const keys = (input.tasks as string[]) ?? []
      if (keys.length > agentConfig.maxBulk) {
        throw new ToolError(`That would touch ${keys.length} tasks; I can do at most ${agentConfig.maxBulk} at once.`)
      }
      const cycle = await prisma.cycle.findFirst({
        where: { id: String(input.cycleId), team: { members: { some: { userId: ctx.uid } } } },
        select: { id: true, name: true },
      })
      if (!cycle) throw new ToolError('Cycle not found.')
      const resolved = await Promise.all(keys.map(k => resolveTask(ctx.uid, k)))
      for (const r of resolved) requireEditor(r.role, `task ${r.task.project.key}-${r.task.number}`)
      await prisma.task.updateMany({
        where: { id: { in: resolved.map(r => r.task.id) } },
        data: { cycleId: cycle.id },
      })
      ctx.actions.push({
        kind: 'linked', projectId: resolved[0]?.task.projectId ?? '',
        title: `${resolved.length} tasks → ${cycle.name}`,
      })
      return { added: resolved.length, cycle: cycle.name }
    },
  },
]

export const TOOL_SCHEMAS: Anthropic.Tool[] = TOOLS.map(t => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
}))

export const TOOL_MAP = new Map(TOOLS.map(t => [t.name, t]))
