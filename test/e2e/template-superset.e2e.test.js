import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { createBisetHarness } from '../helpers/biset-e2e.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';
import { prisma } from '../../src/db.js';
import { SupersetConstraints, SupersetMessageCode } from '../../src/constants/training.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const ROUND_REST = 75;
const UPDATED_REST = 30;
const EXERCISE_NAMES = ['A', 'B', 'C', 'D'];
const VALIDATION_MESSAGE_CODE = 'validation.failed';
const TEMPLATE_NOT_FOUND = 'TEMPLATE_NOT_FOUND';
const NOT_TEMPLATE_OWNER = 'FORBIDDEN_NOT_TEMPLATE_OWNER';

e2eDescribe('e2e: training template supersets', () => {
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

  async function setupTrainer() {
    const trainer = await h.createTrainer();
    await provisionTrainerPlan(trainer.trainerId);
    return trainer;
  }

  function auth(token) {
    return { authorization: `Bearer ${token}` };
  }

  async function createExerciseTemplate(token, name) {
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/exercise-templates',
      headers: auth(token),
      payload: { name, type: 'strength' },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  // why: creates a template with one ungrouped junction per name, in order; returns junction ids by name.
  async function createTemplate(token, names = EXERCISE_NAMES) {
    const exerciseTemplates = [];
    for (const [order, name] of names.entries()) {
      const library = await createExerciseTemplate(token, name);
      exerciseTemplates.push({ exerciseTemplateId: library.id, order, sets: 3 });
    }
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/training-templates',
      headers: auth(token),
      payload: { name: 'Template', category: 'strength', exerciseTemplates },
    });
    expect(response.statusCode).toBe(201);
    const template = response.json();
    const ids = Object.fromEntries(template.trainingTemplateExerciseTemplates.map((j) => [j.name, j.id]));
    return { template, ids };
  }

  function postSuperset(token, templateId, payload) {
    return app.inject({
      method: 'POST',
      url: `/trainer/training-templates/${templateId}/supersets`,
      headers: auth(token),
      payload,
    });
  }

  function patchSuperset(token, templateId, groupId, payload) {
    return app.inject({
      method: 'PATCH',
      url: `/trainer/training-templates/${templateId}/supersets/${groupId}`,
      headers: auth(token),
      payload,
    });
  }

  function deleteSuperset(token, templateId, groupId) {
    return app.inject({
      method: 'DELETE',
      url: `/trainer/training-templates/${templateId}/supersets/${groupId}`,
      headers: auth(token),
    });
  }

  function deleteJunction(token, templateId, junctionId) {
    return app.inject({
      method: 'DELETE',
      url: `/trainer/training-templates/${templateId}/exercises/${junctionId}`,
      headers: auth(token),
    });
  }

  async function getTemplate(token, templateId) {
    const response = await app.inject({
      method: 'GET',
      url: `/trainer/training-templates/${templateId}`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  async function dbRows(templateId) {
    return prisma.trainingTemplateExerciseTemplate.findMany({
      where: { trainingTemplateId: templateId },
      orderBy: { order: 'asc' },
    });
  }

  function junctionsOf(template) {
    return template.trainingTemplateExerciseTemplates;
  }

  function expectErrorContract(body) {
    expect(body).toEqual(expect.objectContaining({
      error: expect.any(String),
      messageCode: expect.any(String),
      message: expect.any(String),
    }));
  }

  async function createGroup(token, templateId, exerciseIds, restInterval) {
    const payload = { exerciseIds };
    if (restInterval !== undefined) payload.restInterval = restInterval;
    const response = await postSuperset(token, templateId, payload);
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  describe('POST /trainer/training-templates/:templateId/supersets (criterion 1)', () => {
    it('returns 201 with the updated template where members share a new group id and carry order and rest', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);

      const response = await postSuperset(trainer.accessToken, template.id, { exerciseIds: [ids.A, ids.B], restInterval: ROUND_REST });

      expect(response.statusCode).toBe(201);
      const [a, b, c, d] = junctionsOf(response.json());
      expect(response.json().id).toBe(template.id);
      expect(a.supersetGroupId).toBeTruthy();
      expect(b.supersetGroupId).toBe(a.supersetGroupId);
      expect([a.supersetOrder, b.supersetOrder]).toEqual([0, 1]);
      expect([a.supersetRestInterval, b.supersetRestInterval]).toEqual([ROUND_REST, ROUND_REST]);
      expect([c.supersetGroupId, d.supersetGroupId]).toEqual([null, null]);
    });

    it('has the same shape as GET /trainer/training-templates/:id', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);

      const response = await postSuperset(trainer.accessToken, template.id, { exerciseIds: [ids.A, ids.B] });

      const fetched = await getTemplate(trainer.accessToken, template.id);
      expect(response.json()).toEqual(fetched);
    });

    it('persists the grouping in the database', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);

      await createGroup(trainer.accessToken, template.id, [ids.A, ids.B], ROUND_REST);

      const rows = await dbRows(template.id);
      expect(rows[0].supersetGroupId).toBe(rows[1].supersetGroupId);
      expect(rows[0].supersetGroupId).not.toBeNull();
      expect(rows[0].supersetRestInterval).toBe(ROUND_REST);
    });

    it('stores a null supersetRestInterval when restInterval is omitted', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);

      const updated = await createGroup(trainer.accessToken, template.id, [ids.A, ids.B]);

      expect(junctionsOf(updated)[0].supersetRestInterval).toBeNull();
    });

    it('accepts an explicit null restInterval', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);

      const response = await postSuperset(trainer.accessToken, template.id, { exerciseIds: [ids.A, ids.B], restInterval: null });

      expect(response.statusCode).toBe(201);
      expect(junctionsOf(response.json())[0].supersetRestInterval).toBeNull();
    });

    it('assigns supersetOrder in request order', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);

      const updated = await createGroup(trainer.accessToken, template.id, [ids.B, ids.A]);

      const byName = Object.fromEntries(junctionsOf(updated).map((j) => [j.name, j]));
      expect([byName.B.supersetOrder, byName.A.supersetOrder]).toEqual([0, 1]);
    });

    it('makes non-adjacent members contiguous and keeps the other exercises in relative order', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);

      const updated = await createGroup(trainer.accessToken, template.id, [ids.A, ids.C]);

      expect(junctionsOf(updated).map((j) => [j.name, j.order])).toEqual([['A', 0], ['C', 1], ['B', 2], ['D', 3]]);
    });

    it('places the block at the position of the first member in current order', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);

      const updated = await createGroup(trainer.accessToken, template.id, [ids.D, ids.B]);

      expect(junctionsOf(updated).map((j) => j.name)).toEqual(['A', 'D', 'B', 'C']);
    });

    it('supports the maximum number of members', async () => {
      const trainer = await setupTrainer();
      const names = Array.from({ length: SupersetConstraints.MAX_MEMBERS }, (_, i) => `M${i}`);
      const { template, ids } = await createTemplate(trainer.accessToken, names);

      const updated = await createGroup(trainer.accessToken, template.id, names.map((n) => ids[n]));

      expect(new Set(junctionsOf(updated).map((j) => j.supersetGroupId)).size).toBe(1);
    });

    it('can create a second group alongside the first', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);
      await createGroup(trainer.accessToken, template.id, [ids.A, ids.B]);

      const updated = await createGroup(trainer.accessToken, template.id, [ids.C, ids.D]);

      const groups = new Set(junctionsOf(updated).map((j) => j.supersetGroupId));
      expect(groups.size).toBe(2);
    });
  });

  describe('POST validation (criterion 2)', () => {
    async function expectNothingGrouped(token, templateId) {
      const rows = await dbRows(templateId);
      expect(rows.every((r) => r.supersetGroupId === null)).toBe(true);
    }

    it('rejects a single exercise id with 400 and writes nothing', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);

      const response = await postSuperset(trainer.accessToken, template.id, { exerciseIds: [ids.A] });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('VALIDATION_ERROR');
      expect([VALIDATION_MESSAGE_CODE, SupersetMessageCode.MIN_MEMBERS]).toContain(response.json().messageCode);
      await expectNothingGrouped(trainer.accessToken, template.id);
    });

    it('rejects an empty exerciseIds array with 400', async () => {
      const trainer = await setupTrainer();
      const { template } = await createTemplate(trainer.accessToken);

      const response = await postSuperset(trainer.accessToken, template.id, { exerciseIds: [] });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('VALIDATION_ERROR');
    });

    it('rejects more than the maximum number of ids with 400 and writes nothing', async () => {
      const trainer = await setupTrainer();
      const names = Array.from({ length: SupersetConstraints.MAX_MEMBERS + 1 }, (_, i) => `M${i}`);
      const { template, ids } = await createTemplate(trainer.accessToken, names);

      const response = await postSuperset(trainer.accessToken, template.id, { exerciseIds: names.map((n) => ids[n]) });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('VALIDATION_ERROR');
      expect([VALIDATION_MESSAGE_CODE, SupersetMessageCode.MAX_MEMBERS]).toContain(response.json().messageCode);
      await expectNothingGrouped(trainer.accessToken, template.id);
    });

    it('rejects a non-uuid id with validation.failed', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);

      const response = await postSuperset(trainer.accessToken, template.id, { exerciseIds: [ids.A, 'not-a-uuid'] });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: VALIDATION_MESSAGE_CODE });
    });

    it('rejects a negative restInterval with validation.failed', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);

      const response = await postSuperset(trainer.accessToken, template.id, { exerciseIds: [ids.A, ids.B], restInterval: -1 });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: VALIDATION_MESSAGE_CODE });
    });

    it('rejects an id that is not in the template with supersetMembershipInvalid and writes nothing', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);

      const response = await postSuperset(trainer.accessToken, template.id, { exerciseIds: [ids.A, randomUUID()] });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: SupersetMessageCode.MEMBERSHIP_INVALID });
      await expectNothingGrouped(trainer.accessToken, template.id);
    });

    it('rejects an id that belongs to another template of the same trainer with supersetMembershipInvalid', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);
      const { ids: otherIds } = await createTemplate(trainer.accessToken);

      const response = await postSuperset(trainer.accessToken, template.id, { exerciseIds: [ids.A, otherIds.A] });

      expect(response.statusCode).toBe(400);
      expect(response.json().messageCode).toBe(SupersetMessageCode.MEMBERSHIP_INVALID);
    });

    it('rejects a member already in a group with alreadyInSuperset and keeps the first group intact', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);
      const first = await createGroup(trainer.accessToken, template.id, [ids.A, ids.B], ROUND_REST);

      const response = await postSuperset(trainer.accessToken, template.id, { exerciseIds: [ids.B, ids.C] });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
      expect(response.json().messageCode).toBe(SupersetMessageCode.ALREADY_IN_SUPERSET);
      expectErrorContract(response.json());
      expect(await getTemplate(trainer.accessToken, template.id)).toEqual(first);
    });
  });

  describe('ownership and auth (criterion 3)', () => {
    it('returns 404 TEMPLATE_NOT_FOUND for POST on a missing template', async () => {
      const trainer = await setupTrainer();

      const response = await postSuperset(trainer.accessToken, randomUUID(), { exerciseIds: [randomUUID(), randomUUID()] });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe(TEMPLATE_NOT_FOUND);
      expectErrorContract(response.json());
    });

    it('returns 403 FORBIDDEN_NOT_TEMPLATE_OWNER for POST on another trainer template and writes nothing', async () => {
      const owner = await setupTrainer();
      const intruder = await setupTrainer();
      const { template, ids } = await createTemplate(owner.accessToken);

      const response = await postSuperset(intruder.accessToken, template.id, { exerciseIds: [ids.A, ids.B] });

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe(NOT_TEMPLATE_OWNER);
      expect((await dbRows(template.id)).every((r) => r.supersetGroupId === null)).toBe(true);
    });

    it('returns 403 FORBIDDEN_NOT_TEMPLATE_OWNER for PATCH on another trainer template', async () => {
      const owner = await setupTrainer();
      const intruder = await setupTrainer();
      const { template, ids } = await createTemplate(owner.accessToken);
      const updated = await createGroup(owner.accessToken, template.id, [ids.A, ids.B], ROUND_REST);

      const response = await patchSuperset(intruder.accessToken, template.id, junctionsOf(updated)[0].supersetGroupId, { restInterval: UPDATED_REST });

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe(NOT_TEMPLATE_OWNER);
    });

    it('returns 403 FORBIDDEN_NOT_TEMPLATE_OWNER for DELETE on another trainer template and keeps the group', async () => {
      const owner = await setupTrainer();
      const intruder = await setupTrainer();
      const { template, ids } = await createTemplate(owner.accessToken);
      const updated = await createGroup(owner.accessToken, template.id, [ids.A, ids.B], ROUND_REST);

      const response = await deleteSuperset(intruder.accessToken, template.id, junctionsOf(updated)[0].supersetGroupId);

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe(NOT_TEMPLATE_OWNER);
      expect(await getTemplate(owner.accessToken, template.id)).toEqual(updated);
    });

    it('returns 401 without a token on POST', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/trainer/training-templates/${randomUUID()}/supersets`,
        payload: { exerciseIds: [randomUUID(), randomUUID()] },
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 401 without a token on PATCH', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/trainer/training-templates/${randomUUID()}/supersets/${randomUUID()}`,
        payload: { restInterval: UPDATED_REST },
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 401 without a token on DELETE', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/trainer/training-templates/${randomUUID()}/supersets/${randomUUID()}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 403 for a student token on POST', async () => {
      const student = await h.createStudent();

      const response = await postSuperset(student.accessToken, randomUUID(), { exerciseIds: [randomUUID(), randomUUID()] });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('PATCH /trainer/training-templates/:templateId/supersets/:groupId (criterion 4)', () => {
    async function templateWithTwoGroups(token) {
      const { template, ids } = await createTemplate(token);
      await createGroup(token, template.id, [ids.A, ids.B], ROUND_REST);
      const updated = await createGroup(token, template.id, [ids.C, ids.D], ROUND_REST);
      const [a, , c] = junctionsOf(updated);
      return { template, firstGroupId: a.supersetGroupId, secondGroupId: c.supersetGroupId };
    }

    it('returns 200 with every member of the group on the new rest', async () => {
      const trainer = await setupTrainer();
      const { template, firstGroupId } = await templateWithTwoGroups(trainer.accessToken);

      const response = await patchSuperset(trainer.accessToken, template.id, firstGroupId, { restInterval: UPDATED_REST });

      expect(response.statusCode).toBe(200);
      const members = junctionsOf(response.json()).filter((j) => j.supersetGroupId === firstGroupId);
      expect(members.map((m) => m.supersetRestInterval)).toEqual([UPDATED_REST, UPDATED_REST]);
    });

    it('does not change the other group', async () => {
      const trainer = await setupTrainer();
      const { template, firstGroupId, secondGroupId } = await templateWithTwoGroups(trainer.accessToken);

      const response = await patchSuperset(trainer.accessToken, template.id, firstGroupId, { restInterval: UPDATED_REST });

      const others = junctionsOf(response.json()).filter((j) => j.supersetGroupId === secondGroupId);
      expect(others.map((m) => m.supersetRestInterval)).toEqual([ROUND_REST, ROUND_REST]);
    });

    it('persists the new rest in the database', async () => {
      const trainer = await setupTrainer();
      const { template, firstGroupId } = await templateWithTwoGroups(trainer.accessToken);

      await patchSuperset(trainer.accessToken, template.id, firstGroupId, { restInterval: UPDATED_REST });

      const rows = (await dbRows(template.id)).filter((r) => r.supersetGroupId === firstGroupId);
      expect(rows.map((r) => r.supersetRestInterval)).toEqual([UPDATED_REST, UPDATED_REST]);
    });

    it('clears the rest when restInterval is null', async () => {
      const trainer = await setupTrainer();
      const { template, firstGroupId } = await templateWithTwoGroups(trainer.accessToken);

      const response = await patchSuperset(trainer.accessToken, template.id, firstGroupId, { restInterval: null });

      expect(response.statusCode).toBe(200);
      expect(junctionsOf(response.json())[0].supersetRestInterval).toBeNull();
    });

    it('accepts a rest of zero', async () => {
      const trainer = await setupTrainer();
      const { template, firstGroupId } = await templateWithTwoGroups(trainer.accessToken);

      const response = await patchSuperset(trainer.accessToken, template.id, firstGroupId, { restInterval: 0 });

      expect(junctionsOf(response.json())[0].supersetRestInterval).toBe(0);
    });

    it('rejects a negative rest with validation.failed', async () => {
      const trainer = await setupTrainer();
      const { template, firstGroupId } = await templateWithTwoGroups(trainer.accessToken);

      const response = await patchSuperset(trainer.accessToken, template.id, firstGroupId, { restInterval: -5 });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: VALIDATION_MESSAGE_CODE });
    });

    it('returns 404 supersetGroupNotFound for an unknown group', async () => {
      const trainer = await setupTrainer();
      const { template } = await createTemplate(trainer.accessToken);

      const response = await patchSuperset(trainer.accessToken, template.id, randomUUID(), { restInterval: UPDATED_REST });

      expect(response.statusCode).toBe(404);
      expect(response.json().messageCode).toBe(SupersetMessageCode.GROUP_NOT_FOUND);
      expectErrorContract(response.json());
    });

    it('returns 404 supersetGroupNotFound for a group that lives in another template', async () => {
      const trainer = await setupTrainer();
      const { template: first } = await templateWithTwoGroups(trainer.accessToken);
      const { template: second, firstGroupId } = await templateWithTwoGroups(trainer.accessToken);

      const response = await patchSuperset(trainer.accessToken, first.id, firstGroupId, { restInterval: UPDATED_REST });

      expect(response.statusCode).toBe(404);
      expect(response.json().messageCode).toBe(SupersetMessageCode.GROUP_NOT_FOUND);
      expect((await dbRows(second.id)).filter((r) => r.supersetGroupId === firstGroupId).map((r) => r.supersetRestInterval))
        .toEqual([ROUND_REST, ROUND_REST]);
    });
  });

  describe('DELETE /trainer/training-templates/:templateId/supersets/:groupId (criterion 5)', () => {
    it('returns 200 with members ungrouped, supersetOrder 0 and no rest', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);
      const created = await createGroup(trainer.accessToken, template.id, [ids.A, ids.B], ROUND_REST);

      const response = await deleteSuperset(trainer.accessToken, template.id, junctionsOf(created)[0].supersetGroupId);

      expect(response.statusCode).toBe(200);
      expect(junctionsOf(response.json()).map((j) => [j.supersetGroupId, j.supersetOrder, j.supersetRestInterval]))
        .toEqual(Array(EXERCISE_NAMES.length).fill([null, 0, null]));
    });

    it('keeps every exercise in the template', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);
      const created = await createGroup(trainer.accessToken, template.id, [ids.A, ids.B], ROUND_REST);

      await deleteSuperset(trainer.accessToken, template.id, junctionsOf(created)[0].supersetGroupId);

      expect((await dbRows(template.id)).map((r) => r.id).sort()).toEqual(Object.values(ids).sort());
    });

    it('does not affect another group', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);
      const firstState = await createGroup(trainer.accessToken, template.id, [ids.A, ids.B], ROUND_REST);
      const secondState = await createGroup(trainer.accessToken, template.id, [ids.C, ids.D], ROUND_REST);
      const secondGroupId = junctionsOf(secondState)[2].supersetGroupId;

      const response = await deleteSuperset(trainer.accessToken, template.id, junctionsOf(firstState)[0].supersetGroupId);

      const remaining = junctionsOf(response.json()).filter((j) => j.supersetGroupId === secondGroupId);
      expect(remaining.map((j) => j.supersetOrder)).toEqual([0, 1]);
    });

    it('returns 404 supersetGroupNotFound for an unknown group', async () => {
      const trainer = await setupTrainer();
      const { template } = await createTemplate(trainer.accessToken);

      const response = await deleteSuperset(trainer.accessToken, template.id, randomUUID());

      expect(response.statusCode).toBe(404);
      expect(response.json().messageCode).toBe(SupersetMessageCode.GROUP_NOT_FOUND);
      expectErrorContract(response.json());
    });

    it('returns 404 supersetGroupNotFound when dissolving the same group twice', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);
      const created = await createGroup(trainer.accessToken, template.id, [ids.A, ids.B]);
      const groupId = junctionsOf(created)[0].supersetGroupId;
      await deleteSuperset(trainer.accessToken, template.id, groupId);

      const response = await deleteSuperset(trainer.accessToken, template.id, groupId);

      expect(response.statusCode).toBe(404);
      expect(response.json().messageCode).toBe(SupersetMessageCode.GROUP_NOT_FOUND);
    });
  });

  describe('DELETE /trainer/training-templates/:tid/exercises/:eid on a member (criterion 6)', () => {
    it('ungroups the survivor when a group of two loses a member', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);
      await createGroup(trainer.accessToken, template.id, [ids.A, ids.B], ROUND_REST);

      const response = await deleteJunction(trainer.accessToken, template.id, ids.A);

      expect(response.statusCode).toBe(200);
      const survivor = (await dbRows(template.id)).find((r) => r.id === ids.B);
      expect(survivor).toMatchObject({ supersetGroupId: null, supersetOrder: 0, supersetRestInterval: null });
    });

    it('keeps the group and renumbers supersetOrder 0..1 when a group of three loses a member', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);
      const created = await createGroup(trainer.accessToken, template.id, [ids.A, ids.B, ids.C], ROUND_REST);
      const groupId = junctionsOf(created)[0].supersetGroupId;

      const response = await deleteJunction(trainer.accessToken, template.id, ids.A);

      expect(response.statusCode).toBe(200);
      const members = (await dbRows(template.id)).filter((r) => r.supersetGroupId === groupId);
      expect(members.map((r) => [r.id, r.supersetOrder, r.supersetRestInterval])).toEqual([[ids.B, 0, ROUND_REST], [ids.C, 1, ROUND_REST]]);
    });

    it('renumbers when the middle member of a group of three is removed', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);
      await createGroup(trainer.accessToken, template.id, [ids.A, ids.B, ids.C]);

      await deleteJunction(trainer.accessToken, template.id, ids.B);

      const grouped = (await dbRows(template.id)).filter((r) => r.supersetGroupId !== null);
      expect(grouped.map((r) => [r.id, r.supersetOrder])).toEqual([[ids.A, 0], [ids.C, 1]]);
    });

    it('leaves the response shape of the delete unchanged', async () => {
      const trainer = await setupTrainer();
      const { template, ids } = await createTemplate(trainer.accessToken);
      await createGroup(trainer.accessToken, template.id, [ids.A, ids.B]);

      const response = await deleteJunction(trainer.accessToken, template.id, ids.A);

      expect(response.statusCode).toBe(200);
      expect(response.json().id).toBe(ids.A);
    });
  });

  describe('imports keep groups made through the endpoint (criterion 7)', () => {
    async function groupedTemplate(token) {
      const { template, ids } = await createTemplate(token);
      const created = await createGroup(token, template.id, [ids.A, ids.C], ROUND_REST);
      return { template, groupId: junctionsOf(created)[0].supersetGroupId };
    }

    async function exercisesOf(trainingId) {
      return prisma.exercise.findMany({ where: { trainingId }, orderBy: { order: 'asc' } });
    }

    it('training from-template keeps grouping, order and rest with a fresh group id', async () => {
      const ctx = await h.setupTraining();
      await provisionTrainerPlan(ctx.trainer.trainerId);
      const { template, groupId } = await groupedTemplate(ctx.trainer.accessToken);

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/trainings/from-template',
        headers: auth(ctx.trainer.accessToken),
        payload: { protocolId: ctx.protocolId, templateId: template.id },
      });

      expect(response.statusCode).toBe(201);
      const imported = await exercisesOf(response.json().id);
      expect(imported.map((r) => [r.name, r.supersetOrder, r.supersetRestInterval])).toEqual([
        ['A', 0, ROUND_REST],
        ['C', 1, ROUND_REST],
        ['B', 0, null],
        ['D', 0, null],
      ]);
      expect(imported[0].supersetGroupId).toBeTruthy();
      expect(imported[0].supersetGroupId).not.toBe(groupId);
      expect(imported[1].supersetGroupId).toBe(imported[0].supersetGroupId);
      expect([imported[2].supersetGroupId, imported[3].supersetGroupId]).toEqual([null, null]);
    });

    it('protocol import-from-template keeps grouping and rest with a fresh group id', async () => {
      const trainer = await setupTrainer();
      const student = await h.createStudent();
      await h.linkStudent(trainer.trainerId, student.userId);
      const { template, groupId } = await groupedTemplate(trainer.accessToken);
      const protocolTemplate = await app.inject({
        method: 'POST',
        url: '/trainer/protocol-templates',
        headers: auth(trainer.accessToken),
        payload: { name: 'Protocol Template', trainings: [{ trainingTemplateId: template.id, weekDay: 'monday', order: 0 }] },
      });
      expect(protocolTemplate.statusCode).toBe(201);

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/import-from-template',
        headers: auth(trainer.accessToken),
        payload: { templateId: protocolTemplate.json().id, assigneeId: student.userId, startDate: '2026-03-01' },
      });

      expect(response.statusCode).toBe(201);
      const imported = await exercisesOf(response.json().trainings[0].id);
      expect(imported.map((r) => [r.supersetOrder, r.supersetRestInterval])).toEqual([[0, ROUND_REST], [1, ROUND_REST], [0, null], [0, null]]);
      expect(imported[0].supersetGroupId).toBeTruthy();
      expect(imported[0].supersetGroupId).not.toBe(groupId);
      expect(imported[1].supersetGroupId).toBe(imported[0].supersetGroupId);
    });
  });
});
