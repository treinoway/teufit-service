import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertStudentActiveOnPlan: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstProtocolCreated: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    trainingTemplate: { findMany: vi.fn() },
    exerciseTemplate: { findMany: vi.fn() },
    advancedTechnique: { findMany: vi.fn() },
    trainingProtocol: { create: vi.fn() },
  },
}));

import { prisma } from '../../src/db.js';
import { assertStudentActiveOnPlan } from '../../src/services/platform-plan-service.js';
import { maybeMarkFirstProtocolCreated } from '../../src/services/trainer-onboarding-service.js';
import { createProtocolWithTrainings } from '../../src/services/training-protocol-service.js';
import { AdvancedTechniqueErrorCode } from '../../src/constants/advanced-technique.js';
import { BulkProtocolErrorCode, BulkProtocolMessageCode } from '../../src/constants/training.js';

const TRAINER_USER_ID = 'user-trainer-1';
const TRAINER_ID = 'trainer-internal-1';
const ASSIGNEE_ID = 'user-assignee-1';
const PROTOCOL_ID = 'protocol-1';

function makeTrainer() {
  return { id: TRAINER_ID };
}

function makeAssignee(deletedAt = null) {
  return { id: ASSIGNEE_ID, deletedAt };
}

function makeCreatedProtocol(overrides = {}) {
  return {
    id: PROTOCOL_ID,
    trainerId: TRAINER_ID,
    assigneeId: ASSIGNEE_ID,
    protocolTemplateId: null,
    name: 'Protocol A',
    description: null,
    status: 'active',
    startDate: new Date('2026-01-01'),
    expirationDate: null,
    genderOrdination: null,
    trainingLevel: null,
    type: null,
    createdAt: new Date(),
    assignee: { id: ASSIGNEE_ID, firstName: 'Jane', lastName: 'Doe', avatarUrl: null },
    trainings: [],
    ...overrides,
  };
}

function makeBasePayload(overrides = {}) {
  return {
    assigneeId: ASSIGNEE_ID,
    name: 'Protocol A',
    startDate: '2026-01-01',
    trainings: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
  prisma.user.findUnique.mockResolvedValue(makeAssignee());
  prisma.trainingTemplate.findMany.mockResolvedValue([]);
  prisma.exerciseTemplate.findMany.mockResolvedValue([]);
  prisma.advancedTechnique.findMany.mockResolvedValue([]);
  prisma.trainingProtocol.create.mockResolvedValue(makeCreatedProtocol());
});

