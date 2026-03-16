import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import { AnamnesisQuestionType } from '../../src/constants/anamnesis.js';
import { Roles } from '../../src/constants/roles.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: anamnesis', () => {
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

  // ─── Auth helpers ──────────────────────────────────────────────────────────

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

    return { userId, accessToken: trainerToken, email };
  }

  async function createStudentWithToken() {
    const email = `e2e+student-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupResponse = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupResponse.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupResponse.json();

    return { userId, accessToken, email };
  }

  async function linkTrainerStudent(trainerToken, studentEmail) {
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/students',
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: { email: studentEmail },
    });
    expect([201, 409]).toContain(response.statusCode);
  }

  async function createAnamnesis(trainerToken, payload = {}) {
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/anamneses',
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: {
        title: 'Health Questionnaire',
        description: 'Basic health assessment',
        ...payload,
      },
    });
    return response;
  }

  // ─── POST /trainer/anamneses ───────────────────────────────────────────────

  describe('POST /trainer/anamneses', () => {
    it('creates anamnesis with title and description', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const response = await createAnamnesis(trainerToken, { title: 'My Anamnesis' });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toMatchObject({
        id: expect.any(String),
        title: 'My Anamnesis',
        description: 'Basic health assessment',
        isGeneral: false,
        sections: [],
      });
    });

    it('creates anamnesis with nested sections, questions, and options', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const response = await createAnamnesis(trainerToken, {
        title: 'Full Questionnaire',
        sections: [
          {
            title: 'Physical Activity',
            questions: [
              {
                text: 'Do you exercise?',
                type: AnamnesisQuestionType.DICHOTOMOUS,
                required: true,
              },
              {
                text: 'Which sports?',
                type: AnamnesisQuestionType.MULTIPLE_CHOICE,
                options: [{ text: 'Running' }, { text: 'Swimming' }],
              },
            ],
          },
        ],
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.sections).toHaveLength(1);
      expect(body.sections[0].title).toBe('Physical Activity');
      expect(body.sections[0].questions).toHaveLength(2);
      expect(body.sections[0].questions[1].options).toHaveLength(2);
    });

    it('returns 400 when title is missing', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/anamneses',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { description: 'No title' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 400 when question type is invalid', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const response = await createAnamnesis(trainerToken, {
        title: 'Test',
        sections: [
          {
            title: 'Section',
            questions: [{ text: 'Q?', type: 'invalid_type' }],
          },
        ],
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 401 without authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/trainer/anamneses',
        payload: { title: 'Test' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 403 when authenticated user is not a trainer', async () => {
      const { accessToken: studentToken } = await createStudentWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/anamneses',
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { title: 'Test' },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // ─── GET /trainer/anamneses ────────────────────────────────────────────────

  describe('GET /trainer/anamneses', () => {
    it('returns list of own anamneses', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      await createAnamnesis(trainerToken, { title: 'Anamnesis A' });
      await createAnamnesis(trainerToken, { title: 'Anamnesis B' });

      const response = await app.inject({
        method: 'GET',
        url: '/trainer/anamneses',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.length).toBeGreaterThanOrEqual(2);
    });

    it('returns 401 without authentication', async () => {
      const response = await app.inject({ method: 'GET', url: '/trainer/anamneses' });
      expect(response.statusCode).toBe(401);
    });
  });

  // ─── GET /trainer/anamneses/:anamnesisId ──────────────────────────────────

  describe('GET /trainer/anamneses/:anamnesisId', () => {
    it('returns full nested detail of an anamnesis', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const createResponse = await createAnamnesis(trainerToken, {
        title: 'Health Questionnaire',
        sections: [{ title: 'Section 1', questions: [{ text: 'Q?', type: AnamnesisQuestionType.FREE_TEXT }] }],
      });
      const anamnesisId = createResponse.json().id;

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/anamneses/${anamnesisId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(anamnesisId);
      expect(body.sections).toHaveLength(1);
      expect(body.sections[0].questions).toHaveLength(1);
    });

    it('returns 404 for unknown anamnesis', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'GET',
        url: '/trainer/anamneses/00000000-0000-0000-0000-000000000099',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it("returns 403 when accessing another trainer's private anamnesis", async () => {
      const { accessToken: trainerToken1 } = await createTrainerWithToken();
      const { accessToken: trainerToken2 } = await createTrainerWithToken();

      const createResponse = await createAnamnesis(trainerToken1);
      const anamnesisId = createResponse.json().id;

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/anamneses/${anamnesisId}`,
        headers: { authorization: `Bearer ${trainerToken2}` },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // ─── PATCH /trainer/anamneses/:anamnesisId ────────────────────────────────

  describe('PATCH /trainer/anamneses/:anamnesisId', () => {
    it('updates title and description', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const anamnesisId = (await createAnamnesis(trainerToken)).json().id;

      const response = await app.inject({
        method: 'PATCH',
        url: `/trainer/anamneses/${anamnesisId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { title: 'Updated Title', description: 'Updated desc' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.title).toBe('Updated Title');
      expect(body.description).toBe('Updated desc');
    });

    it('returns 404 for unknown anamnesis', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'PATCH',
        url: '/trainer/anamneses/00000000-0000-0000-0000-000000000099',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { title: 'X' },
      });

      expect(response.statusCode).toBe(404);
    });

    it("returns 403 when updating another trainer's anamnesis", async () => {
      const { accessToken: trainerToken1 } = await createTrainerWithToken();
      const { accessToken: trainerToken2 } = await createTrainerWithToken();

      const anamnesisId = (await createAnamnesis(trainerToken1)).json().id;

      const response = await app.inject({
        method: 'PATCH',
        url: `/trainer/anamneses/${anamnesisId}`,
        headers: { authorization: `Bearer ${trainerToken2}` },
        payload: { title: 'Stolen' },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // ─── DELETE /trainer/anamneses/:anamnesisId ───────────────────────────────

  describe('DELETE /trainer/anamneses/:anamnesisId', () => {
    it('soft-deletes the anamnesis and returns {id, deletedAt}', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const anamnesisId = (await createAnamnesis(trainerToken)).json().id;

      const response = await app.inject({
        method: 'DELETE',
        url: `/trainer/anamneses/${anamnesisId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({ id: anamnesisId, deletedAt: expect.any(String) });
    });

    it('removes deleted anamnesis from list', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const anamnesisId = (await createAnamnesis(trainerToken)).json().id;

      await app.inject({
        method: 'DELETE',
        url: `/trainer/anamneses/${anamnesisId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      const listResponse = await app.inject({
        method: 'GET',
        url: '/trainer/anamneses',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      const ids = listResponse.json().map((a) => a.id);
      expect(ids).not.toContain(anamnesisId);
    });

    it('returns 404 for unknown anamnesis', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'DELETE',
        url: '/trainer/anamneses/00000000-0000-0000-0000-000000000099',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ─── POST /trainer/anamneses/:anamnesisId/sections ────────────────────────

  describe('POST /trainer/anamneses/:anamnesisId/sections', () => {
    it('adds a section to an anamnesis', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const anamnesisId = (await createAnamnesis(trainerToken)).json().id;

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/anamneses/${anamnesisId}/sections`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { title: 'Medical History', description: 'Past conditions' },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toMatchObject({
        id: expect.any(String),
        anamnesisId,
        title: 'Medical History',
        description: 'Past conditions',
        questions: [],
      });
    });

    it('returns 400 when title is missing', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const anamnesisId = (await createAnamnesis(trainerToken)).json().id;

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/anamneses/${anamnesisId}/sections`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { description: 'No title' },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  // ─── PATCH /trainer/anamneses/:anamnesisId/sections/reorder ──────────────

  describe('PATCH /trainer/anamneses/:anamnesisId/sections/reorder', () => {
    it('reorders sections and returns updated list', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const anamnesisId = (await createAnamnesis(trainerToken)).json().id;

      const section1 = (
        await app.inject({
          method: 'POST',
          url: `/trainer/anamneses/${anamnesisId}/sections`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { title: 'Section A' },
        })
      ).json().id;

      const section2 = (
        await app.inject({
          method: 'POST',
          url: `/trainer/anamneses/${anamnesisId}/sections`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { title: 'Section B' },
        })
      ).json().id;

      const response = await app.inject({
        method: 'PATCH',
        url: `/trainer/anamneses/${anamnesisId}/sections/reorder`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { orderedIds: [section2, section1] },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body[0].id).toBe(section2);
      expect(body[0].order).toBe(0);
      expect(body[1].id).toBe(section1);
      expect(body[1].order).toBe(1);
    });

    it('returns 400 when orderedIds is empty', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const anamnesisId = (await createAnamnesis(trainerToken)).json().id;

      const response = await app.inject({
        method: 'PATCH',
        url: `/trainer/anamneses/${anamnesisId}/sections/reorder`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { orderedIds: [] },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  // ─── PATCH /trainer/anamneses/:anamnesisId/sections/:sectionId ───────────

  describe('PATCH /trainer/anamneses/:anamnesisId/sections/:sectionId', () => {
    it('updates section title and description', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const anamnesisId = (await createAnamnesis(trainerToken)).json().id;
      const sectionId = (
        await app.inject({
          method: 'POST',
          url: `/trainer/anamneses/${anamnesisId}/sections`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { title: 'Original' },
        })
      ).json().id;

      const response = await app.inject({
        method: 'PATCH',
        url: `/trainer/anamneses/${anamnesisId}/sections/${sectionId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { title: 'Updated Section', description: 'New description' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ title: 'Updated Section', description: 'New description' });
    });

    it('returns 404 for unknown section', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const anamnesisId = (await createAnamnesis(trainerToken)).json().id;

      const response = await app.inject({
        method: 'PATCH',
        url: `/trainer/anamneses/${anamnesisId}/sections/00000000-0000-0000-0000-000000000099`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { title: 'X' },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ─── DELETE /trainer/anamneses/:anamnesisId/sections/:sectionId ──────────

  describe('DELETE /trainer/anamneses/:anamnesisId/sections/:sectionId', () => {
    it('soft-deletes a section and returns {id, deletedAt}', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const anamnesisId = (await createAnamnesis(trainerToken)).json().id;
      const sectionId = (
        await app.inject({
          method: 'POST',
          url: `/trainer/anamneses/${anamnesisId}/sections`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { title: 'To Delete' },
        })
      ).json().id;

      const response = await app.inject({
        method: 'DELETE',
        url: `/trainer/anamneses/${anamnesisId}/sections/${sectionId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({ id: sectionId, deletedAt: expect.any(String) });
    });
  });

  // ─── POST .../sections/:sectionId/questions ───────────────────────────────

  describe('POST /trainer/anamneses/:anamnesisId/sections/:sectionId/questions', () => {
    async function setupAnamnesisWithSection(trainerToken) {
      const anamnesisId = (await createAnamnesis(trainerToken)).json().id;
      const sectionId = (
        await app.inject({
          method: 'POST',
          url: `/trainer/anamneses/${anamnesisId}/sections`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { title: 'Section 1' },
        })
      ).json().id;
      return { anamnesisId, sectionId };
    }

    it('creates a free_text question', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { anamnesisId, sectionId } = await setupAnamnesisWithSection(trainerToken);

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/anamneses/${anamnesisId}/sections/${sectionId}/questions`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          text: 'Describe your main health complaint',
          type: AnamnesisQuestionType.FREE_TEXT,
          required: true,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toMatchObject({
        id: expect.any(String),
        sectionId,
        text: 'Describe your main health complaint',
        type: AnamnesisQuestionType.FREE_TEXT,
        required: true,
        options: [],
      });
    });

    it('creates a single_choice question with options', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { anamnesisId, sectionId } = await setupAnamnesisWithSection(trainerToken);

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/anamneses/${anamnesisId}/sections/${sectionId}/questions`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          text: 'How active are you?',
          type: AnamnesisQuestionType.SINGLE_CHOICE,
          options: [{ text: 'Sedentary' }, { text: 'Moderately active' }, { text: 'Very active' }],
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.options).toHaveLength(3);
    });

    it('creates a numeric question with config', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { anamnesisId, sectionId } = await setupAnamnesisWithSection(trainerToken);

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/anamneses/${anamnesisId}/sections/${sectionId}/questions`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          text: 'How many hours do you sleep?',
          type: AnamnesisQuestionType.NUMERIC,
          config: { min: 0, max: 24, unit: 'hours' },
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().config).toMatchObject({ min: 0, max: 24, unit: 'hours' });
    });

    it('returns 400 for invalid question type', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { anamnesisId, sectionId } = await setupAnamnesisWithSection(trainerToken);

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/anamneses/${anamnesisId}/sections/${sectionId}/questions`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { text: 'Q?', type: 'totally_invalid' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 404 for unknown section', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const anamnesisId = (await createAnamnesis(trainerToken)).json().id;

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/anamneses/${anamnesisId}/sections/00000000-0000-0000-0000-000000000099/questions`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { text: 'Q?', type: AnamnesisQuestionType.FREE_TEXT },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ─── PATCH .../questions/:questionId ──────────────────────────────────────

  describe('PATCH /trainer/anamneses/:anamnesisId/sections/:sectionId/questions/:questionId', () => {
    async function setupAnamnesisWithQuestion(trainerToken) {
      const anamnesisId = (await createAnamnesis(trainerToken)).json().id;
      const sectionId = (
        await app.inject({
          method: 'POST',
          url: `/trainer/anamneses/${anamnesisId}/sections`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { title: 'Section 1' },
        })
      ).json().id;
      const questionId = (
        await app.inject({
          method: 'POST',
          url: `/trainer/anamneses/${anamnesisId}/sections/${sectionId}/questions`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { text: 'Original text', type: AnamnesisQuestionType.SINGLE_CHOICE, options: [{ text: 'A' }] },
        })
      ).json().id;
      return { anamnesisId, sectionId, questionId };
    }

    it('updates question text', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { anamnesisId, sectionId, questionId } = await setupAnamnesisWithQuestion(trainerToken);

      const response = await app.inject({
        method: 'PATCH',
        url: `/trainer/anamneses/${anamnesisId}/sections/${sectionId}/questions/${questionId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { text: 'Updated question text' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().text).toBe('Updated question text');
    });

    it('replaces options when options array is provided', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { anamnesisId, sectionId, questionId } = await setupAnamnesisWithQuestion(trainerToken);

      const response = await app.inject({
        method: 'PATCH',
        url: `/trainer/anamneses/${anamnesisId}/sections/${sectionId}/questions/${questionId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { options: [{ text: 'New Option 1' }, { text: 'New Option 2' }] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().options).toHaveLength(2);
      expect(response.json().options[0].text).toBe('New Option 1');
    });

    it('returns 404 for unknown question', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { anamnesisId, sectionId } = await setupAnamnesisWithQuestion(trainerToken);

      const response = await app.inject({
        method: 'PATCH',
        url: `/trainer/anamneses/${anamnesisId}/sections/${sectionId}/questions/00000000-0000-0000-0000-000000000099`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { text: 'X' },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ─── DELETE .../questions/:questionId ─────────────────────────────────────

  describe('DELETE /trainer/anamneses/:anamnesisId/sections/:sectionId/questions/:questionId', () => {
    it('soft-deletes a question', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const anamnesisId = (await createAnamnesis(trainerToken)).json().id;
      const sectionId = (
        await app.inject({
          method: 'POST',
          url: `/trainer/anamneses/${anamnesisId}/sections`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { title: 'Section' },
        })
      ).json().id;
      const questionId = (
        await app.inject({
          method: 'POST',
          url: `/trainer/anamneses/${anamnesisId}/sections/${sectionId}/questions`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { text: 'Q to delete', type: AnamnesisQuestionType.FREE_TEXT },
        })
      ).json().id;

      const response = await app.inject({
        method: 'DELETE',
        url: `/trainer/anamneses/${anamnesisId}/sections/${sectionId}/questions/${questionId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: questionId, deletedAt: expect.any(String) });
    });
  });

  // ─── POST /trainer/students/:studentId/anamneses ──────────────────────────

  describe('POST /trainer/students/:studentId/anamneses', () => {
    it('links an anamnesis to a student', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkTrainerStudent(trainerToken, studentEmail);
      const anamnesisId = (await createAnamnesis(trainerToken)).json().id;

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/students/${studentId}/anamneses`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { anamnesisId },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toMatchObject({
        id: expect.any(String),
        anamnesisId,
        studentId,
        createdAt: expect.any(String),
      });
    });

    it('returns 409 when same anamnesis is linked twice to the same student by the same trainer', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkTrainerStudent(trainerToken, studentEmail);
      const anamnesisId = (await createAnamnesis(trainerToken)).json().id;

      const first = await app.inject({
        method: 'POST',
        url: `/trainer/students/${studentId}/anamneses`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { anamnesisId },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: 'POST',
        url: `/trainer/students/${studentId}/anamneses`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { anamnesisId },
      });

      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({
        messageCode: 'anamnesis.alreadyLinked',
      });
    });

    it('returns 404 when student is not linked to trainer', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      const anamnesisId = (await createAnamnesis(trainerToken)).json().id;

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/students/${studentId}/anamneses`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { anamnesisId },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 401 without authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/trainer/students/00000000-0000-0000-0000-000000000001/anamneses',
        payload: { anamnesisId: '00000000-0000-0000-0000-000000000002' },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  // ─── GET /trainer/students/:studentId/anamneses ───────────────────────────

  describe('GET /trainer/students/:studentId/anamneses', () => {
    it('returns list of anamneses linked to student', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkTrainerStudent(trainerToken, studentEmail);
      const anamnesisId = (await createAnamnesis(trainerToken)).json().id;

      await app.inject({
        method: 'POST',
        url: `/trainer/students/${studentId}/anamneses`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { anamnesisId },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/anamneses`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].anamnesisId).toBe(anamnesisId);
    });

    it('returns 404 when student is not linked to trainer', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/anamneses`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ─── DELETE /trainer/students/:studentId/anamneses/:anamnesisId ──────────

  describe('DELETE /trainer/students/:studentId/anamneses/:anamnesisId', () => {
    it('unlinks an anamnesis from a student', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkTrainerStudent(trainerToken, studentEmail);
      const anamnesisId = (await createAnamnesis(trainerToken)).json().id;

      await app.inject({
        method: 'POST',
        url: `/trainer/students/${studentId}/anamneses`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { anamnesisId },
      });

      const response = await app.inject({
        method: 'DELETE',
        url: `/trainer/students/${studentId}/anamneses/${anamnesisId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(200);

      const listResponse = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/anamneses`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      expect(listResponse.json()).toHaveLength(0);
    });

    it('returns 404 when the link does not exist', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkTrainerStudent(trainerToken, studentEmail);

      const response = await app.inject({
        method: 'DELETE',
        url: `/trainer/students/${studentId}/anamneses/00000000-0000-0000-0000-000000000099`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ─── GET /my/anamneses ────────────────────────────────────────────────────

  describe('GET /my/anamneses', () => {
    it('returns anamneses linked to authenticated student with full nested detail', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken, email: studentEmail } =
        await createStudentWithToken();
      await linkTrainerStudent(trainerToken, studentEmail);

      const createResponse = await createAnamnesis(trainerToken, {
        title: 'Full Questionnaire',
        sections: [
          {
            title: 'Section A',
            questions: [{ text: 'Are you healthy?', type: AnamnesisQuestionType.DICHOTOMOUS }],
          },
        ],
      });
      const anamnesisId = createResponse.json().id;

      await app.inject({
        method: 'POST',
        url: `/trainer/students/${studentId}/anamneses`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { anamnesisId },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/my/anamneses',
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].anamnesis.id).toBe(anamnesisId);
      expect(body[0].anamnesis.sections).toHaveLength(1);
      expect(body[0].anamnesis.sections[0].questions).toHaveLength(1);
      expect(body[0].trainer).toBeDefined();
    });

    it('returns empty array when student has no linked anamneses', async () => {
      const { accessToken: studentToken } = await createStudentWithToken();

      const response = await app.inject({
        method: 'GET',
        url: '/my/anamneses',
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });

    it('returns 401 without authentication', async () => {
      const response = await app.inject({ method: 'GET', url: '/my/anamneses' });
      expect(response.statusCode).toBe(401);
    });
  });

  // ─── Fork flow ────────────────────────────────────────────────────────────

  describe('POST /trainer/anamneses/:anamnesisId/fork', () => {
    it('forks anamnesis with version+1 and parentId set', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const anamnesisId = (
        await createAnamnesis(trainerToken, {
          title: 'Original',
          sections: [{ title: 'Section 1' }],
        })
      ).json().id;

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/anamneses/${anamnesisId}/fork`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.version).toBe(2);
      expect(body.parentId).toBe(anamnesisId);
      expect(body.title).toBe('Original');
      expect(body.isGeneral).toBe(false);
      expect(body.sections).toHaveLength(1);
    });

    it('blocks editing linked anamnesis (section mutation returns 409), then fork allows edit', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkTrainerStudent(trainerToken, studentEmail);

      const anamnesisId = (await createAnamnesis(trainerToken)).json().id;
      const sectionId = (
        await app.inject({
          method: 'POST',
          url: `/trainer/anamneses/${anamnesisId}/sections`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { title: 'Section A' },
        })
      ).json().id;

      // Link anamnesis to student
      await app.inject({
        method: 'POST',
        url: `/trainer/students/${studentId}/anamneses`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { anamnesisId },
      });

      // Try to edit section on linked anamnesis — expect 409
      const editResponse = await app.inject({
        method: 'PATCH',
        url: `/trainer/anamneses/${anamnesisId}/sections/${sectionId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { title: 'Updated' },
      });
      expect(editResponse.statusCode).toBe(409);
      expect(editResponse.json()).toMatchObject({ messageCode: 'anamnesis.hasStudentLinks' });

      // Fork the anamnesis
      const forkResponse = await app.inject({
        method: 'POST',
        url: `/trainer/anamneses/${anamnesisId}/fork`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      expect(forkResponse.statusCode).toBe(201);
      const forkedAnamnesisId = forkResponse.json().id;
      const forkedSectionId = forkResponse.json().sections[0].id;

      // Edit section on forked anamnesis — should succeed
      const editForkedResponse = await app.inject({
        method: 'PATCH',
        url: `/trainer/anamneses/${forkedAnamnesisId}/sections/${forkedSectionId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { title: 'Updated' },
      });
      expect(editForkedResponse.statusCode).toBe(200);
      expect(editForkedResponse.json().title).toBe('Updated');
    });

    it('returns 404 for unknown anamnesis', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/anamneses/00000000-0000-0000-0000-000000000099/fork',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 401 without authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/trainer/anamneses/00000000-0000-0000-0000-000000000099/fork',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ─── Response flow ────────────────────────────────────────────────────────

  describe('POST /my/anamneses/:anamnesisId/response and GET responses', () => {
    async function setupAnamnesisWithRequiredQuestion(trainerToken, studentId) {
      const createResponse = await createAnamnesis(trainerToken, {
        title: 'Health Form',
        sections: [
          {
            title: 'Section A',
            questions: [
              { text: 'Do you smoke?', type: AnamnesisQuestionType.DICHOTOMOUS, required: true },
            ],
          },
        ],
      });
      const anamnesisId = createResponse.json().id;
      const questionId = createResponse.json().sections[0].questions[0].id;

      await app.inject({
        method: 'POST',
        url: `/trainer/students/${studentId}/anamneses`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { anamnesisId },
      });

      return { anamnesisId, questionId };
    }

    it('student submits response and trainer views it', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken, email: studentEmail } =
        await createStudentWithToken();
      await linkTrainerStudent(trainerToken, studentEmail);

      const { anamnesisId, questionId } = await setupAnamnesisWithRequiredQuestion(
        trainerToken,
        studentId,
      );

      // Submit response
      const submitResponse = await app.inject({
        method: 'POST',
        url: `/my/anamneses/${anamnesisId}/response`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { answers: [{ questionId, value: 'yes' }] },
      });
      expect(submitResponse.statusCode).toBe(200);
      const submitBody = submitResponse.json();
      expect(submitBody.anamnesisId).toBe(anamnesisId);
      expect(submitBody.studentId).toBe(studentId);
      expect(submitBody.submittedAt).toBeDefined();
      expect(submitBody.answers).toHaveLength(1);
      expect(submitBody.answers[0].value).toBe('yes');

      // Student gets own response
      const getResponse = await app.inject({
        method: 'GET',
        url: `/my/anamneses/${anamnesisId}/response`,
        headers: { authorization: `Bearer ${studentToken}` },
      });
      expect(getResponse.statusCode).toBe(200);
      expect(getResponse.json().answers).toHaveLength(1);

      // Trainer views student response
      const trainerResponse = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/anamneses/${anamnesisId}/response`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      expect(trainerResponse.statusCode).toBe(200);
      expect(trainerResponse.json().studentId).toBe(studentId);
      expect(trainerResponse.json().answers).toHaveLength(1);
    });

    it('returns 400 when required question is not answered', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken, email: studentEmail } =
        await createStudentWithToken();
      await linkTrainerStudent(trainerToken, studentEmail);

      const { anamnesisId } = await setupAnamnesisWithRequiredQuestion(trainerToken, studentId);

      const response = await app.inject({
        method: 'POST',
        url: `/my/anamneses/${anamnesisId}/response`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { answers: [] },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
      });
    });

    it('returns 404 when anamnesis is not linked to student', async () => {
      const { accessToken: studentToken } = await createStudentWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/my/anamneses/00000000-0000-0000-0000-000000000099/response',
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { answers: [] },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 404 when getting response for unlinked anamnesis', async () => {
      const { accessToken: studentToken } = await createStudentWithToken();

      const response = await app.inject({
        method: 'GET',
        url: '/my/anamneses/00000000-0000-0000-0000-000000000099/response',
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 404 when trainer views response for non-linked anamnesis', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkTrainerStudent(trainerToken, studentEmail);

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/anamneses/00000000-0000-0000-0000-000000000099/response`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it('second submission replaces answers', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken, email: studentEmail } =
        await createStudentWithToken();
      await linkTrainerStudent(trainerToken, studentEmail);

      const { anamnesisId, questionId } = await setupAnamnesisWithRequiredQuestion(
        trainerToken,
        studentId,
      );

      await app.inject({
        method: 'POST',
        url: `/my/anamneses/${anamnesisId}/response`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { answers: [{ questionId, value: 'yes' }] },
      });

      const secondSubmit = await app.inject({
        method: 'POST',
        url: `/my/anamneses/${anamnesisId}/response`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { answers: [{ questionId, value: 'no' }] },
      });

      expect(secondSubmit.statusCode).toBe(200);
      expect(secondSubmit.json().answers[0].value).toBe('no');
    });
  });

  // ─── POST /trainer/anamneses/:anamnesisId/copy ─────────────────────────────

  async function createAdminToken() {
    const email = `e2e+admin-${Date.now()}@example.com`;
    const signupResponse = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: 'StrongPassw0rd!' },
    });
    expect(signupResponse.statusCode).toBe(201);
    const userId = signupResponse.json().user.id;

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { roles: [Roles.ADMIN] },
    });

    return app.jwt.sign({
      sub: updatedUser.id,
      email: updatedUser.email,
      roles: [Roles.ADMIN],
      status: updatedUser.status,
    });
  }

  async function createPublicAnamnesisViaAdmin(title = 'Public Health Questionnaire') {
    const adminToken = await createAdminToken();
    const response = await app.inject({
      method: 'POST',
      url: '/admin/anamneses',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  describe('POST /trainer/anamneses/:anamnesisId/copy', () => {
    it('trainer can copy a public anamnesis into a private independent copy', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const publicAnamnesis = await createPublicAnamnesisViaAdmin('Public Template');

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/anamneses/${publicAnamnesis.id}/copy`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toMatchObject({
        id: expect.any(String),
        isGeneral: false,
        parentId: null,
        version: 1,
      });
      // Copy must be a different record than the source
      expect(body.id).not.toBe(publicAnamnesis.id);
    });

    it('trainer can copy their own private anamnesis', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      // Create a private anamnesis
      const createResp = await app.inject({
        method: 'POST',
        url: '/trainer/anamneses',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { title: 'My Private Template' },
      });
      expect(createResp.statusCode).toBe(201);
      const { id: sourceId } = createResp.json();

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/anamneses/${sourceId}/copy`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toMatchObject({ isGeneral: false, parentId: null, version: 1 });
      expect(body.id).not.toBe(sourceId);
    });

    it('copy preserves sections and questions from the source', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const createResp = await app.inject({
        method: 'POST',
        url: '/trainer/anamneses',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          title: 'Template with Content',
          sections: [
            {
              title: 'Section 1',
              questions: [
                { text: 'Do you smoke?', type: AnamnesisQuestionType.DICHOTOMOUS },
              ],
            },
          ],
        },
      });
      expect(createResp.statusCode).toBe(201);
      const { id: sourceId } = createResp.json();

      const response = await app.inject({
        method: 'POST',
        url: `/trainer/anamneses/${sourceId}/copy`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.sections).toHaveLength(1);
      expect(body.sections[0].title).toBe('Section 1');
      expect(body.sections[0].questions).toHaveLength(1);
    });

    it("returns 403 when trying to copy another trainer's private anamnesis", async () => {
      const { accessToken: trainer1Token } = await createTrainerWithToken();
      const { accessToken: trainer2Token } = await createTrainerWithToken();

      // Trainer 1 creates a private anamnesis
      const createResp = await app.inject({
        method: 'POST',
        url: '/trainer/anamneses',
        headers: { authorization: `Bearer ${trainer1Token}` },
        payload: { title: 'Trainer 1 Private Anamnesis' },
      });
      expect(createResp.statusCode).toBe(201);
      const { id: sourceId } = createResp.json();

      // Trainer 2 tries to copy it
      const response = await app.inject({
        method: 'POST',
        url: `/trainer/anamneses/${sourceId}/copy`,
        headers: { authorization: `Bearer ${trainer2Token}` },
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 401 without authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/trainer/anamneses/00000000-0000-0000-0000-000000000099/copy',
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when anamnesis does not exist', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/anamneses/00000000-0000-0000-0000-000000000099/copy',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
