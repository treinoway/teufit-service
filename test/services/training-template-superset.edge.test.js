import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    trainingTemplate: { findUnique: vi.fn() },
    trainingTemplateExerciseTemplate: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

import { prisma } from '../../src/db.js';
import { SupersetMessageCode } from '../../src/constants/training.js';
import { createTemplateSuperset } from '../../src/services/training-template-service.js';

const TEMPLATE_ID = 'tt1';
const TRAINER_ID = 't1';
const BAD_REQUEST = 400;

let rows;

// Builds one ungrouped in-memory junction row; createdAt follows the creation index.
function row(id, order, createdIndex) {
  return {
    id,
    trainingTemplateId: TEMPLATE_ID,
    order,
    supersetGroupId: null,
    supersetOrder: 0,
    supersetRestInterval: null,
    createdAt: new Date(2026, 0, 1, 0, 0, createdIndex),
    exerciseTemplate: { id: `et-${id}`, name: id },
    advancedTechniqueLinks: [],
  };
}

// Returns rows sorted like the service reads them (order, createdAt, id).
function sortedRows() {
  return [...rows].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

// Wires the Prisma mock to the in-memory rows.
function installFakeTable() {
  const delegate = prisma.trainingTemplateExerciseTemplate;
  delegate.findMany.mockImplementation(async () => sortedRows().map((r) => ({ ...r })));
  delegate.update.mockImplementation(async ({ where, data }) => {
    Object.assign(rows.find((r) => r.id === where.id), data);
    return {};
  });
  prisma.trainingTemplate.findUnique.mockImplementation(async () => ({
    id: TEMPLATE_ID,
    trainerId: TRAINER_ID,
    deletedAt: null,
    trainingTemplateExerciseTemplates: sortedRows().map((r) => ({ ...r })),
  }));
  prisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
  prisma.$transaction = vi.fn().mockImplementation(async (fn) => fn({
    $queryRaw: vi.fn().mockResolvedValue([]),
    trainingTemplateExerciseTemplate: delegate,
  }));
}

describe('createTemplateSuperset edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows = [row('x', 0, 0), row('y', 0, 1), row('z', 0, 2)];
    installFakeTable();
  });

  it('keeps a tied exercise displayed before the first member in front of the block', async () => {
    await createTemplateSuperset('u1', TEMPLATE_ID, ['y', 'z']);

    expect(sortedRows().map((r) => [r.id, r.order])).toEqual([['x', 0], ['y', 1], ['z', 2]]);
  });

  it('rejects duplicate ids with supersetMembershipInvalid and writes nothing', async () => {
    const promise = createTemplateSuperset('u1', TEMPLATE_ID, ['x', 'x']);

    await expect(promise).rejects.toMatchObject({ statusCode: BAD_REQUEST, messageCode: SupersetMessageCode.MEMBERSHIP_INVALID });
    expect(prisma.trainingTemplateExerciseTemplate.update).not.toHaveBeenCalled();
  });
});
