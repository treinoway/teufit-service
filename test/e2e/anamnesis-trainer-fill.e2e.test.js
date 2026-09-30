import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import {
  AnamnesisQuestionType,
  AnamnesisResponseStatus,
  AnamnesisFilledBy,
  AnamnesisErrorCode,
  AnamnesisMessageCode,
} from '../../src/constants/anamnesis.js';
import { PLATFORM_PLAN_ERRORS } from '../../src/constants/platform-plan.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const PASSWORD = 'StrongPassw0rd!';
const LANG_HEADER = 'app-language';
const EN_US = 'en-US';
const PT_BR = 'pt-BR';
const RACE_ITERATIONS = 5;

e2eDescribe('e2e: anamnesis — trainer fills on behalf of the student', () => {
  let app;
  let userCounter = 0;

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

  // ─── Helpers ───────────────────────────────────────────────────────────────

  const bearer = (token, extra = {}) => ({ authorization: `Bearer ${token}`, ...extra });

  const uniqueEmail = (prefix) => {
    userCounter += 1;
    return `e2e+${prefix}-${Date.now()}-${userCounter}@example.com`;
  };

  async function signup(prefix) {
    const email = uniqueEmail(prefix);
    const response = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(201);
    const { user, token } = response.json();
    return { userId: user.id, accessToken: token.accessToken, email };
  }

  async function createTrainer(prefix = 'trainer') {
    const user = await signup(prefix);
    const response = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: bearer(user.accessToken),
    });
    expect(response.statusCode).toBe(200);
    const trainer = await prisma.trainer.findUnique({ where: { userId: user.userId } });
    return { ...user, accessToken: response.json().token.accessToken, trainerId: trainer.id };
  }

  const createStudent = (prefix = 'student') => signup(prefix);

  async function linkStudent(trainer, student) {
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/students',
      headers: bearer(trainer.accessToken),
      payload: { email: student.email },
    });
    expect([201, 409]).toContain(response.statusCode);
  }

  async function createAnamnesis(trainer) {
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/anamneses',
      headers: bearer(trainer.accessToken),
      payload: {
        title: 'Health Form',
        sections: [
          {
            title: 'Section A',
            questions: [
              { text: 'Do you smoke?', type: AnamnesisQuestionType.DICHOTOMOUS, required: true },
              { text: 'Any notes?', type: AnamnesisQuestionType.FREE_TEXT },
            ],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    const [requiredQuestion, optionalQuestion] = body.sections[0].questions;
    return { anamnesisId: body.id, requiredQuestionId: requiredQuestion.id, optionalQuestionId: optionalQuestion.id };
  }

  async function linkAnamnesis(trainer, studentId, anamnesisId) {
    const response = await app.inject({
      method: 'POST',
      url: `/trainer/students/${studentId}/anamneses`,
      headers: bearer(trainer.accessToken),
      payload: { anamnesisId },
    });
    expect(response.statusCode).toBe(201);
  }

  /** Trainer + linked student + anamnesis (1 required + 1 optional question) linked by that trainer. */
  async function setupScenario() {
    const trainer = await createTrainer();
    const student = await createStudent();
    await linkStudent(trainer, student);
    const anamnesis = await createAnamnesis(trainer);
    await linkAnamnesis(trainer, student.userId, anamnesis.anamnesisId);
    return { trainer, student, ...anamnesis };
  }

  const trainerUrl = (studentId, anamnesisId, suffix = '') =>
    `/trainer/students/${studentId}/anamneses/${anamnesisId}${suffix}`;

  const fillUrl = (studentId, anamnesisId, query = '?studentPresent=true') =>
    `${trainerUrl(studentId, anamnesisId, '/fill')}${query}`;

  const attestedBody = (answers) => ({ answers, attestation: { studentPresent: true } });

  const trainerGetFill = (scenario, { query, headers } = {}) =>
    app.inject({
      method: 'GET',
      url: fillUrl(scenario.student.userId, scenario.anamnesisId, query),
      headers: bearer(scenario.trainer.accessToken, headers),
    });

  const trainerSaveDraft = (scenario, answers, { headers } = {}) =>
    app.inject({
      method: 'PATCH',
      url: trainerUrl(scenario.student.userId, scenario.anamnesisId, '/response/draft'),
      headers: bearer(scenario.trainer.accessToken, headers),
      payload: { answers },
    });

  const trainerSubmit = (scenario, answers, { headers, trainer = scenario.trainer } = {}) =>
    app.inject({
      method: 'POST',
      url: trainerUrl(scenario.student.userId, scenario.anamnesisId, '/response'),
      headers: bearer(trainer.accessToken, headers),
      payload: attestedBody(answers),
    });

  const trainerGetDossier = (scenario, { headers } = {}) =>
    app.inject({
      method: 'GET',
      url: trainerUrl(scenario.student.userId, scenario.anamnesisId, '/response'),
      headers: bearer(scenario.trainer.accessToken, headers),
    });

  const studentSubmit = (scenario, answers) =>
    app.inject({
      method: 'POST',
      url: `/my/anamneses/${scenario.anamnesisId}/response`,
      headers: bearer(scenario.student.accessToken),
      payload: { answers },
    });

  const studentSaveDraft = (scenario, answers) =>
    app.inject({
      method: 'PATCH',
      url: `/my/anamneses/${scenario.anamnesisId}/response/draft`,
      headers: bearer(scenario.student.accessToken),
      payload: { answers },
    });

  const studentConfirm = (scenario, { headers } = {}) =>
    app.inject({
      method: 'POST',
      url: `/my/anamneses/${scenario.anamnesisId}/response/confirm`,
      headers: bearer(scenario.student.accessToken, headers),
    });

  const studentList = (scenario, { headers } = {}) =>
    app.inject({
      method: 'GET',
      url: '/my/anamneses',
      headers: bearer(scenario.student.accessToken, headers),
    });

  const answersFor = (scenario, requiredValue = 'yes', notes) => {
    const answers = [{ questionId: scenario.requiredQuestionId, value: requiredValue }];
    if (notes !== undefined) answers.push({ questionId: scenario.optionalQuestionId, value: notes });
    return answers;
  };

  const findResponseRow = (scenario) =>
    prisma.anamnesisResponse.findUnique({
      where: {
        anamnesisId_studentId: { anamnesisId: scenario.anamnesisId, studentId: scenario.student.userId },
      },
      include: { answers: true },
    });

  const expectErrorContract = (response, { statusCode, error, messageCode }) => {
    expect(response.statusCode).toBe(statusCode);
    const body = response.json();
    expect(body).toMatchObject({ error, messageCode, message: expect.any(String) });
    // `details` is only serialized when the AppError carries some
    expect(Object.keys(body).every((key) => ['error', 'messageCode', 'message', 'details'].includes(key))).toBe(true);
  };

  const summaryStatusFor = (listBody, anamnesisId) =>
    listBody.find((item) => item.anamnesisId === anamnesisId).response;

  // ─── GET .../fill ──────────────────────────────────────────────────────────

  describe('GET /trainer/students/:studentId/anamneses/:anamnesisId/fill', () => {
    it('returns 400 VALIDATION_ERROR without the studentPresent attestation', async () => {
      const scenario = await setupScenario();

      const response = await trainerGetFill(scenario, { query: '' });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
        message: expect.any(String),
        details: expect.any(Array),
      });
    });

    it('returns 400 VALIDATION_ERROR with studentPresent=false', async () => {
      const scenario = await setupScenario();

      const response = await trainerGetFill(scenario, { query: '?studentPresent=false' });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('returns the full anamnesis and a null response when the student has not started', async () => {
      const scenario = await setupScenario();

      const response = await trainerGetFill(scenario);

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.response).toBeNull();
      expect(body.anamnesis.id).toBe(scenario.anamnesisId);
      expect(body.anamnesis.sections[0].questions).toHaveLength(2);
    });

    it('returns the student draft as the current response', async () => {
      const scenario = await setupScenario();
      expect((await studentSaveDraft(scenario, answersFor(scenario, 'no'))).statusCode).toBe(200);

      const response = await trainerGetFill(scenario);

      expect(response.statusCode).toBe(200);
      const { response: current } = response.json();
      expect(current).toMatchObject({
        studentId: scenario.student.userId,
        status: AnamnesisResponseStatus.DRAFT,
        filledBy: AnamnesisFilledBy.STUDENT,
        submittedAt: null,
      });
      expect(current.answers).toHaveLength(1);
      expect(current.answers[0].value).toBe('no');
    });

    it('returns the trainer-submitted response as awaiting_confirmation', async () => {
      const scenario = await setupScenario();
      await trainerSubmit(scenario, answersFor(scenario));

      const response = await trainerGetFill(scenario);

      expect(response.json().response).toMatchObject({
        status: AnamnesisResponseStatus.AWAITING_CONFIRMATION,
        filledBy: AnamnesisFilledBy.TRAINER,
      });
    });
  });

  // ─── PATCH draft / POST submit validation ──────────────────────────────────

  describe('PATCH .../response/draft (trainer)', () => {
    it('saves a draft on the student behalf and keeps it private from the dossier', async () => {
      const scenario = await setupScenario();

      const response = await trainerSaveDraft(scenario, answersFor(scenario, 'yes', 'started by trainer'));

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        studentId: scenario.student.userId,
        status: AnamnesisResponseStatus.DRAFT,
        submittedAt: null,
      });
      expect(response.json().answers).toHaveLength(2);
      expect((await trainerGetDossier(scenario)).statusCode).toBe(404);
    });

    it('returns 400 for an empty answers array', async () => {
      const scenario = await setupScenario();

      const response = await trainerSaveDraft(scenario, []);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it.each([
      ['student-submitted', 'student'],
      ['trainer-submitted', 'trainer'],
    ])('returns 409 ANAMNESIS_RESPONSE_ALREADY_SUBMITTED over a %s response', async (_label, author) => {
      const scenario = await setupScenario();
      if (author === 'student') await studentSubmit(scenario, answersFor(scenario));
      else await trainerSubmit(scenario, answersFor(scenario));

      const response = await trainerSaveDraft(scenario, answersFor(scenario, 'no'));

      expectErrorContract(response, {
        statusCode: 409,
        error: AnamnesisErrorCode.ANAMNESIS_RESPONSE_ALREADY_SUBMITTED,
        messageCode: AnamnesisMessageCode.ANAMNESIS_RESPONSE_ALREADY_SUBMITTED,
      });
    });
  });

  describe('POST .../response (trainer)', () => {
    it('returns 400 without the attestation', async () => {
      const scenario = await setupScenario();

      const response = await app.inject({
        method: 'POST',
        url: trainerUrl(scenario.student.userId, scenario.anamnesisId, '/response'),
        headers: bearer(scenario.trainer.accessToken),
        payload: { answers: answersFor(scenario) },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
      expect(await findResponseRow(scenario)).toBeNull();
    });

    it('returns 400 with attestation.studentPresent=false', async () => {
      const scenario = await setupScenario();

      const response = await app.inject({
        method: 'POST',
        url: trainerUrl(scenario.student.userId, scenario.anamnesisId, '/response'),
        headers: bearer(scenario.trainer.accessToken),
        payload: { answers: answersFor(scenario), attestation: { studentPresent: false } },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
      expect(await findResponseRow(scenario)).toBeNull();
    });

    it('returns 400 when a required visible question is not answered', async () => {
      const scenario = await setupScenario();

      const response = await trainerSubmit(scenario, [
        { questionId: scenario.optionalQuestionId, value: 'only notes' },
      ]);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('returns 404 ANAMNESIS_QUESTION_NOT_FOUND for a question outside the anamnesis', async () => {
      const scenario = await setupScenario();

      const response = await trainerSubmit(scenario, [
        ...answersFor(scenario),
        { questionId: '00000000-0000-0000-0000-000000000099', value: 'x' },
      ]);

      expectErrorContract(response, {
        statusCode: 404,
        error: AnamnesisErrorCode.ANAMNESIS_QUESTION_NOT_FOUND,
        messageCode: AnamnesisMessageCode.ANAMNESIS_QUESTION_NOT_FOUND,
      });
    });

    it('returns 400 for a duplicated questionId', async () => {
      const scenario = await setupScenario();

      const response = await trainerSubmit(scenario, [
        { questionId: scenario.requiredQuestionId, value: 'yes' },
        { questionId: scenario.requiredQuestionId, value: 'no' },
      ]);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
      expect(await findResponseRow(scenario)).toBeNull();
    });
  });

  // ─── Full flow ─────────────────────────────────────────────────────────────

  describe('full flow: trainer fills, student confirms', () => {
    it('goes draft -> awaiting_confirmation -> submitted with the expected authorship at each step', async () => {
      const scenario = await setupScenario();
      const { trainer, student, anamnesisId } = scenario;

      // Student had started a draft; the trainer sees it in the fill context
      await studentSaveDraft(scenario, answersFor(scenario, 'no'));
      const fillWithDraft = await trainerGetFill(scenario);
      expect(fillWithDraft.json().response.status).toBe(AnamnesisResponseStatus.DRAFT);

      // Trainer continues the draft
      const draft = await trainerSaveDraft(scenario, answersFor(scenario, 'yes', 'trainer note'));
      expect(draft.statusCode).toBe(200);
      expect(draft.json().status).toBe(AnamnesisResponseStatus.DRAFT);

      // Trainer finalizes
      const submitted = await trainerSubmit(scenario, answersFor(scenario, 'yes', 'trainer note'));
      expect(submitted.statusCode).toBe(200);
      expect(submitted.json()).toMatchObject({
        status: AnamnesisResponseStatus.AWAITING_CONFIRMATION,
        filledBy: AnamnesisFilledBy.TRAINER,
        submittedAt: expect.any(String),
        trainerAttestedAt: expect.any(String),
        studentConfirmedAt: null,
      });
      expect(submitted.json().answers).toHaveLength(2);

      const row = await findResponseRow(scenario);
      expect(row).toMatchObject({
        filledByRole: AnamnesisFilledBy.TRAINER,
        filledByUserId: trainer.userId,
        studentConfirmedAt: null,
      });
      expect(row.trainerAttestedAt).toBeInstanceOf(Date);

      // Student sees it awaiting confirmation
      const listBefore = await studentList(scenario);
      expect(listBefore.statusCode).toBe(200);
      expect(summaryStatusFor(listBefore.json(), anamnesisId)).toMatchObject({
        status: AnamnesisResponseStatus.AWAITING_CONFIRMATION,
        answeredCount: 2,
      });

      // Trainer dossier already shows the awaiting response
      const dossierBefore = await trainerGetDossier(scenario);
      expect(dossierBefore.statusCode).toBe(200);
      expect(dossierBefore.json().status).toBe(AnamnesisResponseStatus.AWAITING_CONFIRMATION);

      // Student confirms
      const confirmed = await studentConfirm(scenario);
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json()).toMatchObject({
        status: AnamnesisResponseStatus.SUBMITTED,
        filledBy: AnamnesisFilledBy.TRAINER,
        studentConfirmedAt: expect.any(String),
      });
      expect(confirmed.json().answers).toHaveLength(2);

      const listAfter = await studentList(scenario);
      expect(summaryStatusFor(listAfter.json(), anamnesisId).status).toBe(AnamnesisResponseStatus.SUBMITTED);

      // Trainer dossier shows the confirmed, trainer-authored response
      const dossierAfter = await trainerGetDossier(scenario);
      expect(dossierAfter.statusCode).toBe(200);
      expect(dossierAfter.json()).toMatchObject({
        studentId: student.userId,
        status: AnamnesisResponseStatus.SUBMITTED,
        filledBy: AnamnesisFilledBy.TRAINER,
        studentConfirmedAt: expect.any(String),
        trainerAttestedAt: expect.any(String),
      });
    });

    it('confirming leaves the answers untouched', async () => {
      const scenario = await setupScenario();
      const submitted = await trainerSubmit(scenario, answersFor(scenario, 'yes', 'as filled by trainer'));
      const answersBefore = submitted.json().answers.map(({ questionId, value }) => ({ questionId, value }));

      const confirmed = await studentConfirm(scenario);

      const answersAfter = confirmed.json().answers.map(({ questionId, value }) => ({ questionId, value }));
      expect(answersAfter).toEqual(expect.arrayContaining(answersBefore));
      expect(answersAfter).toHaveLength(answersBefore.length);
    });

    it('lets the trainer re-finalize an already confirmed trainer submission, resetting the confirmation', async () => {
      const scenario = await setupScenario();
      await trainerSubmit(scenario, answersFor(scenario, 'yes'));
      await studentConfirm(scenario);

      const refinalized = await trainerSubmit(scenario, answersFor(scenario, 'no'));

      expect(refinalized.statusCode).toBe(200);
      expect(refinalized.json()).toMatchObject({
        status: AnamnesisResponseStatus.AWAITING_CONFIRMATION,
        studentConfirmedAt: null,
      });
      expect(refinalized.json().answers[0].value).toBe('no');
    });

    it('drops answers of hidden conditional questions on the trainer submit', async () => {
      const trainer = await createTrainer();
      const student = await createStudent();
      await linkStudent(trainer, student);
      const created = await app.inject({
        method: 'POST',
        url: '/trainer/anamneses',
        headers: bearer(trainer.accessToken),
        payload: {
          title: 'Conditional',
          sections: [
            {
              title: 'S',
              questions: [{ text: 'Injured?', type: AnamnesisQuestionType.DICHOTOMOUS, required: true }],
            },
          ],
        },
      });
      const anamnesisId = created.json().id;
      const sectionId = created.json().sections[0].id;
      const parentId = created.json().sections[0].questions[0].id;
      const childResponse = await app.inject({
        method: 'POST',
        url: `/trainer/anamneses/${anamnesisId}/sections/${sectionId}/questions`,
        headers: bearer(trainer.accessToken),
        payload: {
          text: 'Where?',
          type: AnamnesisQuestionType.FREE_TEXT,
          required: true,
          parentQuestionId: parentId,
          condition: { operator: 'equals', value: 'yes' },
        },
      });
      expect(childResponse.statusCode).toBe(201);
      const childId = childResponse.json().id;
      await linkAnamnesis(trainer, student.userId, anamnesisId);

      const response = await app.inject({
        method: 'POST',
        url: trainerUrl(student.userId, anamnesisId, '/response'),
        headers: bearer(trainer.accessToken),
        payload: attestedBody([
          { questionId: parentId, value: 'no' },
          { questionId: childId, value: 'ghost answer' },
        ]),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().answers.map((a) => a.questionId)).toEqual([parentId]);
    });
  });

  // ─── Student vs trainer authorship ────────────────────────────────────────

  describe('student and trainer authorship conflicts', () => {
    it('returns 409 ANAMNESIS_RESPONSE_SUBMITTED_BY_STUDENT when the student already submitted', async () => {
      const scenario = await setupScenario();
      expect((await studentSubmit(scenario, answersFor(scenario, 'no'))).statusCode).toBe(200);

      const response = await trainerSubmit(scenario, answersFor(scenario, 'yes'));

      expectErrorContract(response, {
        statusCode: 409,
        error: AnamnesisErrorCode.ANAMNESIS_RESPONSE_SUBMITTED_BY_STUDENT,
        messageCode: AnamnesisMessageCode.ANAMNESIS_RESPONSE_SUBMITTED_BY_STUDENT,
      });
      const row = await findResponseRow(scenario);
      expect(row).toMatchObject({ filledByRole: AnamnesisFilledBy.STUDENT, trainerAttestedAt: null });
      expect(row.answers.map((a) => a.value)).toEqual(['no']);
    });

    it('lets the student correct a trainer-filled response: submitted, student-authored, attestation cleared', async () => {
      const scenario = await setupScenario();
      await trainerSubmit(scenario, answersFor(scenario, 'yes', 'trainer version'));

      const response = await studentSubmit(scenario, answersFor(scenario, 'no'));

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: AnamnesisResponseStatus.SUBMITTED,
        filledBy: AnamnesisFilledBy.STUDENT,
        trainerAttestedAt: null,
        studentConfirmedAt: expect.any(String),
      });
      expect(response.json().answers).toHaveLength(1);
      const row = await findResponseRow(scenario);
      expect(row.filledByUserId).toBe(scenario.student.userId);
    });

    it('a student submission records the student as author and confirms it right away', async () => {
      const scenario = await setupScenario();

      const response = await studentSubmit(scenario, answersFor(scenario));

      expect(response.json()).toMatchObject({
        status: AnamnesisResponseStatus.SUBMITTED,
        filledBy: AnamnesisFilledBy.STUDENT,
        trainerAttestedAt: null,
        studentConfirmedAt: expect.any(String),
      });
      expect((await findResponseRow(scenario)).filledByUserId).toBe(scenario.student.userId);
    });

    it('a student draft never records authorship as trainer', async () => {
      const scenario = await setupScenario();

      await trainerSaveDraft(scenario, answersFor(scenario));

      const row = await findResponseRow(scenario);
      expect(row).toMatchObject({
        submittedAt: null,
        filledByRole: AnamnesisFilledBy.STUDENT,
        filledByUserId: null,
        trainerAttestedAt: null,
        studentConfirmedAt: null,
      });
    });

    it('lets the trainer finalize over a student draft', async () => {
      const scenario = await setupScenario();
      await studentSaveDraft(scenario, answersFor(scenario, 'no', 'student draft note'));

      const response = await trainerSubmit(scenario, answersFor(scenario, 'yes'));

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe(AnamnesisResponseStatus.AWAITING_CONFIRMATION);
      expect(response.json().answers).toHaveLength(1);
    });
  });

  // ─── Confirm ───────────────────────────────────────────────────────────────

  describe('POST /my/anamneses/:anamnesisId/response/confirm', () => {
    it('returns 404 ANAMNESIS_NOT_LINKED_TO_STUDENT when the anamnesis is not linked to the student', async () => {
      const student = await createStudent();

      const response = await app.inject({
        method: 'POST',
        url: '/my/anamneses/00000000-0000-0000-0000-000000000099/response/confirm',
        headers: bearer(student.accessToken),
      });

      expectErrorContract(response, {
        statusCode: 404,
        error: AnamnesisErrorCode.ANAMNESIS_NOT_LINKED_TO_STUDENT,
        messageCode: AnamnesisMessageCode.ANAMNESIS_NOT_LINKED_TO_STUDENT,
      });
    });

    it('returns 404 ANAMNESIS_RESPONSE_NOT_FOUND when the student has no response yet', async () => {
      const scenario = await setupScenario();

      const response = await studentConfirm(scenario);

      expectErrorContract(response, {
        statusCode: 404,
        error: AnamnesisErrorCode.ANAMNESIS_RESPONSE_NOT_FOUND,
        messageCode: AnamnesisMessageCode.ANAMNESIS_RESPONSE_NOT_FOUND,
      });
    });

    it('returns 401 without authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/my/anamneses/00000000-0000-0000-0000-000000000099/response/confirm',
      });

      expect(response.statusCode).toBe(401);
    });

    it.each([
      ['a draft', async (s) => studentSaveDraft(s, answersFor(s))],
      ['a student-submitted response', async (s) => studentSubmit(s, answersFor(s))],
      [
        'an already confirmed trainer-filled response',
        async (s) => {
          await trainerSubmit(s, answersFor(s));
          await studentConfirm(s);
        },
      ],
    ])('returns 409 ANAMNESIS_RESPONSE_NOT_AWAITING_CONFIRMATION for %s', async (_label, arrange) => {
      const scenario = await setupScenario();
      await arrange(scenario);

      const response = await studentConfirm(scenario);

      expectErrorContract(response, {
        statusCode: 409,
        error: AnamnesisErrorCode.ANAMNESIS_RESPONSE_NOT_AWAITING_CONFIRMATION,
        messageCode: AnamnesisMessageCode.ANAMNESIS_RESPONSE_NOT_AWAITING_CONFIRMATION,
      });
    });

    it('does not let a second confirmation change the original studentConfirmedAt', async () => {
      const scenario = await setupScenario();
      await trainerSubmit(scenario, answersFor(scenario));
      await studentConfirm(scenario);
      const { studentConfirmedAt } = await findResponseRow(scenario);

      const second = await studentConfirm(scenario);

      expect(second.statusCode).toBe(409);
      expect((await findResponseRow(scenario)).studentConfirmedAt).toEqual(studentConfirmedAt);
    });

    it('does not let another student confirm someone else response', async () => {
      const scenario = await setupScenario();
      await trainerSubmit(scenario, answersFor(scenario));
      const otherStudent = await createStudent('other-student');

      const response = await app.inject({
        method: 'POST',
        url: `/my/anamneses/${scenario.anamnesisId}/response/confirm`,
        headers: bearer(otherStudent.accessToken),
      });

      expect(response.statusCode).toBe(404);
      expect((await findResponseRow(scenario)).studentConfirmedAt).toBeNull();
    });
  });

  // ─── Access guard on the three trainer routes ─────────────────────────────

  describe('access guard', () => {
    const routes = [
      [
        'GET .../fill',
        (s, token, studentId = s.student.userId) =>
          app.inject({
            method: 'GET',
            url: fillUrl(studentId, s.anamnesisId),
            headers: bearer(token),
          }),
      ],
      [
        'PATCH .../response/draft',
        (s, token, studentId = s.student.userId) =>
          app.inject({
            method: 'PATCH',
            url: trainerUrl(studentId, s.anamnesisId, '/response/draft'),
            headers: bearer(token),
            payload: { answers: answersFor(s) },
          }),
      ],
      [
        'POST .../response',
        (s, token, studentId = s.student.userId) =>
          app.inject({
            method: 'POST',
            url: trainerUrl(studentId, s.anamnesisId, '/response'),
            headers: bearer(token),
            payload: attestedBody(answersFor(s)),
          }),
      ],
    ];

    describe.each(routes)('%s', (_name, call) => {
      it('returns 401 without authentication', async () => {
        const scenario = await setupScenario();
        const response = await call(scenario, '');
        // an empty bearer is an invalid token
        expect(response.statusCode).toBe(401);
      });

      it('returns 403 for a student calling a trainer route', async () => {
        const scenario = await setupScenario();

        const response = await call(scenario, scenario.student.accessToken);

        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          error: expect.any(String),
          messageCode: expect.any(String),
          message: expect.any(String),
        });
        expect(await findResponseRow(scenario)).toBeNull();
      });

      it('returns 404 STUDENT_NOT_FOUND when the student is not linked to the trainer', async () => {
        const scenario = await setupScenario();
        const stranger = await createTrainer('stranger-trainer');

        const response = await call(scenario, stranger.accessToken);

        expectErrorContract(response, {
          statusCode: 404,
          error: AnamnesisErrorCode.STUDENT_NOT_FOUND,
          messageCode: AnamnesisMessageCode.STUDENT_NOT_FOUND,
        });
        expect(await findResponseRow(scenario)).toBeNull();
      });

      it('returns 404 ANAMNESIS_NOT_LINKED_TO_STUDENT for another trainer linked to the student who did not link this anamnesis', async () => {
        const scenario = await setupScenario();
        const otherTrainer = await createTrainer('other-trainer');
        await linkStudent(otherTrainer, scenario.student);

        const response = await call(scenario, otherTrainer.accessToken);

        expectErrorContract(response, {
          statusCode: 404,
          error: AnamnesisErrorCode.ANAMNESIS_NOT_LINKED_TO_STUDENT,
          messageCode: AnamnesisMessageCode.ANAMNESIS_NOT_LINKED_TO_STUDENT,
        });
        expect(await findResponseRow(scenario)).toBeNull();
      });

      it('returns 404 ANAMNESIS_NOT_LINKED_TO_STUDENT when the anamnesis exists but was never linked to the student', async () => {
        const scenario = await setupScenario();
        const unlinked = await createAnamnesis(scenario.trainer);

        const response = await call({ ...scenario, ...unlinked }, scenario.trainer.accessToken);

        expectErrorContract(response, {
          statusCode: 404,
          error: AnamnesisErrorCode.ANAMNESIS_NOT_LINKED_TO_STUDENT,
          messageCode: AnamnesisMessageCode.ANAMNESIS_NOT_LINKED_TO_STUDENT,
        });
      });

      it('returns 403 STUDENT_BLOCKED_ON_PLAN when the student is not active on the trainer plan', async () => {
        const scenario = await setupScenario();
        await prisma.trainerStudent.update({
          where: {
            trainerId_studentId: { trainerId: scenario.trainer.trainerId, studentId: scenario.student.userId },
          },
          data: { activeOnPlan: false },
        });

        const response = await call(scenario, scenario.trainer.accessToken);

        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          error: PLATFORM_PLAN_ERRORS.STUDENT_BLOCKED_ON_PLAN.code,
          messageCode: PLATFORM_PLAN_ERRORS.STUDENT_BLOCKED_ON_PLAN.messageCode,
        });
        expect(await findResponseRow(scenario)).toBeNull();
      });
    });

    it('another trainer cannot see or replace the answers of a response filled by the owning trainer', async () => {
      const scenario = await setupScenario();
      await trainerSubmit(scenario, answersFor(scenario, 'yes'));
      const otherTrainer = await createTrainer('other-trainer');
      await linkStudent(otherTrainer, scenario.student);

      const response = await trainerSubmit(scenario, answersFor(scenario, 'no'), { trainer: otherTrainer });

      expect(response.statusCode).toBe(404);
      expect((await findResponseRow(scenario)).answers.map((a) => a.value)).toEqual(['yes']);
    });
  });

  // ─── Two trainers sharing a general anamnesis ─────────────────────────────

  describe('two trainers sharing a general anamnesis with the same student', () => {
    /**
     * A general (public) anamnesis linked directly by two trainers to the same student:
     * both links point to the same anamnesis id, so both trainers reach the same response row.
     */
    async function setupSharedScenario() {
      const trainerA = await createTrainer('trainer-a');
      const trainerB = await createTrainer('trainer-b');
      const student = await createStudent();
      await linkStudent(trainerA, student);
      await linkStudent(trainerB, student);

      const general = await prisma.anamnesis.create({
        data: {
          title: 'General Health Form',
          isGeneral: true,
          sections: {
            create: [{
              title: 'Section A',
              order: 0,
              questions: {
                create: [
                  { text: 'Do you smoke?', type: AnamnesisQuestionType.DICHOTOMOUS, required: true, order: 0 },
                  { text: 'Any notes?', type: AnamnesisQuestionType.FREE_TEXT, order: 1 },
                ],
              },
            }],
          },
        },
        include: { sections: { include: { questions: { orderBy: { order: 'asc' } } } } },
      });
      const [requiredQuestion, optionalQuestion] = general.sections[0].questions;
      await linkAnamnesis(trainerA, student.userId, general.id);
      await linkAnamnesis(trainerB, student.userId, general.id);

      const shared = {
        student,
        anamnesisId: general.id,
        requiredQuestionId: requiredQuestion.id,
        optionalQuestionId: optionalQuestion.id,
      };
      return { asA: { ...shared, trainer: trainerA }, asB: { ...shared, trainer: trainerB } };
    }

    it('blocks trainer B from finalizing over trainer A\'s submission (409) and keeps A\'s answers', async () => {
      const { asA, asB } = await setupSharedScenario();
      expect((await trainerSubmit(asA, answersFor(asA, 'yes'))).statusCode).toBe(200);

      const response = await trainerSubmit(asB, answersFor(asB, 'no'));

      expectErrorContract(response, {
        statusCode: 409,
        error: AnamnesisErrorCode.ANAMNESIS_RESPONSE_FILLED_BY_ANOTHER_TRAINER,
        messageCode: AnamnesisMessageCode.ANAMNESIS_RESPONSE_FILLED_BY_ANOTHER_TRAINER,
      });
      const row = await findResponseRow(asA);
      expect(row.filledByUserId).toBe(asA.trainer.userId);
      expect(row.answers.map((answer) => answer.value)).toEqual(['yes']);
    });

    it('reports canFinalize false to trainer B and true to trainer A', async () => {
      const { asA, asB } = await setupSharedScenario();
      await trainerSubmit(asA, answersFor(asA, 'yes'));

      const fillA = await trainerGetFill(asA);
      const fillB = await trainerGetFill(asB);

      expect(fillA.statusCode).toBe(200);
      expect(fillA.json().canFinalize).toBe(true);
      expect(fillB.statusCode).toBe(200);
      expect(fillB.json().canFinalize).toBe(false);
    });

    it('lets trainer A re-finalize their own submission', async () => {
      const { asA } = await setupSharedScenario();
      await trainerSubmit(asA, answersFor(asA, 'yes'));

      const response = await trainerSubmit(asA, answersFor(asA, 'no'));

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe(AnamnesisResponseStatus.AWAITING_CONFIRMATION);
    });

    it('lets trainer B take over when trainer A\'s user no longer exists (filledByUserId SET NULL)', async () => {
      const { asA, asB } = await setupSharedScenario();
      await trainerSubmit(asA, answersFor(asA, 'yes'));
      await prisma.anamnesisResponse.update({
        where: { anamnesisId_studentId: { anamnesisId: asA.anamnesisId, studentId: asA.student.userId } },
        data: { filledByUserId: null },
      });

      const fillB = await trainerGetFill(asB);
      const response = await trainerSubmit(asB, answersFor(asB, 'no'));

      expect(fillB.json().canFinalize).toBe(true);
      expect(response.statusCode).toBe(200);
      expect((await findResponseRow(asB)).filledByUserId).toBe(asB.trainer.userId);
    });

    it('returns the pt-BR message for the 409 by default', async () => {
      const { asA, asB } = await setupSharedScenario();
      await trainerSubmit(asA, answersFor(asA, 'yes'));

      const response = await trainerSubmit(asB, answersFor(asB, 'no'));

      expect(response.json().message).toBe('Esta anamnese foi preenchida por outro professor.');
    });
  });

  // ─── i18n ──────────────────────────────────────────────────────────────────

  describe('i18n', () => {
    it('returns English labels with app-language en-US', async () => {
      const scenario = await setupScenario();

      const submit = await trainerSubmit(scenario, answersFor(scenario), { headers: { [LANG_HEADER]: EN_US } });
      const list = await studentList(scenario, { headers: { [LANG_HEADER]: EN_US } });

      expect(submit.json()).toMatchObject({
        status: AnamnesisResponseStatus.AWAITING_CONFIRMATION,
        statusLabel: 'Awaiting confirmation',
        filledBy: AnamnesisFilledBy.TRAINER,
        filledByLabel: 'Trainer',
      });
      expect(summaryStatusFor(list.json(), scenario.anamnesisId)).toMatchObject({
        status: AnamnesisResponseStatus.AWAITING_CONFIRMATION,
        statusLabel: 'Awaiting confirmation',
      });
    });

    it('returns Portuguese labels with app-language pt-BR and by default', async () => {
      const scenario = await setupScenario();

      const submit = await trainerSubmit(scenario, answersFor(scenario), { headers: { [LANG_HEADER]: PT_BR } });
      const defaultLanguage = await trainerGetDossier(scenario);

      expect(submit.json()).toMatchObject({ statusLabel: 'Aguardando confirmação', filledByLabel: 'Professor' });
      expect(defaultLanguage.json()).toMatchObject({
        statusLabel: 'Aguardando confirmação',
        filledByLabel: 'Professor',
      });
    });

    it('labels a student-authored submission as Student / Aluno', async () => {
      const scenario = await setupScenario();
      await studentSubmit(scenario, answersFor(scenario));

      const english = await trainerGetDossier(scenario, { headers: { [LANG_HEADER]: EN_US } });
      const portuguese = await trainerGetDossier(scenario, { headers: { [LANG_HEADER]: PT_BR } });

      expect(english.json()).toMatchObject({ statusLabel: 'Submitted', filledByLabel: 'Student' });
      expect(portuguese.json()).toMatchObject({ statusLabel: 'Enviada', filledByLabel: 'Aluno' });
    });

    it.each([
      [EN_US, 'The student has already submitted this anamnesis.'],
      [PT_BR, 'O aluno já enviou esta anamnese.'],
    ])('translates the submittedByStudent 409 message for %s and keeps the messageCode', async (language, message) => {
      const scenario = await setupScenario();
      await studentSubmit(scenario, answersFor(scenario));

      const response = await trainerSubmit(scenario, answersFor(scenario), { headers: { [LANG_HEADER]: language } });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: AnamnesisErrorCode.ANAMNESIS_RESPONSE_SUBMITTED_BY_STUDENT,
        messageCode: 'anamnesis.response.submittedByStudent',
        message,
      });
    });

    it.each([
      [EN_US, 'This anamnesis is not awaiting confirmation.'],
      [PT_BR, 'Esta anamnese não está aguardando confirmação.'],
    ])('translates the notAwaitingConfirmation 409 message for %s and keeps the messageCode', async (language, message) => {
      const scenario = await setupScenario();
      await studentSubmit(scenario, answersFor(scenario));

      const response = await studentConfirm(scenario, { headers: { [LANG_HEADER]: language } });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: AnamnesisErrorCode.ANAMNESIS_RESPONSE_NOT_AWAITING_CONFIRMATION,
        messageCode: 'anamnesis.response.notAwaitingConfirmation',
        message,
      });
    });
  });

  // ─── Legacy rows & authorship persistence ─────────────────────────────────

  describe('legacy rows and persistence', () => {
    it('treats a submitted row created with column defaults as student-authored and submitted', async () => {
      const scenario = await setupScenario();
      await prisma.anamnesisResponse.create({
        data: {
          anamnesisId: scenario.anamnesisId,
          studentId: scenario.student.userId,
          submittedAt: new Date('2026-01-10T12:00:00.000Z'),
        },
      });

      const row = await findResponseRow(scenario);
      expect(row).toMatchObject({
        filledByRole: AnamnesisFilledBy.STUDENT,
        filledByUserId: null,
        trainerAttestedAt: null,
        studentConfirmedAt: null,
      });

      const list = await studentList(scenario);
      expect(summaryStatusFor(list.json(), scenario.anamnesisId).status).toBe(AnamnesisResponseStatus.SUBMITTED);

      const dossier = await trainerGetDossier(scenario);
      expect(dossier.statusCode).toBe(200);
      expect(dossier.json()).toMatchObject({
        status: AnamnesisResponseStatus.SUBMITTED,
        filledBy: AnamnesisFilledBy.STUDENT,
        studentConfirmedAt: null,
      });

      // It is a student submission: the trainer cannot overwrite it and the student cannot "confirm" it
      expect((await trainerSubmit(scenario, answersFor(scenario))).statusCode).toBe(409);
      expect((await studentConfirm(scenario)).statusCode).toBe(409);
    });

    it('keeps filledByRole trainer and nulls filledByUserId when the filling user is deleted', async () => {
      // A trainer who owns anamneses with responses cannot be deleted (Restrict on the anamnesis), so the
      // filler is re-pointed at a dependency-free user to exercise the ON DELETE SET NULL rule of the column.
      const scenario = await setupScenario();
      await trainerSubmit(scenario, answersFor(scenario));
      const filler = await prisma.user.create({ data: { email: uniqueEmail('filler'), roles: [] } });
      await prisma.anamnesisResponse.updateMany({
        where: { anamnesisId: scenario.anamnesisId },
        data: { filledByUserId: filler.id },
      });
      expect((await findResponseRow(scenario)).filledByUserId).toBe(filler.id);

      await prisma.user.delete({ where: { id: filler.id } });

      const row = await findResponseRow(scenario);
      expect(row).toMatchObject({ filledByRole: AnamnesisFilledBy.TRAINER, filledByUserId: null });
      const list = await studentList(scenario);
      expect(summaryStatusFor(list.json(), scenario.anamnesisId).status).toBe(
        AnamnesisResponseStatus.AWAITING_CONFIRMATION,
      );
      const dossier = await trainerGetDossier(scenario);
      expect(dossier.json()).toMatchObject({
        status: AnamnesisResponseStatus.AWAITING_CONFIRMATION,
        filledBy: AnamnesisFilledBy.TRAINER,
      });
    });
  });

  // ─── Concurrency ───────────────────────────────────────────────────────────

  describe('concurrency', () => {
    it('trainer POST racing student POST always ends student-authored and consistent', async () => {
      const scenario = await setupScenario();

      for (let iteration = 0; iteration < RACE_ITERATIONS; iteration += 1) {
        await prisma.anamnesisResponse.deleteMany({ where: { anamnesisId: scenario.anamnesisId } });

        const [trainerResult, studentResult] = await Promise.all([
          trainerSubmit(scenario, answersFor(scenario, 'yes', 'trainer')),
          studentSubmit(scenario, answersFor(scenario, 'no')),
        ]);

        // The student is never rejected; the trainer either won first or was rejected by the student submission
        expect(studentResult.statusCode).toBe(200);
        expect([200, 409]).toContain(trainerResult.statusCode);
        if (trainerResult.statusCode === 409) {
          expect(trainerResult.json().error).toBe(AnamnesisErrorCode.ANAMNESIS_RESPONSE_SUBMITTED_BY_STUDENT);
          expect(trainerResult.json().messageCode).toBe(AnamnesisMessageCode.ANAMNESIS_RESPONSE_SUBMITTED_BY_STUDENT);
        }

        // The student submission is always the last writer, so the final row is entirely the student's
        const rows = await prisma.anamnesisResponse.findMany({
          where: { anamnesisId: scenario.anamnesisId },
          include: { answers: true },
        });
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row).toMatchObject({
          filledByRole: AnamnesisFilledBy.STUDENT,
          filledByUserId: scenario.student.userId,
          trainerAttestedAt: null,
        });
        expect(row.submittedAt).toBeInstanceOf(Date);
        expect(row.studentConfirmedAt).toBeInstanceOf(Date);
        expect(row.answers.map((a) => a.value)).toEqual(['no']);
      }
    });

    it('two concurrent first trainer POSTs both succeed and create a single row', async () => {
      const scenario = await setupScenario();

      for (let iteration = 0; iteration < RACE_ITERATIONS; iteration += 1) {
        await prisma.anamnesisResponse.deleteMany({ where: { anamnesisId: scenario.anamnesisId } });

        const results = await Promise.all([
          trainerSubmit(scenario, answersFor(scenario, 'yes', 'first')),
          trainerSubmit(scenario, answersFor(scenario, 'no', 'second')),
        ]);

        expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
        const rows = await prisma.anamnesisResponse.findMany({
          where: { anamnesisId: scenario.anamnesisId },
          include: { answers: true },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ filledByRole: AnamnesisFilledBy.TRAINER, studentConfirmedAt: null });
        // Answers belong to exactly one of the two payloads (never a merge of both)
        const values = rows[0].answers.map((a) => a.value).sort();
        expect([['first', 'yes'], ['no', 'second']]).toContainEqual(values);
      }
    });

    it('student confirm racing a trainer re-finalize never leaves a confirmation older than the attestation', async () => {
      const scenario = await setupScenario();

      for (let iteration = 0; iteration < RACE_ITERATIONS; iteration += 1) {
        await prisma.anamnesisResponse.deleteMany({ where: { anamnesisId: scenario.anamnesisId } });
        expect((await trainerSubmit(scenario, answersFor(scenario, 'yes'))).statusCode).toBe(200);

        const [confirmResult, resubmitResult] = await Promise.all([
          studentConfirm(scenario),
          trainerSubmit(scenario, answersFor(scenario, 'no')),
        ]);

        expect([200, 409]).toContain(confirmResult.statusCode);
        expect(resubmitResult.statusCode).toBe(200);
        const row = await findResponseRow(scenario);
        expect(row.filledByRole).toBe(AnamnesisFilledBy.TRAINER);
        if (row.studentConfirmedAt) {
          expect(row.studentConfirmedAt.getTime()).toBeGreaterThanOrEqual(row.trainerAttestedAt.getTime());
        }
      }
    });
  });
});
