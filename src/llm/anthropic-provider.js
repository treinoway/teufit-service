import Anthropic from '@anthropic-ai/sdk'
import { LlmProvider } from './llm-provider.js'
import { AI_MODELS } from '../constants/ai.js'

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
      this._client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    }
    return this._client
  }

  _resolveModel() {
    return process.env.ANTHROPIC_MODEL || AI_MODELS.ANTHROPIC
  }

  _normalizeProviderError(err) {
    // Re-throw with a normalized `status` property so the caller can detect 429s
    const normalized = new Error(err.message)
    normalized.status = err.status
    normalized.type = err.type
    normalized.code = err.code
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
      ...tools.slice(0, -1),
      { ...tools[tools.length - 1], cache_control: { type: 'ephemeral' } },
    ]
  }

  async chat({ system, tools, messages, maxTokens }) {
    const client = this._getClient()

    let response
    try {
      response = await client.messages.create({
        model: this._resolveModel(),
        max_tokens: maxTokens,
        system,
        tools: this._applyToolCache(tools),
        messages,
      })
    } catch (err) {
      this._normalizeProviderError(err)
    }

    return this._normalizeResponse(response)
  }

  async *chatStream({ system, tools, messages, maxTokens }) {
    const client = this._getClient()

    // .stream() is synchronous — errors only surface during async iteration
    const stream = client.messages.stream({
      model: this._resolveModel(),
      max_tokens: maxTokens,
      system,
      tools: this._applyToolCache(tools),
      messages,
    })

    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          yield { type: 'text_delta', content: event.delta.text }
        }
      }

      const finalMessage = await stream.finalMessage()
      yield { type: 'complete', response: this._normalizeResponse(finalMessage) }
    } catch (err) {
      this._normalizeProviderError(err)
    }
  }

  _normalizeResponse(response) {
    const textBlock = response.content.find(block => block.type === 'text')
    const toolUseBlocks = response.content.filter(block => block.type === 'tool_use')

    const stopReason = response.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn'

    const toolCalls = toolUseBlocks.map(block => ({
      id: block.id,
      name: block.name,
      input: block.input,
    }))

    return {
      stopReason,
      text: textBlock?.text ?? null,
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
