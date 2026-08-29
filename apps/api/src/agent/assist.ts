import { prisma } from '../db.js'
import { taskRole, documentRole, accessibleProjectIds, atLeast } from '../access.js'
import { agentConfig, provider } from './config.js'

/**
 * Assistant touches outside the chat.
 *
 * These calls differ from chat in two ways that matter: they are one-shot
 * (no tool loop) and they **never write**. They read only what the user can
 * already see and hand back a suggestion; whether to apply it is the user's
 * call. So when this layer is wrong, it costs a moment of someone's time
 * rather than their data.
 */

export class AssistError extends Error {}

const MODEL_MAX_TOKENS = 2000

/**
 * Gets a schema-shaped result through one forced tool call.
 *
 * Forcing the tool, rather than asking for free text and parsing JSON, makes
 * both providers honour the schema, which removes parse failures as a class
 * of error entirely.
 */
async function structured<T>(opts: {
  system: string
  prompt: string
  toolName: string
  description: string
  schema: Record<string, unknown>
}): Promise<T> {
  if (!provider) throw new AssistError('Assistant is not configured.')

  const response = await provider.chat({
    system: opts.system,
    maxTokens: MODEL_MAX_TOKENS,
    messages: [{ role: 'user', text: opts.prompt }],
    tools: [{ name: opts.toolName, description: opts.description, parameters: opts.schema }],
    forceTool: opts.toolName,
  })

  const call = response.toolCalls.find(c => c.name === opts.toolName)
  if (!call) throw new AssistError('The assistant did not return an answer.')
  return call.input as T
}

// --------------------------------------------------------------- subtasks

export interface SubtaskSuggestion {
  title: string
  type: 'FEATURE' | 'BUG' | 'TASK' | 'CHORE'
  why: string
}

/**
 * Breaks a task into steps. It does not create them, it proposes; the user
 * picks what they like and adds it through the normal subtask flow.
 */
export async function suggestSubtasks(uid: string, taskId: string): Promise<SubtaskSuggestion[]> {
  const task = await prisma.task.findFirst({
    where: { id: taskId, deletedAt: null },
    select: {
      title: true, description: true, type: true, number: true,
      project: { select: { id: true, key: true, title: true, description: true } },
      subtasks: { where: { deletedAt: null }, select: { title: true } },
    },
  })
  if (!task) throw new AssistError('Task not found.')

  // taskRole returns an object even without access; the truth is in `role`
  const access = await taskRole(uid, taskId)
  if (!access?.role) throw new AssistError('Task not found.')
  if (!atLeast(access.role, 'EDITOR')) {
    throw new AssistError('You need edit access to break this task down.')
  }

  const existing = task.subtasks.map(s => `- ${s.title}`).join('\n') || '(none yet)'
  const result = await structured<{ subtasks: SubtaskSuggestion[] }>({
    system: [
      'You break a task into the concrete steps needed to finish it.',
      'Rules:',
      '- Between three and six steps. Fewer is better than padding.',
      '- Each title is a specific action someone could start today, under 80 characters.',
      '- No step for "plan it" or "review it" unless the task genuinely needs a separate review pass.',
      '- Never repeat a step that already exists.',
      '- If the task is already small enough to just do, return an empty list.',
      'Write in the language the task is written in.',
    ].join('\n'),
    prompt: [
      `Project: ${task.project.title} (${task.project.key})`,
      task.project.description ? `Project context: ${task.project.description.slice(0, 1500)}` : '',
      '',
      `Task ${task.project.key}-${task.number} [${task.type}]: ${task.title}`,
      task.description ? `Description:\n${task.description.slice(0, 4000)}` : '(no description)',
      '',
      `Steps that already exist:\n${existing}`,
    ].filter(Boolean).join('\n'),
    toolName: 'propose_subtasks',
    description: 'Return the steps needed to finish the task.',
    schema: {
      type: 'object',
      properties: {
        subtasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'The action, under 80 characters' },
              type: { type: 'string', enum: ['FEATURE', 'BUG', 'TASK', 'CHORE'] },
              why: { type: 'string', description: 'One short clause on why this step is needed' },
            },
            required: ['title', 'type', 'why'],
          },
        },
      },
      required: ['subtasks'],
    },
  })

  return (result.subtasks ?? []).slice(0, agentConfig.maxBulk)
}

// ------------------------------------------------------------- summarising

export interface Summary {
  summary: string
  points: string[]
}

