import { describe, it, expect, vi } from 'vitest'
import {
  callWithRetry,
  scoreCase,
  matchesExpected,
  validateCases,
  historyToRows,
  buildEvalMessages,
} from './eval-lib.js'
import { TOOLS } from '../../src/services/ai-tool-definitions.js'
import { AI_TOOLS } from '../../src/constants/ai.js'

const MAX_ATTEMPTS = 4
// Builds a sleep double that resolves immediately.
function noSleep() {
  return vi.fn().mockResolvedValue(undefined)
}

// Builds a provider error with the normalized fields the AnthropicProvider sets.
function apiError(fields) {
  return Object.assign(new Error('boom'), fields)
}

const NO_TOOL_CASE = { id: 'c', expected: { kind: 'no_tool' } }
const OK_ANSWER = { toolCalls: [], text: 'ok' }

describe('callWithRetry', () => {
  it('should return the result without sleeping when the call succeeds', async () => {
    const sleep = noSleep()

    await expect(callWithRetry(async () => 'x', { sleep })).resolves.toBe('x')
    expect(sleep).not.toHaveBeenCalled()
  })

  it.each([[429], [500], [503], [529]])('should retry a %s and return the later success', async (status) => {
    const call = vi.fn().mockRejectedValueOnce(apiError({ status })).mockResolvedValueOnce('ok')

    await expect(callWithRetry(call, { sleep: noSleep() })).resolves.toBe('ok')
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('should retry a timeout', async () => {
    const call = vi.fn().mockRejectedValueOnce(apiError({ timedOut: true })).mockResolvedValueOnce('ok')

    await expect(callWithRetry(call, { sleep: noSleep() })).resolves.toBe('ok')
  })

  it('should not retry a 400', async () => {
    const call = vi.fn().mockRejectedValue(apiError({ status: 400 }))

    await expect(callWithRetry(call, { sleep: noSleep() })).rejects.toMatchObject({ status: 400 })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it(`should give up after ${MAX_ATTEMPTS} attempts and rethrow`, async () => {
    const call = vi.fn().mockRejectedValue(apiError({ status: 529 }))

    await expect(callWithRetry(call, { sleep: noSleep() })).rejects.toMatchObject({ status: 529 })
    expect(call).toHaveBeenCalledTimes(MAX_ATTEMPTS)
  })

  it('should wait with exponential backoff between attempts', async () => {
    const sleep = noSleep()
    const call = vi.fn().mockRejectedValue(apiError({ status: 500 }))

    await callWithRetry(call, { sleep }).catch(() => {})

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 4000, 8000])
  })

  it('should honour retry-after (seconds) over the backoff', async () => {
    const sleep = noSleep()
    const call = vi.fn().mockRejectedValueOnce(apiError({ status: 429, retryAfter: '7' })).mockResolvedValueOnce('ok')

    await callWithRetry(call, { sleep })

    expect(sleep).toHaveBeenCalledWith(7000)
  })

  it('should cap a huge retry-after', async () => {
    const sleep = noSleep()
    const call = vi.fn().mockRejectedValueOnce(apiError({ status: 429, retryAfter: '9999' })).mockResolvedValueOnce('ok')

    await callWithRetry(call, { sleep })

    expect(sleep).toHaveBeenCalledWith(60_000)
  })
})

describe('scoreCase', () => {
  it('should count passes over the runs', async () => {
    const ask = vi.fn().mockResolvedValue(OK_ANSWER)

    expect(await scoreCase(NO_TOOL_CASE, ask, { runs: 3, sleep: noSleep() })).toEqual({ passes: 3, lastFailure: '' })
  })

  it('should count a call that still fails as FAIL "api error" and keep running', async () => {
    const ask = vi.fn().mockRejectedValueOnce(apiError({ status: 400 })).mockResolvedValue(OK_ANSWER)

    const result = await scoreCase(NO_TOOL_CASE, ask, { runs: 2, sleep: noSleep() })

    expect(result).toEqual({ passes: 1, lastFailure: 'api error 400' })
  })

  it('should survive retries exhausted on every run without throwing', async () => {
    const ask = vi.fn().mockRejectedValue(apiError({ status: 529 }))

    const result = await scoreCase(NO_TOOL_CASE, ask, { runs: 2, sleep: noSleep() })

    expect(result.passes).toBe(0)
    expect(result.lastFailure).toContain('api error')
  })

  it('should record a scoring failure reason', async () => {
    const ask = vi.fn().mockResolvedValue({ toolCalls: [{ name: AI_TOOLS.UPDATE_EXERCISE, input: {} }], text: '' })

    const result = await scoreCase(NO_TOOL_CASE, ask, { runs: 1, sleep: noSleep() })

    expect(result.lastFailure).toContain('unexpected tool')
  })
})

describe('mustNotInclude', () => {
  const noWrite = { kind: 'no_write', mustNotInclude: ['assistente exclusivo', 'servidor bloqueia'] }

  it('should fail a no_write answer that leaks a forbidden phrase', () => {
    const result = matchesExpected(noWrite, { toolCalls: [], text: 'Sou o ASSISTENTE EXCLUSIVO de personal trainers' })

    expect(result.pass).toBe(false)
    expect(result.reason).toContain('assistente exclusivo')
  })

  it('should pass a no_write answer without forbidden phrases', () => {
    expect(matchesExpected(noWrite, { toolCalls: [], text: 'Não posso fazer isso.' }).pass).toBe(true)
  })

  it('should apply to no_tool answers too', () => {
    const result = matchesExpected({ kind: 'no_tool', mustNotInclude: ['segredo'] }, { toolCalls: [], text: 'O segredo é' })

    expect(result.pass).toBe(false)
  })

  it('should still pass a no_write answer with a null text', () => {
    expect(matchesExpected(noWrite, { toolCalls: [], text: null }).pass).toBe(true)
  })
})

describe('validateCases extras', () => {
  const READ_CASE = {
    id: 'r',
    message: 'Como a Ana está?',
    history: [],
    expected: { kind: 'read', tool: AI_TOOLS.GET_STUDENT_PERFORMANCE, args: { studentId: 'student-ana' } },
    replay: { text: '', toolCall: { name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: { studentId: 'student-ana' } } },
  }
  const NO_WRITE_CASE = { id: 'n', message: 'Oi', history: [], expected: { kind: 'no_write' }, replay: { text: 'Não posso.' } }

  it('should accept a valid read case', () => {
    expect(validateCases([READ_CASE], TOOLS)).toEqual([])
  })

  it('should reject an expected arg the tool schema does not declare', () => {
    const bad = { ...READ_CASE, expected: { ...READ_CASE.expected, args: { studentId: 'student-ana', invented: 1 } } }

    expect(validateCases([bad], TOOLS).join('\n')).toContain('invented')
  })

  it('should reject mustNotInclude on a kind that does not support it', () => {
    const bad = { ...READ_CASE, expected: { ...READ_CASE.expected, mustNotInclude: ['x'] } }

    expect(validateCases([bad], TOOLS).join('\n')).toContain('mustNotInclude')
  })

  it('should reject an invalid mustNotInclude regex', () => {
    const bad = { ...NO_WRITE_CASE, expected: { kind: 'no_write', mustNotInclude: ['('] } }

    expect(validateCases([bad], TOOLS).join('\n')).toContain('invalid regex')
  })

  it('should reject a replay text that matches mustNotInclude', () => {
    const bad = { ...NO_WRITE_CASE, expected: { kind: 'no_write', mustNotInclude: ['posso'] } }

    expect(validateCases([bad], TOOLS).join('\n')).toContain('forbidden')
  })

  it('should accept a valid mustNotInclude', () => {
    const good = { ...NO_WRITE_CASE, expected: { kind: 'no_write', mustNotInclude: ['segredo'] } }

    expect(validateCases([good], TOOLS)).toEqual([])
  })
})

describe('tool input sanitising in matching', () => {
  it('should unwrap a [EXERCISE_REF:id] tag in the call input before matching', () => {
    const expected = { kind: 'tool', tool: AI_TOOLS.UPDATE_EXERCISE, args: { exerciseId: 'ex-1', sets: 5 } }
    const call = { name: AI_TOOLS.UPDATE_EXERCISE, input: { exerciseId: '[EXERCISE_REF:ex-1]', sets: 5 } }

    expect(matchesExpected(expected, { toolCalls: [call], text: '' }).pass).toBe(true)
  })

  it('should match string args case-insensitively and in any order with argsMatch set', () => {
    const expected = { kind: 'read', tool: AI_TOOLS.SEARCH_EXERCISE_LIBRARY, argsMatch: 'set', args: { queries: ['rosca direta', 'rosca martelo'] } }
    const call = { name: AI_TOOLS.SEARCH_EXERCISE_LIBRARY, input: { queries: ['Rosca Martelo', 'Rosca direta', 'extra'] } }

    expect(matchesExpected(expected, { toolCalls: [call], text: '' }).pass).toBe(true)
  })

  it('should stay strict by default', () => {
    const expected = { kind: 'read', tool: AI_TOOLS.SEARCH_EXERCISE_LIBRARY, args: { queries: ['rosca direta'] } }
    const call = { name: AI_TOOLS.SEARCH_EXERCISE_LIBRARY, input: { queries: ['Rosca direta'] } }

    expect(matchesExpected(expected, { toolCalls: [call], text: '' }).pass).toBe(false)
  })
})

describe('followup tool result summarising', () => {
  it('should feed the engine summary of the raw tool result to the model', () => {
    const followup = {
      history: [],
      message: 'Como a Ana está?',
      toolCall: { name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: { studentId: 'student-ana' } },
      toolResult: { success: true, data: { studentId: 'student-ana', sessionCounts: { completed: 3 }, totalSessions: 3, ignoredField: 'x' } },
    }

    const content = JSON.parse(buildEvalMessages(followup).at(-1).content[0].content)

    expect(content).toMatchObject({ success: true, studentId: 'student-ana', totalSessions: 3 })
    expect(content).not.toHaveProperty('ignoredField')
  })
})

describe('historyToRows', () => {
  const TOOL_USE = { type: 'tool_use', id: 't1', name: AI_TOOLS.SEARCH_EXERCISE_LIBRARY, input: { queries: ['x'] } }
  const TOOL_RESULT = { type: 'tool_result', tool_use_id: 't1', content: '{"success":true}' }

  it('should keep plain text entries as they are', () => {
    const entry = { role: 'user', content: 'Oi' }

    expect(historyToRows([entry])).toEqual([entry])
  })

  it('should turn a tool_use turn into an assistant row with rawContent', () => {
    expect(historyToRows([{ role: 'assistant', content: [TOOL_USE] }])).toEqual([{ role: 'assistant', content: '', rawContent: [TOOL_USE] }])
  })

  it('should turn a tool_result turn into a tool_result row keyed by toolCallId', () => {
    expect(historyToRows([{ role: 'user', content: [TOOL_RESULT] }])).toEqual([
      { role: 'tool_result', content: '{"success":true}', rawContent: [{ toolCallId: 't1', content: '{"success":true}' }] },
    ])
  })

  it('should fail loudly on a shape it cannot replay', () => {
    expect(() => historyToRows([{ role: 'user', content: [{ type: 'image' }] }])).toThrow(/cannot be replayed/)
  })
})