describe('createProtocolWithTrainings', () => {
  describe('trainer resolution', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer not found', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload())).rejects.toMatchObject({
        httpStatus: 404,
        error: 'TRAINER_PROFILE_MISSING',
      });
    });
  });

  describe('assignee resolution', () => {
    it('throws ASSIGNEE_NOT_FOUND when user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload())).rejects.toMatchObject({
        httpStatus: 404,
        error: 'ASSIGNEE_NOT_FOUND',
      });
    });

    it('throws ASSIGNEE_NOT_FOUND when user is soft-deleted', async () => {
      prisma.user.findUnique.mockResolvedValue(makeAssignee(new Date()));

      await expect(createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload())).rejects.toMatchObject({
        httpStatus: 404,
        error: 'ASSIGNEE_NOT_FOUND',
      });
    });
  });

  describe('plan guard', () => {
    it('calls assertStudentActiveOnPlan with trainer.id and assigneeId', async () => {
      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload());

      expect(assertStudentActiveOnPlan).toHaveBeenCalledWith(
        prisma,
        TRAINER_ID,
        ASSIGNEE_ID,
      );
    });

    it('propagates error thrown by assertStudentActiveOnPlan', async () => {
      const planError = new Error('plan blocked');
      assertStudentActiveOnPlan.mockRejectedValueOnce(planError);

      await expect(createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload())).rejects.toThrow('plan blocked');
    });
  });

  describe('protocol field validation', () => {
    it('throws INVALID_STATUS for unknown status', async () => {
      await expect(
        createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ status: 'invalid_status' })),
      ).rejects.toMatchObject({ error: 'INVALID_STATUS' });
    });

    it('throws INVALID_GENDER_ORDINATION for unknown genderOrdination', async () => {
      await expect(
        createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ genderOrdination: 'alien' })),
      ).rejects.toMatchObject({ error: 'INVALID_GENDER_ORDINATION' });
    });

    it('throws INVALID_TRAINING_LEVEL for unknown trainingLevel', async () => {
      await expect(
        createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainingLevel: 'god' })),
      ).rejects.toMatchObject({ error: 'INVALID_TRAINING_LEVEL' });
    });

    it('throws INVALID_PROTOCOL_TYPE for unknown type', async () => {
      await expect(
        createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ type: 'yoga' })),
      ).rejects.toMatchObject({ error: 'INVALID_PROTOCOL_TYPE' });
    });
  });

  describe('template ownership verification', () => {
    it('skips trainingTemplate query when no trainingTemplateIds are provided', async () => {
      const trainings = [{ name: 'Treino A', category: 'strength', order: 0, exercises: [] }];
      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

      expect(prisma.trainingTemplate.findMany).not.toHaveBeenCalled();
    });

    it('skips exerciseTemplate query when no exerciseTemplateIds are provided', async () => {
      const trainings = [
        {
          name: 'Treino A',
          category: 'strength',
          order: 0,
          exercises: [{ name: 'Squat', type: 'strength', order: 0 }],
        },
      ];
      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

      expect(prisma.exerciseTemplate.findMany).not.toHaveBeenCalled();
    });

    it('queries trainingTemplate.findMany once for all unique trainingTemplateIds', async () => {
      const tmplId1 = 'tmpl-training-1';
      const tmplId2 = 'tmpl-training-2';
      prisma.trainingTemplate.findMany.mockResolvedValue([{ id: tmplId1 }, { id: tmplId2 }]);

      const trainings = [
        { trainingTemplateId: tmplId1, name: 'A', category: 'strength', order: 0, exercises: [] },
        { trainingTemplateId: tmplId2, name: 'B', category: 'cardio', order: 1, exercises: [] },
        { trainingTemplateId: tmplId1, name: 'C (reuse)', category: 'strength', order: 2, exercises: [] },
      ];

      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

      expect(prisma.trainingTemplate.findMany).toHaveBeenCalledTimes(1);
      const callArg = prisma.trainingTemplate.findMany.mock.calls[0][0];
      expect(callArg.where.id.in).toContain(tmplId1);
      expect(callArg.where.id.in).toContain(tmplId2);
      expect(callArg.where.id.in).toHaveLength(2); // deduplicated
    });

    it('throws TRAINING_TEMPLATE_NOT_OWNED when returned count < requested count', async () => {
      const tmplId = 'tmpl-owned-by-other';
      prisma.trainingTemplate.findMany.mockResolvedValue([]); // 0 owned, 1 requested

      const trainings = [
        { trainingTemplateId: tmplId, name: 'A', category: 'strength', order: 0, exercises: [] },
      ];

      await expect(
        createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings })),
      ).rejects.toMatchObject({
        httpStatus: 403,
        error: BulkProtocolErrorCode.TRAINING_TEMPLATE_NOT_OWNED,
        messageCode: BulkProtocolMessageCode.TRAINING_TEMPLATE_NOT_OWNED,
      });
    });

    it('throws EXERCISE_TEMPLATE_NOT_OWNED when exerciseTemplate not owned', async () => {
      const exTmplId = 'ex-tmpl-foreign';
      prisma.exerciseTemplate.findMany.mockResolvedValue([]); // 0 owned, 1 requested

      const trainings = [
        {
          name: 'Treino A',
          category: 'strength',
          order: 0,
          exercises: [
            { exerciseTemplateId: exTmplId, name: 'Bench', type: 'strength', order: 0 },
          ],
        },
      ];

      await expect(
        createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings })),
      ).rejects.toMatchObject({
        httpStatus: 403,
        error: BulkProtocolErrorCode.EXERCISE_TEMPLATE_NOT_OWNED,
        messageCode: BulkProtocolMessageCode.EXERCISE_TEMPLATE_NOT_OWNED,
      });
    });

    it('queries exerciseTemplate.findMany once for all unique exerciseTemplateIds across trainings', async () => {
      const exTmpl1 = 'ex-tmpl-1';
      const exTmpl2 = 'ex-tmpl-2';
      prisma.exerciseTemplate.findMany.mockResolvedValue([{ id: exTmpl1 }, { id: exTmpl2 }]);

      const trainings = [
        {
          name: 'Treino A',
          category: 'strength',
          order: 0,
          exercises: [
            { exerciseTemplateId: exTmpl1, name: 'Squat', type: 'strength', order: 0 },
            { exerciseTemplateId: exTmpl2, name: 'Bench', type: 'strength', order: 1 },
            { exerciseTemplateId: exTmpl1, name: 'Squat v2', type: 'strength', order: 2 },
          ],
        },
      ];

      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

      expect(prisma.exerciseTemplate.findMany).toHaveBeenCalledTimes(1);
      const callArg = prisma.exerciseTemplate.findMany.mock.calls[0][0];
      expect(callArg.where.id.in).toHaveLength(2); // deduplicated
    });
  });

  describe('atomic creation', () => {
    it('calls trainingProtocol.create exactly once', async () => {
      const trainings = [
        {
          name: 'Treino A',
          category: 'strength',
          order: 0,
          exercises: [
            { name: 'Squat', type: 'strength', order: 0, sets: 4, repetitions: { min: 8, max: 12 } },
          ],
        },
      ];

      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

      expect(prisma.trainingProtocol.create).toHaveBeenCalledTimes(1);
    });

    it('passes nested trainings create data to prisma.trainingProtocol.create', async () => {
      const trainings = [
        {
          name: 'Treino A',
          category: 'strength',
          order: 0,
          exercises: [
            { name: 'Squat', type: 'strength', order: 0, sets: 3 },
          ],
        },
      ];

      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      expect(createCall.data.trainings.create).toHaveLength(1);
      expect(createCall.data.trainings.create[0]).toMatchObject({
        name: 'Treino A',
        category: 'strength',
        order: 0,
        exercises: { create: expect.arrayContaining([expect.objectContaining({ name: 'Squat' })]) },
      });
    });

    it('works with empty trainings array', async () => {
      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings: [] }));

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      expect(createCall.data.trainings.create).toHaveLength(0);
    });

    it('auto-assigns sequential order 0..n-1 when exercises omit order', async () => {
      const trainings = [
        {
          name: 'Treino A',
          category: 'strength',
          order: 0,
          exercises: [
            { name: 'Squat', type: 'strength' },
            { name: 'Bench', type: 'strength' },
            { name: 'Deadlift', type: 'strength' },
          ],
        },
      ];

      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      const exercises = createCall.data.trainings.create[0].exercises.create;
      expect(exercises.map((e) => e.order)).toEqual([0, 1, 2]);
    });

    it('preserves explicit exercise order when provided', async () => {
      const trainings = [
        {
          name: 'Treino A',
          category: 'strength',
          order: 0,
          exercises: [
            { name: 'Squat', type: 'strength', order: 5 },
            { name: 'Bench', type: 'strength', order: 2 },
          ],
        },
      ];

      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      const exercises = createCall.data.trainings.create[0].exercises.create;
      expect(exercises.map((e) => e.order)).toEqual([5, 2]);
    });

    it('works with training that has empty exercises array', async () => {
      const trainings = [{ name: 'Treino Vazio', category: 'rest', order: 0, exercises: [] }];

      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      const training = createCall.data.trainings.create[0];
      expect(training.exercises.create).toHaveLength(0);
      expect(training.estimatedDurationSeconds).toBe(0);
    });

    it('sets estimatedDurationSeconds > 0 for training with exercises', async () => {
      const trainings = [
        {
          name: 'Treino Força',
          category: 'strength',
          order: 0,
          exercises: [
            {
              name: 'Squat',
              type: 'strength',
              order: 0,
              sets: 4,
              prescriptionMode: 'reps',
              repetitions: { min: 8, max: 12 },
              restInterval: 60,
            },
          ],
        },
      ];

      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      expect(createCall.data.trainings.create[0].estimatedDurationSeconds).toBeGreaterThan(0);
    });

    it('passes protocolTemplateId when provided', async () => {
      const protocolTemplateId = 'proto-tmpl-1';
      await createProtocolWithTrainings(
        TRAINER_USER_ID,
        makeBasePayload({ protocolTemplateId }),
      );

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      expect(createCall.data.protocolTemplateId).toBe(protocolTemplateId);
    });

    it('defaults status to "active" when not provided', async () => {
      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload());

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      expect(createCall.data.status).toBe('active');
    });

    it('uses provided status', async () => {
      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ status: 'completed' }));

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      expect(createCall.data.status).toBe('completed');
    });
  });

  describe('prescriptionMode exclusivity', () => {
    it('nulls out repetitions when prescriptionMode is "duration"', async () => {
      const trainings = [
        {
          name: 'Treino Cardio',
          category: 'cardio',
          order: 0,
          exercises: [
            {
              name: 'Esteira',
              type: 'cardio',
              order: 0,
              sets: 3,
              duration: 120,
              prescriptionMode: 'duration',
              repetitions: { min: 10, max: 15 }, // should be nulled
            },
          ],
        },
      ];

      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      const exercise = createCall.data.trainings.create[0].exercises.create[0];
      expect(exercise.prescriptionMode).toBe('duration');
      expect(exercise.duration).toBe(120);
      expect(exercise.repetitions).toBeNull();
    });

    it('nulls out duration when prescriptionMode is "reps"', async () => {
      const trainings = [
        {
          name: 'Treino Força',
          category: 'strength',
          order: 0,
          exercises: [
            {
              name: 'Squat',
              type: 'strength',
              order: 0,
              sets: 4,
              repetitions: { min: 8, max: 12 },
              prescriptionMode: 'reps',
              duration: 60, // should be nulled
            },
          ],
        },
      ];

      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      const exercise = createCall.data.trainings.create[0].exercises.create[0];
      expect(exercise.prescriptionMode).toBe('reps');
      expect(exercise.duration).toBeNull();
      expect(exercise.repetitions).toEqual({ min: 8, max: 12 });
    });

    it('infers prescriptionMode "duration" when mode absent, duration present, and repetitions explicitly null', async () => {
      // resolvePrescriptionMode checks repetitions === null (not undefined)
      const trainings = [
        {
          name: 'Treino',
          category: 'cardio',
          order: 0,
          exercises: [
            { name: 'Plank', type: 'cardio', order: 0, sets: 3, duration: 60, repetitions: null },
          ],
        },
      ];

      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      const exercise = createCall.data.trainings.create[0].exercises.create[0];
      expect(exercise.prescriptionMode).toBe('duration');
    });

    it('defaults to prescriptionMode "reps" when mode absent and repetitions undefined', async () => {
      const trainings = [
        {
          name: 'Treino',
          category: 'strength',
          order: 0,
          exercises: [
            { name: 'Squat', type: 'strength', order: 0, sets: 3, duration: 60 },
          ],
        },
      ];

      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      const exercise = createCall.data.trainings.create[0].exercises.create[0];
      // duration absent from repetitions context → resolves to 'reps', duration gets nulled
      expect(exercise.prescriptionMode).toBe('reps');
      expect(exercise.duration).toBeNull();
    });
  });

  describe('date normalization', () => {
    it('returns startDate as YYYY-MM-DD string', async () => {
      prisma.trainingProtocol.create.mockResolvedValue(
        makeCreatedProtocol({ startDate: new Date('2026-06-01T00:00:00.000Z') }),
      );

      const result = await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload());

      expect(result.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('returns null expirationDate when not set', async () => {
      prisma.trainingProtocol.create.mockResolvedValue(
        makeCreatedProtocol({ expirationDate: null }),
      );

      const result = await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload());

      expect(result.expirationDate).toBeNull();
    });
  });

  describe('onboarding milestone', () => {
    it('calls maybeMarkFirstProtocolCreated after successful creation', async () => {
      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload());

      expect(maybeMarkFirstProtocolCreated).toHaveBeenCalledWith({ trainerId: TRAINER_ID });
    });
  });

  describe('return value', () => {
    it('returns the created protocol with assignee and trainings', async () => {
      const created = makeCreatedProtocol({
        startDate: new Date('2026-01-01'),
        trainings: [{ id: 't1', name: 'Treino A', order: 0, estimatedDurationSeconds: 0 }],
      });
      prisma.trainingProtocol.create.mockResolvedValue(created);

      const result = await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload());

      expect(result.id).toBe(PROTOCOL_ID);
      expect(result.assignee).toMatchObject({ id: ASSIGNEE_ID });
      expect(result.trainings).toHaveLength(1);
    });
  });

  describe('intensity field round-trip', () => {
    it('passes intensity through to exercise create data when provided', async () => {
      const trainings = [
        {
          name: 'Cardio Day',
          category: 'cardio',
          order: 0,
          exercises: [
            {
              name: 'Esteira',
              type: 'cardio',
              order: 0,
              sets: 3,
              prescriptionMode: 'duration',
              duration: 30,
              intensity: 'moderate',
            },
          ],
        },
      ];

      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      const exercise = createCall.data.trainings.create[0].exercises.create[0];
      expect(exercise.intensity).toBe('moderate');
    });

    it('sets intensity to null when not provided in exercise payload', async () => {
      const trainings = [
        {
          name: 'Força',
          category: 'strength',
          order: 0,
          exercises: [
            { name: 'Squat', type: 'strength', order: 0, sets: 4, repetitions: 10 },
          ],
        },
      ];

      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      const exercise = createCall.data.trainings.create[0].exercises.create[0];
      expect(exercise.intensity).toBeNull();
    });

    it('sets intensity to null when explicitly sent as null', async () => {
      const trainings = [
        {
          name: 'Cardio',
          category: 'cardio',
          order: 0,
          exercises: [
            {
              name: 'Bike',
              type: 'cardio',
              order: 0,
              sets: 2,
              prescriptionMode: 'duration',
              duration: 20,
              intensity: null,
            },
          ],
        },
      ];

      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      const exercise = createCall.data.trainings.create[0].exercises.create[0];
      expect(exercise.intensity).toBeNull();
    });
  });

  describe('estimatedDurationSeconds per training', () => {
    it('sets estimatedDurationSeconds to 0 for training with no exercises', async () => {
      const trainings = [
        { name: 'Descanso', category: 'rest', order: 0, exercises: [] },
      ];

      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      expect(createCall.data.trainings.create[0].estimatedDurationSeconds).toBe(0);
    });

    it('computes estimatedDurationSeconds > 0 for training with reps-based exercises', async () => {
      const trainings = [
        {
          name: 'Força',
          category: 'strength',
          order: 0,
          exercises: [
            {
              name: 'Squat',
              type: 'strength',
              order: 0,
              sets: 4,
              prescriptionMode: 'reps',
              repetitions: { min: 8, max: 12 },
              restInterval: 60,
            },
          ],
        },
      ];

      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      expect(createCall.data.trainings.create[0].estimatedDurationSeconds).toBeGreaterThan(0);
    });

    it('computes estimatedDurationSeconds > 0 for training with duration-based exercises', async () => {
      const trainings = [
        {
          name: 'Cardio',
          category: 'cardio',
          order: 0,
          exercises: [
            {
              name: 'Corrida',
              type: 'cardio',
              order: 0,
              sets: 1,
              prescriptionMode: 'duration',
              duration: 1800,
            },
          ],
        },
      ];

      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      expect(createCall.data.trainings.create[0].estimatedDurationSeconds).toBeGreaterThan(0);
    });

    it('computes estimatedDurationSeconds independently per training', async () => {
      const trainings = [
        {
          name: 'Treino Vazio',
          category: 'rest',
          order: 0,
          exercises: [],
        },
        {
          name: 'Treino com Exercício',
          category: 'strength',
          order: 1,
          exercises: [
            {
              name: 'Bench',
              type: 'strength',
              order: 0,
              sets: 3,
              prescriptionMode: 'reps',
              repetitions: 10,
            },
          ],
        },
      ];

      await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

      const createCall = prisma.trainingProtocol.create.mock.calls[0][0];
      const [emptyTraining, filledTraining] = createCall.data.trainings.create;
      expect(emptyTraining.estimatedDurationSeconds).toBe(0);
      expect(filledTraining.estimatedDurationSeconds).toBeGreaterThan(0);
    });
  });
});


