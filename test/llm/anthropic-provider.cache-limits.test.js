import { describe, it, expect, vi, beforeEach } from 'vitest'

const anthropicCreate = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}))

import Anthropic from '@anthropic-ai/sdk'
import { AnthropicProvider } from '../../src/llm/anthropic-provider.js'

const EPHEMERAL = { type: 'ephemeral' }
const FINAL_MESSAGE = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: null }

// Builds a system block, marked for caching when asked.
function block(text, cached) {
  return { type: 'text', text, ...(cached && { cache_control: EPHEMERAL }) }
}

// Sends one chat and returns the SDK request body.
async function send(provider, params) {
  await provider.chat({ messages: [{ role: 'user', content: 'Oi' }], maxTokens: 64, ...params })
  return anthropicCreate.mock.calls[0][0]
}

describe('AnthropicProvider cache marker limits', () => {
  let provider

  beforeEach(() => {
    Anthropic.mockImplementation(function () {
      this.messages = { create: anthropicCreate }
    })
    anthropicCreate.mockResolvedValue(FINAL_MESSAGE)
    provider = new AnthropicProvider()
  })

  it('should keep cache_control only on the last two system blocks', async () => {
    const system = [block('a', true), block('b', true), block('c', true)]

    const request = await send(provider, { system, tools: [] })

    expect(request.system.map((item) => item.cache_control)).toEqual([undefined, EPHEMERAL, EPHEMERAL])
  })

  it('should keep a single marked system block marked', async () => {
    const request = await send(provider, { system: [block('a', true)], tools: [] })

    expect(request.system[0].cache_control).toEqual(EPHEMERAL)
  })

  it('should leave unmarked system blocks unmarked', async () => {
    const request = await send(provider, { system: [block('a', false), block('b', false)], tools: [] })

    expect(request.system.map((item) => item.cache_control)).toEqual([undefined, undefined])
  })

  it('should pass a string system through', async () => {
    const request = await send(provider, { system: 'texto', tools: [] })

    expect(request.system).toBe('texto')
  })

  it('should strip cache_control from every tool but the last', async () => {
    const tools = [
      { name: 'a', input_schema: {}, cache_control: EPHEMERAL },
      { name: 'b', input_schema: {}, cache_control: EPHEMERAL },
      { name: 'c', input_schema: {} },
    ]

    const request = await send(provider, { system: [], tools })

    expect(request.tools.map((tool) => tool.cache_control)).toEqual([undefined, undefined, EPHEMERAL])
  })

  it('should never send more than four markers for over-marked input', async () => {
    const system = [block('a', true), block('b', true), block('c', true)]
    const tools = [{ name: 'a', input_schema: {}, cache_control: EPHEMERAL }, { name: 'b', input_schema: {}, cache_control: EPHEMERAL }]

    const request = await send(provider, { system, tools })

    expect((JSON.stringify(request).match(/"cache_control"/g) ?? []).length).toBe(4)
  })

  it('should not mutate the caller system or tools', async () => {
    const system = [block('a', true), block('b', true), block('c', true)]
    const tools = [{ name: 'a', input_schema: {}, cache_control: EPHEMERAL }, { name: 'b', input_schema: {} }]
    const snapshot = structuredClone({ system, tools })

    await send(provider, { system, tools })

    expect({ system, tools }).toEqual(snapshot)
  })

  it('should expose the retry-after header on a normalized provider error', async () => {
    const sdkError = Object.assign(new Error('rate'), { status: 429, headers: new Headers({ 'retry-after': '12' }) })
    anthropicCreate.mockRejectedValue(sdkError)

    const error = await provider.chat({ system: [], tools: [], messages: [{ role: 'user', content: 'Oi' }], maxTokens: 64 }).catch((err) => err)

    expect(error).toMatchObject({ status: 429, retryAfter: '12' })
  })
})
