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
import { SupersetConstraints, SupersetMessageCode } from '../../src/constants/training.js';
import {
  createTemplateSuperset,
  updateTemplateSupersetRestInterval,
  dissolveTemplateSuperset,
  deleteTrainingTemplateExercise,
} from '../../src/services/training-template-service.js';

const OWNER_USER_ID = 'u1';
const OWNER_TRAINER_ID = 't1';
const OTHER_TRAINER_ID = 't2';
const TEMPLATE_ID = 'tt1';
const GROUP_ID = 'g1';
const OTHER_GROUP_ID = 'g2';
const ROUND_REST = 90;
const NOT_FOUND = 404;
const FORBIDDEN = 403;
const BAD_REQUEST = 400;

let rows;

// Builds one in-memory junction row; unspecified superset fields mean "ungrouped".
function row(id, order, overrides = {}) {
  return {
    id,
    trainingTemplateId: TEMPLATE_ID,
    exerciseTemplateId: `et-${id}`,
    order,
    supersetGroupId: null,
    supersetOrder: 0,
    supersetRestInterval: null,
    createdAt: new Date(2026, 0, 1, 0, 0, order),
    exerciseTemplate: { id: `et-${id}`, name: id },
    advancedTechniqueLinks: [],
    ...overrides,
  };
}

// Returns the rows sorted the way the service reads them (order, createdAt, id).
function sortedRows() {
  return [...rows].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

// Tells whether a row satisfies a Prisma-style flat where clause (equality and { in }).
function matches(candidate, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && 'in' in expected) return expected.in.includes(candidate[key]);
    return candidate[key] === expected;
  });
}

// Wires the Prisma mock to an in-memory table so tests assert final state, not call shapes.
function installFakeTable(templateOwnerId = OWNER_TRAINER_ID) {
  const delegate = prisma.trainingTemplateExerciseTemplate;
  delegate.findMany.mockImplementation(async ({ where } = {}) => sortedRows().filter((r) => matches(r, where)).map((r) => ({ ...r })));
  delegate.findFirst.mockImplementation(async ({ where } = {}) => {
    const found = sortedRows().find((r) => matches(r, where));
    return found ? { ...found } : null;
  });
  delegate.update.mockImplementation(async ({ where, data }) => {
    const target = rows.find((r) => r.id === where.id);
    Object.assign(target, data);
    return { ...target };
  });
  delegate.updateMany.mockImplementation(async ({ where, data }) => {
    const targets = rows.filter((r) => matches(r, where));
    targets.forEach((r) => Object.assign(r, data));
    return { count: targets.length };
  });
  delegate.delete.mockImplementation(async ({ where }) => {
    rows = rows.filter((r) => r.id !== where.id);
    return {};
  });
  prisma.trainingTemplate.findUnique.mockImplementation(async () => ({
    id: TEMPLATE_ID,
    trainerId: templateOwnerId,
    isPublic: false,
    deletedAt: null,
    trainingTemplateExerciseTemplates: sortedRows().map((r) => ({ ...r })),
  }));
  prisma.trainer.findUnique.mockResolvedValue({ id: OWNER_TRAINER_ID });
  prisma.$transaction = vi.fn().mockImplementation(async (fn) => fn({
    $queryRaw: vi.fn().mockResolvedValue([]),
    trainingTemplate: prisma.trainingTemplate,
    trainingTemplateExerciseTemplate: delegate,
  }));
}

// Summarises current state as [id, order, supersetGroupId, supersetOrder, supersetRestInterval] sorted by order.
function snapshot() {
  return sortedRows().map((r) => [r.id, r.order, r.supersetGroupId, r.supersetOrder, r.supersetRestInterval]);
}

// Returns a stored row by id.
function byId(id) {
  return rows.find((r) => r.id === id);
}

// Counts write calls made to the junction table.
function writeCount() {
  const delegate = prisma.trainingTemplateExerciseTemplate;
  return delegate.update.mock.calls.length + delegate.updateMany.mock.calls.length + delegate.delete.mock.calls.length;
}

