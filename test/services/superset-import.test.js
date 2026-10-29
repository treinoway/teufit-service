import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertStudentActiveOnPlan: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn() },
    trainingProtocol: { create: vi.fn(), findUnique: vi.fn() },
    trainingProtocolTemplate: { findUnique: vi.fn() },
    trainingTemplate: { findUnique: vi.fn() },
    advancedTechnique: { findMany: vi.fn() },
    training: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    exercise: { create: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../src/db.js';
import { assertStudentActiveOnPlan } from '../../src/services/platform-plan-service.js';
import { importFromTemplate as importTraining } from '../../src/services/training-service.js';
import { importFromTemplate as importProtocol } from '../../src/services/training-protocol-service.js';

const TEMPLATE_GROUP_ID = 'template-group-1';
const ROUND_REST = 75;

// Builds a template junction row with sensible defaults.
const makeJunction = (id, order, overrides = {}) => ({
  id,
  exerciseTemplateId: `et-${id}`,
  name: `Exercise ${id}`,
  type: 'strength',
  order,
  sets: 3,
  repetitions: { min: 8, max: 12 },
  duration: null,
  prescriptionMode: 'reps',
  hasLoad: false,
  suggestedLoad: null,
  restInterval: 60,
  notes: null,
  videoUrl: null,
  supersetGroupId: null,
  supersetOrder: 0,
  supersetRestInterval: null,
  exerciseTemplate: { id: `et-${id}`, name: `Exercise ${id}`, type: 'strength' },
  advancedTechniqueLinks: [],
  ...overrides,
});

// Builds junctions [A, B] sharing a template group id plus a loose C.
const groupedJunctions = () => [
  makeJunction('j1', 0, { supersetGroupId: TEMPLATE_GROUP_ID, supersetOrder: 0, supersetRestInterval: ROUND_REST }),
  makeJunction('j2', 1, { supersetGroupId: TEMPLATE_GROUP_ID, supersetOrder: 1, supersetRestInterval: ROUND_REST }),
  makeJunction('j3', 2),
];

describe('superset grouping on template imports', () => {
  beforeEach(() => {
    assertStudentActiveOnPlan.mockResolvedValue(undefined);
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
    prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
    prisma.trainer.updateMany.mockResolvedValue({ count: 0 });
    prisma.advancedTechnique.findMany.mockResolvedValue([]);
  });

  describe('training-service importFromTemplate', () => {
    function arrange(junctions) {
      prisma.trainingProtocol.findUnique.mockResolvedValue({ id: 'p1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplate.findUnique.mockResolvedValue({
        id: 'tmpl-1',
        trainerId: 't1',
        name: 'Leg Day',
        description: null,
        category: 'strength',
        bodySegment: null,
        deletedAt: null,
        isPublic: false,
        trainingTemplateExerciseTemplates: junctions,
      });
      prisma.training.create.mockResolvedValue({ id: 'tr-1' });
      prisma.exercise.create.mockResolvedValue({ id: 'ex-1' });
      prisma.exercise.findMany.mockResolvedValue([]);
      prisma.training.update.mockResolvedValue({});
      prisma.training.findUnique.mockResolvedValue({ id: 'tr-1', exercises: [] });
    }

    const createdData = () => prisma.exercise.create.mock.calls.map(([arg]) => arg.data);

    it('copies supersetRestInterval onto every grouped exercise', async () => {
      arrange(groupedJunctions());

      await importTraining('u1', 'p1', 'tmpl-1');

      expect(createdData().map((d) => d.supersetRestInterval ?? null)).toEqual([ROUND_REST, ROUND_REST, null]);
    });

    it('keeps the grouping under one fresh group id different from the template one', async () => {
      arrange(groupedJunctions());

      await importTraining('u1', 'p1', 'tmpl-1');

      const [first, second, loose] = createdData();
      expect(first.supersetGroupId).toBeTruthy();
      expect(first.supersetGroupId).not.toBe(TEMPLATE_GROUP_ID);
      expect(second.supersetGroupId).toBe(first.supersetGroupId);
      expect(loose.supersetGroupId).toBeNull();
    });
  });

  describe('training-protocol-service importFromTemplate', () => {
    function arrange(junctions) {
      prisma.trainingProtocolTemplate.findUnique.mockResolvedValue({
        id: 'ptmpl-1',
        trainerId: 't1',
        name: 'Template',
        deletedAt: null,
        trainings: [
          {
            id: 'pt-1',
            weekDay: 'monday',
            order: 0,
            trainingTemplate: {
              id: 'tt-1',
              name: 'Training',
              description: null,
              category: 'strength',
              bodySegment: 'upper',
              trainingTemplateExerciseTemplates: junctions,
            },
          },
        ],
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'assignee-1' });
      prisma.trainingProtocol.create.mockResolvedValue({ id: 'p1', trainings: [], assignee: {} });
    }

    const createdExercises = () =>
      prisma.trainingProtocol.create.mock.calls[0][0].data.trainings.create[0].exercises.create;

    it('copies supersetOrder and supersetRestInterval onto every grouped exercise', async () => {
      arrange(groupedJunctions());

      await importProtocol('u1', 'ptmpl-1', 'assignee-1');

      expect(createdExercises().map((e) => [e.supersetOrder, e.supersetRestInterval ?? null])).toEqual([
        [0, ROUND_REST],
        [1, ROUND_REST],
        [0, null],
      ]);
    });

    it('keeps the grouping under one fresh group id different from the template one', async () => {
      arrange(groupedJunctions());

      await importProtocol('u1', 'ptmpl-1', 'assignee-1');

      const [first, second, loose] = createdExercises();
      expect(first.supersetGroupId).toBeTruthy();
      expect(first.supersetGroupId).not.toBe(TEMPLATE_GROUP_ID);
      expect(second.supersetGroupId).toBe(first.supersetGroupId);
      expect(loose.supersetGroupId ?? null).toBeNull();
    });
  });
});
