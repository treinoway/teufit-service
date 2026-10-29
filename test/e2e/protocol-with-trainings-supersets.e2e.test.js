import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { createBisetHarness } from '../helpers/biset-e2e.js';
import { prisma } from '../../src/db.js';
import { SupersetConstraints, SupersetMessageCode } from '../../src/constants/training.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const ROUND_REST = 80;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Builds a minimal exercise body for the bulk payload.
function exerciseBody(name, order, extra = {}) {
  return { name, type: 'strength', order, sets: 3, ...extra };
}

e2eDescribe('e2e: POST /trainer/protocols/with-trainings — supersets and substitutes', () => {
  let app;
  let h;

  beforeAll(async () => {
    app = await setupApp();
    h = createBisetHarness(app);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  async function setupActors() {
    const trainer = await h.createTrainer();
    const student = await h.createStudent();
    await h.linkStudent(trainer.trainerId, student.userId);
    return { trainer, student };
  }

  function postBulk(trainerToken, assigneeId, trainings) {
    return app.inject({
      method: 'POST',
      url: '/trainer/protocols/with-trainings',
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: { assigneeId, name: 'Bulk', startDate: '2026-01-01', trainings },
    });
  }

  function training(exercises, extra = {}) {
    return { name: 'Treino A', category: 'strength', order: 0, exercises, ...extra };
  }

  async function exercisesOf(trainingId) {
    return prisma.exercise.findMany({ where: { trainingId }, orderBy: [{ order: 'asc' }, { substituteOrder: 'asc' }] });
  }

  function groupedExercises(clientGroupId, count, extra = {}) {
    return Array.from({ length: count }, (_, i) => exerciseBody(`G${i}`, i, {
      supersetGroupId: clientGroupId,
      supersetOrder: i,
      supersetRestInterval: ROUND_REST,
      ...extra,
    }));
  }

  describe('supersets', () => {
    it('stores a group with a fresh server uuid instead of the client one', async () => {
      const { trainer, student } = await setupActors();
      const clientGroupId = randomUUID();

      const response = await postBulk(trainer.accessToken, student.userId, [
        training([...groupedExercises(clientGroupId, 2), exerciseBody('Loose', 2)]),
      ]);

      expect(response.statusCode).toBe(201);
      const rows = await exercisesOf(response.json().trainings[0].id);
      const members = rows.filter((r) => r.supersetGroupId);
      expect(members).toHaveLength(2);
      expect(members[0].supersetGroupId).toMatch(UUID_PATTERN);
      expect(members[0].supersetGroupId).not.toBe(clientGroupId);
      expect(members[1].supersetGroupId).toBe(members[0].supersetGroupId);
    });

    it('stores supersetOrder and supersetRestInterval on every member and leaves loose exercises ungrouped', async () => {
      const { trainer, student } = await setupActors();

      const response = await postBulk(trainer.accessToken, student.userId, [
        training([...groupedExercises(randomUUID(), 2), exerciseBody('Loose', 2)]),
      ]);

      const rows = await exercisesOf(response.json().trainings[0].id);
      expect(rows.map((r) => [r.name, r.supersetOrder, r.supersetRestInterval])).toEqual([
        ['G0', 0, ROUND_REST],
        ['G1', 1, ROUND_REST],
        ['Loose', 0, null],
      ]);
      expect(rows[2].supersetGroupId).toBeNull();
    });

    it('gives distinct server group ids to two groups of one training', async () => {
      const { trainer, student } = await setupActors();
      const exercises = [
        ...groupedExercises(randomUUID(), 2),
        ...groupedExercises(randomUUID(), 3).map((e, i) => ({ ...e, name: `H${i}`, order: 2 + i })),
      ];

      const response = await postBulk(trainer.accessToken, student.userId, [training(exercises)]);

      expect(response.statusCode).toBe(201);
      const rows = await exercisesOf(response.json().trainings[0].id);
      expect(new Set(rows.map((r) => r.supersetGroupId)).size).toBe(2);
    });

    it('treats the same client group id in two trainings as two separate groups', async () => {
      const { trainer, student } = await setupActors();
      const sharedClientId = randomUUID();

      const response = await postBulk(trainer.accessToken, student.userId, [
        training(groupedExercises(sharedClientId, 2)),
        training(groupedExercises(sharedClientId, 2), { name: 'Treino B', order: 1 }),
      ]);

      expect(response.statusCode).toBe(201);
      const [first, second] = response.json().trainings;
      const [firstRows, secondRows] = [await exercisesOf(first.id), await exercisesOf(second.id)];
      expect(firstRows[0].supersetGroupId).not.toBe(secondRows[0].supersetGroupId);
    });

    it('accepts a group with the maximum number of members', async () => {
      const { trainer, student } = await setupActors();

      const response = await postBulk(trainer.accessToken, student.userId, [
        training(groupedExercises(randomUUID(), SupersetConstraints.MAX_MEMBERS)),
      ]);

      expect(response.statusCode).toBe(201);
      const rows = await exercisesOf(response.json().trainings[0].id);
      expect(new Set(rows.map((r) => r.supersetGroupId)).size).toBe(1);
      expect(rows[0].supersetGroupId).toBeTruthy();
      expect(rows).toHaveLength(SupersetConstraints.MAX_MEMBERS);
    });

    it('keeps old payloads (no superset fields) working with ungrouped rows', async () => {
      const { trainer, student } = await setupActors();

      const response = await postBulk(trainer.accessToken, student.userId, [
        training([exerciseBody('A', 0), exerciseBody('B', 1)]),
      ]);

      expect(response.statusCode).toBe(201);
      const rows = await exercisesOf(response.json().trainings[0].id);
      expect(rows.map((r) => [r.supersetGroupId, r.supersetRestInterval])).toEqual([[null, null], [null, null]]);
    });
  });

  describe('invalid groups', () => {
    async function expectRejected(exercises, messageCode) {
      const { trainer, student } = await setupActors();

      const response = await postBulk(trainer.accessToken, student.userId, [training(exercises)]);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode });
      expect(await prisma.trainingProtocol.count()).toBe(0);
    }

    it('rejects a group with a single member (supersetMinMembers)', async () => {
      await expectRejected(groupedExercises(randomUUID(), 1), SupersetMessageCode.MIN_MEMBERS);
    });

    it('rejects a group with more than the maximum members (supersetMaxMembers)', async () => {
      await expectRejected(
        groupedExercises(randomUUID(), SupersetConstraints.MAX_MEMBERS + 1),
        SupersetMessageCode.MAX_MEMBERS,
      );
    });

    it('rejects non-contiguous members (supersetMembershipInvalid)', async () => {
      const groupId = randomUUID();
      const exercises = [
        exerciseBody('A', 0, { supersetGroupId: groupId, supersetOrder: 0 }),
        exerciseBody('Between', 1),
        exerciseBody('B', 2, { supersetGroupId: groupId, supersetOrder: 1 }),
      ];

      await expectRejected(exercises, SupersetMessageCode.MEMBERSHIP_INVALID);
    });

    it('rejects a substitute that carries superset fields', async () => {
      const { trainer, student } = await setupActors();
      const exercises = [
        exerciseBody('A', 0, { substitutes: [{ name: 'Alt', type: 'strength', supersetGroupId: randomUUID() }] }),
      ];

      const response = await postBulk(trainer.accessToken, student.userId, [training(exercises)]);

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('VALIDATION_ERROR');
      expect(await prisma.trainingProtocol.count()).toBe(0);
    });

    it('rejects a substitute that carries nested substitutes', async () => {
      const { trainer, student } = await setupActors();
      const nested = { name: 'Alt', type: 'strength', substitutes: [{ name: 'Alt2', type: 'strength' }] };

      const response = await postBulk(trainer.accessToken, student.userId, [
        training([exerciseBody('A', 0, { substitutes: [nested] })]),
      ]);

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('VALIDATION_ERROR');
    });

    it('rejects a negative supersetRestInterval with validation.failed', async () => {
      const { trainer, student } = await setupActors();
      const exercises = groupedExercises(randomUUID(), 2).map((e) => ({ ...e, supersetRestInterval: -1 }));

      const response = await postBulk(trainer.accessToken, student.userId, [training(exercises)]);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });
  });

  describe('substitutes', () => {
    it('creates substitutes linked to their principal with substituteOrder in array order', async () => {
      const { trainer, student } = await setupActors();
      const exercises = [
        exerciseBody('Principal', 0, {
          substitutes: [
            { name: 'Alt 1', type: 'strength', sets: 4 },
            { name: 'Alt 2', type: 'strength', sets: 2 },
          ],
        }),
        exerciseBody('Other', 1),
      ];

      const response = await postBulk(trainer.accessToken, student.userId, [training(exercises)]);

      expect(response.statusCode).toBe(201);
      const trainingId = response.json().trainings[0].id;
      const rows = await exercisesOf(trainingId);
      const principal = rows.find((r) => r.name === 'Principal');
      const subs = rows.filter((r) => r.substituteForExerciseId === principal.id);
      expect(subs.map((s) => [s.name, s.substituteOrder, s.sets, s.trainingId])).toEqual([
        ['Alt 1', 0, 4, trainingId],
        ['Alt 2', 1, 2, trainingId],
      ]);
      expect(subs.every((s) => s.supersetGroupId === null)).toBe(true);
    });

    it('allows a bi-set member to carry substitutes without breaking the group', async () => {
      const { trainer, student } = await setupActors();
      const exercises = groupedExercises(randomUUID(), 2);
      exercises[0].substitutes = [{ name: 'Alt', type: 'strength' }];

      const response = await postBulk(trainer.accessToken, student.userId, [training(exercises)]);

      expect(response.statusCode).toBe(201);
      const rows = await exercisesOf(response.json().trainings[0].id);
      const principals = rows.filter((r) => r.substituteForExerciseId === null);
      expect(principals).toHaveLength(2);
      expect(new Set(principals.map((r) => r.supersetGroupId)).size).toBe(1);
      expect(rows.filter((r) => r.substituteForExerciseId !== null)).toHaveLength(1);
    });

    it('keeps substitutes out of the contiguity check (substitute rows do not break a group)', async () => {
      const { trainer, student } = await setupActors();
      const exercises = groupedExercises(randomUUID(), 3);
      exercises[1].substitutes = [{ name: 'Alt', type: 'strength' }];

      const response = await postBulk(trainer.accessToken, student.userId, [training(exercises)]);

      expect(response.statusCode).toBe(201);
      const rows = await exercisesOf(response.json().trainings[0].id);
      const members = rows.filter((r) => r.substituteForExerciseId === null);
      expect(members.every((r) => r.supersetGroupId === members[0].supersetGroupId && r.supersetGroupId)).toBe(true);
      expect(rows.filter((r) => r.substituteForExerciseId !== null)).toHaveLength(1);
    });

    it('accepts an empty substitutes array', async () => {
      const { trainer, student } = await setupActors();

      const response = await postBulk(trainer.accessToken, student.userId, [
        training([exerciseBody('A', 0, { substitutes: [] })]),
      ]);

      expect(response.statusCode).toBe(201);
      expect(await exercisesOf(response.json().trainings[0].id)).toHaveLength(1);
    });
  });
});