/** Boils a long discussion or document down to a few lines. */
export async function summarize(
  uid: string,
  kind: 'task' | 'document' | 'cycle',
  id: string,
): Promise<Summary> {
  const { heading, body } = await gather(uid, kind, id)

  return structured<Summary>({
    system: [
      'You summarise work discussions for someone who has been away.',
      'Rules:',
      '- Lead with where things stand now, not with history.',
      '- Say what was decided and what is still open. Name people when it matters.',
      '- Do not invent a decision that was never made. If nothing was decided, say so.',
      '- Two or three sentences, then at most four short bullet points.',
      'Write in the language the material is written in.',
    ].join('\n'),
    prompt: `${heading}\n\n${body}`,
    toolName: 'write_summary',
    description: 'Return the summary.',
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Two or three sentences on where things stand' },
        points: {
          type: 'array',
          items: { type: 'string', description: 'One decision, blocker or open question' },
        },
      },
      required: ['summary', 'points'],
    },
  })
}

/** Gathers the material to summarise, bounded by what the user may see. */
async function gather(uid: string, kind: 'task' | 'document' | 'cycle', id: string) {
  if (kind === 'task') {
    // A present object is not enough: `role` is null for anyone without access
    if (!(await taskRole(uid, id))?.role) throw new AssistError('Task not found.')
    const task = await prisma.task.findFirst({
      where: { id, deletedAt: null },
      select: {
        title: true, description: true, status: true, type: true, number: true,
        project: { select: { key: true, title: true } },
        assignees: { select: { user: { select: { name: true } } } },
        comments: {
          orderBy: { createdAt: 'asc' },
          take: 100,
          select: { text: true, createdAt: true, author: { select: { name: true } } },
        },
      },
    })
    if (!task) throw new AssistError('Task not found.')
    if (task.comments.length === 0 && !task.description.trim()) {
      throw new AssistError('There is nothing here to summarise yet.')
    }
    return {
      heading: `Task ${task.project.key}-${task.number} [${task.type}, ${task.status}]: ${task.title}`
        + (task.assignees.length ? `\nAssigned to: ${task.assignees.map(a => a.user.name).join(', ')}` : ''),
      body: [
        task.description ? `Description:\n${task.description.slice(0, 4000)}` : '',
        '',
        'Discussion:',
        ...task.comments.map(c =>
          `${c.author?.name ?? 'Someone'} · ${c.createdAt.toISOString().slice(0, 10)}\n${c.text.slice(0, 2000)}`),
      ].filter(Boolean).join('\n\n'),
    }
  }

  if (kind === 'document') {
    if (!(await documentRole(uid, id))?.role) throw new AssistError('Doc not found.')
    const doc = await prisma.document.findFirst({
      where: { id, deletedAt: null },
      select: {
        title: true, content: true,
        comments: {
          orderBy: { createdAt: 'asc' },
          take: 60,
          select: { text: true, author: { select: { name: true } } },
        },
        tasks: { where: { deletedAt: null }, select: { title: true, status: true } },
      },
    })
    if (!doc) throw new AssistError('Doc not found.')
    return {
      heading: `Doc: ${doc.title}`,
      body: [
        doc.content.slice(0, 12000),
        doc.tasks.length
          ? `\nLinked work:\n${doc.tasks.map(x => `- [${x.status}] ${x.title}`).join('\n')}`
          : '',
        doc.comments.length
          ? `\nComments:\n${doc.comments.map(c => `${c.author?.name ?? 'Someone'}: ${c.text.slice(0, 1200)}`).join('\n')}`
          : '',
      ].filter(Boolean).join('\n'),
    }
  }

  // Cycle: the material that shows where everyone stands at a glance
  const ids = await accessibleProjectIds(uid)
  const cycle = await prisma.cycle.findFirst({
    where: { id, team: { members: { some: { userId: uid } } } },
    select: {
      name: true, goal: true, startsAt: true, endsAt: true,
      tasks: {
        where: { deletedAt: null, projectId: { in: ids } },
        select: {
          title: true, status: true, type: true, estimate: true, dueDate: true,
          project: { select: { key: true } },
          number: true,
          assignees: { select: { user: { select: { name: true } } } },
        },
      },
    },
  })
  if (!cycle) throw new AssistError('Cycle not found.')
  if (cycle.tasks.length === 0) throw new AssistError('This cycle has no work in it yet.')

  const overdue = (d: Date | null) => (d && d < new Date() ? ' · overdue' : '')
  return {
    heading: `Cycle: ${cycle.name}`
      + (cycle.goal ? `\nGoal: ${cycle.goal}` : '')
      + `\nRuns ${cycle.startsAt.toISOString().slice(0, 10)} → ${cycle.endsAt.toISOString().slice(0, 10)}`
      + `\nToday is ${new Date().toISOString().slice(0, 10)}`,
    body: cycle.tasks.map(x =>
      `- ${x.project.key}-${x.number} [${x.type}, ${x.status}${overdue(x.dueDate)}]`
      + `${x.estimate ? ` ${x.estimate}pts` : ''} ${x.title}`
      + (x.assignees.length ? ` — ${x.assignees.map(a => a.user.name).join(', ')}` : ' — unassigned'),
    ).join('\n'),
  }
}
