/**
 * Tests for the 6 new update tools added to ai-training-service and the
 * enriched buildTrainerContext query (trainings + exercises nested under protocols).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock Prisma before any service imports
vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    trainingProtocol: { findUnique: vi.fn(), findMany: vi.fn() },
    trainerStudent: { findMany: vi.fn() },
    trainingProtocolTemplate: { findMany: vi.fn(), create: vi.fn() },
    trainingTemplate: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    exerciseTemplate: { findMany: vi.fn(), create: vi.fn() },
    training: { create: vi.fn() },
    exercise: { create: vi.fn() },
    aiConversation: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    aiMessage: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}))

// Mock Anthropic SDK to prevent real API calls
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}))

// Mock all service dependencies
vi.mock('../../src/services/training-protocol-service.js', () => ({
  importFromTemplate: vi.fn(),
  updateProtocol: vi.fn(),
}))
vi.mock('../../src/services/exercise-template-service.js', () => ({
  createExerciseTemplate: vi.fn(),
  updateExerciseTemplate: vi.fn(),
}))
vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstProtocolCreated: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/services/training-protocol-template-service.js', () => ({
  updateProtocolTemplate: vi.fn(),
}))
vi.mock('../../src/services/training-template-service.js', () => ({
  updateTrainingTemplate: vi.fn(),
}))
vi.mock('../../src/services/training-service.js', () => ({
  updateTraining: vi.fn(),
}))
vi.mock('../../src/services/exercise-service.js', () => ({
  updateExercise: vi.fn(),
}))

import { prisma } from '../../src/db.js'
import Anthropic from '@anthropic-ai/sdk'
import { updateProtocolTemplate } from '../../src/services/training-protocol-template-service.js'
import { updateTrainingTemplate } from '../../src/services/training-template-service.js'
import { updateExerciseTemplate } from '../../src/services/exercise-template-service.js'
import { updateProtocol } from '../../src/services/training-protocol-service.js'
import { updateTraining } from '../../src/services/training-service.js'
import { updateExercise } from '../../src/services/exercise-service.js'
import { buildTrainerContext, executeTool } from '../../src/services/ai-training-service.js'
import { AI_TOOLS, AI_LIMITS } from '../../src/constants/ai.js'

describe('ai-training-service — update tools & enriched context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Anthropic.mockImplementation(function () {
      this.messages = { create: vi.fn() }
    })
    prisma.$transaction.mockImplementation(async (fn) => {
      if (typeof fn === 'function') return fn(prisma)
      return Promise.all(fn.map((p) => p))
    })
  })

  // ---------------------------------------------------------------------------
  // buildTrainerContext — enriched activeProtocols with trainings + exercises
  // ---------------------------------------------------------------------------

  describe('buildTrainerContext — enriched activeProtocols', () => {
    function stubFullContext({ protocols = [] } = {}) {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
      prisma.trainerStudent.findMany.mockResolvedValue([])
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([])
      prisma.trainingTemplate.findMany.mockResolvedValue([])
      prisma.trainingProtocol.findMany.mockResolvedValue(protocols)
      prisma.exerciseTemplate.findMany.mockResolvedValue([])
    }

    it('requests trainings with exercises nested under active protocols', async () => {
      stubFullContext()

      await buildTrainerContext('user-1')

      const call = prisma.trainingProtocol.findMany.mock.calls[0][0]

      // Must select trainings
      expect(call.select).toHaveProperty('trainings')

      // Trainings must be limited
      expect(call.select.trainings).toMatchObject({
        take: AI_LIMITS.MAX_CONTEXT_TRAININGS_PER_PROTOCOL,
      })

      // Trainings must include exercises
      expect(call.select.trainings.select).toHaveProperty('exercises')
      expect(call.select.trainings.select.exercises).toMatchObject({
        take: AI_LIMITS.MAX_CONTEXT_EXERCISES_PER_TRAINING,
      })
    })

    it('returns trainings and exercises in the context object', async () => {
      const protocols = [
        {
          id: 'proto-1',
          name: 'Protocolo Força',
          assigneeId: 'student-1',
          assignee: { firstName: 'Ana', lastName: 'Lima' },
          trainings: [
            {
              id: 'training-1',
              name: 'Treino A',
              weekDay: 'monday',
              exercises: [
                { id: 'ex-1', name: 'Supino' },
                { id: 'ex-2', name: 'Crucifixo' },
              ],
            },
          ],
        },
      ]
      stubFullContext({ protocols })

      const ctx = await buildTrainerContext('user-1')

      expect(ctx.activeProtocols).toHaveLength(1)
      expect(ctx.activeProtocols[0].trainings).toHaveLength(1)
      expect(ctx.activeProtocols[0].trainings[0].exercises).toHaveLength(2)
      expect(ctx.activeProtocols[0].trainings[0].exercises[0].name).toBe('Supino')
    })

    it('handles protocols with empty trainings array without error', async () => {
      const protocols = [
        {
          id: 'proto-1',
          name: 'Protocolo Vazio',
          assigneeId: 'student-2',
          assignee: { firstName: 'João', lastName: null },
          trainings: [],
        },
      ]
      stubFullContext({ protocols })

      const ctx = await buildTrainerContext('user-1')

      expect(ctx.activeProtocols[0].trainings).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // executeTool — UPDATE_PROTOCOL_TEMPLATE
  // ---------------------------------------------------------------------------

  describe(`executeTool — ${AI_TOOLS.UPDATE_PROTOCOL_TEMPLATE}`, () => {
    it('calls updateProtocolTemplate with only the provided fields', async () => {
      const updated = { id: 'tmpl-1', name: 'Nova Rotina' }
      updateProtocolTemplate.mockResolvedValue(updated)

      const result = await executeTool('user-1', AI_TOOLS.UPDATE_PROTOCOL_TEMPLATE, {
        templateId: 'tmpl-1',
        name: 'Nova Rotina',
      })

      expect(updateProtocolTemplate).toHaveBeenCalledWith('user-1', 'tmpl-1', {
        name: 'Nova Rotina',
      })
      expect(result).toMatchObject({ success: true, data: updated })
    })

    it('does not include undefined fields in the data object', async () => {
      updateProtocolTemplate.mockResolvedValue({ id: 'tmpl-1', name: 'Força' })

      await executeTool('user-1', AI_TOOLS.UPDATE_PROTOCOL_TEMPLATE, {
        templateId: 'tmpl-1',
        name: 'Força',
        // trainingLevel and type are intentionally omitted
      })

      const [, , data] = updateProtocolTemplate.mock.calls[0]
      expect(data).not.toHaveProperty('trainingLevel')
      expect(data).not.toHaveProperty('type')
    })

    it('passes all supported fields when all are provided', async () => {
      updateProtocolTemplate.mockResolvedValue({ id: 'tmpl-1' })

      await executeTool('user-1', AI_TOOLS.UPDATE_PROTOCOL_TEMPLATE, {
        templateId: 'tmpl-1',
        name: 'Full',
        description: 'Desc',
        defaultDurationWeeks: 8,
        genderOrdination: 'female',
        trainingLevel: 'intermediate',
        type: 'strength',
      })

      const [, , data] = updateProtocolTemplate.mock.calls[0]
      expect(data).toEqual({
        name: 'Full',
        description: 'Desc',
        defaultDurationWeeks: 8,
        genderOrdination: 'female',
        trainingLevel: 'intermediate',
        type: 'strength',
      })
    })

    it('returns { success: false } when the service throws an AppError', async () => {
      const { AppError } = await import('../../src/errors/app-error.js')
      updateProtocolTemplate.mockRejectedValue(
        new AppError({
          httpStatus: 404,
          error: 'NOT_FOUND',
          messageCode: 'protocol.templateNotFound',
          message: 'Template not found',
        }),
      )

      const result = await executeTool('user-1', AI_TOOLS.UPDATE_PROTOCOL_TEMPLATE, {
        templateId: 'tmpl-missing',
      })

      expect(result).toMatchObject({
        success: false,
        error: 'NOT_FOUND',
        messageCode: 'protocol.templateNotFound',
      })
    })
  })

  // ---------------------------------------------------------------------------
  // executeTool — UPDATE_TRAINING_TEMPLATE
  // ---------------------------------------------------------------------------

  describe(`executeTool — ${AI_TOOLS.UPDATE_TRAINING_TEMPLATE}`, () => {
    it('calls updateTrainingTemplate with only the provided fields', async () => {
      const updated = { id: 'tt-1', name: 'Treino Costas' }
      updateTrainingTemplate.mockResolvedValue(updated)

      const result = await executeTool('user-1', AI_TOOLS.UPDATE_TRAINING_TEMPLATE, {
        templateId: 'tt-1',
        name: 'Treino Costas',
        category: 'strength',
      })

      expect(updateTrainingTemplate).toHaveBeenCalledWith('user-1', 'tt-1', {
        name: 'Treino Costas',
        category: 'strength',
      })
      expect(result).toMatchObject({ success: true, data: updated })
    })

    it('does not send bodySegment when not provided', async () => {
      updateTrainingTemplate.mockResolvedValue({ id: 'tt-1' })

      await executeTool('user-1', AI_TOOLS.UPDATE_TRAINING_TEMPLATE, {
        templateId: 'tt-1',
        name: 'Peito',
      })

      const [, , data] = updateTrainingTemplate.mock.calls[0]
      expect(data).not.toHaveProperty('bodySegment')
    })
  })

  // ---------------------------------------------------------------------------
  // executeTool — UPDATE_EXERCISE_TEMPLATE
  // ---------------------------------------------------------------------------

  describe(`executeTool — ${AI_TOOLS.UPDATE_EXERCISE_TEMPLATE}`, () => {
    it('calls updateExerciseTemplate with only the provided fields', async () => {
      const updated = { id: 'et-1', name: 'Supino Reto' }
      updateExerciseTemplate.mockResolvedValue(updated)

      const result = await executeTool('user-1', AI_TOOLS.UPDATE_EXERCISE_TEMPLATE, {
        templateId: 'et-1',
        name: 'Supino Reto',
        sets: 4,
      })

      expect(updateExerciseTemplate).toHaveBeenCalledWith('user-1', 'et-1', {
        name: 'Supino Reto',
        sets: 4,
      })
      expect(result).toMatchObject({ success: true, data: updated })
    })

    it('passes boolean hasLoad=false correctly (falsy but defined)', async () => {
      updateExerciseTemplate.mockResolvedValue({ id: 'et-1' })

      await executeTool('user-1', AI_TOOLS.UPDATE_EXERCISE_TEMPLATE, {
        templateId: 'et-1',
        hasLoad: false,
      })

      const [, , data] = updateExerciseTemplate.mock.calls[0]
      expect(data).toHaveProperty('hasLoad', false)
    })

    it('passes all supported fields when all are provided', async () => {
      updateExerciseTemplate.mockResolvedValue({ id: 'et-1' })

      await executeTool('user-1', AI_TOOLS.UPDATE_EXERCISE_TEMPLATE, {
        templateId: 'et-1',
        name: 'Rosca Direta',
        type: 'strength',
        sets: 3,
        repetitions: { min: 10, max: 12 },
        duration: null,
        hasLoad: true,
        suggestedLoad: 20,
        restInterval: 60,
        notes: 'Cotovelos fixos',
      })

      const [, , data] = updateExerciseTemplate.mock.calls[0]
      // duration is null (explicitly provided) — should still be present
      expect(data).toMatchObject({
        name: 'Rosca Direta',
        type: 'strength',
        sets: 3,
        repetitions: { min: 10, max: 12 },
        hasLoad: true,
        suggestedLoad: 20,
        restInterval: 60,
        notes: 'Cotovelos fixos',
      })
    })
  })

  // ---------------------------------------------------------------------------
  // executeTool — UPDATE_PROTOCOL
  // ---------------------------------------------------------------------------

  describe(`executeTool — ${AI_TOOLS.UPDATE_PROTOCOL}`, () => {
    it('calls updateProtocol with only the provided fields', async () => {
      const updated = { id: 'proto-1', name: 'Protocolo Verão', status: 'active' }
      updateProtocol.mockResolvedValue(updated)

      const result = await executeTool('user-1', AI_TOOLS.UPDATE_PROTOCOL, {
        protocolId: 'proto-1',
        name: 'Protocolo Verão',
        status: 'active',
      })

      expect(updateProtocol).toHaveBeenCalledWith('user-1', 'proto-1', {
        name: 'Protocolo Verão',
        status: 'active',
      })
      expect(result).toMatchObject({ success: true, data: updated })
    })

    it('does not include expirationDate when not provided', async () => {
      updateProtocol.mockResolvedValue({ id: 'proto-1' })

      await executeTool('user-1', AI_TOOLS.UPDATE_PROTOCOL, {
        protocolId: 'proto-1',
        status: 'paused',
      })

      const [, , data] = updateProtocol.mock.calls[0]
      expect(data).not.toHaveProperty('expirationDate')
      expect(data).not.toHaveProperty('startDate')
    })

    it('returns { success: false } when updateProtocol throws AppError', async () => {
      const { AppError } = await import('../../src/errors/app-error.js')
      updateProtocol.mockRejectedValue(
        new AppError({
          httpStatus: 403,
          error: 'FORBIDDEN',
          messageCode: 'protocol.forbidden',
          message: 'Not your protocol',
        }),
      )

      const result = await executeTool('user-1', AI_TOOLS.UPDATE_PROTOCOL, {
        protocolId: 'proto-x',
        name: 'Hack',
      })

      expect(result).toMatchObject({
        success: false,
        error: 'FORBIDDEN',
        messageCode: 'protocol.forbidden',
      })
    })
  })

  // ---------------------------------------------------------------------------
  // executeTool — UPDATE_TRAINING
  // ---------------------------------------------------------------------------

  describe(`executeTool — ${AI_TOOLS.UPDATE_TRAINING}`, () => {
    it('calls updateTraining with only the provided fields', async () => {
      const updated = { id: 'tr-1', name: 'Treino B', weekDay: 'tuesday' }
      updateTraining.mockResolvedValue(updated)

      const result = await executeTool('user-1', AI_TOOLS.UPDATE_TRAINING, {
        trainingId: 'tr-1',
        name: 'Treino B',
        weekDay: 'tuesday',
      })

      expect(updateTraining).toHaveBeenCalledWith('user-1', 'tr-1', {
        name: 'Treino B',
        weekDay: 'tuesday',
      })
      expect(result).toMatchObject({ success: true, data: updated })
    })

    it('does not include order or notes when not provided', async () => {
      updateTraining.mockResolvedValue({ id: 'tr-1' })

      await executeTool('user-1', AI_TOOLS.UPDATE_TRAINING, {
        trainingId: 'tr-1',
        category: 'cardio',
      })

      const [, , data] = updateTraining.mock.calls[0]
      expect(data).not.toHaveProperty('order')
      expect(data).not.toHaveProperty('notes')
    })

    it('passes order=0 correctly (falsy integer but defined)', async () => {
      updateTraining.mockResolvedValue({ id: 'tr-1' })

      await executeTool('user-1', AI_TOOLS.UPDATE_TRAINING, {
        trainingId: 'tr-1',
        order: 0,
      })

      const [, , data] = updateTraining.mock.calls[0]
      expect(data).toHaveProperty('order', 0)
    })
  })

  // ---------------------------------------------------------------------------
  // executeTool — UPDATE_EXERCISE
  // ---------------------------------------------------------------------------

  describe(`executeTool — ${AI_TOOLS.UPDATE_EXERCISE}`, () => {
    it('calls updateExercise with only the provided fields', async () => {
      const updated = { id: 'ex-1', sets: 5 }
      updateExercise.mockResolvedValue(updated)

      const result = await executeTool('user-1', AI_TOOLS.UPDATE_EXERCISE, {
        exerciseId: 'ex-1',
        sets: 5,
      })

      expect(updateExercise).toHaveBeenCalledWith('user-1', 'ex-1', {
        sets: 5,
      })
      expect(result).toMatchObject({ success: true, data: updated })
    })

    it('passes repetitions object correctly', async () => {
      updateExercise.mockResolvedValue({ id: 'ex-1' })

      await executeTool('user-1', AI_TOOLS.UPDATE_EXERCISE, {
        exerciseId: 'ex-1',
        repetitions: { min: 8, max: 10 },
      })

      const [, , data] = updateExercise.mock.calls[0]
      expect(data).toEqual({ repetitions: { min: 8, max: 10 } })
    })

    it('does not include name or notes when not provided', async () => {
      updateExercise.mockResolvedValue({ id: 'ex-1' })

      await executeTool('user-1', AI_TOOLS.UPDATE_EXERCISE, {
        exerciseId: 'ex-1',
        restInterval: 90,
      })

      const [, , data] = updateExercise.mock.calls[0]
      expect(data).not.toHaveProperty('name')
      expect(data).not.toHaveProperty('notes')
      expect(data).toEqual({ restInterval: 90 })
    })

    it('returns { success: false } when updateExercise throws AppError', async () => {
      const { AppError } = await import('../../src/errors/app-error.js')
      updateExercise.mockRejectedValue(
        new AppError({
          httpStatus: 404,
          error: 'EXERCISE_NOT_FOUND',
          messageCode: 'exercise.notFound',
          message: 'Exercise not found',
        }),
      )

      const result = await executeTool('user-1', AI_TOOLS.UPDATE_EXERCISE, {
        exerciseId: 'ex-missing',
        sets: 3,
      })

      expect(result).toMatchObject({
        success: false,
        error: 'EXERCISE_NOT_FOUND',
        messageCode: 'exercise.notFound',
      })
    })

    it('re-throws generic (non-AppError) errors', async () => {
      updateExercise.mockRejectedValue(new Error('DB connection lost'))

      await expect(
        executeTool('user-1', AI_TOOLS.UPDATE_EXERCISE, {
          exerciseId: 'ex-1',
          sets: 3,
        }),
      ).rejects.toThrow('DB connection lost')
    })
  })

  // ---------------------------------------------------------------------------
  // TOOLS constant — verify all 6 new tools are registered
  // ---------------------------------------------------------------------------

  describe('AI_TOOLS constants', () => {
    it('exports all 6 new update tool names', () => {
      expect(AI_TOOLS.UPDATE_PROTOCOL_TEMPLATE).toBe('update_protocol_template')
      expect(AI_TOOLS.UPDATE_TRAINING_TEMPLATE).toBe('update_training_template')
      expect(AI_TOOLS.UPDATE_EXERCISE_TEMPLATE).toBe('update_exercise_template')
      expect(AI_TOOLS.UPDATE_PROTOCOL).toBe('update_protocol')
      expect(AI_TOOLS.UPDATE_TRAINING).toBe('update_training')
      expect(AI_TOOLS.UPDATE_EXERCISE).toBe('update_exercise')
    })
  })

  // ---------------------------------------------------------------------------
  // AI_LIMITS — verify new context limits
  // ---------------------------------------------------------------------------

  describe('AI_LIMITS', () => {
    it('exports MAX_CONTEXT_TRAININGS_PER_PROTOCOL', () => {
      expect(AI_LIMITS.MAX_CONTEXT_TRAININGS_PER_PROTOCOL).toBe(6)
    })

    it('exports MAX_CONTEXT_EXERCISES_PER_TRAINING', () => {
      expect(AI_LIMITS.MAX_CONTEXT_EXERCISES_PER_TRAINING).toBe(6)
    })
  })
})
