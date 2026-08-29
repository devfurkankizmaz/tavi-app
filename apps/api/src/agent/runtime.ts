import { prisma } from '../db.js'
import { accessibleProjectIds } from '../access.js'
import { agentConfig, provider } from './config.js'
import type { ChatTool, ChatTurn, ChatToolResult } from './provider.js'
import { TOOL_SCHEMAS, TOOL_MAP, ToolError, type AgentAction, type TaskCard, type ToolContext } from './tools.js'

/** Tool schemas, converted into the provider-agnostic shape. */
const CHAT_TOOLS: ChatTool[] = TOOL_SCHEMAS.map(t => ({
  name: t.name,
  description: t.description ?? '',
  parameters: t.input_schema as Record<string, unknown>,
}))

export interface AgentTurn {
  reply: string
  /** Tasks named in the reply; the interface draws these as cards. */
  cards: TaskCard[]
  actions: AgentAction[]
  steps: { tool: string; ok: boolean }[]
  stopped?: 'steps' | 'timeout' | 'refusal'
}

/** History from the client; plain-text turns only. */
export interface HistoryTurn {
  role: 'user' | 'assistant'
  text: string
}

async function buildSystemPrompt(uid: string): Promise<string> {
  const me = await prisma.user.findUnique({ where: { id: uid }, select: { name: true, email: true } })
  const ids = await accessibleProjectIds(uid)
  const projects = await prisma.project.findMany({
    where: { id: { in: ids }, archived: false },
    select: { key: true, title: true },
    orderBy: { position: 'asc' },
    take: 30,
  })
  const projectList = projects.length
    ? projects.map(p => `${p.key} — ${p.title}`).join('\n')
    : '(none yet)'

  return [
    "You are Tavi's assistant. Tavi is a task tracker for small teams.",
    `You are helping ${me?.name} (${me?.email}). Today is ${new Date().toISOString().slice(0, 10)}.`,
    '',
    'How Tavi is organised:',
    '- Work lives in projects. Every project has a short key, and its tasks are numbered from it: TAV-12.',
    '- A task has a kind (FEATURE, BUG, TASK, CHORE), a status (BACKLOG, TODO, IN_PROGRESS, IN_REVIEW, DONE), a priority 0-5, optional estimate in points, dates, labels, assignees and an optional cycle.',
    '- Cycles are the weekly or two-week sprints a team runs.',
    '- Docs hold feature specs and decisions, and tasks can be linked to them.',
    '',
    "The user's projects:",
    projectList,
    '',
    'The app itself, so you can point people at it:',
    '- / overview · /my my work · /cycles cycles · /teams teams and invites · /labels labels · /settings account and preferences · /trash deleted items',
    '- A project page has tabs for List, Kanban, Table, Calendar, Gantt and Docs, plus Share for giving a team access.',
    '- Shortcuts: Cmd+K command palette, / search, C new task, G then H/M/C to jump, ? for the full list.',
    '- The Calendar tab shows work on its due date; a task with a start date spans the days between. Dragging a task to another day moves its due date.',
    '- Deleting anything puts it in Trash with an Undo toast and keeps it for 30 days.',
    '- Teams → your team → Slack connects an Incoming Webhook so activity posts to a channel.',
    '',
    'Rules you must follow:',
    '1. Search before you change anything. Never guess a task key — if you are not certain which task the user means, ask.',
    '2. Set the kind when you create a task: FEATURE for a new capability, BUG for something broken, CHORE for upkeep, TASK for everything else. Only make the change that was asked for. Do not tidy up, reprioritise or reassign anything on your own initiative.',
    '3. When a request would affect many tasks, say what you are about to do and ask for a go-ahead first, unless the user already spelled out the exact set.',
    '4. Always name a task by its key (TAV-12). The app turns every key you write into a clickable card showing the title, status, assignees, due date and labels.',
    '5. Because the card already shows those fields, never repeat them in prose. Write what changed or why it matters, not "TAV-12 — Fix login, in progress, due Friday, assigned to Ada".',
    '6. If a tool returns an error, explain it in one sentence and stop; do not retry the same call.',
    '',
    'What you cannot do, and what to say instead. Never imply you tried:',
    '- Deleting a task, doc or project — "I cannot delete anything. Open the task and use Delete; it goes to [Trash](/trash) and you have 30 days to change your mind."',
    '- Inviting people, removing them, or changing roles — send them to [Teams](/teams).',
    '- Creating or ending a cycle, or changing its dates — send them to [Cycles](/cycles). You can put tasks into an existing cycle.',
    '- Creating projects, connecting Slack, changing settings, uploading files — say which screen does it and link there.',
    'In every one of these cases give the exact path in one short sentence, then stop. Do not apologise twice.',
    '',
    'Links: write internal links as ordinary markdown to an app path — [Cycles](/cycles), [my work](/my). They open in place. Use them whenever a screen is the answer.',
    '',
    'Follow-ups: end every reply with a fenced ```next block holding one to three things the user might plausibly say next, one per line, written as the user would type them. Skip the block only when you asked the user a direct question. They are shown as buttons; keep each under 60 characters.',
    '',
    'Style: short and concrete. No preamble, no restating the request. Write in the language the user writes to you in.',
    'Formatting: a sentence or two, then keys. For several tasks, one short markdown list item per task — a key plus the one thing worth knowing ("TAV-12 — blocked on the API key"). Use **bold** for a heading only when the answer has more than one section. Never build a table; the cards are the table.',
  ].join('\n')
}

