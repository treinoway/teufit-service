import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const anthropicCreate = vi.fn()
const anthropicStream = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}))

import Anthropic from '@anthropic-ai/sdk'
import { AnthropicProvider } from '../../src/llm/anthropic-provider.js'
import { getLlmProvider, checkLlmConfiguration, isLlmConfigured } from '../../src/llm/index.js'

const TOOL = { name: 'update_exercise', description: 'x', input_schema: { type: 'object', properties: {} } }
const PARAMS = { system: 'sys', tools: [TOOL], messages: [{ role: 'user', content: 'Oi' }], maxTokens: 256 }
const OK_RESPONSE = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }

// Builds an error whose constructor is named like the SDK class (the SDK does not set `name`).
function sdkError(className, message = 'boom') {
  const SdkError = { [className]: class extends Error {} }[className]
  return new SdkError(message)
}

// Drains a provider stream, returning the thrown error if any.
async function drainError(provider, params) {
  try {
    for await (const chunk of provider.chatStream(params)) void chunk
  } catch (err) {
    return err
  }
  return null
}

beforeEach(() => {
  vi.clearAllMocks()
  Anthropic.mockImplementation(function () {
    this.messages = { create: anthropicCreate, stream: anthropicStream }
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('one tool call per response (B1)', () => {
  it('should disable parallel tool use in chat()', async () => {
    anthropicCreate.mockResolvedValue(OK_RESPONSE)

    await new AnthropicProvider().chat(PARAMS)

    expect(anthropicCreate.mock.calls[0][0].tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true })
  })

  it('should disable parallel tool use in chatStream()', async () => {
    anthropicStream.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {},
      finalMessage: vi.fn().mockResolvedValue(OK_RESPONSE),
    })

    await drainError(new AnthropicProvider(), PARAMS)

    expect(anthropicStream.mock.calls[0][0].tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true })
  })

  it('should not send tool_choice when there are no tools (the API rejects it)', async () => {
    anthropicCreate.mockResolvedValue(OK_RESPONSE)

    await new AnthropicProvider().chat({ ...PARAMS, tools: [] })

    expect(anthropicCreate.mock.calls[0][0]).not.toHaveProperty('tool_choice')
  })
})

describe('error classification', () => {
  it('should flag an SDK abort error as aborted', async () => {
    anthropicCreate.mockRejectedValue(sdkError('APIUserAbortError', 'Request was aborted.'))

    await expect(new AnthropicProvider().chat(PARAMS)).rejects.toMatchObject({ aborted: true, timedOut: false })
  })

  it('should flag any error as aborted when the caller signal is aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    anthropicCreate.mockRejectedValue(new Error('socket hang up'))

    await expect(new AnthropicProvider().chat({ ...PARAMS, signal: controller.signal })).rejects.toMatchObject({ aborted: true })
  })

  it('should flag the SDK timeout error as timedOut, not aborted', async () => {
    anthropicCreate.mockRejectedValue(sdkError('APIConnectionTimeoutError', 'Request timed out.'))

    await expect(new AnthropicProvider().chat(PARAMS)).rejects.toMatchObject({ timedOut: true, aborted: false })
  })

  it('should classify the same way while streaming', async () => {
    anthropicStream.mockReturnValue({
      [Symbol.asyncIterator]: async function* () { throw sdkError('APIConnectionTimeoutError') },
      finalMessage: vi.fn(),
    })

    expect(await drainError(new AnthropicProvider(), PARAMS)).toMatchObject({ timedOut: true })
  })

  it('should leave ordinary errors unflagged', async () => {
    anthropicCreate.mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }))

    await expect(new AnthropicProvider().chat(PARAMS)).rejects.toMatchObject({ aborted: false, timedOut: false, status: 400 })
  })
})

describe('LLM_PROVIDER matching is case-insensitive (nit)', () => {
  it.each(['Anthropic', 'ANTHROPIC', ' anthropic '])('should resolve the Anthropic provider for "%s"', (value) => {
    vi.stubEnv('LLM_PROVIDER', value)
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')

    expect(getLlmProvider()).toBeInstanceOf(AnthropicProvider)
    expect(isLlmConfigured()).toBe(true)
  })

  it('should still refuse GEMINI in any case', () => {
    vi.stubEnv('LLM_PROVIDER', 'GEMINI')

    expect(() => getLlmProvider()).toThrow(/no longer supported/i)
  })

  it('should report an unsupported provider at boot regardless of case', () => {
    vi.stubEnv('LLM_PROVIDER', 'Gemini')
    const logger = { error: vi.fn() }

    expect(checkLlmConfiguration(logger)).toBe(false)
    expect(logger.error).toHaveBeenCalledTimes(1)
  })
})
