import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    training: { findUnique: vi.fn() },
    exercise: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../src/db.js';
import { createSuperset, updateSupersetRestInterval } from '../../src/services/exercise-service.js';
import { SupersetMessageCode } from '../../src/constants/training.js';

const TRAINER_ID = 't1';
const TRAINING_ID = 'tr1';
const GROUP_ID = 'group-a';
const EXPLICIT_REST = 90;
const FIRST_REST = 60;
const LAST_REST = 45;

// Builds a training owned by the given trainer.
const makeTraining = (trainerId = TRAINER_ID) => ({
  id: TRAINING_ID,
  deletedAt: null,
  trainingProtocol: { id: 'p1', trainerId, deletedAt: null },
});

// Builds an active principal exercise row.
const makeActive = (id, order, restInterval) => ({
  id,
  name: id,
  order,
  restInterval,
  supersetGroupId: null,
  supersetOrder: 0,
  substituteForExerciseId: null,
});

describe('superset round rest', () => {
  beforeEach(() => {
    prisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
    prisma.training.findUnique.mockResolvedValue(makeTraining());
  });

  describe('createSuperset — supersetRestInterval', () => {
    function arrangeTx(active) {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: {
          findMany: vi.fn().mockResolvedValue(active),
          update: vi.fn().mockImplementation(async ({ where, data }) => ({
            id: where.id,
            name: where.id,
            order: data.order,
            supersetOrder: data.supersetOrder,
          })),
        },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(tx));
      return tx;
    }

    function memberUpdates(tx) {
      return tx.exercise.update.mock.calls
        .map(([arg]) => arg)
        .filter((arg) => arg.data.supersetGroupId !== undefined);
    }

    it('writes the sent restInterval as supersetRestInterval on every member', async () => {
      const tx = arrangeTx([makeActive('a', 0, FIRST_REST), makeActive('b', 1, LAST_REST)]);

      await createSuperset('u1', TRAINING_ID, ['a', 'b'], EXPLICIT_REST);

      expect(memberUpdates(tx).map((u) => u.data.supersetRestInterval)).toEqual([EXPLICIT_REST, EXPLICIT_REST]);
    });

    it('returns the applied restInterval in the result', async () => {
      arrangeTx([makeActive('a', 0, FIRST_REST), makeActive('b', 1, LAST_REST)]);

      const result = await createSuperset('u1', TRAINING_ID, ['a', 'b'], EXPLICIT_REST);

      expect(result.restInterval).toBe(EXPLICIT_REST);
    });

    it('defaults to the restInterval of the last member in the requested order when omitted', async () => {
      const tx = arrangeTx([makeActive('a', 0, FIRST_REST), makeActive('b', 1, LAST_REST)]);

      const result = await createSuperset('u1', TRAINING_ID, ['a', 'b']);

      expect(result.restInterval).toBe(LAST_REST);
      expect(memberUpdates(tx).map((u) => u.data.supersetRestInterval)).toEqual([LAST_REST, LAST_REST]);
    });

    it('uses the first-listed exercise rest when it ends up last (array order, not current order)', async () => {
      arrangeTx([makeActive('a', 0, FIRST_REST), makeActive('b', 1, LAST_REST)]);

      const result = await createSuperset('u1', TRAINING_ID, ['b', 'a']);

      expect(result.restInterval).toBe(FIRST_REST);
    });

    it('stores null when omitted and the last member has no restInterval', async () => {
      const tx = arrangeTx([makeActive('a', 0, FIRST_REST), makeActive('b', 1, null)]);

      const result = await createSuperset('u1', TRAINING_ID, ['a', 'b']);

      expect(result.restInterval).toBeNull();
      expect(memberUpdates(tx).map((u) => u.data.supersetRestInterval)).toEqual([null, null]);
    });

    it('keeps an explicit 0 instead of falling back to the last member value', async () => {
      const tx = arrangeTx([makeActive('a', 0, FIRST_REST), makeActive('b', 1, LAST_REST)]);

      await createSuperset('u1', TRAINING_ID, ['a', 'b'], 0);

      expect(memberUpdates(tx).map((u) => u.data.supersetRestInterval)).toEqual([0, 0]);
    });
  });

  describe('updateSupersetRestInterval', () => {
    const members = [
      { id: 'a', name: 'A', supersetOrder: 0 },
      { id: 'b', name: 'B', supersetOrder: 1 },
    ];

    function arrangeTx() {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: {
          updateMany: vi.fn().mockResolvedValue({ count: members.length }),
          findMany: vi.fn().mockResolvedValue(members),
        },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(tx));
      prisma.exercise.findMany.mockResolvedValue(members);
      return tx;
    }

    it('throws TRAINER_PROFILE_MISSING (404) when the trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(updateSupersetRestInterval('u1', TRAINING_ID, GROUP_ID, EXPLICIT_REST))
        .rejects.toMatchObject({ code: 'TRAINER_PROFILE_MISSING', statusCode: 404 });
    });

    it('throws TRAINING_NOT_FOUND (404) when the training does not exist', async () => {
      prisma.training.findUnique.mockResolvedValue(null);

      await expect(updateSupersetRestInterval('u1', TRAINING_ID, GROUP_ID, EXPLICIT_REST))
        .rejects.toMatchObject({ code: 'TRAINING_NOT_FOUND', statusCode: 404 });
    });

    it('throws FORBIDDEN_NOT_PROTOCOL_OWNER (403) when the trainer does not own the training', async () => {
      prisma.training.findUnique.mockResolvedValue(makeTraining('other-trainer'));

      await expect(updateSupersetRestInterval('u1', TRAINING_ID, GROUP_ID, EXPLICIT_REST))
        .rejects.toMatchObject({ code: 'FORBIDDEN_NOT_PROTOCOL_OWNER', statusCode: 403 });
    });

    it('throws SUPERSET_GROUP_NOT_FOUND (404, supersetGroupNotFound) when the group has no active members', async () => {
      prisma.exercise.findMany.mockResolvedValue([]);

      await expect(updateSupersetRestInterval('u1', TRAINING_ID, GROUP_ID, EXPLICIT_REST)).rejects.toMatchObject({
        httpStatus: 404,
        error: 'SUPERSET_GROUP_NOT_FOUND',
        messageCode: SupersetMessageCode.GROUP_NOT_FOUND,
      });
    });

    it('does not open a transaction when the group is missing', async () => {
      prisma.exercise.findMany.mockResolvedValue([]);

      await updateSupersetRestInterval('u1', TRAINING_ID, GROUP_ID, EXPLICIT_REST).catch(() => {});

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('updates supersetRestInterval for all active members of the group in the training', async () => {
      const tx = arrangeTx();

      await updateSupersetRestInterval('u1', TRAINING_ID, GROUP_ID, EXPLICIT_REST);

      expect(tx.exercise.updateMany).toHaveBeenCalledWith({
        where: { trainingId: TRAINING_ID, supersetGroupId: GROUP_ID, deletedAt: null },
        data: { supersetRestInterval: EXPLICIT_REST },
      });
    });

    it('locks the training row before updating members', async () => {
      const tx = arrangeTx();

      await updateSupersetRestInterval('u1', TRAINING_ID, GROUP_ID, EXPLICIT_REST);

      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.exercise.updateMany.mock.invocationCallOrder[0]);
    });

    it('returns the group shape with members ordered by supersetOrder', async () => {
      arrangeTx();

      const result = await updateSupersetRestInterval('u1', TRAINING_ID, GROUP_ID, EXPLICIT_REST);

      expect(result).toEqual({
        supersetGroupId: GROUP_ID,
        trainingId: TRAINING_ID,
        restInterval: EXPLICIT_REST,
        members,
      });
    });

    it('accepts 0 as a valid restInterval', async () => {
      const tx = arrangeTx();

      await updateSupersetRestInterval('u1', TRAINING_ID, GROUP_ID, 0);

      expect(tx.exercise.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { supersetRestInterval: 0 } }));
    });
  });
});
