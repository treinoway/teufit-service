import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import {
  AnamnesisQuestionType,
  AnamnesisErrorCode,
  AnamnesisMessageCode,
} from '../../src/constants/anamnesis.js';
import { Roles } from '../../src/constants/roles.js';
import { signupVerified } from '../helpers/signup-user.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: admin anamnesis', () => {
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

  // ─── Auth helpers ───────────────────────────────────────────────────────────

  async function createUserAndGetId(email, password = 'StrongPassw0rd!') {
    const response = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(response.statusCode).toBe(201);
    return response.json().user.id;
  }

  async function createAdminWithToken() {
    const email = `e2e+admin-${Date.now()}@example.com`;
    const userId = await createUserAndGetId(email);

    // Directly update the user's roles to include ADMIN
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { roles: [Roles.ADMIN] },
    });

    // Issue a JWT directly using the app's fastify.jwt
    const accessToken = app.jwt.sign({
      sub: updatedUser.id,
      email: updatedUser.email,
      roles: [Roles.ADMIN],
      status: updatedUser.status,
    });

    return { userId, accessToken, email };
  }

  async function createTrainerWithToken() {
    const email = `e2e+trainer-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupResponse = await signupVerified(app, {
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

    const signupResponse = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupResponse.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupResponse.json();

    return { userId, accessToken, email };
  }

  async function createPublicAnamnesis(adminToken, payload = {}) {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/anamneses',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        title: 'Public Health Questionnaire',
        ...payload,
      },
    });
    return response;
  }

  // ─── POST /admin/anamneses ─────────────────────────────────────────────────

  describe('POST /admin/anamneses', () => {
    it('creates a public anamnesis with isGeneral: true and trainerId: null', async () => {
      const { accessToken: adminToken } = await createAdminWithToken();

      const response = await createPublicAnamnesis(adminToken, {
        title: 'Public Questionnaire',
        description: 'For all trainers',
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toMatchObject({
        id: expect.any(String),
        title: 'Public Questionnaire',
        description: 'For all trainers',
        isGeneral: true,
        trainerId: null,
        sections: [],
      });
    });

    it('creates a public anamnesis with nested sections and questions', async () => {
      const { accessToken: adminToken } = await createAdminWithToken();

      const response = await createPublicAnamnesis(adminToken, {
        title: 'Full Public Questionnaire',
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
      expect(body.sections[0].questions).toHaveLength(2);
      expect(body.sections[0].questions[1].options).toHaveLength(2);
    });

    it('returns 403 when a trainer tries to access admin endpoint', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const response = await createPublicAnamnesis(trainerToken);

      expect(response.statusCode).toBe(403);
    });

    it('returns 403 when a student tries to access admin endpoint', async () => {
      const { accessToken: studentToken } = await createStudentWithToken();

      const response = await createPublicAnamnesis(studentToken);

      expect(response.statusCode).toBe(403);
    });

    it('returns 401 without authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/anamneses',
        payload: { title: 'Test' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 400 when title is missing', async () => {
      const { accessToken: adminToken } = await createAdminWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/admin/anamneses',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { description: 'No title' },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  // ─── GET /admin/anamneses ──────────────────────────────────────────────────

  describe('GET /admin/anamneses', () => {
    it('returns list of public anamneses', async () => {
      const { accessToken: adminToken } = await createAdminWithToken();
      await createPublicAnamnesis(adminToken, { title: 'First' });
      await createPublicAnamnesis(adminToken, { title: 'Second' });

      const response = await app.inject({
        method: 'GET',
        url: '/admin/anamneses',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(2);
      expect(body.every((a) => a.isGeneral === true)).toBe(true);
    });

    it('returns 403 for non-admin', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'GET',
        url: '/admin/anamneses',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // ─── GET /admin/anamneses/:anamnesisId ─────────────────────────────────────

  describe('GET /admin/anamneses/:anamnesisId', () => {
    it('returns full detail of a public anamnesis', async () => {
      const { accessToken: adminToken } = await createAdminWithToken();
      const createResp = await createPublicAnamnesis(adminToken, { title: 'Detail Test' });
      const { id } = createResp.json();

      const response = await app.inject({
        method: 'GET',
        url: `/admin/anamneses/${id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id, isGeneral: true });
    });

    it('returns 404 for non-existent anamnesis', async () => {
      const { accessToken: adminToken } = await createAdminWithToken();

      const response = await app.inject({
        method: 'GET',
        url: '/admin/anamneses/00000000-0000-0000-0000-000000000099',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ─── PATCH /admin/anamneses/:anamnesisId ───────────────────────────────────

  describe('PATCH /admin/anamneses/:anamnesisId', () => {
    it('updates title and description', async () => {
      const { accessToken: adminToken } = await createAdminWithToken();
      const createResp = await createPublicAnamnesis(adminToken, { title: 'Original Title' });
      const { id } = createResp.json();

      const response = await app.inject({
        method: 'PATCH',
        url: `/admin/anamneses/${id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { title: 'Updated Title', description: 'Updated description' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.title).toBe('Updated Title');
      expect(body.description).toBe('Updated description');
    });

    it('returns 409 when updating an anamnesis that is linked to a student', async () => {
      const { accessToken: adminToken } = await createAdminWithToken();
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();

      // Link trainer-student
      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: studentEmail },
      });

      // Create public anamnesis and link to student
      const createResp = await createPublicAnamnesis(adminToken, { title: 'Linked Anamnesis' });
      const { id: anamnesisId } = createResp.json();

      await app.inject({
        method: 'POST',
        url: `/trainer/students/${studentId}/anamneses`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { anamnesisId },
      });

      // Admin update is blocked while the anamnesis is linked to a student
      // (assertAnamnesisNotLinked in admin-anamnesis-service.js — the guard was
      // deliberately added in "Add support for interval"; editing a linked
      // template must go through the fork flow instead).
      const response = await app.inject({
        method: 'PATCH',
        url: `/admin/anamneses/${anamnesisId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { title: 'Still Updated' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'ANAMNESIS_HAS_STUDENT_LINKS' });
    });
  });

  // ─── DELETE /admin/anamneses/:anamnesisId ──────────────────────────────────

  describe('DELETE /admin/anamneses/:anamnesisId', () => {
    it('soft-deletes a public anamnesis', async () => {
      const { accessToken: adminToken } = await createAdminWithToken();
      const createResp = await createPublicAnamnesis(adminToken, { title: 'To Delete' });
      const { id } = createResp.json();

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: `/admin/anamneses/${id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(deleteResponse.statusCode).toBe(200);
      expect(deleteResponse.json()).toMatchObject({ id, deletedAt: expect.any(String) });

      // Verify it's no longer visible
      const getResponse = await app.inject({
        method: 'GET',
        url: `/admin/anamneses/${id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(getResponse.statusCode).toBe(404);
    });

    it('returns 404 when deleting non-existent anamnesis', async () => {
      const { accessToken: adminToken } = await createAdminWithToken();

      const response = await app.inject({
        method: 'DELETE',
        url: '/admin/anamneses/00000000-0000-0000-0000-000000000099',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ─── POST /admin/anamneses/:anamnesisId/sections ───────────────────────────

  describe('POST /admin/anamneses/:anamnesisId/sections', () => {
    it('adds a section to a public anamnesis', async () => {
      const { accessToken: adminToken } = await createAdminWithToken();
      const { id: anamnesisId } = (await createPublicAnamnesis(adminToken)).json();

      const response = await app.inject({
        method: 'POST',
        url: `/admin/anamneses/${anamnesisId}/sections`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { title: 'Physical Health', order: 0 },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ anamnesisId, title: 'Physical Health' });
    });

    it('can add section even when anamnesis is linked to students (no 409)', async () => {
      const { accessToken: adminToken } = await createAdminWithToken();
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();

      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: studentEmail },
      });

      const { id: anamnesisId } = (await createPublicAnamnesis(adminToken)).json();

      await app.inject({
        method: 'POST',
        url: `/trainer/students/${studentId}/anamneses`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { anamnesisId },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/admin/anamneses/${anamnesisId}/sections`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { title: 'New Section' },
      });

      expect(response.statusCode).toBe(201);
    });
  });

  // ─── Full admin CRUD flow ──────────────────────────────────────────────────

  describe('full admin CRUD flow', () => {
    it('create → add section → add question → reorder → update section → delete question → delete section → delete anamnesis', async () => {
      const { accessToken: adminToken } = await createAdminWithToken();

      // Create public anamnesis
      const createResp = await createPublicAnamnesis(adminToken, { title: 'Full Flow Test' });
      expect(createResp.statusCode).toBe(201);
      const { id: anamnesisId } = createResp.json();

      // Add two sections
      const section1Resp = await app.inject({
        method: 'POST',
        url: `/admin/anamneses/${anamnesisId}/sections`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { title: 'Section A', order: 0 },
      });
      expect(section1Resp.statusCode).toBe(201);
      const { id: section1Id } = section1Resp.json();

      const section2Resp = await app.inject({
        method: 'POST',
        url: `/admin/anamneses/${anamnesisId}/sections`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { title: 'Section B', order: 1 },
      });
      expect(section2Resp.statusCode).toBe(201);
      const { id: section2Id } = section2Resp.json();

      // Add question to section 1
      const questionResp = await app.inject({
        method: 'POST',
        url: `/admin/anamneses/${anamnesisId}/sections/${section1Id}/questions`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { text: 'Do you smoke?', type: AnamnesisQuestionType.DICHOTOMOUS },
      });
      expect(questionResp.statusCode).toBe(201);
      const { id: questionId } = questionResp.json();

      // Reorder sections (swap)
      const reorderResp = await app.inject({
        method: 'PATCH',
        url: `/admin/anamneses/${anamnesisId}/sections/reorder`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { orderedIds: [section2Id, section1Id] },
      });
      expect(reorderResp.statusCode).toBe(200);

      // Update section 1 title
      const updateSectionResp = await app.inject({
        method: 'PATCH',
        url: `/admin/anamneses/${anamnesisId}/sections/${section1Id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { title: 'Updated Section A' },
      });
      expect(updateSectionResp.statusCode).toBe(200);
      expect(updateSectionResp.json().title).toBe('Updated Section A');

      // Update the question
      const updateQuestionResp = await app.inject({
        method: 'PATCH',
        url: `/admin/anamneses/${anamnesisId}/sections/${section1Id}/questions/${questionId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { text: 'Updated question text' },
      });
      expect(updateQuestionResp.statusCode).toBe(200);
      expect(updateQuestionResp.json().text).toBe('Updated question text');

      // Delete the question
      const deleteQuestionResp = await app.inject({
        method: 'DELETE',
        url: `/admin/anamneses/${anamnesisId}/sections/${section1Id}/questions/${questionId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(deleteQuestionResp.statusCode).toBe(200);

      // Delete section 2
      const deleteSectionResp = await app.inject({
        method: 'DELETE',
        url: `/admin/anamneses/${anamnesisId}/sections/${section2Id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(deleteSectionResp.statusCode).toBe(200);

      // Delete the anamnesis
      const deleteResp = await app.inject({
        method: 'DELETE',
        url: `/admin/anamneses/${anamnesisId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(deleteResp.statusCode).toBe(200);
    });
  });

  // ─── Public anamnesis visibility to trainers ──────────────────────────────

  describe('public anamnesis visible to trainers', () => {
    it('trainers can see public anamneses in their list', async () => {
      const { accessToken: adminToken } = await createAdminWithToken();
      const { accessToken: trainerToken } = await createTrainerWithToken();

      // Admin creates a public anamnesis
      await createPublicAnamnesis(adminToken, { title: 'Trainer Visible Questionnaire' });

      // Trainer lists their anamneses — should include the public one
      const response = await app.inject({
        method: 'GET',
        url: '/trainer/anamneses',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const publicAnamnesis = body.find((a) => a.isGeneral === true);
      expect(publicAnamnesis).toBeDefined();
      expect(publicAnamnesis.title).toBe('Trainer Visible Questionnaire');
    });
  });

  // ─── Retired `matrix` question type ─────────────────────────────────────────

  describe('retired matrix question type', () => {
    const LANG_HEADER = 'app-language';
    const MATRIX_ROWS = ['Row A', 'Row B', 'Row C'];
    const matrixQuestionPayload = {
      text: 'Rate each item',
      type: AnamnesisQuestionType.MATRIX,
      options: MATRIX_ROWS.map((text) => ({ text })),
    };

    const bearerAuth = (token, extra = {}) => ({ authorization: `Bearer ${token}`, ...extra });

    const expectInvalidQuestionType = (response) => {
      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body).toMatchObject({
        error: AnamnesisErrorCode.INVALID_QUESTION_TYPE,
        messageCode: AnamnesisMessageCode.INVALID_QUESTION_TYPE,
        message: expect.any(String),
      });
      expect(Object.keys(body).every((key) => ['error', 'messageCode', 'message', 'details'].includes(key))).toBe(
        true,
      );
    };

    async function createPublicAnamnesisWithSection(adminToken) {
      const created = await createPublicAnamnesis(adminToken, { sections: [{ title: 'Section 1' }] });
      expect(created.statusCode).toBe(201);
      const body = created.json();
      return { anamnesisId: body.id, sectionId: body.sections[0].id };
    }

    /** Inserts a legacy matrix question (with option rows) straight into the database, bypassing the API. */
    const insertLegacyMatrixQuestion = (sectionId) =>
      prisma.anamnesisQuestion.create({
        data: {
          sectionId,
          text: 'Legacy matrix question',
          type: AnamnesisQuestionType.MATRIX,
          order: 0,
          options: { create: MATRIX_ROWS.map((text, order) => ({ text, order })) },
        },
        include: { options: { orderBy: { order: 'asc' } } },
      });

    const questionUrl = (anamnesisId, sectionId, questionId = '') =>
      `/admin/anamneses/${anamnesisId}/sections/${sectionId}/questions${questionId ? `/${questionId}` : ''}`;

    describe('creating content', () => {
      it('POST question with type matrix returns 400 INVALID_QUESTION_TYPE and creates nothing', async () => {
        const { accessToken: adminToken } = await createAdminWithToken();
        const { anamnesisId, sectionId } = await createPublicAnamnesisWithSection(adminToken);

        const response = await app.inject({
          method: 'POST',
          url: questionUrl(anamnesisId, sectionId),
          headers: bearerAuth(adminToken),
          payload: matrixQuestionPayload,
        });

        expectInvalidQuestionType(response);
        expect(await prisma.anamnesisQuestion.count({ where: { sectionId } })).toBe(0);
      });

      it('POST question with an unknown type is still a schema VALIDATION_ERROR', async () => {
        const { accessToken: adminToken } = await createAdminWithToken();
        const { anamnesisId, sectionId } = await createPublicAnamnesisWithSection(adminToken);

        const response = await app.inject({
          method: 'POST',
          url: questionUrl(anamnesisId, sectionId),
          headers: bearerAuth(adminToken),
          payload: { text: 'Q?', type: 'foo' },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          error: 'VALIDATION_ERROR',
          messageCode: 'validation.failed',
          details: expect.any(Array),
        });
      });

      it('POST anamnesis with a nested matrix question returns 400 INVALID_QUESTION_TYPE and creates nothing', async () => {
        const { accessToken: adminToken } = await createAdminWithToken();

        const response = await createPublicAnamnesis(adminToken, {
          sections: [
            {
              title: 'Section',
              questions: [{ text: 'Smoke?', type: AnamnesisQuestionType.DICHOTOMOUS }, matrixQuestionPayload],
            },
          ],
        });

        expectInvalidQuestionType(response);
        expect(await prisma.anamnesis.count()).toBe(0);
        expect(await prisma.anamnesisSection.count()).toBe(0);
        expect(await prisma.anamnesisQuestion.count()).toBe(0);
      });

      it('POST section with a nested matrix question returns 400 INVALID_QUESTION_TYPE and creates nothing', async () => {
        const { accessToken: adminToken } = await createAdminWithToken();
        const { anamnesisId } = await createPublicAnamnesisWithSection(adminToken);

        const response = await app.inject({
          method: 'POST',
          url: `/admin/anamneses/${anamnesisId}/sections`,
          headers: bearerAuth(adminToken),
          payload: { title: 'Second section', questions: [matrixQuestionPayload] },
        });

        expectInvalidQuestionType(response);
        expect(await prisma.anamnesisSection.count({ where: { anamnesisId } })).toBe(1);
        expect(await prisma.anamnesisQuestion.count()).toBe(0);
      });

      it('returns the pt-BR message by default and the en-US message with app-language en-US', async () => {
        const { accessToken: adminToken } = await createAdminWithToken();
        const { anamnesisId, sectionId } = await createPublicAnamnesisWithSection(adminToken);
        const send = (headers = {}) =>
          app.inject({
            method: 'POST',
            url: questionUrl(anamnesisId, sectionId),
            headers: bearerAuth(adminToken, headers),
            payload: matrixQuestionPayload,
          });

        const ptBr = await send();
        const enUs = await send({ [LANG_HEADER]: 'en-US' });

        expect(ptBr.json()).toMatchObject({
          messageCode: AnamnesisMessageCode.INVALID_QUESTION_TYPE,
          message: 'Tipo de pergunta inválido ou não suportado.',
        });
        expect(enUs.json()).toMatchObject({
          messageCode: AnamnesisMessageCode.INVALID_QUESTION_TYPE,
          message: 'Invalid or unsupported question type.',
        });
      });

      it.each([
        AnamnesisQuestionType.FREE_TEXT,
        AnamnesisQuestionType.DICHOTOMOUS,
        AnamnesisQuestionType.NUMERIC,
        AnamnesisQuestionType.SINGLE_CHOICE,
        AnamnesisQuestionType.MULTIPLE_CHOICE,
      ])('POST question still creates a %s question', async (type) => {
        const { accessToken: adminToken } = await createAdminWithToken();
        const { anamnesisId, sectionId } = await createPublicAnamnesisWithSection(adminToken);

        const response = await app.inject({
          method: 'POST',
          url: questionUrl(anamnesisId, sectionId),
          headers: bearerAuth(adminToken),
          payload: { text: 'Creatable?', type, options: [{ text: 'A' }, { text: 'B' }] },
        });

        expect(response.statusCode).toBe(201);
        expect(response.json().type).toBe(type);
      });
    });

    describe('updating a question', () => {
      async function setupSingleChoiceQuestion(adminToken) {
        const { anamnesisId, sectionId } = await createPublicAnamnesisWithSection(adminToken);
        const created = await app.inject({
          method: 'POST',
          url: questionUrl(anamnesisId, sectionId),
          headers: bearerAuth(adminToken),
          payload: { text: 'Pick one', type: AnamnesisQuestionType.SINGLE_CHOICE, options: [{ text: 'A' }] },
        });
        expect(created.statusCode).toBe(201);
        return { anamnesisId, sectionId, questionId: created.json().id };
      }

      it('PATCH question TO matrix returns 400 INVALID_QUESTION_TYPE and keeps the type', async () => {
        const { accessToken: adminToken } = await createAdminWithToken();
        const { anamnesisId, sectionId, questionId } = await setupSingleChoiceQuestion(adminToken);

        const response = await app.inject({
          method: 'PATCH',
          url: questionUrl(anamnesisId, sectionId, questionId),
          headers: bearerAuth(adminToken),
          payload: { type: AnamnesisQuestionType.MATRIX, text: 'Should not be saved' },
        });

        expectInvalidQuestionType(response);
        const row = await prisma.anamnesisQuestion.findUnique({ where: { id: questionId } });
        expect(row).toMatchObject({ type: AnamnesisQuestionType.SINGLE_CHOICE, text: 'Pick one' });
      });

      it('PATCH legacy matrix question with its type unchanged returns 200 and keeps type matrix', async () => {
        const { accessToken: adminToken } = await createAdminWithToken();
        const { anamnesisId, sectionId } = await createPublicAnamnesisWithSection(adminToken);
        const legacy = await insertLegacyMatrixQuestion(sectionId);

        const response = await app.inject({
          method: 'PATCH',
          url: questionUrl(anamnesisId, sectionId, legacy.id),
          headers: bearerAuth(adminToken),
          payload: { text: 'Renamed matrix', type: AnamnesisQuestionType.MATRIX },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          id: legacy.id,
          text: 'Renamed matrix',
          type: AnamnesisQuestionType.MATRIX,
        });
        expect(response.json().options.map((option) => option.text)).toEqual(MATRIX_ROWS);
      });

      it('PATCH legacy matrix question to a creatable type returns 200, and it cannot go back to matrix', async () => {
        const { accessToken: adminToken } = await createAdminWithToken();
        const { anamnesisId, sectionId } = await createPublicAnamnesisWithSection(adminToken);
        const legacy = await insertLegacyMatrixQuestion(sectionId);
        const patch = (type) =>
          app.inject({
            method: 'PATCH',
            url: questionUrl(anamnesisId, sectionId, legacy.id),
            headers: bearerAuth(adminToken),
            payload: { type },
          });

        const migrated = await patch(AnamnesisQuestionType.SINGLE_CHOICE);
        const backToMatrix = await patch(AnamnesisQuestionType.MATRIX);

        expect(migrated.statusCode).toBe(200);
        expect(migrated.json().type).toBe(AnamnesisQuestionType.SINGLE_CHOICE);
        expectInvalidQuestionType(backToMatrix);
      });
    });

    describe('legacy matrix questions on read', () => {
      it('GET /admin/anamneses/:id returns the legacy matrix question with type matrix and its typeLabel', async () => {
        const { accessToken: adminToken } = await createAdminWithToken();
        const { anamnesisId, sectionId } = await createPublicAnamnesisWithSection(adminToken);
        await insertLegacyMatrixQuestion(sectionId);
        const get = (headers = {}) =>
          app.inject({
            method: 'GET',
            url: `/admin/anamneses/${anamnesisId}`,
            headers: bearerAuth(adminToken, headers),
          });

        const ptBr = await get();
        const enUs = await get({ [LANG_HEADER]: 'en-US' });

        expect(ptBr.statusCode).toBe(200);
        const [question] = ptBr.json().sections[0].questions;
        expect(question).toMatchObject({ type: AnamnesisQuestionType.MATRIX, typeLabel: 'Matriz' });
        expect(question.options.map((option) => option.text)).toEqual(MATRIX_ROWS);
        expect(enUs.json().sections[0].questions[0].typeLabel).toBe('Matrix');
      });

      it('lets a trainer read the public anamnesis that holds a legacy matrix question', async () => {
        const { accessToken: adminToken } = await createAdminWithToken();
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { anamnesisId, sectionId } = await createPublicAnamnesisWithSection(adminToken);
        await insertLegacyMatrixQuestion(sectionId);

        const response = await app.inject({
          method: 'GET',
          url: `/trainer/anamneses/${anamnesisId}`,
          headers: bearerAuth(trainerToken),
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().sections[0].questions[0]).toMatchObject({ type: AnamnesisQuestionType.MATRIX });
      });
    });
  });
});
