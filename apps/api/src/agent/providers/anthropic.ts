import Anthropic from '@anthropic-ai/sdk'
import type {
  ChatReply, ChatRequest, ChatToolCall, Provider, StopReason,
} from '../provider.js'

/**
 * The Anthropic provider.
 *
 * Shared turns become `tool_use` / `tool_result` blocks. Every tool result
 * from one turn must come back in a single user message, which the API
 * requires, so `toolResults` travels as an array.
 */
export function anthropicProvider(
  apiKey: string,
  model: string,
  effort: 'low' | 'medium' | 'high',
): Provider {
  const client = new Anthropic({ apiKey, maxRetries: 2 })

  return {
    name: 'anthropic',
    model,

    isAuthError: err => err instanceof Anthropic.AuthenticationError,
    isRateLimit: err => err instanceof Anthropic.RateLimitError,

    async chat(req: ChatRequest): Promise<ChatReply> {
      const messages: Anthropic.MessageParam[] = []
      for (const turn of req.messages) {
        if (turn.toolResults?.length) {
          messages.push({
            role: 'user',
            content: turn.toolResults.map(r => ({
              type: 'tool_result' as const,
              tool_use_id: r.id,
              content: r.content,
              is_error: r.isError,
            })),
          })
          continue
        }

        if (turn.toolCalls?.length) {
          const content: Anthropic.ContentBlockParam[] = []
          if (turn.text) content.push({ type: 'text', text: turn.text })
          for (const call of turn.toolCalls) {
            content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
          }
          messages.push({ role: 'assistant', content })
          continue
        }

        if (turn.text) messages.push({ role: turn.role, content: turn.text })
      }

      const response = await client.messages.create({
        model,
        max_tokens: req.maxTokens,
        system: req.system,
        output_config: { effort },
        messages,
        ...(req.tools?.length
          ? {
              tools: req.tools.map(t => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters as Anthropic.Tool['input_schema'],
              })),
              ...(req.forceTool
                ? { tool_choice: { type: 'tool' as const, name: req.forceTool } }
                : {}),
            }
          : {}),
      })

      if (response.stop_reason === 'refusal') {
        return { text: '', toolCalls: [], stop: 'refusal' }
      }

      const toolCalls: ChatToolCall[] = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map(b => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }))

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim()

      const stop: StopReason = toolCalls.length ? 'tool_use' : 'end'
      return { text, toolCalls, stop }
    },
  }
}