describe('createProtocolWithTrainings — advancedTechniqueIds', () => {
  const makeTrainings = () => [
    {
      name: 'Treino A',
      category: 'strength',
      order: 0,
      exercises: [
        { name: 'Squat', type: 'strength', order: 0, advancedTechniqueIds: ['tech-b', 'tech-a'] },
        { name: 'Lunge', type: 'strength', order: 1 },
      ],
    },
    {
      name: 'Treino B',
      category: 'strength',
      order: 1,
      exercises: [{ name: 'Press', type: 'strength', order: 0, advancedTechniqueIds: ['tech-a'] }],
    },
  ];

  const createdTrainings = () => prisma.trainingProtocol.create.mock.calls[0][0].data.trainings.create;

  it('passes ordered advancedTechniqueIds through as nested link creates', async () => {
    prisma.advancedTechnique.findMany.mockResolvedValue([{ id: 'tech-a' }, { id: 'tech-b' }]);

    await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings: makeTrainings() }));

    const [first, second] = createdTrainings();
    expect(first.exercises.create[0].advancedTechniqueLinks).toEqual({
      create: [
        { advancedTechniqueId: 'tech-b', order: 0 },
        { advancedTechniqueId: 'tech-a', order: 1 },
      ],
    });
    expect(second.exercises.create[0].advancedTechniqueLinks).toEqual({
      create: [{ advancedTechniqueId: 'tech-a', order: 0 }],
    });
  });

  it('omits advancedTechniqueLinks for exercises without advancedTechniqueIds', async () => {
    prisma.advancedTechnique.findMany.mockResolvedValue([{ id: 'tech-a' }, { id: 'tech-b' }]);

    await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings: makeTrainings() }));

    expect(createdTrainings()[0].exercises.create[1]).not.toHaveProperty('advancedTechniqueLinks');
  });

  it('validates all technique ids of all exercises in one deduplicated query', async () => {
    prisma.advancedTechnique.findMany.mockResolvedValue([{ id: 'tech-a' }, { id: 'tech-b' }]);

    await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings: makeTrainings() }));

    expect(prisma.advancedTechnique.findMany).toHaveBeenCalledTimes(1);
    expect([...prisma.advancedTechnique.findMany.mock.calls[0][0].where.id.in].sort()).toEqual(['tech-a', 'tech-b']);
  });

  it('skips the technique query when no exercise sends advancedTechniqueIds', async () => {
    const trainings = [
      { name: 'A', category: 'strength', order: 0, exercises: [{ name: 'Squat', type: 'strength', order: 0 }] },
    ];

    await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

    expect(prisma.advancedTechnique.findMany).not.toHaveBeenCalled();
  });

  it('throws INVALID_SELECTION and writes nothing when a technique is not visible', async () => {
    prisma.advancedTechnique.findMany.mockResolvedValue([{ id: 'tech-a' }]);

    await expect(
      createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings: makeTrainings() })),
    ).rejects.toMatchObject({ httpStatus: 400, error: AdvancedTechniqueErrorCode.INVALID_SELECTION });

    expect(prisma.trainingProtocol.create).not.toHaveBeenCalled();
  });
});

