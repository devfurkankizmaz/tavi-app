import type { Provider } from './provider.js'
import { anthropicProvider } from './providers/anthropic.js'
import { geminiProvider } from './providers/gemini.js'

/**
 * The assistant only exists when an LLM key is configured. Without one the
 * app runs exactly as before and the chat bubble never appears.
 *
 * Two providers are supported. Which one runs follows from which key is set;
 * with both set, `AGENT_PROVIDER` decides, and failing that Anthropic wins.
 */

const anthropicKey = process.env.AGENT_API_KEY || process.env.ANTHROPIC_API_KEY || ''
const geminiKey = process.env.GEMINI_API_KEY || ''

const DEFAULT_MODEL = {
  anthropic: 'claude-opus-5',
  gemini: 'gemini-3.1-pro-preview',
} as const

function pick(): 'anthropic' | 'gemini' | null {
  const forced = process.env.AGENT_PROVIDER?.toLowerCase()
  if (forced === 'anthropic') return anthropicKey ? 'anthropic' : null
  if (forced === 'gemini') return geminiKey ? 'gemini' : null
  if (anthropicKey) return 'anthropic'
  if (geminiKey) return 'gemini'
  return null
}

const chosen = pick()

/**
 * The model name is read per provider: `AGENT_MODEL` applies to both, while
 * `GEMINI_MODEL` is Gemini only. That way someone holding both keys does not
 * have to hand-edit the model name every time they switch providers.
 */
function resolveModel(provider: 'anthropic' | 'gemini'): string {
  if (provider === 'gemini') {
    return process.env.GEMINI_MODEL || process.env.AGENT_MODEL || DEFAULT_MODEL.gemini
  }
  return process.env.AGENT_MODEL || DEFAULT_MODEL.anthropic
}

export const agentConfig = {
  enabled: !!chosen,
  provider: chosen,
  model: chosen ? resolveModel(chosen) : '',
  effort: (process.env.AGENT_EFFORT || 'medium') as 'low' | 'medium' | 'high',
  /** Tool calls allowed per request; the guard against runaway loops. */
  maxSteps: Number(process.env.AGENT_MAX_STEPS || 8),
  /** Writes allowed per request. */
  maxWrites: Number(process.env.AGENT_MAX_WRITES || 20),
  /** Records a single tool call may touch. */
  maxBulk: Number(process.env.AGENT_MAX_BULK || 20),
  /** Wall clock for the whole turn, in milliseconds. */
  timeoutMs: Number(process.env.AGENT_TIMEOUT_MS || 90_000),
}

export const provider: Provider | null =
  chosen === 'anthropic' ? anthropicProvider(anthropicKey, agentConfig.model, agentConfig.effort)
  : chosen === 'gemini' ? geminiProvider(geminiKey, agentConfig.model)
  : null
