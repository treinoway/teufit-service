import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    trainingProtocol: { findUnique: vi.fn() },
    trainingProtocolTemplate: { create: vi.fn() },
    trainingTemplate: { create: vi.fn() },
    exerciseTemplate: { findMany: vi.fn(), create: vi.fn() },
    advancedTechnique: { findMany: vi.fn() },
    training: { findUnique: vi.fn(), create: vi.fn(), aggregate: vi.fn() },
    exercise: { create: vi.fn(), aggregate: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('../../src/services/training-protocol-service.js', () => ({
  importFromTemplate: vi.fn(),
}))
vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstProtocolCreated: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertCanUseAi: vi.fn().mockResolvedValue(undefined),
  recordAiAction: vi.fn().mockResolvedValue(undefined),
}))

import { prisma } from '../../src/db.js'
import { executeTool } from '../../src/services/ai-training-service.js'
import { AI_TOOLS } from '../../src/constants/ai.js'
import { ExerciseType, TrainingCategory } from '../../src/constants/training.js'

const USER_ID = 'user-1'
const TRAINER_ID = 'trainer-1'
const ADMIN_TRAINER_ID = 'admin-trainer'
const TRAINING_ID = 'training-1'
const PROTOCOL_ID = 'protocol-1'

const PUBLIC_SUPINO = {
  id: 'lib-supino',
  trainerId: ADMIN_TRAINER_ID,
  name: 'Supino Reto com Barra',
  type: ExerciseType.STRENGTH,
  videoUrl: 'https://videos.example.com/supino.mp4',
  gifUrl: 'https://gifs.example.com/supino.gif',
  advancedTechniqueLinks: [],
}

const DROP_SET_ID = 'tech-drop-set'
const REST_PAUSE_ID = 'tech-rest-pause'
const FOREIGN_TECHNIQUE_ID = 'tech-other-trainer-private'

const PUBLIC_REMADA = {
  id: 'lib-remada',
  trainerId: ADMIN_TRAINER_ID,
  name: 'Remada Curvada',
  type: ExerciseType.STRENGTH,
  videoUrl: null,
  gifUrl: 'https://gifs.example.com/remada.gif',
  advancedTechniqueLinks: [
    { advancedTechniqueId: REST_PAUSE_ID, order: 1 },
    { advancedTechniqueId: FOREIGN_TECHNIQUE_ID, order: 2 },
    { advancedTechniqueId: DROP_SET_ID, order: 0 },
  ],
}

const REMADA = { name: 'remada curvada', type: ExerciseType.STRENGTH, sets: 3, repetitions: { min: 8, max: 10 }, restInterval: 90 }
const EXPECTED_REMADA_LINKS = {
  create: [
    { advancedTechniqueId: DROP_SET_ID, order: 0 },
    { advancedTechniqueId: REST_PAUSE_ID, order: 1 },
  ],
}

const SUPINO = { name: 'supino reto barra', type: ExerciseType.STRENGTH, sets: 4, repetitions: { min: 8, max: 12 }, restInterval: 90 }
const UNKNOWN = { name: 'Exercicio inventado', type: ExerciseType.STRENGTH, sets: 3, repetitions: { min: 10, max: 12 }, restInterval: 60 }

// Echoes created rows back with a deterministic id.
function echoCreate(prefix) {
  return async ({ data }) => ({ id: `${prefix}-${data.name}`, ...data })
}

// Junction rows passed to the n-th trainingTemplate.create call.
function junctionRows(callIndex = 0) {
  return prisma.trainingTemplate.create.mock.calls[callIndex][0].data.trainingTemplateExerciseTemplates.create
}

beforeEach(() => {
  prisma.$transaction.mockImplementation(async (fn) => fn(prisma))
  prisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID })
  prisma.exerciseTemplate.findMany.mockResolvedValue([PUBLIC_SUPINO, PUBLIC_REMADA])
  prisma.advancedTechnique.findMany.mockResolvedValue([{ id: DROP_SET_ID }, { id: REST_PAUSE_ID }])
  prisma.exerciseTemplate.create.mockImplementation(echoCreate('created'))
  prisma.exercise.create.mockImplementation(echoCreate('exercise'))
  prisma.training.create.mockImplementation(echoCreate('training'))
  prisma.trainingTemplate.create.mockImplementation(echoCreate('tt'))
  prisma.trainingProtocolTemplate.create.mockImplementation(echoCreate('pt'))
})

