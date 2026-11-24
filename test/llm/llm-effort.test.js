import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const anthropicCreate = vi.fn()
const anthropicStream = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}))

import Anthropic from '@anthropic-ai/sdk'
import { AnthropicProvider } from '../../src/llm/anthropic-provider.js'
import { resolveEffort } from '../../src/llm/config.js'

const EFFORT_ENV = 'ANTHROPIC_EFFORT'
const VALID_EFFORTS = ['low', 'medium', 'high', 'max']
const FINAL_MESSAGE = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: null }
const PARAMS = { system: [{ type: 'text', text: 's' }], tools: [], messages: [{ role: 'user', content: 'Oi' }], maxTokens: 64 }

// Sends one chat and returns the SDK request body.
async function sendChat(provider) {
  await provider.chat(PARAMS)
  return anthropicCreate.mock.calls[0][0]
}

// Sends one stream and returns the SDK request body.
async function sendStream(provider) {
  for await (const chunk of provider.chatStream(PARAMS)) void chunk
  return anthropicStream.mock.calls[0][0]
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveEffort (AC 4)', () => {
  it.each(VALID_EFFORTS)('should return the effort when ANTHROPIC_EFFORT is %s', (effort) => {
    vi.stubEnv(EFFORT_ENV, effort)

    expect(resolveEffort()).toBe(effort)
  })

  it('should return nothing when ANTHROPIC_EFFORT is unset', () => {
    vi.stubEnv(EFFORT_ENV, undefined)

    expect(resolveEffort() ?? null).toBeNull()
  })

  it('should return nothing when ANTHROPIC_EFFORT is blank', () => {
    vi.stubEnv(EFFORT_ENV, '   ')

    expect(resolveEffort() ?? null).toBeNull()
  })

  it('should return nothing when ANTHROPIC_EFFORT is empty', () => {
    vi.stubEnv(EFFORT_ENV, '')

    expect(resolveEffort() ?? null).toBeNull()
  })

  it('should return nothing when ANTHROPIC_EFFORT is invalid', () => {
    vi.stubEnv(EFFORT_ENV, 'turbo')

    expect(resolveEffort() ?? null).toBeNull()
  })

  it('should read the environment at call time, not at import time', () => {
    vi.stubEnv(EFFORT_ENV, 'low')
    const first = resolveEffort()
    vi.stubEnv(EFFORT_ENV, 'high')

    expect([first, resolveEffort()]).toEqual(['low', 'high'])
  })
})

describe('AnthropicProvider effort (AC 4)', () => {
  let provider

  beforeEach(() => {
    Anthropic.mockImplementation(function () {
      this.messages = { create: anthropicCreate, stream: anthropicStream }
    })
    anthropicCreate.mockResolvedValue(FINAL_MESSAGE)
    anthropicStream.mockImplementation(() => ({
      [Symbol.asyncIterator]: async function* () {},
      finalMessage: vi.fn().mockResolvedValue(FINAL_MESSAGE),
    }))
    provider = new AnthropicProvider()
  })

  const chatRequest = () => sendChat(provider)
  const streamRequest = () => sendStream(provider)

  it.each(['low', 'medium', 'high'])('should send output_config effort %s on chat', async (effort) => {
    vi.stubEnv(EFFORT_ENV, effort)

    expect((await chatRequest()).output_config).toEqual({ effort })
  })

  it('should send output_config effort on chatStream', async () => {
    vi.stubEnv(EFFORT_ENV, 'medium')

    expect((await streamRequest()).output_config).toEqual({ effort: 'medium' })
  })

  it('should pick up an effort set after the provider was created', async () => {
    vi.stubEnv(EFFORT_ENV, 'high')

    expect((await chatRequest()).output_config).toEqual({ effort: 'high' })
  })

  it('should omit output_config on chat when ANTHROPIC_EFFORT is unset', async () => {
    vi.stubEnv(EFFORT_ENV, undefined)

    expect(await chatRequest()).not.toHaveProperty('output_config')
  })

  it('should omit output_config on chatStream when ANTHROPIC_EFFORT is unset', async () => {
    vi.stubEnv(EFFORT_ENV, undefined)

    expect(await streamRequest()).not.toHaveProperty('output_config')
  })

  it('should omit output_config when ANTHROPIC_EFFORT is invalid', async () => {
    vi.stubEnv(EFFORT_ENV, 'turbo')

    expect(await chatRequest()).not.toHaveProperty('output_config')
  })
})
