import { describe, it, expect } from 'vitest'
import ptBR from '../../src/i18n/locales/pt-BR.js'
import enUS from '../../src/i18n/locales/en-US.js'
import { AI_MESSAGE_CODES, AI_ERRORS } from '../../src/constants/ai.js'
import { aiChatSchema, aiChatStreamSchema } from '../../api/schemas/ai-route.schema.js'

const NEW_AI_MESSAGE_CODES = ['ai.unavailable', 'ai.responseTooLong', 'ai.confirmationRequired', 'ai.toolDisabled']

describe('AI message codes', () => {
  describe('constants (AC 27)', () => {
    it('should expose the new codes with their stable string values', () => {
      expect(AI_MESSAGE_CODES).toMatchObject({
        UNAVAILABLE: 'ai.unavailable',
        RESPONSE_TOO_LONG: 'ai.responseTooLong',
        CONFIRMATION_REQUIRED: 'ai.confirmationRequired',
        TOOL_DISABLED: 'ai.toolDisabled',
      })
    })

    it('should keep every pre-existing AI messageCode value unchanged', () => {
      expect(Object.values(AI_MESSAGE_CODES)).toEqual(expect.arrayContaining([
        'ai.trainerNotFound',
        'ai.conversationNotFound',
        'ai.rateLimited',
        'ai.modelError',
        'ai.overloaded',
        'ai.exerciseTemplateNotOwned',
        'ai.trainingTemplateNotOwned',
      ]))
    })

    it('should expose an AI_ERRORS code for the unavailable state', () => {
      expect(AI_ERRORS.UNAVAILABLE).toEqual(expect.any(String))
    })

    it('should be frozen so codes cannot be mutated at runtime', () => {
      expect(Object.isFrozen(AI_MESSAGE_CODES)).toBe(true)
    })
  })

  describe.each([
    ['pt-BR', ptBR],
    ['en-US', enUS],
  ])('%s locale (AC 27)', (_name, locale) => {
    it.each(NEW_AI_MESSAGE_CODES)('should translate %s', (messageCode) => {
      expect(locale.errors[messageCode]).toEqual(expect.any(String))
      expect(locale.errors[messageCode].length).toBeGreaterThan(0)
    })

    it('should translate every code listed in AI_MESSAGE_CODES', () => {
      const missing = Object.values(AI_MESSAGE_CODES).filter((code) => !locale.errors[code])

      expect(missing).toEqual([])
    })
  })

  describe('pt-BR copy (AC 6, AC 27)', () => {
    it('should tell the trainer to split a too-long answer', () => {
      expect(ptBR.errors['ai.responseTooLong']).toMatch(/longa/i)
    })

    it('should keep accents in the pt-BR unavailable message', () => {
      expect(ptBR.errors['ai.unavailable']).toMatch(/[ãéçõíáê]/)
    })
  })
})

describe('chat request schemas (AC 20)', () => {
  it.each([
    ['aiChatSchema', aiChatSchema],
    ['aiChatStreamSchema', aiChatStreamSchema],
  ])('should accept an optional uuid studentId in %s', (_name, schema) => {
    expect(schema.body.properties.studentId).toMatchObject({ type: 'string', format: 'uuid' })
    expect(schema.body.required).not.toContain('studentId')
  })
})

describe('chat response schema (AC 4)', () => {
  it('should document 503 and 529 on the non-streaming chat route', () => {
    expect(Object.keys(aiChatSchema.response)).toEqual(expect.arrayContaining(['503', '529']))
  })
})
