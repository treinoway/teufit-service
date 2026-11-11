import { describe, it, expect, vi, beforeEach } from 'vitest'

const anthropicCreate = vi.fn()
const anthropicStream = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}))

import Anthropic from '@anthropic-ai/sdk'
import { AnthropicProvider } from '../../src/llm/anthropic-provider.js'

const EPHEMERAL = { type: 'ephemeral' }
const MAX_BREAKPOINTS = 4
const FINAL_MESSAGE = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: null }

// Builds fresh params (tools, two cached system blocks, array-content tail) for each call.
function buildParams(overrides = {}) {
  return {
    system: [
      { type: 'text', text: 'static', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'dynamic', cache_control: { type: 'ephemeral' } },
    ],
    tools: [
      { name: 'tool_a', description: 'A', input_schema: { type: 'object' } },
      { name: 'tool_b', description: 'B', input_schema: { type: 'object' } },
    ],
    messages: [
      { role: 'user', content: 'primeira' },
      { role: 'assistant', content: [{ type: 'text', text: 'resposta' }] },
      { role: 'user', content: [{ type: 'text', text: 'parte 1' }, { type: 'text', text: 'parte 2' }] },
    ],
    maxTokens: 256,
    ...overrides,
  }
}

// Counts every cache_control marker in a serialized request.
function countBreakpoints(request) {
  return (JSON.stringify(request).match(/"cache_control"/g) ?? []).length
}

// Makes an Anthropic stream double resolving to the final message.
function makeStream() {
  return {
    [Symbol.asyncIterator]: async function* () {},
    finalMessage: vi.fn().mockResolvedValue(FINAL_MESSAGE),
  }
}

describe('AnthropicProvider cache breakpoints (AC 3)', () => {
  let provider

  beforeEach(() => {
    Anthropic.mockImplementation(function () {
      this.messages = { create: anthropicCreate, stream: anthropicStream }
    })
    anthropicCreate.mockResolvedValue(FINAL_MESSAGE)
    anthropicStream.mockImplementation(makeStream)
    provider = new AnthropicProvider()
  })

  describe.each([
    ['chat', async (params) => { await provider.chat(params); return anthropicCreate.mock.calls[0][0] }],
    ['chatStream', async (params) => { for await (const _ of provider.chatStream(params)); return anthropicStream.mock.calls[0][0] }],
  ])('%s', (_name, send) => {
    it('should send exactly four cache_control markers when system has two cached blocks', async () => {
      const request = await send(buildParams())

      expect(countBreakpoints(request)).toBe(MAX_BREAKPOINTS)
    })

    it('should never send more than four markers even when the caller marks other message blocks', async () => {
      const params = buildParams()
      params.messages[0] = { role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] }

      const request = await send(params)

      expect(countBreakpoints(request)).toBeLessThanOrEqual(MAX_BREAKPOINTS)
    })

    it('should mark the last tool only', async () => {
      const request = await send(buildParams())

      expect(request.tools.map((tool) => tool.cache_control)).toEqual([undefined, EPHEMERAL])
    })

    it('should keep both system blocks marked', async () => {
      const request = await send(buildParams())

      expect(request.system.map((block) => block.cache_control)).toEqual([EPHEMERAL, EPHEMERAL])
    })

    it('should mark the last content block of the last message', async () => {
      const request = await send(buildParams())

      expect(request.messages.at(-1).content.map((block) => block.cache_control)).toEqual([undefined, EPHEMERAL])
    })

    it('should not mark earlier messages', async () => {
      const request = await send(buildParams())

      expect(JSON.stringify(request.messages.slice(0, -1))).not.toContain('cache_control')
    })

    it('should convert string content of the last message into a text block with cache_control', async () => {
      const params = buildParams({ messages: [{ role: 'user', content: 'Oi' }] })

      const request = await send(params)

      expect(request.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Oi', cache_control: EPHEMERAL }] }])
    })

    it('should not mutate the caller messages array or its objects', async () => {
      const params = buildParams()
      const snapshot = structuredClone(params.messages)
      const originalLast = params.messages.at(-1)
      const originalBlocks = originalLast.content

      await send(params)

      expect(params.messages).toEqual(snapshot)
      expect(params.messages.at(-1)).toBe(originalLast)
      expect(originalLast.content).toBe(originalBlocks)
    })

    it('should not mutate the caller tools or system', async () => {
      const params = buildParams()
      const snapshot = structuredClone({ tools: params.tools, system: params.system })

      await send(params)

      expect({ tools: params.tools, system: params.system }).toEqual(snapshot)
    })

    it('should send no tools marker and still mark the tail when there are no tools', async () => {
      const request = await send(buildParams({ tools: [] }))

      expect(countBreakpoints(request)).toBe(3)
    })
  })
})
