import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the Anthropic SDK before importing the provider
const anthropicCreate = vi.fn()
const anthropicStream = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}))

import Anthropic from '@anthropic-ai/sdk'
import { AnthropicProvider } from '../../src/llm/anthropic-provider.js'

describe('AnthropicProvider', () => {
  let provider

  beforeEach(() => {
    vi.clearAllMocks()
    Anthropic.mockImplementation(function () {
      this.messages = { create: anthropicCreate, stream: anthropicStream }
    })
    provider = new AnthropicProvider()
  })

  // ---------------------------------------------------------------------------
  // _applyToolCache
  // ---------------------------------------------------------------------------

  describe('_applyToolCache', () => {
    it('marks the last tool with cache_control: { type: "ephemeral" }', () => {
      const tools = [
        { name: 'tool_a', description: 'A', input_schema: {} },
        { name: 'tool_b', description: 'B', input_schema: {} },
      ]
      const result = provider._applyToolCache(tools)
      expect(result[result.length - 1].cache_control).toEqual({ type: 'ephemeral' })
    })

    it('does not add cache_control to tools other than the last', () => {
      const tools = [
        { name: 'tool_a', description: 'A', input_schema: {} },
        { name: 'tool_b', description: 'B', input_schema: {} },
        { name: 'tool_c', description: 'C', input_schema: {} },
      ]
      const result = provider._applyToolCache(tools)
      expect(result[0].cache_control).toBeUndefined()
      expect(result[1].cache_control).toBeUndefined()
      expect(result[2].cache_control).toEqual({ type: 'ephemeral' })
    })

    it('does not mutate the original tools array', () => {
      const original = { name: 'tool_a', description: 'A', input_schema: {} }
      const tools = [original]
      provider._applyToolCache(tools)
      expect(original.cache_control).toBeUndefined()
      expect(tools[0]).toBe(original)
    })

    it('returns empty array unchanged when tools is empty', () => {
      expect(provider._applyToolCache([])).toEqual([])
    })

    it('preserves all other tool properties on the last element', () => {
      const tools = [
        { name: 'my_tool', description: 'desc', input_schema: { type: 'object' } },
      ]
      const result = provider._applyToolCache(tools)
      expect(result[0].name).toBe('my_tool')
      expect(result[0].description).toBe('desc')
      expect(result[0].input_schema).toEqual({ type: 'object' })
      expect(result[0].cache_control).toEqual({ type: 'ephemeral' })
    })

    it('works correctly with a single tool', () => {
      const tools = [{ name: 'only_tool', description: 'Solo', input_schema: {} }]
      const result = provider._applyToolCache(tools)
      expect(result).toHaveLength(1)
      expect(result[0].cache_control).toEqual({ type: 'ephemeral' })
    })
  })

  // ---------------------------------------------------------------------------
  // chat()
  // ---------------------------------------------------------------------------

  describe('chat()', () => {
    const baseParams = {
      system: 'You are helpful',
      tools: [
        { name: 'tool_a', description: 'A', input_schema: {} },
        { name: 'tool_b', description: 'B', input_schema: {} },
      ],
      messages: [{ role: 'user', content: 'Hello' }],
      maxTokens: 1024,
    }

    beforeEach(() => {
      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Hi' }],
      })
    })

    it('passes tools with cache_control on last element to SDK', async () => {
      await provider.chat(baseParams)
      const callArgs = anthropicCreate.mock.calls[0][0]
      const sentTools = callArgs.tools
      expect(sentTools[sentTools.length - 1].cache_control).toEqual({ type: 'ephemeral' })
      expect(sentTools[0].cache_control).toBeUndefined()
    })

    it('passes system string as-is to SDK', async () => {
      await provider.chat({ ...baseParams, system: 'plain system string' })
      const callArgs = anthropicCreate.mock.calls[0][0]
      expect(callArgs.system).toBe('plain system string')
    })

    it('passes system array as-is to SDK', async () => {
      const systemBlocks = [
        { type: 'text', text: 'Static rules', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Dynamic context' },
      ]
      await provider.chat({ ...baseParams, system: systemBlocks })
      const callArgs = anthropicCreate.mock.calls[0][0]
      expect(callArgs.system).toBe(systemBlocks)
    })
  })

  // ---------------------------------------------------------------------------
  // chatStream()
  // ---------------------------------------------------------------------------

  describe('chatStream()', () => {
    const baseParams = {
      system: [
        { type: 'text', text: 'Static', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Dynamic' },
      ],
      tools: [
        { name: 'tool_x', description: 'X', input_schema: {} },
        { name: 'tool_y', description: 'Y', input_schema: {} },
      ],
      messages: [{ role: 'user', content: 'Stream me' }],
      maxTokens: 512,
    }

    it('passes tools with cache_control on last element to stream()', async () => {
      // Set up a mock stream that yields a complete event immediately
      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }
        },
        finalMessage: vi.fn().mockResolvedValue({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'hi' }],
        }),
      }
      anthropicStream.mockReturnValue(mockStream)

      // Drain the generator
       
      for await (const _chunk of provider.chatStream(baseParams)) { /* drain */ }

      const callArgs = anthropicStream.mock.calls[0][0]
      const sentTools = callArgs.tools
      expect(sentTools[sentTools.length - 1].cache_control).toEqual({ type: 'ephemeral' })
      expect(sentTools[0].cache_control).toBeUndefined()
    })
  })

  describe('usage normalization', () => {
    const baseParams = {
      system: 'sys',
      tools: [],
      messages: [{ role: 'user', content: 'Hello' }],
      maxTokens: 256,
    }

    const rawUsage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 10,
    }

    const normalizedUsage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
    }

    function makeStream(finalMessage) {
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }
        },
        finalMessage: vi.fn().mockResolvedValue(finalMessage),
      }
    }

    async function collectComplete(params) {
      let complete = null
      for await (const chunk of provider.chatStream(params)) {
        if (chunk.type === 'complete') complete = chunk
      }
      return complete
    }

    it('chat() maps Anthropic usage fields to the normalized usage object', async () => {
      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Hi' }],
        usage: rawUsage,
      })

      const response = await provider.chat(baseParams)

      expect(response.usage).toEqual(normalizedUsage)
    })

    it('chat() defaults missing cache counters to 0', async () => {
      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Hi' }],
        usage: { input_tokens: 7, output_tokens: 3 },
      })

      const response = await provider.chat(baseParams)

      expect(response.usage).toEqual({
        inputTokens: 7,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })
    })

    it('chat() returns usage null when the provider sent none', async () => {
      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Hi' }],
      })

      const response = await provider.chat(baseParams)

      expect(response.usage).toBeNull()
    })

    it('chatStream() complete event carries the normalized usage', async () => {
      anthropicStream.mockReturnValue(
        makeStream({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'hi' }],
          usage: rawUsage,
        }),
      )

      const complete = await collectComplete(baseParams)

      expect(complete.response.usage).toEqual(normalizedUsage)
    })

    it('chatStream() complete event has usage null when the provider sent none', async () => {
      anthropicStream.mockReturnValue(
        makeStream({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] }),
      )

      const complete = await collectComplete(baseParams)

      expect(complete.response.usage).toBeNull()
    })
  })
})
