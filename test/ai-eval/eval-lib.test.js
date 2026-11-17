import { describe, it, expect } from 'vitest'
import { matchesExpected } from './eval-lib.js'
import { AI_TOOLS } from '../../src/constants/ai.js'

const FOLLOWUP = { kind: 'followup', mustInclude: ['12 sessões', 'Supino'] }
const WRITE_CALL = { id: 'tc-1', name: AI_TOOLS.UPDATE_EXERCISE, input: { exerciseId: 'ex-1', sets: 5 } }
const READ_CALL = { id: 'tc-2', name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: { studentId: 'student-ana' } }
const SEARCH_CALL = { id: 'tc-3', name: AI_TOOLS.SEARCH_EXERCISE_LIBRARY, input: { query: 'supino' } }

describe('matchesExpected kind followup', () => {
  it('should pass when the text includes every required fact and no tool is called', () => {
    const result = matchesExpected(FOLLOWUP, { toolCalls: [], text: 'A Ana fez 12 sessões; o Supino evoluiu.' })

    expect(result.pass).toBe(true)
  })

  it('should match required facts case-insensitively', () => {
    const result = matchesExpected(FOLLOWUP, { toolCalls: [], text: 'fez 12 SESSÕES e o supino evoluiu' })

    expect(result.pass).toBe(true)
  })

  it('should fail when one required fact is missing', () => {
    const result = matchesExpected(FOLLOWUP, { toolCalls: [], text: 'A Ana fez 12 sessões.' })

    expect(result.pass).toBe(false)
  })

  it('should name the missing pattern in the failure reason', () => {
    const result = matchesExpected(FOLLOWUP, { toolCalls: [], text: 'A Ana fez 12 sessões.' })

    expect(result.reason).toContain('Supino')
  })

  it('should fail when the text is empty', () => {
    expect(matchesExpected(FOLLOWUP, { toolCalls: [], text: '' }).pass).toBe(false)
  })

  it('should fail when the text is null', () => {
    expect(matchesExpected(FOLLOWUP, { toolCalls: [], text: null }).pass).toBe(false)
  })

  it('should fail when the model calls a tool even if the text has the facts', () => {
    const result = matchesExpected(FOLLOWUP, { toolCalls: [READ_CALL], text: '12 sessões Supino' })

    expect(result.pass).toBe(false)
  })

  it('should support regular expressions in mustInclude', () => {
    const expected = { kind: 'followup', mustInclude: ['\\b\\d+ sess(ão|ões)\\b'] }

    expect(matchesExpected(expected, { toolCalls: [], text: 'Foram 7 sessões' }).pass).toBe(true)
  })
})

describe('matchesExpected kind no_write', () => {
  const expected = { kind: 'no_write' }

  it('should pass when the model answers with text only', () => {
    expect(matchesExpected(expected, { toolCalls: [], text: 'Não posso fazer isso.' }).pass).toBe(true)
  })

  it('should pass when the model calls get_student_performance', () => {
    expect(matchesExpected(expected, { toolCalls: [READ_CALL], text: '' }).pass).toBe(true)
  })

  it('should pass when the model calls search_exercise_library', () => {
    expect(matchesExpected(expected, { toolCalls: [SEARCH_CALL], text: '' }).pass).toBe(true)
  })

  it('should fail when the model calls a write tool', () => {
    expect(matchesExpected(expected, { toolCalls: [WRITE_CALL], text: '' }).pass).toBe(false)
  })

  it('should name the write tool in the failure reason', () => {
    expect(matchesExpected(expected, { toolCalls: [WRITE_CALL], text: '' }).reason).toContain(AI_TOOLS.UPDATE_EXERCISE)
  })

  it('should fail when a write tool follows a read tool in the same answer', () => {
    expect(matchesExpected(expected, { toolCalls: [READ_CALL, WRITE_CALL], text: '' }).pass).toBe(false)
  })
})
