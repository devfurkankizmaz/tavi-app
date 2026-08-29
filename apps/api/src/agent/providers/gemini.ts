import type {
  ChatReply, ChatRequest, ChatToolCall, Provider, StopReason,
} from '../provider.js'

const BASE = 'https://generativelanguage.googleapis.com/v1beta'

/** Google's error body, unpacked into a class that travels. */
export class GeminiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

interface GeminiPart {
  text?: string
  thought?: boolean
  /** Gemini 3 requires this back whenever a tool call is returned to it. */
  thoughtSignature?: string
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> }
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> }
}

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

/**
 * Turns shared turns into Gemini's `contents` array.
 *
 * The formats differ most on tool results: Anthropic carries them as a
 * `tool_result` block in its own user message, Gemini as a `functionResponse`
 * part, which also sits under the 'user' role.
 *
 * Gemini 3 also expects a `thoughtSignature` beside every `functionCall` part
 * handed back to it and answers 400 without one. We do not interpret the
 * signature; we store it with the call and return it unchanged.
 */
function toContents(req: ChatRequest): GeminiContent[] {
  const out: GeminiContent[] = []
  for (const turn of req.messages) {
    if (turn.toolResults?.length) {
      out.push({
        role: 'user',
        parts: turn.toolResults.map(r => ({
          functionResponse: {
            id: r.id,
            name: r.name,
            // Errors travel as ordinary responses so the model can read and explain them
            response: r.isError ? { error: r.content } : { result: r.content },
          },
        })),
      })
      continue
    }

    const parts: GeminiPart[] = []
    if (turn.text) parts.push({ text: turn.text })
    for (const call of turn.toolCalls ?? []) {
      parts.push({
        functionCall: { id: call.id, name: call.name, args: call.input },
        ...(call.signature ? { thoughtSignature: call.signature } : {}),
      })
    }
    if (!parts.length) continue
    out.push({ role: turn.role === 'assistant' ? 'model' : 'user', parts })
  }
  return out
}

/**
 * The Google AI Studio (Gemini) provider.
 *
 * Plain REST rather than the official SDK: the surface we need is a single
 * endpoint (`generateContent`), which is not worth another dependency.
 */
export function geminiProvider(apiKey: string, model: string): Provider {
  return {
    name: 'gemini',
    model,

    isAuthError: err => err instanceof GeminiError && (err.status === 401 || err.status === 403),
    isRateLimit: err => err instanceof GeminiError && err.status === 429,

    async chat(req: ChatRequest): Promise<ChatReply> {
      const body: Record<string, unknown> = {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: toContents(req),
        generationConfig: { maxOutputTokens: req.maxTokens },
      }

      if (req.tools?.length) {
        body.tools = [{
          functionDeclarations: req.tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        }]
        // Structured output means the model must call exactly one tool
        body.toolConfig = req.forceTool
          ? { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [req.forceTool] } }
          : { functionCallingConfig: { mode: 'AUTO' } }
      }

      const res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        let message = `Gemini ${res.status}`
        try {
          const parsed = JSON.parse(detail) as { error?: { message?: string } }
          if (parsed.error?.message) message = parsed.error.message
        } catch { /* a non-JSON body leaves the raw status, which is enough */ }
        throw new GeminiError(res.status, message)
      }

      const data = await res.json() as {
        candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[]
        promptFeedback?: { blockReason?: string }
      }

      if (data.promptFeedback?.blockReason) {
        return { text: '', toolCalls: [], stop: 'refusal' }
      }

      const candidate = data.candidates?.[0]
      if (!candidate) return { text: '', toolCalls: [], stop: 'end' }
      if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'PROHIBITED_CONTENT') {
        return { text: '', toolCalls: [], stop: 'refusal' }
      }

      const parts = candidate.content?.parts ?? []
      const toolCalls: ChatToolCall[] = []
      let text = ''

      for (const [i, part] of parts.entries()) {
        // Thinking parts are not the answer and are never shown to the user
        if (part.thought) continue
        if (part.functionCall) {
          toolCalls.push({
            id: part.functionCall.id ?? `${part.functionCall.name}-${i}`,
            name: part.functionCall.name,
            input: part.functionCall.args ?? {},
            signature: part.thoughtSignature,
          })
        } else if (part.text) {
          text += part.text
        }
      }

      const stop: StopReason = toolCalls.length ? 'tool_use' : 'end'
      return { text: text.trim(), toolCalls, stop }
    },
  }
}