describe('createProtocolWithTrainings — technique inheritance from exercise templates', () => {
  const TEMPLATE_ID = 'et-1';
  const link = (advancedTechniqueId, order) => ({ advancedTechniqueId, order });

  const makeTrainings = (exerciseExtra = {}) => [
    {
      name: 'Treino A',
      category: 'strength',
      order: 0,
      exercises: [{ name: 'Squat', type: 'strength', order: 0, exerciseTemplateId: TEMPLATE_ID, ...exerciseExtra }],
    },
  ];

  const createdExercise = () => prisma.trainingProtocol.create.mock.calls[0][0].data.trainings.create[0].exercises.create[0];

  beforeEach(() => {
    prisma.exerciseTemplate.findMany.mockResolvedValue([
      { id: TEMPLATE_ID, advancedTechniqueLinks: [link('tech-b', 5), link('tech-gone', 6), link('tech-a', 9)] },
    ]);
    prisma.advancedTechnique.findMany.mockResolvedValue([{ id: 'tech-a' }, { id: 'tech-b' }]);
  });

  it('inherits the template links, filtered to visible and reindexed, when advancedTechniqueIds is omitted', async () => {
    await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings: makeTrainings() }));

    expect(createdExercise().advancedTechniqueLinks).toEqual({
      create: [
        { advancedTechniqueId: 'tech-b', order: 0 },
        { advancedTechniqueId: 'tech-a', order: 1 },
      ],
    });
  });

  it('creates no links when advancedTechniqueIds is an explicit empty array', async () => {
    await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings: makeTrainings({ advancedTechniqueIds: [] }) }));

    expect(createdExercise()).not.toHaveProperty('advancedTechniqueLinks');
  });

  it('uses explicit ids instead of the template links when provided', async () => {
    await createProtocolWithTrainings(
      TRAINER_USER_ID,
      makeBasePayload({ trainings: makeTrainings({ advancedTechniqueIds: ['tech-a'] }) }),
    );

    expect(createdExercise().advancedTechniqueLinks).toEqual({ create: [{ advancedTechniqueId: 'tech-a', order: 0 }] });
  });

  it('rejects explicit ids that are not visible', async () => {
    prisma.advancedTechnique.findMany.mockResolvedValue([]);

    await expect(
      createProtocolWithTrainings(
        TRAINER_USER_ID,
        makeBasePayload({ trainings: makeTrainings({ advancedTechniqueIds: ['tech-x'] }) }),
      ),
    ).rejects.toMatchObject({ httpStatus: 400, error: AdvancedTechniqueErrorCode.INVALID_SELECTION });
  });

  it('loads template links through a single exerciseTemplate.findMany selecting advancedTechniqueLinks', async () => {
    await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings: makeTrainings() }));

    expect(prisma.exerciseTemplate.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.exerciseTemplate.findMany.mock.calls[0][0].select).toEqual({ id: true, advancedTechniqueLinks: true });
  });

  it('visibility-checks techniques with one batched query per kind (explicit, inherited), not per exercise', async () => {
    const trainings = makeTrainings();
    trainings[0].exercises.push({ name: 'Press', type: 'strength', order: 1, advancedTechniqueIds: ['tech-a'] });

    await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

    expect(prisma.exerciseTemplate.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.advancedTechnique.findMany).toHaveBeenCalledTimes(2);
  });

  it('inherits nothing when the exercise has no exerciseTemplateId and no ids', async () => {
    const trainings = [{ name: 'A', category: 'strength', order: 0, exercises: [{ name: 'Squat', type: 'strength', order: 0 }] }];

    await createProtocolWithTrainings(TRAINER_USER_ID, makeBasePayload({ trainings }));

    expect(createdExercise()).not.toHaveProperty('advancedTechniqueLinks');
  });
});
