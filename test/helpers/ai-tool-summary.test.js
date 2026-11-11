import { describe, it, expect } from 'vitest'
import { summarizeToolResult } from '../../src/helpers/ai-tool-summary.js'

const DEFAULT_EXERCISE_NAME = 'exercício'

describe('summarizeToolResult', () => {
  describe('failure results', () => {
    it('should return only success, error and message when the tool failed', () => {
      const result = summarizeToolResult({
        success: false,
        error: 'NOT_FOUND',
        message: 'Protocol not found',
        data: { name: 'ignored' },
      })

      expect(result).toEqual({ success: false, error: 'NOT_FOUND', message: 'Protocol not found' })
    })
  })

  describe('missing data', () => {
    it('should return a bare success when data is undefined', () => {
      expect(summarizeToolResult({ success: true })).toEqual({ success: true })
    })

    it('should return a bare success when data is null', () => {
      expect(summarizeToolResult({ success: true, data: null })).toEqual({ success: true })
    })
  })

  describe('protocol with trainings', () => {
    const protocol = {
      name: 'Hypertrophy',
      type: 'STRENGTH',
      ignored: 'x',
      trainings: [
        {
          weekDay: 1,
          trainingTemplate: {
            name: 'Push',
            trainingTemplateExerciseTemplates: [
              {
                name: 'Bench',
                sets: 4,
                repetitions: '8-10',
                restInterval: 90,
                hasLoad: true,
                suggestedLoad: 60,
                id: 'drop',
              },
              { exerciseTemplate: { name: 'Fly' } },
              {},
            ],
          },
        },
      ],
    }

    it('should summarize protocol header and training count', () => {
      const result = summarizeToolResult({ success: true, data: protocol })

      expect(result).toMatchObject({
        success: true,
        name: 'Hypertrophy',
        type: 'STRENGTH',
        trainingsCount: 1,
      })
      expect(result).not.toHaveProperty('ignored')
    })

    it('should summarize a training using the template name, weekDay and exercises count', () => {
      const [training] = summarizeToolResult({ success: true, data: protocol }).trainings

      expect(training).toMatchObject({ name: 'Push', weekDay: 1, exercisesCount: 3 })
    })

    it('should keep only the whitelisted exercise fields', () => {
      const [training] = summarizeToolResult({ success: true, data: protocol }).trainings

      expect(training.exercises[0]).toEqual({
        name: 'Bench',
        sets: 4,
        repetitions: '8-10',
        restInterval: 90,
        hasLoad: true,
        suggestedLoad: 60,
      })
    })

    it('should fall back to the exerciseTemplate name and null for missing numeric fields', () => {
      const [training] = summarizeToolResult({ success: true, data: protocol }).trainings

      expect(training.exercises[1]).toEqual({
        name: 'Fly',
        sets: null,
        repetitions: null,
        restInterval: null,
        hasLoad: null,
        suggestedLoad: null,
      })
    })

    it('should fall back to the default exercise name when none is available', () => {
      const [training] = summarizeToolResult({ success: true, data: protocol }).trainings

      expect(training.exercises[2].name).toBe(DEFAULT_EXERCISE_NAME)
    })

    it('should use the training name when there is no trainingTemplate', () => {
      const data = { name: 'P', type: 'T', trainings: [{ name: 'Direct', weekDay: 3 }] }

      const [training] = summarizeToolResult({ success: true, data }).trainings

      expect(training).toEqual({ name: 'Direct', weekDay: 3, exercisesCount: null, exercises: [] })
    })

    it('should return trainingsCount zero and an empty list for an empty trainings array', () => {
      const result = summarizeToolResult({ success: true, data: { name: 'P', type: 'T', trainings: [] } })

      expect(result).toEqual({ success: true, name: 'P', type: 'T', trainingsCount: 0, trainings: [] })
    })

    it('should not treat a non-array trainings value as a protocol', () => {
      const result = summarizeToolResult({ success: true, data: { name: 'P', id: 'i', trainings: 'x' } })

      expect(result).toEqual({ success: true, name: 'P', id: 'i' })
    })
  })

  describe('training template with exercises', () => {
    const template = {
      name: 'Leg day',
      category: 'LEGS',
      id: 'drop',
      trainingTemplateExerciseTemplates: [
        { name: 'Squat', sets: 5, repetitions: '5', restInterval: 120, hasLoad: true, suggestedLoad: 100 },
        { exerciseTemplate: { name: 'Lunge' } },
        {},
      ],
    }

    it('should summarize name, category and exercises count', () => {
      const result = summarizeToolResult({ success: true, data: template })

      expect(result).toMatchObject({
        success: true,
        name: 'Leg day',
        category: 'LEGS',
        exercisesCount: 3,
      })
      expect(result).not.toHaveProperty('id')
    })

    it('should map exercises with fallbacks for name and null numeric fields', () => {
      const { exercises } = summarizeToolResult({ success: true, data: template })

      expect(exercises).toEqual([
        { name: 'Squat', sets: 5, repetitions: '5', restInterval: 120, hasLoad: true, suggestedLoad: 100 },
        { name: 'Lunge', sets: null, repetitions: null, restInterval: null, hasLoad: null, suggestedLoad: null },
        { name: DEFAULT_EXERCISE_NAME, sets: null, repetitions: null, restInterval: null, hasLoad: null, suggestedLoad: null },
      ])
    })

    it('should handle an empty exercise list', () => {
      const data = { name: 'Empty', category: 'X', trainingTemplateExerciseTemplates: [] }

      expect(summarizeToolResult({ success: true, data })).toEqual({
        success: true,
        name: 'Empty',
        category: 'X',
        exercisesCount: 0,
        exercises: [],
      })
    })
  })

  describe('student performance', () => {
    const performance = {
      studentId: 's1',
      studentName: 'Ana',
      window: { days: 30 },
      sessionCounts: { COMPLETED: 8, SKIPPED: 2 },
      totalSessions: 10,
      completionRate: 0.8,
      lastSessionAt: '2026-11-01T10:00:00.000Z',
      currentProtocol: { id: 'p1', name: 'Proto' },
      extra: 'drop',
      topExercises: [
        {
          exerciseId: 'e1',
          name: 'Bench',
          hasLoad: true,
          sessionCount: 6,
          lastPerformedAt: '2026-11-01',
          latestMaxLoad: 80,
          latestAvgLoad: 75,
          latestTotalVolume: 2400,
          maxLoadDelta: 5,
          maxLoadDeltaPct: 6.6,
          secret: 'drop',
        },
      ],
    }

    it('should pass through the aggregate performance fields and drop unknown ones', () => {
      const result = summarizeToolResult({ success: true, data: performance })

      expect(result).toMatchObject({
        success: true,
        studentId: 's1',
        studentName: 'Ana',
        window: { days: 30 },
        sessionCounts: { COMPLETED: 8, SKIPPED: 2 },
        totalSessions: 10,
        completionRate: 0.8,
        lastSessionAt: '2026-11-01T10:00:00.000Z',
        currentProtocol: { id: 'p1', name: 'Proto' },
      })
      expect(result).not.toHaveProperty('extra')
    })

    it('should keep only the whitelisted topExercises fields', () => {
      const { topExercises } = summarizeToolResult({ success: true, data: performance })

      expect(topExercises).toEqual([
        {
          exerciseId: 'e1',
          name: 'Bench',
          hasLoad: true,
          sessionCount: 6,
          lastPerformedAt: '2026-11-01',
          latestMaxLoad: 80,
          latestAvgLoad: 75,
          latestTotalVolume: 2400,
          maxLoadDelta: 5,
          maxLoadDeltaPct: 6.6,
        },
      ])
    })

    it('should return an empty topExercises list when it is missing', () => {
      const data = { studentId: 's1', sessionCounts: {} }

      expect(summarizeToolResult({ success: true, data }).topExercises).toEqual([])
    })
  })

  describe('library results', () => {
    it('should return the results array as-is', () => {
      const results = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]

      expect(summarizeToolResult({ success: true, data: { results, other: 1 } })).toEqual({
        success: true,
        results,
      })
    })

    it('should return an empty results array', () => {
      expect(summarizeToolResult({ success: true, data: { results: [] } })).toEqual({
        success: true,
        results: [],
      })
    })
  })

  describe('default shape', () => {
    it('should return only name and id', () => {
      const result = summarizeToolResult({ success: true, data: { name: 'Thing', id: 'i1', big: { x: 1 } } })

      expect(result).toEqual({ success: true, name: 'Thing', id: 'i1' })
    })

    it('should return undefined name and id when the data has neither', () => {
      expect(summarizeToolResult({ success: true, data: { other: 1 } })).toEqual({
        success: true,
        name: undefined,
        id: undefined,
      })
    })
  })
})
