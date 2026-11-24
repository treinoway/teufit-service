import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../../src/services/ai-prompt.js'
import { loadEvalFixtures } from '../ai-eval/eval-lib.js'

const EPHEMERAL = { type: 'ephemeral' }
const { context } = loadEvalFixtures()

describe('buildSystemPrompt caching (AC 3)', () => {
  it('should return exactly two blocks', () => {
    expect(buildSystemPrompt(context)).toHaveLength(2)
  })

  it('should mark the static block with an ephemeral cache_control', () => {
    expect(buildSystemPrompt(context)[0].cache_control).toEqual(EPHEMERAL)
  })

  it('should mark the dynamic block with an ephemeral cache_control', () => {
    expect(buildSystemPrompt(context)[1].cache_control).toEqual(EPHEMERAL)
  })

  it('should return byte-identical output for the same context called twice', () => {
    const first = JSON.stringify(buildSystemPrompt(context))
    const second = JSON.stringify(buildSystemPrompt(structuredClone(context)))

    expect(second).toBe(first)
  })

  it('should return byte-identical output with the same student focus called twice', () => {
    const focus = { studentId: 'student-ana', anamnesis: null, performance: null }

    expect(JSON.stringify(buildSystemPrompt(context, focus))).toBe(JSON.stringify(buildSystemPrompt(context, focus)))
  })
})
