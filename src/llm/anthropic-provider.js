import Anthropic from '@anthropic-ai/sdk'
import { LlmProvider } from './llm-provider.js'
import { AI_MODELS, AI_LIMITS } from '../constants/ai.js'
import { resolveEffort } from './config.js'

const MAX_CACHED_SYSTEM_BLOCKS = 2

// Returns a copy of a request block without its cache_control marker.
function withoutCacheControl(block) {
  const { cache_control: _cache, ...rest } = block
  return rest
}

// Maps Anthropic stop reasons to the facade's; anything unlisted is a normal end of turn.
const STOP_REASONS = {
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
}

/**
 * Anthropic adapter for the LLM facade.
 *
 * Tool definitions: passed through as-is — Anthropic's native format matches the facade.
 * Messages: passed through as-is.
 * Tool results: converted to { type: 'tool_result', tool_use_id, content }.
 */
export class AnthropicProvider extends LlmProvider {
  constructor() {
    super()
    // Lazy client creation avoids failures if ANTHROPIC_API_KEY is not set at import time
    this._client = null
  }

  _getClient() {
    if (!this._client) {
      // why: maxRetries 0 keeps the service's callModel as the single retry layer.
      this._client = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
        maxRetries: 0,
        timeout: AI_LIMITS.LLM_TIMEOUT_MS,
      })
    }
    return this._client
  }

  // Detects an aborted request; the SDK error classes do not set `name`, so the constructor name is used.
  _isAbortError(err) {
    return err?.constructor?.name === 'APIUserAbortError' || err?.name === 'AbortError'
  }

  // Detects the SDK's request-timeout error (the client timeout is AI_LIMITS.LLM_TIMEOUT_MS).
  _isTimeoutError(err) {
    return err?.constructor?.name === 'APIConnectionTimeoutError' || err?.name === 'TimeoutError'
  }

  _resolveModel() {
    return process.env.ANTHROPIC_MODEL || AI_MODELS.ANTHROPIC
  }

  _normalizeProviderError(err, signal) {
    // Re-throw with a normalized `status` property so the caller can detect 429s
    const normalized = new Error(err.message)
    normalized.status = err.status
    normalized.type = err.type
    normalized.code = err.code
    normalized.retryAfter = err.headers?.get?.('retry-after') ?? err.headers?.['retry-after']
    normalized.aborted = Boolean(signal?.aborted) || this._isAbortError(err)
    normalized.timedOut = !normalized.aborted && this._isTimeoutError(err)
    throw normalized
  }

  /**
   * Marks the last tool in the array with cache_control: { type: "ephemeral" }
   * so Anthropic caches the entire tools array after the first request.
   * Returns the original array unchanged if it is empty.
   *
   * @param {object[]} tools
   * @returns {object[]}
   */
  _applyToolCache(tools) {
    if (!tools || tools.length === 0) return tools
    return [
      ...tools.slice(0, -1).map(withoutCacheControl),
      { ...tools[tools.length - 1], cache_control: { type: 'ephemeral' } },
    ]
  }

  // Keeps the caller's cache_control on at most the last two system blocks and strips it from earlier ones.
  _limitSystemCache(system) {
    if (!Array.isArray(system)) return system
    const firstKept = Math.max(system.length - MAX_CACHED_SYSTEM_BLOCKS, 0)
    if (!system.slice(0, firstKept).some((block) => block.cache_control)) return system
    return system.map((block, index) => (index < firstKept ? withoutCacheControl(block) : block))
  }

  // Returns a copy of the messages with the cache breakpoint on the last content block (never mutates the input).
  _applyTailCache(messages) {
    if (!messages || messages.length === 0) return messages
    const last = messages[messages.length - 1]
    const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content
    if (!Array.isArray(blocks) || blocks.length === 0) return messages
    const marked = [...blocks.slice(0, -1), { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } }]
    return [...messages.slice(0, -1), { ...last, content: marked }]
  }

  // Strips cache markers from every message but the tail's so the request never exceeds the breakpoint budget.
  _stripMessageCache(messages) {
    return (messages ?? []).map((message) => {
      if (!Array.isArray(message.content)) return message
      return { ...message, content: message.content.map(withoutCacheControl) }
    })
  }

  // Builds the request body shared by chat and chatStream.
  _buildRequest({ system, tools, messages, maxTokens }) {
    const effort = resolveEffort()
    return {
      model: this._resolveModel(),
      max_tokens: maxTokens,
      system: this._limitSystemCache(system),
      tools: this._applyToolCache(tools),
      ...this._toolChoice(tools),
      messages: this._applyTailCache(this._stripMessageCache(messages)),
      ...(effort && { output_config: { effort } }),
    }
  }

  // Keeps the model to one tool call per response: a second unanswered tool_use would break the conversation.
  _toolChoice(tools) {
    if (!tools || tools.length === 0) return {}
    return { tool_choice: { type: 'auto', disable_parallel_tool_use: true } }
  }

  async chat({ system, tools, messages, maxTokens, signal }) {
    const client = this._getClient()

    let response
    try {
      response = await client.messages.create(this._buildRequest({ system, tools, messages, maxTokens }), { signal })
    } catch (err) {
      this._normalizeProviderError(err, signal)
    }

    return this._normalizeResponse(response)
  }

  async *chatStream({ system, tools, messages, maxTokens, signal }) {
    const client = this._getClient()

    // .stream() is synchronous — errors only surface during async iteration
    const stream = client.messages.stream(this._buildRequest({ system, tools, messages, maxTokens }), { signal })

    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          yield { type: 'text_delta', content: event.delta.text }
        }
      }

      const finalMessage = await stream.finalMessage()
      yield { type: 'complete', response: this._normalizeResponse(finalMessage) }
    } catch (err) {
      this._normalizeProviderError(err, signal)
    }
  }

  _normalizeResponse(response) {
    const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('')
    const toolUseBlocks = response.content.filter(block => block.type === 'tool_use')

    const stopReason = STOP_REASONS[response.stop_reason] ?? 'end_turn'

    const toolCalls = toolUseBlocks.map(block => ({
      id: block.id,
      name: block.name,
      input: block.input,
    }))

    return {
      stopReason,
      text: text || null,
      toolCalls,
      rawContent: response.content,
      usage: this._normalizeUsage(response.usage),
    }
  }

  // Maps Anthropic usage to the normalized usage shape, or null when absent.
  _normalizeUsage(usage) {
    if (!usage) return null
    return {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    }
  }

  buildToolResultMessages(previousAssistantContent, toolResults) {
    return [
      { role: 'assistant', content: previousAssistantContent },
      {
        role: 'user',
        content: toolResults.map(result => ({
          type: 'tool_result',
          tool_use_id: result.toolCallId,
          content: result.content,
        })),
      },
    ]
  }
}
