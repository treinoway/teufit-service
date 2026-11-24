import { describe, it, expect } from 'vitest'
import { sanitizeToolInputIds, unwrapRefTag } from '../../src/helpers/ai-tool-input.js'

const UUID = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b'
const OTHER_UUID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const REF_LABELS = ['REF', 'PROTOCOL_REF', 'ASSIGNEE_REF', 'TRAINING_REF', 'EXERCISE_REF']

describe('unwrapRefTag', () => {
  it.each(REF_LABELS)('should strip a [%s:uuid] wrapper', (label) => {
    expect(unwrapRefTag(`[${label}:${UUID}]`)).toBe(UUID)
  })

  it('should trim whitespace around a wrapped value', () => {
    expect(unwrapRefTag(`  [PROTOCOL_REF:${UUID}]  `)).toBe(UUID)
  })

  it('should return a raw uuid unchanged', () => {
    expect(unwrapRefTag(UUID)).toBe(UUID)
  })

  it('should trim a raw value with surrounding whitespace', () => {
    expect(unwrapRefTag(` ${UUID} `)).toBe(UUID)
  })

  it('should not unwrap a tag with a lowercase label', () => {
    expect(unwrapRefTag(`[ref:${UUID}]`)).toBe(`[ref:${UUID}]`)
  })

  it('should not unwrap a tag missing the closing bracket', () => {
    expect(unwrapRefTag(`[REF:${UUID}`)).toBe(`[REF:${UUID}`)
  })

  it('should return null for null', () => {
    expect(unwrapRefTag(null)).toBeNull()
  })

  it('should return undefined for undefined', () => {
    expect(unwrapRefTag(undefined)).toBeUndefined()
  })

  it('should stringify non-string values', () => {
    expect(unwrapRefTag(42)).toBe('42')
  })
})

describe('sanitizeToolInputIds', () => {
  it.each(REF_LABELS)('should unwrap a top-level *Id field wrapped as [%s:uuid]', (label) => {
    expect(sanitizeToolInputIds({ protocolId: `[${label}:${UUID}]` })).toEqual({ protocolId: UUID })
  })

  it('should unwrap ids inside arrays of objects such as trainings[].trainingTemplateId', () => {
    const input = {
      trainings: [
        { trainingTemplateId: `[TRAINING_REF:${UUID}]`, weekDay: 1 },
        { trainingTemplateId: OTHER_UUID, weekDay: 2 },
      ],
    }

    expect(sanitizeToolInputIds(input)).toEqual({
      trainings: [
        { trainingTemplateId: UUID, weekDay: 1 },
        { trainingTemplateId: OTHER_UUID, weekDay: 2 },
      ],
    })
  })

  it('should unwrap every entry of an *Ids string array such as exerciseTemplateIds[]', () => {
    const input = { exerciseTemplateIds: [`[EXERCISE_REF:${UUID}]`, OTHER_UUID] }

    expect(sanitizeToolInputIds(input)).toEqual({ exerciseTemplateIds: [UUID, OTHER_UUID] })
  })

  it('should recurse into object entries of an *Ids array', () => {
    const input = { items: [{ x: 1 }], groupIds: [{ studentId: `[ASSIGNEE_REF:${UUID}]` }] }

    expect(sanitizeToolInputIds(input)).toEqual({
      items: [{ x: 1 }],
      groupIds: [{ studentId: UUID }],
    })
  })

  it('should unwrap ids in deeply nested objects', () => {
    const input = { a: { b: { c: { studentId: `[ASSIGNEE_REF:${UUID}]` } } } }

    expect(sanitizeToolInputIds(input)).toEqual({ a: { b: { c: { studentId: UUID } } } })
  })

  it('should sanitize a top-level array input', () => {
    expect(sanitizeToolInputIds([{ id: 'x', protocolId: `[REF:${UUID}]` }])).toEqual([
      { id: 'x', protocolId: UUID },
    ])
  })

  it('should leave non-id fields untouched even when they look like ref tags', () => {
    const input = { name: `[REF:${UUID}]`, notes: `[PROTOCOL_REF:${UUID}]`, sets: 3 }

    expect(sanitizeToolInputIds(input)).toEqual(input)
  })

  it('should leave a key that merely contains Id but does not end with it untouched', () => {
    const input = { idea: `[REF:${UUID}]`, Identity: `[REF:${UUID}]` }

    expect(sanitizeToolInputIds(input)).toEqual(input)
  })

  it('should not mutate the input object', () => {
    const input = {
      protocolId: `[REF:${UUID}]`,
      trainings: [{ trainingTemplateId: `[TRAINING_REF:${UUID}]` }],
      exerciseTemplateIds: [`[EXERCISE_REF:${UUID}]`],
    }
    const snapshot = structuredClone(input)

    sanitizeToolInputIds(input)

    expect(input).toEqual(snapshot)
  })

  it('should return a new object rather than the input reference', () => {
    const input = { protocolId: UUID }

    expect(sanitizeToolInputIds(input)).not.toBe(input)
  })

  it('should leave a non-string *Id value untouched', () => {
    const input = { protocolId: 123, studentId: { nested: true } }

    expect(sanitizeToolInputIds(input)).toEqual(input)
  })

  it('should keep a null *Id value as null', () => {
    expect(sanitizeToolInputIds({ protocolId: null })).toEqual({ protocolId: null })
  })

  it('should leave a non-array *Ids value untouched', () => {
    expect(sanitizeToolInputIds({ exerciseIds: null })).toEqual({ exerciseIds: null })
  })

  it('should pass through primitives and nullish inputs', () => {
    expect(sanitizeToolInputIds(null)).toBeNull()
    expect(sanitizeToolInputIds(undefined)).toBeUndefined()
    expect(sanitizeToolInputIds('text')).toBe('text')
    expect(sanitizeToolInputIds(7)).toBe(7)
  })

  it('should return an empty object for an empty object', () => {
    expect(sanitizeToolInputIds({})).toEqual({})
  })
})