describe('iArnold links exercises to the library by name', () => {
  describe(AI_TOOLS.ADD_EXERCISES_TO_TRAINING, () => {
    beforeEach(() => {
      prisma.training.findUnique.mockResolvedValue({ id: TRAINING_ID, deletedAt: null, trainingProtocol: { trainerId: TRAINER_ID } })
      prisma.exercise.aggregate.mockResolvedValue({ _max: { order: null } })
    })

    it('should copy the matched template link, video and gif onto the student exercise', async () => {
      await executeTool(USER_ID, AI_TOOLS.ADD_EXERCISES_TO_TRAINING, { trainingId: TRAINING_ID, exercises: [SUPINO] })

      expect(prisma.exercise.create.mock.calls[0][0].data).toMatchObject({
        exerciseTemplateId: PUBLIC_SUPINO.id,
        videoUrl: PUBLIC_SUPINO.videoUrl,
        gifUrl: PUBLIC_SUPINO.gifUrl,
        name: SUPINO.name,
        sets: 4,
      })
    })

    it('should leave link and media empty when no template matches', async () => {
      await executeTool(USER_ID, AI_TOOLS.ADD_EXERCISES_TO_TRAINING, { trainingId: TRAINING_ID, exercises: [UNKNOWN] })

      const data = prisma.exercise.create.mock.calls[0][0].data
      expect(data).not.toHaveProperty('exerciseTemplateId')
      expect(data).not.toHaveProperty('gifUrl')
    })

    it('should search only the trainer own and public templates', async () => {
      await executeTool(USER_ID, AI_TOOLS.ADD_EXERCISES_TO_TRAINING, { trainingId: TRAINING_ID, exercises: [SUPINO] })

      expect(prisma.exerciseTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deletedAt: null, OR: [{ trainerId: TRAINER_ID }, { isPublic: true }] } }),
      )
    })
  })

  describe(AI_TOOLS.ADD_TRAINING_TO_PROTOCOL, () => {
    beforeEach(() => {
      prisma.trainingProtocol.findUnique.mockResolvedValue({ id: PROTOCOL_ID, trainerId: TRAINER_ID, deletedAt: null })
      prisma.training.aggregate.mockResolvedValue({ _max: { order: null } })
    })

    it('should copy the matched template link and media onto each exercise of the new training', async () => {
      await executeTool(USER_ID, AI_TOOLS.ADD_TRAINING_TO_PROTOCOL, {
        protocolId: PROTOCOL_ID,
        trainings: [{ name: 'Treino A', category: TrainingCategory.STRENGTH, exercises: [SUPINO, UNKNOWN] }],
      })

      const [matched, unmatched] = prisma.exercise.create.mock.calls.map(([arg]) => arg.data)
      expect(matched).toMatchObject({ exerciseTemplateId: PUBLIC_SUPINO.id, gifUrl: PUBLIC_SUPINO.gifUrl, videoUrl: PUBLIC_SUPINO.videoUrl })
      expect(unmatched).not.toHaveProperty('exerciseTemplateId')
    })
  })

  describe(AI_TOOLS.CREATE_TRAINING_TEMPLATE, () => {
    it('should reuse the matched library template instead of creating a duplicate', async () => {
      await executeTool(USER_ID, AI_TOOLS.CREATE_TRAINING_TEMPLATE, {
        name: 'Treino A',
        category: TrainingCategory.STRENGTH,
        exercises: [SUPINO],
      })

      expect(prisma.exerciseTemplate.create).not.toHaveBeenCalled()
      expect(junctionRows()[0]).toMatchObject({
        exerciseTemplateId: PUBLIC_SUPINO.id,
        name: SUPINO.name,
        videoUrl: PUBLIC_SUPINO.videoUrl,
        gifUrl: PUBLIC_SUPINO.gifUrl,
        sets: 4,
        restInterval: 90,
      })
    })

    it('should create a private template only for unmatched exercises', async () => {
      await executeTool(USER_ID, AI_TOOLS.CREATE_TRAINING_TEMPLATE, {
        name: 'Treino A',
        category: TrainingCategory.STRENGTH,
        exercises: [SUPINO, UNKNOWN],
      })

      expect(prisma.exerciseTemplate.create).toHaveBeenCalledTimes(1)
      expect(prisma.exerciseTemplate.create.mock.calls[0][0].data).toMatchObject({ name: UNKNOWN.name, trainerId: TRAINER_ID, isPublic: false })
      expect(junctionRows().map((row) => row.exerciseTemplateId)).toEqual([PUBLIC_SUPINO.id, `created-${UNKNOWN.name}`])
    })

    it('should keep a video URL given by the model over the library one', async () => {
      await executeTool(USER_ID, AI_TOOLS.CREATE_TRAINING_TEMPLATE, {
        name: 'Treino A',
        category: TrainingCategory.STRENGTH,
        exercises: [{ ...SUPINO, videoUrl: 'https://videos.example.com/custom.mp4' }],
      })

      expect(junctionRows()[0]).toMatchObject({ videoUrl: 'https://videos.example.com/custom.mp4', gifUrl: PUBLIC_SUPINO.gifUrl })
    })
  })

  describe(AI_TOOLS.CREATE_PROTOCOL_TEMPLATE, () => {
    it('should reuse library templates and create an unmatched exercise once across trainings', async () => {
      await executeTool(USER_ID, AI_TOOLS.CREATE_PROTOCOL_TEMPLATE, {
        name: 'Rotina',
        trainings: [
          { name: 'Treino A', category: TrainingCategory.STRENGTH, exercises: [SUPINO, UNKNOWN] },
          { name: 'Treino B', category: TrainingCategory.STRENGTH, exercises: [UNKNOWN] },
        ],
      })

      expect(prisma.exerciseTemplate.create).toHaveBeenCalledTimes(1)
      expect(prisma.exerciseTemplate.findMany).toHaveBeenCalledTimes(1)
      expect(junctionRows(0)[0]).toMatchObject({ exerciseTemplateId: PUBLIC_SUPINO.id, gifUrl: PUBLIC_SUPINO.gifUrl })
      expect(junctionRows(1)[0].exerciseTemplateId).toBe(`created-${UNKNOWN.name}`)
    })
  })

  describe('advanced techniques of the matched library exercise', () => {
    it('should copy the visible techniques in order onto a student exercise added to a training', async () => {
      prisma.training.findUnique.mockResolvedValue({ id: TRAINING_ID, deletedAt: null, trainingProtocol: { trainerId: TRAINER_ID } })
      prisma.exercise.aggregate.mockResolvedValue({ _max: { order: null } })

      await executeTool(USER_ID, AI_TOOLS.ADD_EXERCISES_TO_TRAINING, { trainingId: TRAINING_ID, exercises: [REMADA, UNKNOWN] })

      const [matched, unmatched] = prisma.exercise.create.mock.calls.map(([arg]) => arg.data)
      expect(matched.advancedTechniqueLinks).toEqual(EXPECTED_REMADA_LINKS)
      expect(unmatched).not.toHaveProperty('advancedTechniqueLinks')
    })

    it('should check technique visibility for the trainer', async () => {
      prisma.training.findUnique.mockResolvedValue({ id: TRAINING_ID, deletedAt: null, trainingProtocol: { trainerId: TRAINER_ID } })
      prisma.exercise.aggregate.mockResolvedValue({ _max: { order: null } })

      await executeTool(USER_ID, AI_TOOLS.ADD_EXERCISES_TO_TRAINING, { trainingId: TRAINING_ID, exercises: [REMADA] })

      const { where } = prisma.advancedTechnique.findMany.mock.calls[0][0]
      expect(where.id.in).toEqual(expect.arrayContaining([DROP_SET_ID, REST_PAUSE_ID, FOREIGN_TECHNIQUE_ID]))
      expect(JSON.stringify(where)).toContain(TRAINER_ID)
    })

    it('should copy the techniques onto exercises of a training added to a protocol', async () => {
      prisma.trainingProtocol.findUnique.mockResolvedValue({ id: PROTOCOL_ID, trainerId: TRAINER_ID, deletedAt: null })
      prisma.training.aggregate.mockResolvedValue({ _max: { order: null } })

      await executeTool(USER_ID, AI_TOOLS.ADD_TRAINING_TO_PROTOCOL, {
        protocolId: PROTOCOL_ID,
        trainings: [{ name: 'Treino B', category: TrainingCategory.STRENGTH, exercises: [REMADA] }],
      })

      expect(prisma.exercise.create.mock.calls[0][0].data.advancedTechniqueLinks).toEqual(EXPECTED_REMADA_LINKS)
    })

    it('should copy the techniques onto the junction row of a training template', async () => {
      await executeTool(USER_ID, AI_TOOLS.CREATE_TRAINING_TEMPLATE, {
        name: 'Treino B',
        category: TrainingCategory.STRENGTH,
        exercises: [REMADA, UNKNOWN],
      })

      const [matched, unmatched] = junctionRows()
      expect(matched.advancedTechniqueLinks).toEqual(EXPECTED_REMADA_LINKS)
      expect(unmatched).not.toHaveProperty('advancedTechniqueLinks')
    })

    it('should copy the techniques of a template linked by id', async () => {
      prisma.exerciseTemplate.findMany.mockImplementation(async ({ where }) =>
        where.id ? [{ ...PUBLIC_REMADA, trainerId: TRAINER_ID }] : [],
      )

      await executeTool(USER_ID, AI_TOOLS.CREATE_TRAINING_TEMPLATE, {
        name: 'Treino B',
        category: TrainingCategory.STRENGTH,
        exerciseTemplateIds: [PUBLIC_REMADA.id],
      })

      expect(junctionRows()[0].advancedTechniqueLinks).toEqual(EXPECTED_REMADA_LINKS)
    })

    it('should copy the techniques onto junction rows of a protocol template', async () => {
      await executeTool(USER_ID, AI_TOOLS.CREATE_PROTOCOL_TEMPLATE, {
        name: 'Rotina',
        trainings: [{ name: 'Treino B', category: TrainingCategory.STRENGTH, exercises: [REMADA] }],
      })

      expect(junctionRows(0)[0].advancedTechniqueLinks).toEqual(EXPECTED_REMADA_LINKS)
    })

    it('should not query techniques when no matched exercise has any', async () => {
      await executeTool(USER_ID, AI_TOOLS.CREATE_TRAINING_TEMPLATE, {
        name: 'Treino A',
        category: TrainingCategory.STRENGTH,
        exercises: [SUPINO, UNKNOWN],
      })

      expect(prisma.advancedTechnique.findMany).not.toHaveBeenCalled()
      expect(junctionRows().every((row) => !('advancedTechniqueLinks' in row))).toBe(true)
    })
  })
})
