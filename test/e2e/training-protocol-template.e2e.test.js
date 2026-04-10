import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: training protocol templates', () => {
  let app;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  async function createTrainerWithToken() {
    const email = `e2e+trainer-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupResponse = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupResponse.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupResponse.json();

    const becomeTrainerResponse = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(becomeTrainerResponse.statusCode).toBe(200);
    const { token: { accessToken: trainerToken } } = becomeTrainerResponse.json();

    return { userId, accessToken: trainerToken };
  }

  async function createAssigneeWithToken() {
    const email = `e2e+assignee-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupResponse = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupResponse.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupResponse.json();

    return { userId, accessToken };
  }

  async function createTrainingTemplate(accessToken, overrides = {}) {
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/training-templates',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        name: 'Bench Press',
        category: 'strength',
        bodySegment: 'upper',
        ...overrides,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  async function createProtocolTemplate(accessToken, payload) {
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/protocol-templates',
      headers: { authorization: `Bearer ${accessToken}` },
      payload,
    });
    return response;
  }

  // ==================== POST /trainer/protocol-templates ====================

  describe('POST /trainer/protocol-templates', () => {
    it('creates template without trainings', async () => {
      const { accessToken } = await createTrainerWithToken();

      const response = await createProtocolTemplate(accessToken, {
        name: 'Full Body Template',
        defaultDurationWeeks: 8,
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('name', 'Full Body Template');
      expect(body).toHaveProperty('trainings');
      expect(body.trainings).toHaveLength(0);
      expect(body).toHaveProperty('trainingsCount', 0);
    });

    it('creates template with trainings', async () => {
      const { accessToken } = await createTrainerWithToken();
      const trainingTemplate = await createTrainingTemplate(accessToken);

      const response = await createProtocolTemplate(accessToken, {
        name: 'Push Pull Legs',
        trainings: [
          { trainingTemplateId: trainingTemplate.id, weekDay: 'monday', order: 0 },
          { trainingTemplateId: trainingTemplate.id, weekDay: 'wednesday', order: 1 },
        ],
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.trainings).toHaveLength(2);
      expect(body.trainings[0]).toMatchObject({
        weekDay: 'monday',
        order: 0,
        trainingTemplate: expect.objectContaining({
          id: trainingTemplate.id,
          name: 'Bench Press',
          category: 'strength',
        }),
      });
    });

    it('creates template with trainings without weekDay (nullable)', async () => {
      const { accessToken } = await createTrainerWithToken();
      const trainingTemplate = await createTrainingTemplate(accessToken);

      const response = await createProtocolTemplate(accessToken, {
        name: 'Flexible Template',
        trainings: [
          { trainingTemplateId: trainingTemplate.id, order: 0 },
        ],
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.trainings).toHaveLength(1);
      expect(body.trainings[0].weekDay).toBeNull();
    });

    it('returns 404 when training template does not exist', async () => {
      const { accessToken } = await createTrainerWithToken();

      const response = await createProtocolTemplate(accessToken, {
        name: 'Template',
        trainings: [{ trainingTemplateId: '00000000-0000-0000-0000-000000000000', weekDay: 'monday', order: 0 }],
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 401 without authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocol-templates',
        payload: { name: 'T' },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  // ==================== GET /trainer/protocol-templates ====================

  describe('GET /trainer/protocol-templates', () => {
    it('returns templates with trainingsCount', async () => {
      const { accessToken } = await createTrainerWithToken();
      const trainingTemplate = await createTrainingTemplate(accessToken);

      await createProtocolTemplate(accessToken, {
        name: 'Template A',
        trainings: [{ trainingTemplateId: trainingTemplate.id, weekDay: 'monday', order: 0 }],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/trainer/protocol-templates',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0]).toHaveProperty('trainingsCount', 1);
    });

    it('returns 0 for trainingsCount when no trainings added', async () => {
      const { accessToken } = await createTrainerWithToken();
      await createProtocolTemplate(accessToken, { name: 'Empty Template' });

      const response = await app.inject({
        method: 'GET',
        url: '/trainer/protocol-templates',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body[0].trainingsCount).toBe(0);
    });
  });

  // ==================== i18n label fields ====================

  describe('i18n labels on GET /trainer/protocol-templates', () => {
    it('returns translated labels in pt-BR', async () => {
      const { accessToken } = await createTrainerWithToken();

      await createProtocolTemplate(accessToken, {
        name: 'Template i18n PT',
        trainingLevel: 'intermediate',
        type: 'strength',
        genderOrdination: 'male',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/trainer/protocol-templates',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'app-language': 'pt-BR',
        },
      });

      expect(response.statusCode).toBe(200);
      const [item] = response.json();
      expect(item).toHaveProperty('trainingLevel', 'intermediate');
      expect(item).toHaveProperty('trainingLevelLabel', 'Intermediário');
      expect(item).toHaveProperty('type', 'strength');
      expect(item).toHaveProperty('typeLabel', 'Força');
      expect(item).toHaveProperty('genderOrdination', 'male');
      expect(item).toHaveProperty('genderOrdinationLabel', 'Masculino');
    });

    it('returns translated labels in en-US', async () => {
      const { accessToken } = await createTrainerWithToken();

      await createProtocolTemplate(accessToken, {
        name: 'Template i18n EN',
        trainingLevel: 'intermediate',
        type: 'strength',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/trainer/protocol-templates',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'app-language': 'en-US',
        },
      });

      expect(response.statusCode).toBe(200);
      const [item] = response.json();
      expect(item).toHaveProperty('trainingLevelLabel', 'Intermediate');
      expect(item).toHaveProperty('typeLabel', 'Strength');
    });

    it('returns null label when genderOrdination is null', async () => {
      const { accessToken } = await createTrainerWithToken();

      await createProtocolTemplate(accessToken, {
        name: 'Template No Gender',
        trainingLevel: 'beginner',
        type: 'cardio',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/trainer/protocol-templates',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'app-language': 'pt-BR',
        },
      });

      expect(response.statusCode).toBe(200);
      const [item] = response.json();
      expect(item.genderOrdination).toBeNull();
      expect(item.genderOrdinationLabel).toBeNull();
    });
  });

  // ==================== GET /trainer/protocol-templates/:id ====================

  describe('GET /trainer/protocol-templates/:id', () => {
    it('returns template with trainings including nested training template info', async () => {
      const { accessToken } = await createTrainerWithToken();
      const trainingTemplate = await createTrainingTemplate(accessToken, { name: 'Squat', category: 'strength', bodySegment: 'lower' });

      const createResponse = await createProtocolTemplate(accessToken, {
        name: 'Leg Day Template',
        trainings: [{ trainingTemplateId: trainingTemplate.id, weekDay: 'tuesday', order: 1 }],
      });
      const { id: templateId } = createResponse.json();

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/protocol-templates/${templateId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.trainings).toHaveLength(1);
      expect(body.trainings[0]).toMatchObject({
        weekDay: 'tuesday',
        order: 1,
        trainingTemplate: expect.objectContaining({
          name: 'Squat',
          category: 'strength',
          bodySegment: 'lower',
        }),
      });
    });
  });

  // ==================== PATCH /trainer/protocol-templates/:id ====================

  describe('PATCH /trainer/protocol-templates/:id', () => {
    it('replaces trainings when trainings array is provided', async () => {
      const { accessToken } = await createTrainerWithToken();
      const ttA = await createTrainingTemplate(accessToken, { name: 'Bench Press', category: 'strength' });
      const ttB = await createTrainingTemplate(accessToken, { name: 'Deadlift', category: 'strength', bodySegment: 'lower' });

      const createResponse = await createProtocolTemplate(accessToken, {
        name: 'Template',
        trainings: [{ trainingTemplateId: ttA.id, weekDay: 'monday', order: 0 }],
      });
      const { id: templateId } = createResponse.json();

      const updateResponse = await app.inject({
        method: 'PATCH',
        url: `/trainer/protocol-templates/${templateId}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          trainings: [
            { trainingTemplateId: ttB.id, weekDay: 'monday', order: 0 },
            { trainingTemplateId: ttB.id, weekDay: 'wednesday', order: 1 },
          ],
        },
      });

      expect(updateResponse.statusCode).toBe(200);
      const body = updateResponse.json();
      expect(body.trainings).toHaveLength(2);
      expect(body.trainings.every((s) => s.trainingTemplate.name === 'Deadlift')).toBe(true);
    });

    it('clears all trainings when trainings is empty array', async () => {
      const { accessToken } = await createTrainerWithToken();
      const tt = await createTrainingTemplate(accessToken);

      const createResponse = await createProtocolTemplate(accessToken, {
        name: 'Template',
        trainings: [{ trainingTemplateId: tt.id, weekDay: 'monday', order: 0 }],
      });
      const { id: templateId } = createResponse.json();

      const updateResponse = await app.inject({
        method: 'PATCH',
        url: `/trainer/protocol-templates/${templateId}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { trainings: [] },
      });

      expect(updateResponse.statusCode).toBe(200);
      expect(updateResponse.json().trainings).toHaveLength(0);
    });
  });

  // ==================== POST /trainer/protocols/import-from-template ====================

  describe('POST /trainer/protocols/import-from-template (with trainings)', () => {
    it('imports protocol and creates trainings with weekDay from template', async () => {
      const { accessToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken();
      const tt = await createTrainingTemplate(accessToken, { name: 'Bench Press', category: 'strength' });

      const templateResponse = await createProtocolTemplate(accessToken, {
        name: 'Full Body',
        trainings: [
          { trainingTemplateId: tt.id, weekDay: 'monday', order: 0 },
          { trainingTemplateId: tt.id, weekDay: 'wednesday', order: 1 },
        ],
      });
      const { id: templateId } = templateResponse.json();

      const importResponse = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/import-from-template',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          templateId,
          assigneeId,
          startDate: '2025-03-01',
        },
      });

      expect(importResponse.statusCode).toBe(201);
      const body = importResponse.json();
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('trainings');
      expect(body.trainings).toHaveLength(2);
      expect(body.trainings[0]).toMatchObject({
        name: 'Bench Press',
        category: 'strength',
        weekDay: 'monday',
        order: 0,
      });
      expect(body.trainings[1]).toMatchObject({
        weekDay: 'wednesday',
        order: 1,
      });
    });

    it('imports protocol with no trainings when template has no trainings', async () => {
      const { accessToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken();

      const templateResponse = await createProtocolTemplate(accessToken, {
        name: 'Empty Template',
      });
      const { id: templateId } = templateResponse.json();

      const importResponse = await app.inject({
        method: 'POST',
        url: '/trainer/protocols/import-from-template',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          templateId,
          assigneeId,
          startDate: '2025-03-01',
        },
      });

      expect(importResponse.statusCode).toBe(201);
      const body = importResponse.json();
      expect(body.trainings).toHaveLength(0);
    });
  });

  // ==================== i18n labels ====================

  describe('i18n labels — training protocol template', () => {
    it('GET /trainer/protocol-templates/:id returns categoryLabel and bodySegmentLabel in pt-BR', async () => {
      const { accessToken } = await createTrainerWithToken();
      // training template with category 'strength' and bodySegment 'lower'
      const trainingTemplate = await createTrainingTemplate(accessToken, {
        name: 'Agachamento',
        category: 'strength',
        bodySegment: 'lower',
      });

      const createResponse = await createProtocolTemplate(accessToken, {
        name: 'Template Pernas',
        trainings: [{ trainingTemplateId: trainingTemplate.id, weekDay: 'monday', order: 0 }],
      });
      const { id: templateId } = createResponse.json();

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/protocol-templates/${templateId}`,
        headers: { authorization: `Bearer ${accessToken}`, 'app-language': 'pt-BR' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.trainings).toHaveLength(1);
      expect(body.trainings[0].trainingTemplate).toMatchObject({
        category: 'strength',
        categoryLabel: 'Força',
        bodySegment: 'lower',
        bodySegmentLabel: 'Inferior',
      });
    });

    it('GET /trainer/protocol-templates/:id returns categoryLabel in en-US', async () => {
      const { accessToken } = await createTrainerWithToken();
      const trainingTemplate = await createTrainingTemplate(accessToken, {
        name: 'Squat',
        category: 'strength',
        bodySegment: 'lower',
      });

      const createResponse = await createProtocolTemplate(accessToken, {
        name: 'Leg Template',
        trainings: [{ trainingTemplateId: trainingTemplate.id, weekDay: 'tuesday', order: 0 }],
      });
      const { id: templateId } = createResponse.json();

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/protocol-templates/${templateId}`,
        headers: { authorization: `Bearer ${accessToken}`, 'app-language': 'en-US' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.trainings[0].trainingTemplate).toMatchObject({
        category: 'strength',
        categoryLabel: 'Strength',
        bodySegment: 'lower',
        bodySegmentLabel: 'Lower',
      });
    });

    it('GET /trainer/protocol-templates/:id sets bodySegmentLabel to null when bodySegment is null', async () => {
      const { accessToken } = await createTrainerWithToken();
      // Create training template directly without bodySegment so it remains null
      const ttResponse = await app.inject({
        method: 'POST',
        url: '/trainer/training-templates',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { name: 'Cardio Run', category: 'cardio' },
      });
      expect(ttResponse.statusCode).toBe(201);
      const trainingTemplate = ttResponse.json();

      const createResponse = await createProtocolTemplate(accessToken, {
        name: 'Cardio Template',
        trainings: [{ trainingTemplateId: trainingTemplate.id, order: 0 }],
      });
      const { id: templateId } = createResponse.json();

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/protocol-templates/${templateId}`,
        headers: { authorization: `Bearer ${accessToken}`, 'app-language': 'pt-BR' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.trainings[0].trainingTemplate.bodySegment).toBeNull();
      expect(body.trainings[0].trainingTemplate.bodySegmentLabel).toBeNull();
    });
  });
});