/**
 * Turns task keys in the reply into cards. A task the model read but did not
 * mention gets no card, to keep the answer quiet. Anything it changed appears
 * even when the text does not name it.
 */
function mentioned(ctx: ToolContext, reply: string): TaskCard[] {
  const keys = new Set(reply.match(/\b[A-Z][A-Z0-9]*-\d+\b/g) ?? [])
  for (const action of ctx.actions) if (action.taskKey) keys.add(action.taskKey)
  const cards: TaskCard[] = []
  for (const key of keys) {
    const card = ctx.cards.get(key)
    if (card) cards.push(card)
  }
  return cards.slice(0, 24)
}

/**
 * A bounded agent loop. Tools run with the user's own permissions at every
 * step, and the loop stops gracefully once a step, write or time budget runs out.
 */
export async function runAgent(opts: {
  uid: string
  message: string
  history: HistoryTurn[]
  onStep?: (step: { tool: string; ok: boolean }) => void
}): Promise<AgentTurn> {
  if (!provider) throw new Error('agent disabled')

  const started = Date.now()
  const ctx: ToolContext = { uid: opts.uid, writes: 0, actions: [], cards: new Map() }
  const steps: AgentTurn['steps'] = []

  const messages: ChatTurn[] = [
    ...opts.history.slice(-12).map(turn => ({
      role: turn.role,
      text: turn.text.slice(0, 4000),
    } satisfies ChatTurn)),
    { role: 'user', text: opts.message },
  ]

  const system = await buildSystemPrompt(opts.uid)
  let stopped: AgentTurn['stopped']

  for (let step = 0; step < agentConfig.maxSteps; step++) {
    if (Date.now() - started > agentConfig.timeoutMs) { stopped = 'timeout'; break }

    const response = await provider.chat({
      system,
      messages,
      tools: CHAT_TOOLS,
      maxTokens: 8000,
    })

    if (response.stop === 'refusal') {
      return { reply: '', cards: [], actions: ctx.actions, steps, stopped: 'refusal' }
    }

    if (!response.toolCalls.length) {
      const reply = response.text
      return { reply, cards: mentioned(ctx, reply), actions: ctx.actions, steps }
    }

    messages.push({ role: 'assistant', text: response.text, toolCalls: response.toolCalls })

    // Every tool result from one turn must come back in a single message
    const results: ChatToolResult[] = []
    for (const use of response.toolCalls) {
      const tool = TOOL_MAP.get(use.name)
      let ok = true
      let payload: string

      if (!tool) {
        ok = false
        payload = `Unknown tool ${use.name}.`
      } else {
        try {
          const out = await tool.run(ctx, use.input)
          payload = JSON.stringify(out)
        } catch (err) {
          ok = false
          // Expected errors are explained to the model; unexpected ones never reach the user
          payload = err instanceof ToolError
            ? err.message
            : 'That operation failed. Tell the user it did not go through.'
          if (!(err instanceof ToolError)) console.error('agent tool error:', use.name, err)
        }
      }

      steps.push({ tool: use.name, ok })
      opts.onStep?.({ tool: use.name, ok })
      results.push({ id: use.id, name: use.name, content: payload, isError: !ok })
    }

    messages.push({ role: 'user', toolResults: results })
    if (step === agentConfig.maxSteps - 1) stopped = 'steps'
  }

  // Budget spent: ask for a closing sentence with no tools available
  const closing = await provider.chat({
    system,
    maxTokens: 1000,
    messages: [
      ...messages,
      {
        role: 'user',
        text: 'Summarise for the user what you managed to do and what is still open. Do not use tools.',
      },
    ],
  })

  const reply = closing.text
  return { reply, cards: mentioned(ctx, reply), actions: ctx.actions, steps, stopped }
}

export const isRateLimit = (err: unknown) => !!provider?.isRateLimit(err)
export const isAuthError = (err: unknown) => !!provider?.isAuthError(err)
