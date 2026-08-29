/**
 * The model provider abstraction.
 *
 * The agent loop and the inline suggestions talk to this interface and never
 * learn which provider is behind it. Tools, budgets and guardrails stay in
 * one place, and adding a provider is writing one file.
 *
 * The surface is deliberately narrow: text, tool calls, tool results. Anything
 * provider-specific — Anthropic's `tool_use` blocks, Gemini's `functionCall`
 * parts — is translated inside that provider's own file.
 */

export interface ChatTool {
  name: string
  description: string
  /** JSON Schema, in the subset both providers understand. */
  parameters: Record<string, unknown>
}

export interface ChatToolCall {
  /** Used to pair a result back to its call. */
  id: string
  name: string
  input: Record<string, unknown>
  /**
   * A provider-specific signature we never interpret. Gemini 3 wants its
   * `thoughtSignature` back when a tool call is returned, so we keep it
   * verbatim and hand it back verbatim.
   */
  signature?: string
}

export interface ChatToolResult {
  id: string
  name: string
  content: string
  isError: boolean
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  text?: string
  toolCalls?: ChatToolCall[]
  toolResults?: ChatToolResult[]
}

export interface ChatRequest {
  system: string
  messages: ChatTurn[]
  tools?: ChatTool[]
  maxTokens: number
  /** When set, the model must call this tool; used for structured output. */
  forceTool?: string
}

export type StopReason = 'end' | 'tool_use' | 'refusal'

export interface ChatReply {
  text: string
  toolCalls: ChatToolCall[]
  stop: StopReason
}

export interface Provider {
  readonly name: 'anthropic' | 'gemini'
  readonly model: string
  chat(req: ChatRequest): Promise<ChatReply>
  /** Is the key invalid, so the user can be told the right thing. */
  isAuthError(err: unknown): boolean
  isRateLimit(err: unknown): boolean
}
