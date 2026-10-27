import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    training: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    trainingProtocol: { findUnique: vi.fn() },
    trainingTemplate: { findUnique: vi.fn() },
    exercise: { create: vi.fn(), findMany: vi.fn() },
    advancedTechnique: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../src/db.js';
import { importFromTemplate } from '../../src/services/training-service.js';
import { advancedTechniqueLinksInclude } from '../../src/helpers/advanced-technique-refs.js';

const TRAINER_ID = 't1';

// Builds a junction row of a training template, with technique links.
const makeJunctionRow = (overrides = {}) => ({
  exerciseTemplateId: 'et-1',
  name: 'Supino',
  type: 'strength',
  order: 0,
  sets: 3,
  repetitions: { min: 8, max: 12 },
  duration: null,
  advancedTechniqueLinks: [],
  ...overrides,
});

// Builds the training template returned by the lookup.
const makeTemplate = (rows) => ({
  id: 'tmpl-1',
  trainerId: TRAINER_ID,
  name: 'Leg Day',
  description: null,
  category: 'strength',
  bodySegment: 'lower',
  deletedAt: null,
  isPublic: false,
  trainingTemplateExerciseTemplates: rows,
});

describe('importFromTemplate technique links', () => {
  beforeEach(() => {
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
    prisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
    prisma.trainingProtocol.findUnique.mockResolvedValue({ id: 'p1', trainerId: TRAINER_ID, deletedAt: null });
    prisma.training.create.mockResolvedValue({ id: 'tr-1' });
    prisma.exercise.findMany.mockResolvedValue([]);
    prisma.training.update.mockResolvedValue({});
    prisma.training.findUnique.mockResolvedValue({ id: 'tr-1', exercises: [] });
    prisma.advancedTechnique.findMany.mockResolvedValue([]);
  });

  it('loads the junction technique links with the template', async () => {
    prisma.trainingTemplate.findUnique.mockResolvedValue(makeTemplate([]));

    await importFromTemplate('u1', 'p1', 'tmpl-1');

    expect(prisma.trainingTemplate.findUnique).toHaveBeenCalledWith({
      where: { id: 'tmpl-1' },
      include: {
        trainingTemplateExerciseTemplates: expect.objectContaining({ include: { advancedTechniqueLinks: true } }),
      },
    });
  });

  it('copies the junction links onto the created exercise, re-indexed by order', async () => {
    prisma.advancedTechnique.findMany.mockResolvedValue([{ id: 'drop' }, { id: 'rest-pause' }]);
    const junctionRow = makeJunctionRow({
      advancedTechniqueLinks: [
        { advancedTechniqueId: 'rest-pause', order: 4 },
        { advancedTechniqueId: 'drop', order: 1 },
      ],
    });
    prisma.trainingTemplate.findUnique.mockResolvedValue(makeTemplate([junctionRow]));

    await importFromTemplate('u1', 'p1', 'tmpl-1');

    expect(prisma.exercise.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        advancedTechniqueLinks: {
          create: [
            { advancedTechniqueId: 'drop', order: 0 },
            { advancedTechniqueId: 'rest-pause', order: 1 },
          ],
        },
      }),
    });
  });

  it('drops links to techniques that are no longer visible to the trainer', async () => {
    prisma.advancedTechnique.findMany.mockResolvedValue([{ id: 'drop' }]);
    const junctionRow = makeJunctionRow({
      advancedTechniqueLinks: [
        { advancedTechniqueId: 'deleted', order: 0 },
        { advancedTechniqueId: 'drop', order: 1 },
      ],
    });
    prisma.trainingTemplate.findUnique.mockResolvedValue(makeTemplate([junctionRow]));

    await importFromTemplate('u1', 'p1', 'tmpl-1');

    expect(prisma.exercise.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        advancedTechniqueLinks: { create: [{ advancedTechniqueId: 'drop', order: 0 }] },
      }),
    });
  });

  it('adds no nested link create when the junction row has no links', async () => {
    prisma.trainingTemplate.findUnique.mockResolvedValue(makeTemplate([makeJunctionRow()]));

    await importFromTemplate('u1', 'p1', 'tmpl-1');

    expect(prisma.exercise.create.mock.calls[0][0].data).not.toHaveProperty('advancedTechniqueLinks');
  });

  it('inherits each junction row own links independently', async () => {
    prisma.advancedTechnique.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    const first = makeJunctionRow({ order: 0, advancedTechniqueLinks: [{ advancedTechniqueId: 'a', order: 0 }] });
    const second = makeJunctionRow({ order: 1, advancedTechniqueLinks: [{ advancedTechniqueId: 'b', order: 0 }] });
    prisma.trainingTemplate.findUnique.mockResolvedValue(makeTemplate([first, second]));

    await importFromTemplate('u1', 'p1', 'tmpl-1');

    const created = prisma.exercise.create.mock.calls.map(([args]) => args.data.advancedTechniqueLinks);
    expect(created).toEqual([
      { create: [{ advancedTechniqueId: 'a', order: 0 }] },
      { create: [{ advancedTechniqueId: 'b', order: 0 }] },
    ]);
  });

  it('validates technique visibility of all junction rows in a single query', async () => {
    prisma.advancedTechnique.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const rows = ['a', 'b', 'c'].map((id, order) =>
      makeJunctionRow({ order, advancedTechniqueLinks: [{ advancedTechniqueId: id, order: 0 }] }));
    prisma.trainingTemplate.findUnique.mockResolvedValue(makeTemplate(rows));

    await importFromTemplate('u1', 'p1', 'tmpl-1');

    expect(prisma.advancedTechnique.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.exercise.create).toHaveBeenCalledTimes(3);
  });

  it('reloads the training with the exercise links included and maps them to advancedTechniques', async () => {
    prisma.trainingTemplate.findUnique.mockResolvedValue(makeTemplate([makeJunctionRow()]));
    const link = {
      advancedTechniqueId: 'drop',
      order: 0,
      advancedTechnique: { id: 'drop', key: 'drop_set', name: 'Drop set', description: 'd', videoUrl: null, gifUrl: null },
    };
    prisma.training.findUnique.mockResolvedValue({
      id: 'tr-1',
      exercises: [{ id: 'ex-1', advancedTechniqueLinks: [link] }],
    });

    const result = await importFromTemplate('u1', 'p1', 'tmpl-1');

    expect(prisma.training.findUnique).toHaveBeenCalledWith({
      where: { id: 'tr-1' },
      include: { exercises: expect.objectContaining({ include: advancedTechniqueLinksInclude }) },
    });
    expect(result.exercises[0]).toEqual({
      id: 'ex-1',
      advancedTechniques: [{ id: 'drop', key: 'drop_set', name: 'Drop set', description: 'd', videoUrl: null, gifUrl: null, isDeleted: false, order: 0 }],
    });
  });
});
