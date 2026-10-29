import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { createBisetHarness } from '../helpers/biset-e2e.js';
import { prisma } from '../../src/db.js';
import { SupersetMessageCode } from '../../src/constants/training.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const EXPLICIT_REST = 90;
const FIRST_MEMBER_REST = 60;
const LAST_MEMBER_REST = 45;
const UPDATED_REST = 120;

e2eDescribe('e2e: superset round rest (supersetRestInterval)', () => {
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

  function expectErrorContract(body) {
    expect(body).toHaveProperty('error');
    expect(body).toHaveProperty('messageCode');
    expect(body).toHaveProperty('message');
  }

  describe('POST /trainer/trainings/:trainingId/supersets', () => {
    it('stores the sent restInterval on every member and echoes it in the response', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const a = await h.createExercise(trainer.accessToken, trainingId, { restInterval: FIRST_MEMBER_REST });
      const b = await h.createExercise(trainer.accessToken, trainingId, { restInterval: LAST_MEMBER_REST });

      const response = await h.postSuperset(trainer.accessToken, trainingId, {
        exerciseIds: [a.id, b.id],
        restInterval: EXPLICIT_REST,
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().restInterval).toBe(EXPLICIT_REST);
      expect(await h.dbRestIntervals([a.id, b.id])).toEqual({ [a.id]: EXPLICIT_REST, [b.id]: EXPLICIT_REST });
    });

    it('defaults to the last member restInterval when omitted', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const a = await h.createExercise(trainer.accessToken, trainingId, { restInterval: FIRST_MEMBER_REST });
      const b = await h.createExercise(trainer.accessToken, trainingId, { restInterval: LAST_MEMBER_REST });

      const response = await h.postSuperset(trainer.accessToken, trainingId, { exerciseIds: [a.id, b.id] });

      expect(response.statusCode).toBe(201);
      expect(response.json().restInterval).toBe(LAST_MEMBER_REST);
      expect(await h.dbRestIntervals([a.id, b.id])).toEqual({ [a.id]: LAST_MEMBER_REST, [b.id]: LAST_MEMBER_REST });
    });

    it('uses the member with highest supersetOrder (array order), not creation order, as default', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const a = await h.createExercise(trainer.accessToken, trainingId, { restInterval: FIRST_MEMBER_REST });
      const b = await h.createExercise(trainer.accessToken, trainingId, { restInterval: LAST_MEMBER_REST });

      const response = await h.postSuperset(trainer.accessToken, trainingId, { exerciseIds: [b.id, a.id] });

      expect(response.statusCode).toBe(201);
      expect(response.json().restInterval).toBe(FIRST_MEMBER_REST);
    });

    it('stores null when omitted and the last member has no restInterval', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const a = await h.createExercise(trainer.accessToken, trainingId, { restInterval: FIRST_MEMBER_REST });
      const b = await h.createExercise(trainer.accessToken, trainingId);

      const response = await h.postSuperset(trainer.accessToken, trainingId, { exerciseIds: [a.id, b.id] });

      expect(response.statusCode).toBe(201);
      expect(response.json().restInterval).toBeNull();
      expect(await h.dbRestIntervals([a.id, b.id])).toEqual({ [a.id]: null, [b.id]: null });
    });

    it('accepts restInterval 0 without falling back to the last member value', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const a = await h.createExercise(trainer.accessToken, trainingId, { restInterval: FIRST_MEMBER_REST });
      const b = await h.createExercise(trainer.accessToken, trainingId, { restInterval: LAST_MEMBER_REST });

      const response = await h.postSuperset(trainer.accessToken, trainingId, {
        exerciseIds: [a.id, b.id],
        restInterval: 0,
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().restInterval).toBe(0);
      expect(await h.dbRestIntervals([a.id, b.id])).toEqual({ [a.id]: 0, [b.id]: 0 });
    });

    it('keeps the old payload working (members and supersetGroupId still returned)', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const a = await h.createExercise(trainer.accessToken, trainingId);
      const b = await h.createExercise(trainer.accessToken, trainingId);

      const response = await h.postSuperset(trainer.accessToken, trainingId, { exerciseIds: [a.id, b.id] });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ supersetGroupId: expect.any(String), trainingId });
      expect(response.json().members).toHaveLength(2);
    });

    it.each([-1, 1.5, 'abc'])('rejects invalid restInterval %s with validation.failed', async (restInterval) => {
      const { trainer, trainingId } = await h.setupTraining();
      const a = await h.createExercise(trainer.accessToken, trainingId);
      const b = await h.createExercise(trainer.accessToken, trainingId);

      const response = await h.postSuperset(trainer.accessToken, trainingId, {
        exerciseIds: [a.id, b.id],
        restInterval,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });
  });

  describe('PATCH /trainer/trainings/:trainingId/supersets/:groupId', () => {
    it('updates supersetRestInterval on all members and returns the group shape', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const { groupId, exercises } = await h.createGroup(trainer.accessToken, trainingId, { restInterval: EXPLICIT_REST });

      const response = await h.patchSupersetRest(trainer.accessToken, trainingId, groupId, { restInterval: UPDATED_REST });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        supersetGroupId: groupId,
        trainingId,
        restInterval: UPDATED_REST,
        members: [
          { id: exercises[0].id, name: 'Member 0', supersetOrder: 0 },
          { id: exercises[1].id, name: 'Member 1', supersetOrder: 1 },
        ],
      });
      expect(await h.dbRestIntervals(exercises.map((e) => e.id))).toEqual({
        [exercises[0].id]: UPDATED_REST,
        [exercises[1].id]: UPDATED_REST,
      });
    });

    it('does not touch members of another group in the same training', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const first = await h.createGroup(trainer.accessToken, trainingId, { restInterval: EXPLICIT_REST });
      const second = await h.createGroup(trainer.accessToken, trainingId, { restInterval: EXPLICIT_REST });

      await h.patchSupersetRest(trainer.accessToken, trainingId, first.groupId, { restInterval: UPDATED_REST });

      const untouched = await h.dbRestIntervals(second.exercises.map((e) => e.id));
      expect(Object.values(untouched)).toEqual([EXPLICIT_REST, EXPLICIT_REST]);
    });

    it('does not change the per-exercise restInterval of members', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const { groupId, exercises } = await h.createGroup(trainer.accessToken, trainingId);

      const response = await h.patchSupersetRest(trainer.accessToken, trainingId, groupId, { restInterval: UPDATED_REST });

      expect(response.statusCode).toBe(200);
      const row = await prisma.exercise.findUnique({ where: { id: exercises[0].id }, select: { restInterval: true } });
      expect(row.restInterval).toBe(FIRST_MEMBER_REST);
    });

    it('returns 404 GROUP_NOT_FOUND for an unknown group id', async () => {
      const { trainer, trainingId } = await h.setupTraining();

      const response = await h.patchSupersetRest(trainer.accessToken, trainingId, randomUUID(), { restInterval: UPDATED_REST });

      expect(response.statusCode).toBe(404);
      expect(response.json().messageCode).toBe(SupersetMessageCode.GROUP_NOT_FOUND);
      expectErrorContract(response.json());
    });

    it('returns 404 GROUP_NOT_FOUND when the group belongs to a different training', async () => {
      const { trainer, protocolId, trainingId } = await h.setupTraining();
      const otherTrainingId = await h.createTraining(trainer.accessToken, protocolId, { name: 'Leg Day' });
      const { groupId } = await h.createGroup(trainer.accessToken, otherTrainingId);

      const response = await h.patchSupersetRest(trainer.accessToken, trainingId, groupId, { restInterval: UPDATED_REST });

      expect(response.statusCode).toBe(404);
      expect(response.json().messageCode).toBe(SupersetMessageCode.GROUP_NOT_FOUND);
    });

    it('answers a foreign trainer exactly like the other superset routes (DELETE) do', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const { groupId } = await h.createGroup(trainer.accessToken, trainingId);
      const intruder = await h.createTrainer();

      const reference = await h.deleteSuperset(intruder.accessToken, trainingId, groupId);
      const response = await h.patchSupersetRest(intruder.accessToken, trainingId, groupId, { restInterval: UPDATED_REST });

      expect(response.statusCode).toBe(reference.statusCode);
      expect(response.json().error).toBe(reference.json().error);
      expect(response.json().messageCode).toBe(reference.json().messageCode);
    });

    it('does not modify members when a foreign trainer attempts the update', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const { groupId, exercises } = await h.createGroup(trainer.accessToken, trainingId, { restInterval: EXPLICIT_REST });
      const intruder = await h.createTrainer();

      await h.patchSupersetRest(intruder.accessToken, trainingId, groupId, { restInterval: UPDATED_REST });

      expect(Object.values(await h.dbRestIntervals(exercises.map((e) => e.id)))).toEqual([EXPLICIT_REST, EXPLICIT_REST]);
    });

    it('returns 400 validation.failed when restInterval is missing', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const { groupId } = await h.createGroup(trainer.accessToken, trainingId);

      const response = await h.patchSupersetRest(trainer.accessToken, trainingId, groupId, {});

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it.each([-5, 2.5, null])('returns 400 validation.failed for invalid restInterval %s', async (restInterval) => {
      const { trainer, trainingId } = await h.setupTraining();
      const { groupId } = await h.createGroup(trainer.accessToken, trainingId);

      const response = await h.patchSupersetRest(trainer.accessToken, trainingId, groupId, { restInterval });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('accepts restInterval 0', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const { groupId } = await h.createGroup(trainer.accessToken, trainingId, { restInterval: EXPLICIT_REST });

      const response = await h.patchSupersetRest(trainer.accessToken, trainingId, groupId, { restInterval: 0 });

      expect(response.statusCode).toBe(200);
      expect(response.json().restInterval).toBe(0);
    });

    it('returns 401 when unauthenticated', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/trainer/trainings/${randomUUID()}/supersets/${randomUUID()}`,
        payload: { restInterval: UPDATED_REST },
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 403 for a non-trainer user', async () => {
      const student = await h.createStudent();

      const response = await h.patchSupersetRest(student.accessToken, randomUUID(), randomUUID(), { restInterval: UPDATED_REST });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('clearing the round rest', () => {
    it('DELETE supersets/:groupId sets supersetRestInterval to null on the dissolved members', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const { groupId, exercises } = await h.createGroup(trainer.accessToken, trainingId, { restInterval: EXPLICIT_REST });

      const response = await h.deleteSuperset(trainer.accessToken, trainingId, groupId);

      expect(response.statusCode).toBe(200);
      expect(Object.values(await h.dbRestIntervals(exercises.map((e) => e.id)))).toEqual([null, null]);
    });

    it('deleting a member of a 2-member group clears supersetRestInterval on the remaining exercise', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const { exercises } = await h.createGroup(trainer.accessToken, trainingId, { restInterval: EXPLICIT_REST });

      const response = await app.inject({
        method: 'DELETE',
        url: `/trainer/exercises/${exercises[0].id}`,
        headers: { authorization: `Bearer ${trainer.accessToken}` },
      });

      expect(response.statusCode).toBeLessThan(300);
      const remaining = await prisma.exercise.findUnique({
        where: { id: exercises[1].id },
        select: { supersetGroupId: true, supersetRestInterval: true },
      });
      expect(remaining).toEqual({ supersetGroupId: null, supersetRestInterval: null });
    });

    it('deleting a member of a 3-member group keeps supersetRestInterval on the remaining members', async () => {
      const { trainer, trainingId } = await h.setupTraining();
      const { exercises } = await h.createGroup(trainer.accessToken, trainingId, {
        restInterval: EXPLICIT_REST,
        memberRests: [60, 50, 40],
      });

      await app.inject({
        method: 'DELETE',
        url: `/trainer/exercises/${exercises[0].id}`,
        headers: { authorization: `Bearer ${trainer.accessToken}` },
      });

      const remaining = await h.dbRestIntervals([exercises[1].id, exercises[2].id]);
      expect(Object.values(remaining)).toEqual([EXPLICIT_REST, EXPLICIT_REST]);
    });
  });

  describe('supersetRestInterval on exercise responses', () => {
    async function setupGroupAndLoose() {
      const ctx = await h.setupTraining();
      const group = await h.createGroup(ctx.trainer.accessToken, ctx.trainingId, { restInterval: EXPLICIT_REST });
      const loose = await h.createExercise(ctx.trainer.accessToken, ctx.trainingId, { name: 'Loose' });
      return { ...ctx, group, loose };
    }

    it('GET /trainer/trainings/:id/exercises returns the value for members and null for loose exercises', async () => {
      const { trainer, trainingId, group, loose } = await setupGroupAndLoose();

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/trainings/${trainingId}/exercises`,
        headers: { authorization: `Bearer ${trainer.accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const byId = Object.fromEntries(response.json().map((e) => [e.id, e]));
      expect(byId[group.exercises[0].id].supersetRestInterval).toBe(EXPLICIT_REST);
      expect(byId[group.exercises[1].id].supersetRestInterval).toBe(EXPLICIT_REST);
      expect(byId[loose.id]).toHaveProperty('supersetRestInterval', null);
    });

    it('GET /trainer/exercises/:id includes supersetRestInterval', async () => {
      const { trainer, group } = await setupGroupAndLoose();

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/exercises/${group.exercises[0].id}`,
        headers: { authorization: `Bearer ${trainer.accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().supersetRestInterval).toBe(EXPLICIT_REST);
    });

    it('POST /trainer/trainings/:id/exercises response includes supersetRestInterval null for a new exercise', async () => {
      const { trainer, trainingId } = await h.setupTraining();

      const created = await h.createExercise(trainer.accessToken, trainingId);

      expect(created).toHaveProperty('supersetRestInterval', null);
    });

    it('PATCH /trainer/exercises/:id response includes supersetRestInterval', async () => {
      const { trainer, group } = await setupGroupAndLoose();

      const response = await app.inject({
        method: 'PATCH',
        url: `/trainer/exercises/${group.exercises[0].id}`,
        headers: { authorization: `Bearer ${trainer.accessToken}` },
        payload: { notes: 'updated' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().supersetRestInterval).toBe(EXPLICIT_REST);
    });

    it('GET /my/trainings/:id/exercises returns the value for members and null for loose exercises', async () => {
      const { student, trainingId, group, loose } = await setupGroupAndLoose();

      const response = await app.inject({
        method: 'GET',
        url: `/my/trainings/${trainingId}/exercises`,
        headers: { authorization: `Bearer ${student.accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const byId = Object.fromEntries(response.json().map((e) => [e.id, e]));
      expect(byId[group.exercises[0].id].supersetRestInterval).toBe(EXPLICIT_REST);
      expect(byId[loose.id]).toHaveProperty('supersetRestInterval', null);
    });

    it('GET /my/exercises/:id includes supersetRestInterval', async () => {
      const { student, group } = await setupGroupAndLoose();

      const response = await app.inject({
        method: 'GET',
        url: `/my/exercises/${group.exercises[1].id}`,
        headers: { authorization: `Bearer ${student.accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().supersetRestInterval).toBe(EXPLICIT_REST);
    });

    it('GET /my/exercises/:id returns null supersetRestInterval for an ungrouped exercise', async () => {
      const { student, loose } = await setupGroupAndLoose();

      const response = await app.inject({
        method: 'GET',
        url: `/my/exercises/${loose.id}`,
        headers: { authorization: `Bearer ${student.accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty('supersetRestInterval', null);
    });
  });
});
