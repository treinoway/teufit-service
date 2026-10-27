import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const anthropicCreate = vi.fn()
const anthropicStream = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}))

import Anthropic from '@anthropic-ai/sdk'
import { AnthropicProvider } from '../../src/llm/anthropic-provider.js'

const MAX_LLM_TIMEOUT_MS = 60_000

const BASE_PARAMS = {
  system: 'sys',
  tools: [],
  messages: [{ role: 'user', content: 'Oi' }],
  maxTokens: 256,
}

const TRUNCATED_TOOL_USE = { type: 'tool_use', id: 'tc-1', name: 'update_exercise', input: { exerciseId: 'abc' } }

// Builds an Anthropic stream double that resolves to the given final message.
function makeStream(finalMessage) {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }
    },
    finalMessage: vi.fn().mockResolvedValue(finalMessage),
  }
}

// Drains chatStream and returns the final normalized response.
async function drainToComplete(provider, params) {
  let complete = null
  for await (const chunk of provider.chatStream(params)) {
    if (chunk.type === 'complete') complete = chunk.response
  }
  return complete
}

describe('AnthropicProvider hardening', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  beforeEach(() => {
    Anthropic.mockImplementation(function () {
      this.messages = { create: anthropicCreate, stream: anthropicStream }
    })
  })

  describe('stop reason normalization (AC 6)', () => {
    it('should surface max_tokens as stopReason "max_tokens" in chat()', async () => {
      anthropicCreate.mockResolvedValue({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'cortad' }] })

      const response = await new AnthropicProvider().chat(BASE_PARAMS)

      expect(response.stopReason).toBe('max_tokens')
    })

    it('should surface refusal as stopReason "refusal" in chat()', async () => {
      anthropicCreate.mockResolvedValue({ stop_reason: 'refusal', content: [] })

      const response = await new AnthropicProvider().chat(BASE_PARAMS)

      expect(response.stopReason).toBe('refusal')
    })

    it('should not report tool_use when max_tokens truncated a response that contains a tool_use block', async () => {
      anthropicCreate.mockResolvedValue({ stop_reason: 'max_tokens', content: [TRUNCATED_TOOL_USE] })

      const response = await new AnthropicProvider().chat(BASE_PARAMS)

      expect(response.stopReason).toBe('max_tokens')
    })

    it('should surface max_tokens as stopReason "max_tokens" in chatStream()', async () => {
      anthropicStream.mockReturnValue(makeStream({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'x' }] }))

      const response = await drainToComplete(new AnthropicProvider(), BASE_PARAMS)

      expect(response.stopReason).toBe('max_tokens')
    })

    it('should surface refusal as stopReason "refusal" in chatStream()', async () => {
      anthropicStream.mockReturnValue(makeStream({ stop_reason: 'refusal', content: [] }))

      const response = await drainToComplete(new AnthropicProvider(), BASE_PARAMS)

      expect(response.stopReason).toBe('refusal')
    })

    it('should keep mapping end_turn and tool_use unchanged', async () => {
      anthropicCreate.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] })
      anthropicCreate.mockResolvedValueOnce({ stop_reason: 'tool_use', content: [TRUNCATED_TOOL_USE] })
      const provider = new AnthropicProvider()

      const endTurn = await provider.chat(BASE_PARAMS)
      const toolUse = await provider.chat(BASE_PARAMS)

      expect([endTurn.stopReason, toolUse.stopReason]).toEqual(['end_turn', 'tool_use'])
    })
  })

  describe('timeout, retries and abort (AC 7)', () => {
    it('should disable SDK-level retries so withLlmRetry is the single retry layer', async () => {
      anthropicCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] })

      await new AnthropicProvider().chat(BASE_PARAMS)

      expect(Anthropic).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }))
    })

    it('should configure an explicit client timeout of at most 60 seconds', async () => {
      anthropicCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] })

      await new AnthropicProvider().chat(BASE_PARAMS)

      const clientOptions = Anthropic.mock.calls[0][0]
      expect(clientOptions.timeout).toBeGreaterThan(0)
      expect(clientOptions.timeout).toBeLessThanOrEqual(MAX_LLM_TIMEOUT_MS)
    })

    it('should forward the abort signal to messages.create in chat()', async () => {
      anthropicCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] })
      const controller = new AbortController()

      await new AnthropicProvider().chat({ ...BASE_PARAMS, signal: controller.signal })

      expect(anthropicCreate.mock.calls[0][1]).toMatchObject({ signal: controller.signal })
    })

    it('should forward the abort signal to messages.stream in chatStream()', async () => {
      anthropicStream.mockReturnValue(makeStream({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] }))
      const controller = new AbortController()

      await drainToComplete(new AnthropicProvider(), { ...BASE_PARAMS, signal: controller.signal })

      expect(anthropicStream.mock.calls[0][1]).toMatchObject({ signal: controller.signal })
    })
  })

  describe('default model (AC 25)', () => {
    it('should call the SDK with claude-sonnet-5-5 when ANTHROPIC_MODEL is unset', async () => {
      vi.stubEnv('ANTHROPIC_MODEL', '')
      anthropicCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] })

      await new AnthropicProvider().chat(BASE_PARAMS)

      expect(anthropicCreate.mock.calls[0][0].model).toBe('claude-sonnet-5-5')
    })
  })
})
