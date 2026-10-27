import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import { bearer, createAdvancedTechniqueFixtures } from '../helpers/advanced-technique-e2e.js';
import {
  AdvancedTechniqueErrorCode,
  AdvancedTechniqueMessageCode,
} from '../../src/constants/advanced-technique.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const SYSTEM_TECHNIQUES = [
  { key: 'drop_set', name: 'Drop set' },
  { key: 'rest_pause', name: 'Rest-pause' },
  { key: 'cluster_set', name: 'Cluster set' },
  { key: 'peak_contraction', name: 'Pico de contração' },
];
const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const ITEM_KEYS = [
  'id', 'key', 'name', 'description', 'videoUrl', 'gifUrl', 'isSystem', 'trainerId', 'createdAt', 'updatedAt',
];

e2eDescribe('e2e: advanced techniques library', () => {
  let app;
  let fx;

  beforeAll(async () => {
    app = await setupApp();
    fx = createAdvancedTechniqueFixtures(app);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  function list(token, query = '') {
    return app.inject({ method: 'GET', url: `/trainer/advanced-techniques${query}`, headers: bearer(token) });
  }

  function expectErrorContract(response, { status, error, messageCode }) {
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error, messageCode });
    expect(response.json()).toHaveProperty('message');
    expect(response.json()).toHaveProperty('details');
  }


  describe('system techniques seeded by migration', () => {
    it('should have exactly the 4 system techniques with stable keys and names', async () => {
      const rows = await prisma.advancedTechnique.findMany({ where: { trainerId: null } });

      expect(rows.map((r) => ({ key: r.key, name: r.name })).sort((a, b) => a.key.localeCompare(b.key))).toEqual(
        [...SYSTEM_TECHNIQUES].sort((a, b) => a.key.localeCompare(b.key)),
      );
    });

    it('should give every system technique a non-empty description and no soft-delete', async () => {
      const rows = await prisma.advancedTechnique.findMany({ where: { trainerId: null } });

      for (const row of rows) {
        expect(row.description.trim().length).toBeGreaterThan(0);
        expect(row.deletedAt).toBeNull();
      }
    });

    it('should not allow two rows with the same key', async () => {
      await expect(
        prisma.advancedTechnique.create({
          data: { trainerId: null, key: 'drop_set', name: 'Dup', description: 'Dup' },
        }),
      ).rejects.toThrow();
    });
  });


  describe('GET /trainer/advanced-techniques', () => {
    it('should return 401 when unauthenticated', async () => {
      const response = await app.inject({ method: 'GET', url: '/trainer/advanced-techniques' });

      expect(response.statusCode).toBe(401);
    });

    it('should return 403 for a non-trainer user', async () => {
      const { accessToken } = await fx.createStudent();

      const response = await list(accessToken);

      expect(response.statusCode).toBe(403);
    });

    it('should return the paginated envelope with the system techniques for a new trainer', async () => {
      const { accessToken } = await fx.createTrainer();

      const response = await list(accessToken);

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({ total: 4, page: 1, limit: 20 });
      expect(body.data).toHaveLength(4);
      for (const item of body.data) {
        expect(Object.keys(item).sort()).toEqual([...ITEM_KEYS].sort());
        expect(item).toMatchObject({ isSystem: true, trainerId: null });
        expect(item.key).toBeTruthy();
      }
    });

    it('should include own techniques flagged isSystem false with the trainer id', async () => {
      const trainer = await fx.createTrainer();
      const own = await fx.createTechnique(trainer.accessToken, { name: 'Myo-reps' });

      const { data, total } = (await list(trainer.accessToken)).json();

      expect(total).toBe(5);
      expect(data.find((item) => item.id === own.id)).toMatchObject({
        isSystem: false,
        key: null,
        trainerId: trainer.trainerId,
        name: 'Myo-reps',
      });
    });

    it("should never return another trainer's private techniques", async () => {
      const trainerA = await fx.createTrainer();
      const trainerB = await fx.createTrainer();
      await fx.createTechnique(trainerA.accessToken, { name: 'Secret A' });

      const { data, total } = (await list(trainerB.accessToken)).json();

      expect(total).toBe(4);
      expect(data.map((item) => item.name)).not.toContain('Secret A');
    });

    it('should hide soft-deleted techniques', async () => {
      const trainer = await fx.createTrainer();
      const own = await fx.createTechnique(trainer.accessToken, { name: 'To delete' });
      await fx.deleteTechnique(trainer.accessToken, own.id);

      const { data } = (await list(trainer.accessToken)).json();

      expect(data.map((item) => item.id)).not.toContain(own.id);
    });

    it('should filter by q case-insensitively on the name', async () => {
      const trainer = await fx.createTrainer();
      await fx.createTechnique(trainer.accessToken, { name: 'Myo-reps' });

      const { data, total } = (await list(trainer.accessToken, '?q=DROP')).json();

      expect(total).toBe(1);
      expect(data[0]).toMatchObject({ key: 'drop_set', name: 'Drop set' });
    });

    it('should page results with page and limit', async () => {
      const trainer = await fx.createTrainer();

      const page2 = (await list(trainer.accessToken, '?page=2&limit=3')).json();

      expect(page2).toMatchObject({ page: 2, limit: 3, total: 4 });
      expect(page2.data).toHaveLength(1);
    });
  });


  describe('GET /trainer/advanced-techniques/:id', () => {
    it('should return a system technique', async () => {
      const trainer = await fx.createTrainer();
      const system = await fx.systemTechniqueByKey('drop_set');

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/advanced-techniques/${system.id}`,
        headers: bearer(trainer.accessToken),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: system.id, key: 'drop_set', isSystem: true, trainerId: null });
    });

    it('should return an own technique', async () => {
      const trainer = await fx.createTrainer();
      const own = await fx.createTechnique(trainer.accessToken);

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/advanced-techniques/${own.id}`,
        headers: bearer(trainer.accessToken),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: own.id, isSystem: false });
    });

    it("should return 404 ADVANCED_TECHNIQUE_NOT_FOUND for another trainer's private technique", async () => {
      const trainerA = await fx.createTrainer();
      const trainerB = await fx.createTrainer();
      const own = await fx.createTechnique(trainerA.accessToken);

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/advanced-techniques/${own.id}`,
        headers: bearer(trainerB.accessToken),
      });

      expectErrorContract(response, {
        status: 404,
        error: AdvancedTechniqueErrorCode.NOT_FOUND,
        messageCode: AdvancedTechniqueMessageCode.NOT_FOUND,
      });
    });

    it('should return 404 ADVANCED_TECHNIQUE_NOT_FOUND for a missing id', async () => {
      const trainer = await fx.createTrainer();

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/advanced-techniques/${MISSING_ID}`,
        headers: bearer(trainer.accessToken),
      });

      expectErrorContract(response, {
        status: 404,
        error: AdvancedTechniqueErrorCode.NOT_FOUND,
        messageCode: AdvancedTechniqueMessageCode.NOT_FOUND,
      });
    });

    it('should return 404 for a soft-deleted technique', async () => {
      const trainer = await fx.createTrainer();
      const own = await fx.createTechnique(trainer.accessToken);
      await fx.deleteTechnique(trainer.accessToken, own.id);

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/advanced-techniques/${own.id}`,
        headers: bearer(trainer.accessToken),
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return a translated message in en-US and pt-BR with the same messageCode', async () => {
      const trainer = await fx.createTrainer();
      const url = `/trainer/advanced-techniques/${MISSING_ID}`;

      const en = await app.inject({ method: 'GET', url, headers: { ...bearer(trainer.accessToken), 'app-language': 'en-US' } });
      const pt = await app.inject({ method: 'GET', url, headers: { ...bearer(trainer.accessToken), 'app-language': 'pt-BR' } });

      expect(en.json().messageCode).toBe(AdvancedTechniqueMessageCode.NOT_FOUND);
      expect(pt.json().messageCode).toBe(AdvancedTechniqueMessageCode.NOT_FOUND);
      expect(en.json().message).not.toBe(pt.json().message);
    });
  });


  describe('POST /trainer/advanced-techniques', () => {
    function create(token, payload) {
      return app.inject({ method: 'POST', url: '/trainer/advanced-techniques', headers: bearer(token), payload });
    }

    it('should return 401 when unauthenticated', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/trainer/advanced-techniques',
        payload: { name: 'X', description: 'Y' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 403 for a non-trainer user', async () => {
      const { accessToken } = await fx.createStudent();

      const response = await create(accessToken, { name: 'X', description: 'Y' });

      expect(response.statusCode).toBe(403);
    });

    it('should create a technique owned by the trainer with null media', async () => {
      const trainer = await fx.createTrainer();

      const response = await create(trainer.accessToken, { name: 'Myo-reps', description: 'Activation + mini-sets' });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        name: 'Myo-reps',
        description: 'Activation + mini-sets',
        key: null,
        videoUrl: null,
        gifUrl: null,
        isSystem: false,
        trainerId: trainer.trainerId,
      });
      expect(response.json().id).toEqual(expect.any(String));
    });

    it('should persist videoUrl and gifUrl', async () => {
      const trainer = await fx.createTrainer();

      const response = await create(trainer.accessToken, {
        name: 'Myo-reps',
        description: 'desc',
        videoUrl: 'https://youtu.be/abc123',
        gifUrl: 'https://example.com/myo.gif',
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        videoUrl: 'https://youtu.be/abc123',
        gifUrl: 'https://example.com/myo.gif',
      });
    });

    it('should trim the name', async () => {
      const trainer = await fx.createTrainer();

      const response = await create(trainer.accessToken, { name: '  Myo-reps  ', description: 'desc' });

      expect(response.statusCode).toBe(201);
      expect(response.json().name).toBe('Myo-reps');
    });

    it('should accept the boundary lengths (name 80, description 600)', async () => {
      const trainer = await fx.createTrainer();

      const response = await create(trainer.accessToken, { name: 'n'.repeat(80), description: 'd'.repeat(600) });

      expect(response.statusCode).toBe(201);
    });

    it.each([
      ['missing name', { description: 'desc' }],
      ['missing description', { name: 'Name' }],
      ['empty name', { name: '', description: 'desc' }],
      ['whitespace-only name', { name: '   ', description: 'desc' }],
      ['name over 80 chars', { name: 'n'.repeat(81), description: 'desc' }],
      ['empty description', { name: 'Name', description: '' }],
      ['description over 600 chars', { name: 'Name', description: 'd'.repeat(601) }],
      ['gifUrl that is not http(s)', { name: 'Name', description: 'desc', gifUrl: 'ftp://x/y.gif' }],
      ['gifUrl with whitespace', { name: 'Name', description: 'desc', gifUrl: 'https://x/a b.gif' }],
      ['gifUrl over 2048 chars', { name: 'Name', description: 'desc', gifUrl: `https://x/${'a'.repeat(2048)}` }],
    ])('should return 400 validation.failed for %s', async (_label, payload) => {
      const trainer = await fx.createTrainer();

      const response = await create(trainer.accessToken, payload);

      expectErrorContract(response, { status: 400, error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });
  });


  describe('PATCH /trainer/advanced-techniques/:id', () => {
    function patch(token, id, payload) {
      return app.inject({ method: 'PATCH', url: `/trainer/advanced-techniques/${id}`, headers: bearer(token), payload });
    }

    it('should update the provided fields of an own technique and keep the rest', async () => {
      const trainer = await fx.createTrainer();
      const own = await fx.createTechnique(trainer.accessToken, { name: 'Old', description: 'Keep me' });

      const response = await patch(trainer.accessToken, own.id, { name: 'New' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: own.id, name: 'New', description: 'Keep me' });
    });

    it('should set and then clear media with null', async () => {
      const trainer = await fx.createTrainer();
      const own = await fx.createTechnique(trainer.accessToken, { gifUrl: 'https://example.com/a.gif' });

      const cleared = await patch(trainer.accessToken, own.id, { gifUrl: null, videoUrl: 'https://youtu.be/xyz' });

      expect(cleared.statusCode).toBe(200);
      expect(cleared.json()).toMatchObject({ gifUrl: null, videoUrl: 'https://youtu.be/xyz' });
    });

    it('should return 400 validation.failed for an invalid name', async () => {
      const trainer = await fx.createTrainer();
      const own = await fx.createTechnique(trainer.accessToken);

      const response = await patch(trainer.accessToken, own.id, { name: 'n'.repeat(81) });

      expectErrorContract(response, { status: 400, error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('should return 403 ADVANCED_TECHNIQUE_FORBIDDEN for a system technique', async () => {
      const trainer = await fx.createTrainer();
      const system = await fx.systemTechniqueByKey('drop_set');

      const response = await patch(trainer.accessToken, system.id, { name: 'Hacked' });

      expectErrorContract(response, {
        status: 403,
        error: AdvancedTechniqueErrorCode.FORBIDDEN,
        messageCode: AdvancedTechniqueMessageCode.FORBIDDEN,
      });
      expect((await fx.systemTechniqueByKey('drop_set')).name).toBe('Drop set');
    });

    it("should return 404 ADVANCED_TECHNIQUE_NOT_FOUND for another trainer's technique", async () => {
      const trainerA = await fx.createTrainer();
      const trainerB = await fx.createTrainer();
      const own = await fx.createTechnique(trainerA.accessToken);

      const response = await patch(trainerB.accessToken, own.id, { name: 'Stolen' });

      expectErrorContract(response, {
        status: 404,
        error: AdvancedTechniqueErrorCode.NOT_FOUND,
        messageCode: AdvancedTechniqueMessageCode.NOT_FOUND,
      });
    });

    it('should return 404 for a soft-deleted technique', async () => {
      const trainer = await fx.createTrainer();
      const own = await fx.createTechnique(trainer.accessToken);
      await fx.deleteTechnique(trainer.accessToken, own.id);

      const response = await patch(trainer.accessToken, own.id, { name: 'Zombie' });

      expect(response.statusCode).toBe(404);
    });

    it('should return 401 when unauthenticated', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/trainer/advanced-techniques/${MISSING_ID}`,
        payload: { name: 'X' },
      });

      expect(response.statusCode).toBe(401);
    });
  });


  describe('DELETE /trainer/advanced-techniques/:id', () => {
    function remove(token, id) {
      return app.inject({ method: 'DELETE', url: `/trainer/advanced-techniques/${id}`, headers: bearer(token) });
    }

    it('should soft delete an own technique and return 200 with the deleted item', async () => {
      const trainer = await fx.createTrainer();
      const own = await fx.createTechnique(trainer.accessToken);

      const response = await remove(trainer.accessToken, own.id);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: own.id, name: own.name });
      const row = await prisma.advancedTechnique.findUnique({ where: { id: own.id } });
      expect(row.deletedAt).toBeInstanceOf(Date);
    });

    it('should return 403 ADVANCED_TECHNIQUE_FORBIDDEN for a system technique', async () => {
      const trainer = await fx.createTrainer();
      const system = await fx.systemTechniqueByKey('rest_pause');

      const response = await remove(trainer.accessToken, system.id);

      expectErrorContract(response, {
        status: 403,
        error: AdvancedTechniqueErrorCode.FORBIDDEN,
        messageCode: AdvancedTechniqueMessageCode.FORBIDDEN,
      });
      expect((await fx.systemTechniqueByKey('rest_pause')).deletedAt).toBeNull();
    });

    it("should return 404 ADVANCED_TECHNIQUE_NOT_FOUND for another trainer's technique", async () => {
      const trainerA = await fx.createTrainer();
      const trainerB = await fx.createTrainer();
      const own = await fx.createTechnique(trainerA.accessToken);

      const response = await remove(trainerB.accessToken, own.id);

      expectErrorContract(response, {
        status: 404,
        error: AdvancedTechniqueErrorCode.NOT_FOUND,
        messageCode: AdvancedTechniqueMessageCode.NOT_FOUND,
      });
    });

    it('should return 404 when deleting an already deleted technique', async () => {
      const trainer = await fx.createTrainer();
      const own = await fx.createTechnique(trainer.accessToken);
      await fx.deleteTechnique(trainer.accessToken, own.id);

      const response = await remove(trainer.accessToken, own.id);

      expect(response.statusCode).toBe(404);
    });

    it('should return 401 when unauthenticated', async () => {
      const response = await app.inject({ method: 'DELETE', url: `/trainer/advanced-techniques/${MISSING_ID}` });

      expect(response.statusCode).toBe(401);
    });
  });
});
