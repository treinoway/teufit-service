import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadEvalFixtures } from './eval-lib.js'

const MIN_CASES = 45
const MIN_CASES_PER_KIND = 3
const EVAL_DIR = import.meta.dirname
const { cases } = loadEvalFixtures()

const KIND_PREDICATES = {
  tool: (evalCase) => evalCase.expected.kind === 'tool',
  read: (evalCase) => evalCase.expected.kind === 'read',
  propose: (evalCase) => evalCase.expected.kind === 'propose',
  clarify: (evalCase) => evalCase.expected.kind === 'clarify',
  no_tool: (evalCase) => evalCase.expected.kind === 'no_tool',
  followup: (evalCase) => evalCase.expected.kind === 'followup',
  no_write: (evalCase) => evalCase.expected.kind === 'no_write',
  multi_turn: (evalCase) => Array.isArray(evalCase.history) && evalCase.history.length > 0,
  student_focus: (evalCase) => Boolean(evalCase.studentFocus),
}

describe('iArnold eval set shape (AC 1)', () => {
  it(`should contain at least ${MIN_CASES} cases`, () => {
    expect(cases.length).toBeGreaterThanOrEqual(MIN_CASES)
  })

  it('should have unique case ids', () => {
    const ids = cases.map((evalCase) => evalCase.id)

    expect(new Set(ids).size).toBe(ids.length)
  })

  describe.each(Object.entries(KIND_PREDICATES))('kind %s', (kind, predicate) => {
    it(`should have at least ${MIN_CASES_PER_KIND} cases`, () => {
      expect(cases.filter(predicate).length).toBeGreaterThanOrEqual(MIN_CASES_PER_KIND)
    })
  })

  it('should give every followup case a toolResult', () => {
    const followups = cases.filter(KIND_PREDICATES.followup)

    expect(followups.length).toBeGreaterThan(0)
    followups.forEach((evalCase) => expect(evalCase.toolResult, evalCase.id).toBeTruthy())
  })

  it('should give every followup case a non-empty expected.mustInclude list', () => {
    const followups = cases.filter(KIND_PREDICATES.followup)

    expect(followups.length).toBeGreaterThan(0)
    followups.forEach((evalCase) => {
      expect(Array.isArray(evalCase.expected.mustInclude), evalCase.id).toBe(true)
      expect(evalCase.expected.mustInclude.length, evalCase.id).toBeGreaterThan(0)
    })
  })

  it('should have mustInclude entries that compile as regular expressions', () => {
    const patterns = cases.filter(KIND_PREDICATES.followup).flatMap((evalCase) => evalCase.expected.mustInclude)

    patterns.forEach((pattern) => expect(() => new RegExp(pattern, 'i')).not.toThrow())
  })

  it('should include a case that uses an alternate context fixture file that exists', () => {
    const withContext = cases.filter((evalCase) => evalCase.context)

    expect(withContext.length).toBeGreaterThan(0)
    withContext.forEach((evalCase) => expect(existsSync(join(EVAL_DIR, evalCase.context)), evalCase.id).toBe(true))
  })
})
