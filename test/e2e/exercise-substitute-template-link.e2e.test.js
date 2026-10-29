import 'dotenv/config';
import crypto from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import { bearer, createAdvancedTechniqueFixtures, techniqueIds } from '../helpers/advanced-technique-e2e.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: POST /trainer/exercises/:id/substitutes with exerciseTemplateId', () => {
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

  async function setup() {
    const trainer = await fx.createTrainer();
    const student = await fx.createStudent();
    const { trainingId } = await fx.createProtocolAndTraining(trainer, student.userId);
    const principal = await fx.createExercise(trainer.accessToken, trainingId);
    const a = await fx.createTechnique(trainer.accessToken, { name: 'Technique A' });
    const b = await fx.createTechnique(trainer.accessToken, { name: 'Technique B' });
    return { trainer, principal, a, b };
  }

  function addSubstitute(token, principalId, payload) {
    return app.inject({
      method: 'POST',
      url: `/trainer/exercises/${principalId}/substitutes`,
      headers: bearer(token),
      payload: { name: 'Leg Press', type: 'strength', sets: 3, ...payload },
    });
  }

  function createTemplateRow(trainerId, overrides = {}) {
    return prisma.exerciseTemplate.create({
      data: { trainerId, name: 'Leg Press', type: 'strength', isPublic: false, ...overrides },
    });
  }

  it('should link the substitute to the own template and not create a copy', async () => {
    const { trainer, principal } = await setup();
    const template = await fx.createExerciseTemplate(trainer.accessToken, { name: 'Hack Squat' });
    const before = await prisma.exerciseTemplate.count();

    const response = await addSubstitute(trainer.accessToken, principal.id, {
      name: 'Hack Squat',
      exerciseTemplateId: template.id,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().exerciseTemplateId).toBe(template.id);
    expect(await prisma.exerciseTemplate.count()).toBe(before);
  });

  it('should accept a public template of another trainer without copying it', async () => {
    const { trainer, principal } = await setup();
    const other = await fx.createTrainer();
    const template = await createTemplateRow(other.trainerId, { isPublic: true });
    const before = await prisma.exerciseTemplate.count();

    const response = await addSubstitute(trainer.accessToken, principal.id, { exerciseTemplateId: template.id });

    expect(response.statusCode).toBe(201);
    expect(response.json().exerciseTemplateId).toBe(template.id);
    expect(await prisma.exerciseTemplate.count()).toBe(before);
  });

  it('should return 403 FORBIDDEN_PRIVATE_TEMPLATE for a private template of another trainer', async () => {
    const { trainer, principal } = await setup();
    const other = await fx.createTrainer();
    const template = await createTemplateRow(other.trainerId);

    const response = await addSubstitute(trainer.accessToken, principal.id, { exerciseTemplateId: template.id });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('FORBIDDEN_PRIVATE_TEMPLATE');
  });

  it('should return 404 EXERCISE_TEMPLATE_NOT_FOUND for an unknown template', async () => {
    const { trainer, principal } = await setup();

    const response = await addSubstitute(trainer.accessToken, principal.id, { exerciseTemplateId: crypto.randomUUID() });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('EXERCISE_TEMPLATE_NOT_FOUND');
  });

  it('should return 404 EXERCISE_TEMPLATE_NOT_FOUND for a deleted template', async () => {
    const { trainer, principal } = await setup();
    const template = await createTemplateRow(trainer.trainerId, { deletedAt: new Date() });

    const response = await addSubstitute(trainer.accessToken, principal.id, { exerciseTemplateId: template.id });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('EXERCISE_TEMPLATE_NOT_FOUND');
  });

  it('should return 400 VALIDATION_ERROR for a non-uuid exerciseTemplateId', async () => {
    const { trainer, principal } = await setup();

    const response = await addSubstitute(trainer.accessToken, principal.id, { exerciseTemplateId: 'nope' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('VALIDATION_ERROR');
  });

  describe('media fallback', () => {
    it('should use the template media when videoUrl and gifUrl are absent', async () => {
      const { trainer, principal } = await setup();
      const template = await createTemplateRow(trainer.trainerId, {
        videoUrl: 'https://example.com/v.mp4',
        gifUrl: 'https://example.com/g.gif',
      });

      const response = await addSubstitute(trainer.accessToken, principal.id, { exerciseTemplateId: template.id });

      expect(response.json()).toMatchObject({ videoUrl: 'https://example.com/v.mp4', gifUrl: 'https://example.com/g.gif' });
    });

    it('should prefer explicit media over the template media', async () => {
      const { trainer, principal } = await setup();
      const template = await createTemplateRow(trainer.trainerId, {
        videoUrl: 'https://example.com/v.mp4',
        gifUrl: 'https://example.com/g.gif',
      });

      const response = await addSubstitute(trainer.accessToken, principal.id, {
        exerciseTemplateId: template.id,
        videoUrl: 'https://example.com/own.mp4',
      });

      expect(response.json()).toMatchObject({ videoUrl: 'https://example.com/own.mp4', gifUrl: 'https://example.com/g.gif' });
    });
  });

  describe('technique inheritance', () => {
    it("should inherit the template's techniques in order when advancedTechniqueIds is omitted", async () => {
      const { trainer, principal, a, b } = await setup();
      const template = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [b.id, a.id] });

      const response = await addSubstitute(trainer.accessToken, principal.id, { exerciseTemplateId: template.id });

      expect(response.statusCode).toBe(201);
      expect(techniqueIds(response.json().advancedTechniques)).toEqual([b.id, a.id]);
    });

    it('should drop deleted techniques and reindex when inheriting', async () => {
      const { trainer, principal, a, b } = await setup();
      const template = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [a.id, b.id] });
      await fx.deleteTechnique(trainer.accessToken, a.id);

      const response = await addSubstitute(trainer.accessToken, principal.id, { exerciseTemplateId: template.id });

      const techniques = response.json().advancedTechniques;
      expect(techniqueIds(techniques)).toEqual([b.id]);
      expect(techniques.map((t) => t.order)).toEqual([0]);
    });

    it("should drop another trainer's private techniques when inheriting from a public template", async () => {
      const { trainer, principal } = await setup();
      const other = await fx.createTrainer();
      const foreign = await fx.createTechnique(other.accessToken, { name: 'Foreign' });
      const template = await fx.createExerciseTemplate(other.accessToken, { advancedTechniqueIds: [foreign.id], isPublic: true });

      const response = await addSubstitute(trainer.accessToken, principal.id, { exerciseTemplateId: template.id });

      expect(response.statusCode).toBe(201);
      expect(response.json().advancedTechniques).toEqual([]);
    });

    it('should use the explicit list instead of inheriting', async () => {
      const { trainer, principal, a, b } = await setup();
      const template = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [a.id] });

      const response = await addSubstitute(trainer.accessToken, principal.id, {
        exerciseTemplateId: template.id,
        advancedTechniqueIds: [b.id],
      });

      expect(techniqueIds(response.json().advancedTechniques)).toEqual([b.id]);
    });

    it('should create no techniques when an empty list is sent', async () => {
      const { trainer, principal, a } = await setup();
      const template = await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [a.id] });

      const response = await addSubstitute(trainer.accessToken, principal.id, {
        exerciseTemplateId: template.id,
        advancedTechniqueIds: [],
      });

      expect(response.json().advancedTechniques).toEqual([]);
    });
  });

  describe('without exerciseTemplateId', () => {
    it('should keep the name+type library lookup and not inherit techniques', async () => {
      const { trainer, principal, a } = await setup();
      await fx.createExerciseTemplate(trainer.accessToken, { advancedTechniqueIds: [a.id] });
      const before = await prisma.exerciseTemplate.count();

      const response = await addSubstitute(trainer.accessToken, principal.id, {});

      expect(response.statusCode).toBe(201);
      expect(response.json().advancedTechniques).toEqual([]);
      expect(await prisma.exerciseTemplate.count()).toBe(before);
    });

    it('should create a private library template when none matches', async () => {
      const { trainer, principal } = await setup();

      const response = await addSubstitute(trainer.accessToken, principal.id, { name: 'Brand New Move' });

      expect(response.statusCode).toBe(201);
      const created = await prisma.exerciseTemplate.findUnique({ where: { id: response.json().exerciseTemplateId } });
      expect(created).toMatchObject({ name: 'Brand New Move', isPublic: false, trainerId: trainer.trainerId });
    });
  });
});