describe('training-template superset service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows = [];
  });

  describe('createTemplateSuperset', () => {
    beforeEach(() => {
      rows = [row('a', 0), row('b', 1), row('c', 2), row('d', 3)];
      installFakeTable();
    });

    it('groups members with a shared new group id, supersetOrder in request order and the given rest', async () => {
      await createTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, ['a', 'b'], ROUND_REST);

      const [groupA, groupB] = [byId('a').supersetGroupId, byId('b').supersetGroupId];
      expect(groupA).toBeTruthy();
      expect(groupB).toBe(groupA);
      expect([byId('a').supersetOrder, byId('b').supersetOrder]).toEqual([0, 1]);
      expect([byId('a').supersetRestInterval, byId('b').supersetRestInterval]).toEqual([ROUND_REST, ROUND_REST]);
    });

    it('stores a null supersetRestInterval when restInterval is omitted', async () => {
      await createTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, ['a', 'b']);

      expect(byId('a').supersetRestInterval).toBeNull();
      expect(byId('b').supersetRestInterval).toBeNull();
    });

    it('keeps a rest of zero instead of treating it as missing', async () => {
      await createTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, ['a', 'b'], 0);

      expect(byId('a').supersetRestInterval).toBe(0);
    });

    it('does not touch exercises outside the group', async () => {
      await createTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, ['a', 'b'], ROUND_REST);

      expect(byId('c')).toMatchObject({ order: 2, supersetGroupId: null, supersetOrder: 0, supersetRestInterval: null });
    });

    it('assigns supersetOrder following the request order, not the current template order', async () => {
      await createTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, ['b', 'a']);

      expect([byId('b').supersetOrder, byId('a').supersetOrder]).toEqual([0, 1]);
    });

    it('places the block at the lowest member order and pushes non-members after it, keeping their relative order', async () => {
      await createTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, ['d', 'b']);

      expect(sortedRows().map((r) => [r.id, r.order])).toEqual([['a', 0], ['d', 1], ['b', 2], ['c', 3]]);
    });

    it('makes non-adjacent members contiguous in order', async () => {
      await createTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, ['a', 'c']);

      expect(sortedRows().map((r) => [r.id, r.order])).toEqual([['a', 0], ['c', 1], ['b', 2], ['d', 3]]);
    });

    it('returns the updated template with its junction rows', async () => {
      const result = await createTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, ['a', 'b'], ROUND_REST);

      expect(result.id).toBe(TEMPLATE_ID);
      expect(result.trainingTemplateExerciseTemplates.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
      expect(result.trainingTemplateExerciseTemplates[0].supersetGroupId).toBe(byId('a').supersetGroupId);
    });

    it('runs the writes inside a transaction', async () => {
      await createTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, ['a', 'b']);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    describe('validation', () => {
      it('rejects fewer than the minimum members with supersetMinMembers and writes nothing', async () => {
        const promise = createTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, ['a']);

        await expect(promise).rejects.toMatchObject({ statusCode: BAD_REQUEST, messageCode: SupersetMessageCode.MIN_MEMBERS });
        expect(writeCount()).toBe(0);
      });

      it('rejects more than the maximum members with supersetMaxMembers and writes nothing', async () => {
        const tooMany = Array.from({ length: SupersetConstraints.MAX_MEMBERS + 1 }, (_, i) => `x${i}`);
        rows = tooMany.map((id, i) => row(id, i));

        const promise = createTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, tooMany);

        await expect(promise).rejects.toMatchObject({ statusCode: BAD_REQUEST, messageCode: SupersetMessageCode.MAX_MEMBERS });
        expect(writeCount()).toBe(0);
      });

      it('accepts exactly the maximum number of members', async () => {
        const maxIds = Array.from({ length: SupersetConstraints.MAX_MEMBERS }, (_, i) => `x${i}`);
        rows = maxIds.map((id, i) => row(id, i));

        await createTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, maxIds);

        expect(rows.every((r) => r.supersetGroupId === rows[0].supersetGroupId)).toBe(true);
      });

      it('rejects an id that is not in the template with supersetMembershipInvalid and writes nothing', async () => {
        const promise = createTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, ['a', 'foreign']);

        await expect(promise).rejects.toMatchObject({ statusCode: BAD_REQUEST, messageCode: SupersetMessageCode.MEMBERSHIP_INVALID });
        expect(writeCount()).toBe(0);
      });

      it('rejects a member already in a group with alreadyInSuperset and writes nothing', async () => {
        rows = [row('a', 0, { supersetGroupId: GROUP_ID }), row('b', 1, { supersetGroupId: GROUP_ID, supersetOrder: 1 }), row('c', 2)];

        const promise = createTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, ['b', 'c']);

        await expect(promise).rejects.toMatchObject({ messageCode: SupersetMessageCode.ALREADY_IN_SUPERSET });
        expect(writeCount()).toBe(0);
        expect(byId('c').supersetGroupId).toBeNull();
      });
    });

    describe('ownership', () => {
      it('throws TEMPLATE_NOT_FOUND 404 when the template does not exist', async () => {
        prisma.trainingTemplate.findUnique.mockResolvedValue(null);

        await expect(createTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, ['a', 'b'])).rejects.toMatchObject({
          code: 'TEMPLATE_NOT_FOUND',
          statusCode: NOT_FOUND,
        });
        expect(writeCount()).toBe(0);
      });

      it('throws FORBIDDEN_NOT_TEMPLATE_OWNER 403 when the template belongs to another trainer', async () => {
        installFakeTable(OTHER_TRAINER_ID);

        await expect(createTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, ['a', 'b'])).rejects.toMatchObject({
          code: 'FORBIDDEN_NOT_TEMPLATE_OWNER',
          statusCode: FORBIDDEN,
        });
        expect(writeCount()).toBe(0);
      });

      it('throws TRAINER_PROFILE_MISSING 404 when the user has no trainer profile', async () => {
        prisma.trainer.findUnique.mockResolvedValue(null);

        await expect(createTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, ['a', 'b'])).rejects.toMatchObject({
          code: 'TRAINER_PROFILE_MISSING',
          statusCode: NOT_FOUND,
        });
      });
    });
  });

  describe('updateTemplateSupersetRestInterval', () => {
    beforeEach(() => {
      rows = [
        row('a', 0, { supersetGroupId: GROUP_ID, supersetOrder: 0, supersetRestInterval: ROUND_REST }),
        row('b', 1, { supersetGroupId: GROUP_ID, supersetOrder: 1, supersetRestInterval: ROUND_REST }),
        row('c', 2, { supersetGroupId: OTHER_GROUP_ID, supersetOrder: 0, supersetRestInterval: ROUND_REST }),
        row('d', 3, { supersetGroupId: OTHER_GROUP_ID, supersetOrder: 1, supersetRestInterval: ROUND_REST }),
      ];
      installFakeTable();
    });

    it('updates the rest of every member of the group', async () => {
      await updateTemplateSupersetRestInterval(OWNER_USER_ID, TEMPLATE_ID, GROUP_ID, 30);

      expect([byId('a').supersetRestInterval, byId('b').supersetRestInterval]).toEqual([30, 30]);
    });

    it('clears the rest when restInterval is null', async () => {
      await updateTemplateSupersetRestInterval(OWNER_USER_ID, TEMPLATE_ID, GROUP_ID, null);

      expect([byId('a').supersetRestInterval, byId('b').supersetRestInterval]).toEqual([null, null]);
    });

    it('keeps a rest of zero', async () => {
      await updateTemplateSupersetRestInterval(OWNER_USER_ID, TEMPLATE_ID, GROUP_ID, 0);

      expect(byId('a').supersetRestInterval).toBe(0);
    });

    it('does not change the members of other groups', async () => {
      await updateTemplateSupersetRestInterval(OWNER_USER_ID, TEMPLATE_ID, GROUP_ID, 30);

      expect([byId('c').supersetRestInterval, byId('d').supersetRestInterval]).toEqual([ROUND_REST, ROUND_REST]);
    });

    it('returns the updated template', async () => {
      const result = await updateTemplateSupersetRestInterval(OWNER_USER_ID, TEMPLATE_ID, GROUP_ID, 30);

      expect(result.trainingTemplateExerciseTemplates.find((r) => r.id === 'a').supersetRestInterval).toBe(30);
    });

    it('throws supersetGroupNotFound 404 for an unknown group and writes nothing', async () => {
      await expect(
        updateTemplateSupersetRestInterval(OWNER_USER_ID, TEMPLATE_ID, 'unknown-group', 30),
      ).rejects.toMatchObject({ statusCode: NOT_FOUND, messageCode: SupersetMessageCode.GROUP_NOT_FOUND });
      expect(writeCount()).toBe(0);
    });

    it('throws FORBIDDEN_NOT_TEMPLATE_OWNER 403 when the template belongs to another trainer', async () => {
      installFakeTable(OTHER_TRAINER_ID);

      await expect(
        updateTemplateSupersetRestInterval(OWNER_USER_ID, TEMPLATE_ID, GROUP_ID, 30),
      ).rejects.toMatchObject({ code: 'FORBIDDEN_NOT_TEMPLATE_OWNER', statusCode: FORBIDDEN });
    });
  });

  describe('dissolveTemplateSuperset', () => {
    beforeEach(() => {
      rows = [
        row('a', 0, { supersetGroupId: GROUP_ID, supersetOrder: 0, supersetRestInterval: ROUND_REST }),
        row('b', 1, { supersetGroupId: GROUP_ID, supersetOrder: 1, supersetRestInterval: ROUND_REST }),
        row('c', 2, { supersetGroupId: OTHER_GROUP_ID, supersetOrder: 0, supersetRestInterval: ROUND_REST }),
        row('d', 3, { supersetGroupId: OTHER_GROUP_ID, supersetOrder: 1, supersetRestInterval: ROUND_REST }),
      ];
      installFakeTable();
    });

    it('resets every member to ungrouped, supersetOrder 0 and no rest', async () => {
      await dissolveTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, GROUP_ID);

      expect(snapshot().slice(0, 2)).toEqual([['a', 0, null, 0, null], ['b', 1, null, 0, null]]);
    });

    it('keeps the exercises in the template', async () => {
      await dissolveTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, GROUP_ID);

      expect(prisma.trainingTemplateExerciseTemplate.delete).not.toHaveBeenCalled();
      expect(rows).toHaveLength(4);
    });

    it('leaves other groups untouched', async () => {
      await dissolveTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, GROUP_ID);

      expect(snapshot().slice(2)).toEqual([
        ['c', 2, OTHER_GROUP_ID, 0, ROUND_REST],
        ['d', 3, OTHER_GROUP_ID, 1, ROUND_REST],
      ]);
    });

    it('returns the updated template', async () => {
      const result = await dissolveTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, GROUP_ID);

      expect(result.trainingTemplateExerciseTemplates.find((r) => r.id === 'a').supersetGroupId).toBeNull();
    });

    it('throws supersetGroupNotFound 404 for an unknown group and writes nothing', async () => {
      await expect(dissolveTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, 'unknown-group')).rejects.toMatchObject({
        statusCode: NOT_FOUND,
        messageCode: SupersetMessageCode.GROUP_NOT_FOUND,
      });
      expect(writeCount()).toBe(0);
    });

    it('throws FORBIDDEN_NOT_TEMPLATE_OWNER 403 when the template belongs to another trainer', async () => {
      installFakeTable(OTHER_TRAINER_ID);

      await expect(dissolveTemplateSuperset(OWNER_USER_ID, TEMPLATE_ID, GROUP_ID)).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_TEMPLATE_OWNER',
        statusCode: FORBIDDEN,
      });
    });
  });

  describe('deleteTrainingTemplateExercise with superset members', () => {
    it('ungroups the survivor when a group of two loses a member', async () => {
      rows = [
        row('a', 0, { supersetGroupId: GROUP_ID, supersetOrder: 0, supersetRestInterval: ROUND_REST }),
        row('b', 1, { supersetGroupId: GROUP_ID, supersetOrder: 1, supersetRestInterval: ROUND_REST }),
        row('c', 2),
      ];
      installFakeTable();

      await deleteTrainingTemplateExercise(OWNER_USER_ID, TEMPLATE_ID, 'a');

      expect(snapshot()).toEqual([['b', 1, null, 0, null], ['c', 2, null, 0, null]]);
    });

    it('keeps the group and renumbers supersetOrder 0..1 when a group of three loses its first member', async () => {
      rows = [
        row('a', 0, { supersetGroupId: GROUP_ID, supersetOrder: 0, supersetRestInterval: ROUND_REST }),
        row('b', 1, { supersetGroupId: GROUP_ID, supersetOrder: 1, supersetRestInterval: ROUND_REST }),
        row('c', 2, { supersetGroupId: GROUP_ID, supersetOrder: 2, supersetRestInterval: ROUND_REST }),
      ];
      installFakeTable();

      await deleteTrainingTemplateExercise(OWNER_USER_ID, TEMPLATE_ID, 'a');

      expect(snapshot()).toEqual([
        ['b', 1, GROUP_ID, 0, ROUND_REST],
        ['c', 2, GROUP_ID, 1, ROUND_REST],
      ]);
    });

    it('renumbers supersetOrder when a middle member of a group of three is removed', async () => {
      rows = [
        row('a', 0, { supersetGroupId: GROUP_ID, supersetOrder: 0, supersetRestInterval: ROUND_REST }),
        row('b', 1, { supersetGroupId: GROUP_ID, supersetOrder: 1, supersetRestInterval: ROUND_REST }),
        row('c', 2, { supersetGroupId: GROUP_ID, supersetOrder: 2, supersetRestInterval: ROUND_REST }),
      ];
      installFakeTable();

      await deleteTrainingTemplateExercise(OWNER_USER_ID, TEMPLATE_ID, 'b');

      expect(snapshot()).toEqual([
        ['a', 0, GROUP_ID, 0, ROUND_REST],
        ['c', 2, GROUP_ID, 1, ROUND_REST],
      ]);
    });

    it('does not touch other groups when a member is removed', async () => {
      rows = [
        row('a', 0, { supersetGroupId: GROUP_ID, supersetOrder: 0, supersetRestInterval: ROUND_REST }),
        row('b', 1, { supersetGroupId: GROUP_ID, supersetOrder: 1, supersetRestInterval: ROUND_REST }),
        row('c', 2, { supersetGroupId: OTHER_GROUP_ID, supersetOrder: 0, supersetRestInterval: ROUND_REST }),
        row('d', 3, { supersetGroupId: OTHER_GROUP_ID, supersetOrder: 1, supersetRestInterval: ROUND_REST }),
      ];
      installFakeTable();

      await deleteTrainingTemplateExercise(OWNER_USER_ID, TEMPLATE_ID, 'a');

      expect(snapshot().slice(1)).toEqual([
        ['c', 2, OTHER_GROUP_ID, 0, ROUND_REST],
        ['d', 3, OTHER_GROUP_ID, 1, ROUND_REST],
      ]);
    });

    it('still returns the deleted junction row', async () => {
      rows = [row('a', 0), row('b', 1)];
      installFakeTable();

      const result = await deleteTrainingTemplateExercise(OWNER_USER_ID, TEMPLATE_ID, 'a');

      expect(result.id).toBe('a');
    });

    it('leaves ungrouped neighbours unchanged when an ungrouped exercise is deleted', async () => {
      rows = [row('a', 0), row('b', 1, { supersetGroupId: GROUP_ID, supersetOrder: 0 }), row('c', 2, { supersetGroupId: GROUP_ID, supersetOrder: 1 })];
      installFakeTable();

      await deleteTrainingTemplateExercise(OWNER_USER_ID, TEMPLATE_ID, 'a');

      expect(snapshot().map((s) => s.slice(2, 4))).toEqual([[GROUP_ID, 0], [GROUP_ID, 1]]);
    });
  });
});
