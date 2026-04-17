/**
 * LLM Provider base interface.
 *
 * All concrete provider implementations must implement:
 *
 *   chat({ system, tools, messages, maxTokens }) → NormalizedResponse
 *   buildToolResultMessages(previousAssistantContent, toolResults) → messages array
 *
 * Normalized response shape:
 *   {
 *     stopReason: 'end_turn' | 'tool_use',
 *     text: string | null,
 *     toolCalls: [{ id: string, name: string, input: object }],
 *     rawContent: any,   // provider-specific content preserved for multi-turn
 *   }
 *
 * Normalized tool definition format (input to chat()):
 *   {
 *     name: string,
 *     description: string,
 *     input_schema: object,  // JSON Schema
 *   }
 *
 * Tool result format (input to buildToolResultMessages()):
 *   { toolCallId: string, content: string }
 */

export class LlmProvider {
  /**
   * Send a chat message to the LLM and return a normalized response.
   *
   * @param {object} params
   * @param {string | Array<{type: string, text: string, cache_control?: object}>} params.system -
   *   System prompt. May be a plain string or an array of text blocks (used by Anthropic for
   *   prompt caching). Providers that do not support block-style system prompts must flatten
   *   the array to a concatenated string.
   * @param {object[]} params.tools - Tool definitions in facade format
   * @param {object[]} params.messages - Conversation messages
   * @param {number} params.maxTokens - Maximum tokens to generate
   * @returns {Promise<NormalizedResponse>}
   */
  // eslint-disable-next-line no-unused-vars
  async chat({ system, tools, messages, maxTokens }) {
    throw new Error('LlmProvider.chat() must be implemented by subclass')
  }

  /**
   * Stream a chat message to the LLM, yielding text deltas and a final complete response.
   *
   * Yields:
   *   { type: 'text_delta', content: string }
   *   { type: 'complete', response: NormalizedResponse }
   *
   * @param {object} params
   * @param {string | Array<{type: string, text: string, cache_control?: object}>} params.system -
   *   System prompt. May be a plain string or an array of text blocks (used by Anthropic for
   *   prompt caching). Providers that do not support block-style system prompts must flatten
   *   the array to a concatenated string.
   * @param {object[]} params.tools - Tool definitions in facade format
   * @param {object[]} params.messages - Conversation messages
   * @param {number} params.maxTokens - Maximum tokens to generate
   * @returns {AsyncGenerator}
   */
  // eslint-disable-next-line no-unused-vars, require-yield
  async *chatStream({ system, tools, messages, maxTokens }) {
    throw new Error('LlmProvider.chatStream() must be implemented by subclass')
  }

  /**
   * Build provider-specific messages for the tool result turn in a multi-turn conversation.
   *
   * @param {any} previousAssistantContent - The rawContent from the previous assistant response
   * @param {Array<{ toolCallId: string, content: string }>} toolResults
   * @returns {object[]} Messages array to append for the tool result turn
   */
  // eslint-disable-next-line no-unused-vars
  buildToolResultMessages(previousAssistantContent, toolResults) {
    throw new Error('LlmProvider.buildToolResultMessages() must be implemented by subclass')
  }
}
