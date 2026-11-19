import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: { $disconnect: vi.fn(), trainer: { findUnique: vi.fn() } },
}));

vi.mock('../../src/services/student-feedback-student-service.js', () => ({
  getFeedback: vi.fn(),
  getPendingFeedback: vi.fn(),
  saveDraft: vi.fn(),
  submitFeedback: vi.fn(),
}));

vi.mock('../../src/services/student-feedback-trainer-service.js', () => ({
  countUnread: vi.fn(),
  getStudentHistory: vi.fn(),
  listInbox: vi.fn(),
  markAsRead: vi.fn(),
  sendAdhocFeedback: vi.fn(),
}));

vi.mock('../../src/services/student-feedback-config-service.js', () => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  getMilestoneTemplates: vi.fn(),
  updateMilestoneTemplates: vi.fn(),
}));

vi.mock('../../src/services/student-feedback-template-service.js', () => ({
  listTemplates: vi.fn(),
  getTemplate: vi.fn(),
  duplicateTemplate: vi.fn(),
  saveTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
}));

import { buildServer } from '../../api/server.js';
import emailHandler from '../../src/config/email-handler.js';
import { prisma } from '../../src/db.js';
import { AppError } from '../../src/errors/app-error.js';
import { Roles } from '../../src/constants/roles.js';
import {
  STUDENT_FEEDBACK_TEMPLATE_LIMITS,
  StudentFeedbackMilestone,
  StudentFeedbackPillar,
  StudentFeedbackQuestionCondition,
  StudentFeedbackQuestionType,
  StudentFeedbackStatus,
  StudentFeedbackTemplateErrorCode,
  StudentFeedbackTemplateMessageCode,
} from '../../src/constants/student-feedback.js';
import { getConfig, getMilestoneTemplates, updateConfig, updateMilestoneTemplates } from '../../src/services/student-feedback-config-service.js';
import {
  deleteTemplate,
  duplicateTemplate,
  getTemplate,
  listTemplates,
  saveTemplate,
} from '../../src/services/student-feedback-template-service.js';
import { sendAdhocFeedback } from '../../src/services/student-feedback-trainer-service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TRAINER_ID = '22222222-2222-4222-8222-222222222222';
const STUDENT_ID = '33333333-3333-4333-8333-333333333333';
const FEEDBACK_ID = '44444444-4444-4444-8444-444444444444';
const QUESTION_ID = '55555555-5555-4555-8555-555555555555';
const TEMPLATE_ID = '66666666-6666-4666-8666-666666666666';
const NEW_VERSION_ID = '77777777-7777-4777-8777-777777777777';
const GENERAL_ID = '88888888-8888-4888-8888-888888888888';
const NOT_A_UUID = 'not-a-uuid';
const SENT_AT = '2026-03-10T12:00:00.000Z';
const EXPIRES_AT = '2026-03-13T12:00:00.000Z';
const UPDATED_AT = '2026-03-09T12:00:00.000Z';

// Booting the whole server cold (imports of every route and plugin) can take far longer than the 10 s default hook timeout on a loaded machine
const SERVER_LIFECYCLE_TIMEOUT_MS = 120000;

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const VALIDATION_ERROR = 'VALIDATION_ERROR';
const VALIDATION_MESSAGE_CODE = 'validation.failed';
const FORBIDDEN_ERROR = 'FORBIDDEN';
const FORBIDDEN_MESSAGE_CODE = 'auth.forbidden';
const TRAINER_PROFILE_MISSING_MESSAGE_CODE = 'trainer.notFound';

const TEMPLATES_URL = '/trainer/student-feedbacks/templates';
const TEMPLATE_URL = `${TEMPLATES_URL}/${TEMPLATE_ID}`;
const DUPLICATE_URL = `${TEMPLATE_URL}/duplicate`;
const MILESTONE_TEMPLATES_URL = '/trainer/student-feedbacks/milestone-templates';
const STUDENT_FEEDBACKS_URL = `/trainer/students/${STUDENT_ID}/feedbacks`;

const NO_MILESTONE_TEMPLATES = Object.freeze({ d7: null, d15: null, d21: null, d30: null, recurring: null });
const TEMPLATE_ROUTES = [
  ['GET', TEMPLATES_URL],
  ['GET', TEMPLATE_URL],
  ['POST', DUPLICATE_URL],
  ['PUT', TEMPLATE_URL],
  ['DELETE', TEMPLATE_URL],
  ['GET', MILESTONE_TEMPLATES_URL],
  ['PUT', MILESTONE_TEMPLATES_URL],
];
const ALL_SERVICES = [
  getConfig,
  updateConfig,
  getMilestoneTemplates,
  updateMilestoneTemplates,
  listTemplates,
  getTemplate,
  duplicateTemplate,
  saveTemplate,
  deleteTemplate,
  sendAdhocFeedback,
];

let app = null;
let studentToken = null;
let trainerToken = null;

// Authorization header carrying the given access token
function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

// A question of a save body with every field the builder sends
function scoreQuestion(overrides = {}) {
  return {
    text: 'Como foi tua semana de treino?',
    helpText: 'Pensa nos últimos 7 dias',
    type: StudentFeedbackQuestionType.SCORE,
    pillar: StudentFeedbackPillar.TRAINING_ADHERENCE,
    required: true,
    condition: StudentFeedbackQuestionCondition.HAS_MEAL_PLAN,
    invertScore: false,
    minLabel: 'Péssima',
    maxLabel: 'Ótima',
    ...overrides,
  };
}

// A question of a save body with only the required fields
function openQuestion(overrides = {}) {
  return { text: 'Algo a relatar?', type: StudentFeedbackQuestionType.OPEN, pillar: StudentFeedbackPillar.REPORT, required: false, invertScore: false, ...overrides };
}

// A schema-valid save body unless overridden
function saveBody(overrides = {}) {
  return { name: 'Check-in semanal', questions: [scoreQuestion(), openQuestion()], ...overrides };
}

// A list of the given number of valid questions
function questionList(count) {
  return Array.from({ length: count }, (_unused, index) => openQuestion({ text: `Pergunta ${index + 1}` }));
}

// A text of the given length
function textOf(length) {
  return 'a'.repeat(length);
}

// Save body whose first question has the given field replaced
function bodyWithQuestion(overrides) {
  return saveBody({ questions: [scoreQuestion(overrides)] });
}

// Save body whose first question lacks the given field
function bodyWithoutQuestionField(field) {
  const question = scoreQuestion();
  delete question[field];
  return saveBody({ questions: [question] });
}

// A body that passes the schema of the route, so only auth can reject the call
function validPayloadFor(method, url) {
  if (method === 'PUT' && url === TEMPLATE_URL) return saveBody();
  if (method === 'PUT' && url === MILESTONE_TEMPLATES_URL) return { d7: TEMPLATE_ID };
  return undefined;
}

// Sends the request with an optional access token and a schema-valid body unless one is given
function call(method, url, { token, payload } = {}) {
  return app.inject({
    method,
    url,
    headers: token ? bearer(token) : {},
    payload: payload ?? validPayloadFor(method, url),
  });
}

// Template as the template service returns it for the builder, without the label siblings
function buildTemplate(overrides = {}) {
  return {
    id: TEMPLATE_ID,
    name: 'Check-in semanal',
    isGeneral: false,
    version: 2,
    hasRequests: true,
    milestones: [StudentFeedbackMilestone.D7, StudentFeedbackMilestone.RECURRING],
    questions: [
      {
        id: QUESTION_ID,
        order: 1,
        text: 'Como foi tua semana de treino?',
        helpText: null,
        type: StudentFeedbackQuestionType.SCORE,
        pillar: StudentFeedbackPillar.TRAINING_ADHERENCE,
        required: true,
        condition: null,
        invertScore: false,
        minLabel: 'Péssima',
        maxLabel: 'Ótima',
      },
    ],
    ...overrides,
  };
}

// Template as the template service returns it in the list
function buildListItem(overrides = {}) {
  return { id: TEMPLATE_ID, name: 'Check-in semanal', isGeneral: false, version: 2, questionCount: 3, milestones: [StudentFeedbackMilestone.D7], updatedAt: UPDATED_AT, ...overrides };
}

// Template error of the unified contract, as the services throw it
function templateAppError(key, httpStatus) {
  return new AppError({
    httpStatus,
    error: StudentFeedbackTemplateErrorCode[key],
    messageCode: StudentFeedbackTemplateMessageCode[key],
    message: 'Template error',
    details: {},
  });
}

// Asserts the unified error contract with a template code
function expectTemplateError(res, statusCode, key) {
  expect(res.statusCode).toBe(statusCode);
  expect(res.json()).toMatchObject({
    error: StudentFeedbackTemplateErrorCode[key],
    messageCode: StudentFeedbackTemplateMessageCode[key],
    message: expect.any(String),
  });
  expect(res.json()).toHaveProperty('details');
}

// Asserts a schema rejection in the unified contract
function expectValidationError(res) {
  expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
  expect(res.json()).toMatchObject({ error: VALIDATION_ERROR, messageCode: VALIDATION_MESSAGE_CODE, message: expect.any(String) });
  expect(Array.isArray(res.json().details)).toBe(true);
}

// Asserts that no service of the feature ran
function expectNoServiceCalled() {
  for (const service of ALL_SERVICES) expect(service).not.toHaveBeenCalled();
}

// Leading arguments of the first call of a mocked service
function firstCallArgs(service, count) {
  return service.mock.calls[0].slice(0, count);
}

beforeAll(async () => {
  app = await buildServer({ logger: false, adminDb: { $disconnect: vi.fn() } });
  await app.ready();
  studentToken = app.jwt.sign({ sub: USER_ID, email: 'student@example.com', roles: [] });
  trainerToken = app.jwt.sign({ sub: USER_ID, email: 'trainer@example.com', roles: [Roles.TRAINER] });
}, SERVER_LIFECYCLE_TIMEOUT_MS);

afterAll(async () => {
  await app?.close().catch(() => {});
}, SERVER_LIFECYCLE_TIMEOUT_MS);

beforeEach(() => {
  prisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
});

describe('student-feedback template routes authentication', () => {
  it.each(TEMPLATE_ROUTES)('should reject %s %s without a token with 401', async (method, url) => {
    const res = await call(method, url);

    expect(res.statusCode).toBe(HTTP_UNAUTHORIZED);
    expect(res.json()).toMatchObject({ error: expect.any(String), messageCode: expect.any(String), message: expect.any(String) });
    expectNoServiceCalled();
  });

  it.each(TEMPLATE_ROUTES)('should reject a non-trainer on %s %s with 403 in the unified contract', async (method, url) => {
    const res = await call(method, url, { token: studentToken });

    expect(res.statusCode).toBe(HTTP_FORBIDDEN);
    expect(res.json()).toMatchObject({ error: FORBIDDEN_ERROR, messageCode: FORBIDDEN_MESSAGE_CODE, message: expect.any(String) });
    expect(res.json()).toHaveProperty('details');
    expect(prisma.trainer.findUnique).not.toHaveBeenCalled();
    expectNoServiceCalled();
  });

  it.each(TEMPLATE_ROUTES)('should reject %s %s with 403 trainer.notFound when the user has no trainer profile', async (method, url) => {
    prisma.trainer.findUnique.mockResolvedValue(null);

    const res = await call(method, url, { token: trainerToken });

    expect(res.statusCode).toBe(HTTP_FORBIDDEN);
    expect(res.json()).toMatchObject({ error: FORBIDDEN_ERROR, messageCode: TRAINER_PROFILE_MISSING_MESSAGE_CODE });
    expectNoServiceCalled();
  });
});

describe('student-feedback template routes: list, get and duplicate', () => {
  it('GET /trainer/student-feedbacks/templates should return the templates of the trainer', async () => {
    const general = buildListItem({ id: GENERAL_ID, name: 'Padrão TeuFit', isGeneral: true, version: 1, questionCount: 8, milestones: [StudentFeedbackMilestone.D15] });
    listTemplates.mockResolvedValue([general, buildListItem()]);

    const res = await call('GET', TEMPLATES_URL, { token: trainerToken });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(firstCallArgs(listTemplates, 2)).toEqual([prisma, TRAINER_ID]);
    expect(Object.keys(res.json())).toEqual(['templates']);
    expect(res.json().templates).toHaveLength(2);
    expect(res.json().templates[0]).toMatchObject(general);
    expect(res.json().templates[1]).toMatchObject(buildListItem());
  });

  it('GET /trainer/student-feedbacks/templates should return an empty list as it is', async () => {
    listTemplates.mockResolvedValue([]);

    const res = await call('GET', TEMPLATES_URL, { token: trainerToken });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toEqual({ templates: [] });
  });

  it('GET /trainer/student-feedbacks/templates/:id should return the template with its questions', async () => {
    getTemplate.mockResolvedValue(buildTemplate());

    const res = await call('GET', TEMPLATE_URL, { token: trainerToken });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(firstCallArgs(getTemplate, 3)).toEqual([prisma, TRAINER_ID, TEMPLATE_ID]);
    const { questions, ...header } = buildTemplate();
    expect(res.json().template).toMatchObject(header);
    expect(res.json().template.questions).toEqual([expect.objectContaining(questions[0])]);
  });

  it('GET /trainer/student-feedbacks/templates/:id should add the translated type and pillar labels to each question', async () => {
    getTemplate.mockResolvedValue(buildTemplate());

    const res = await call('GET', TEMPLATE_URL, { token: trainerToken });

    const [question] = res.json().template.questions;
    expect(question.typeLabel).toEqual(expect.any(String));
    expect(question.typeLabel.length).toBeGreaterThan(0);
    expect(question.pillarLabel).toEqual(expect.any(String));
    expect(question.pillarLabel.length).toBeGreaterThan(0);
  });

  it('GET /trainer/student-feedbacks/templates/:id should answer 404 in the unified contract when the service does not find it', async () => {
    getTemplate.mockRejectedValue(templateAppError('NOT_FOUND', HTTP_NOT_FOUND));

    const res = await call('GET', TEMPLATE_URL, { token: trainerToken });

    expectTemplateError(res, HTTP_NOT_FOUND, 'NOT_FOUND');
  });

  it('GET /trainer/student-feedbacks/templates/:id should reject an id that is not a uuid with 400', async () => {
    const res = await call('GET', `${TEMPLATES_URL}/${NOT_A_UUID}`, { token: trainerToken });

    expectValidationError(res);
    expectNoServiceCalled();
  });

  it('POST /trainer/student-feedbacks/templates/:id/duplicate should answer 201 with the copy', async () => {
    const copy = buildTemplate({ id: NEW_VERSION_ID, name: 'Check-in semanal (cópia)', version: 1, hasRequests: false, milestones: [] });
    duplicateTemplate.mockResolvedValue(copy);

    const res = await call('POST', DUPLICATE_URL, { token: trainerToken });

    expect(res.statusCode).toBe(HTTP_CREATED);
    expect(firstCallArgs(duplicateTemplate, 3)).toEqual([prisma, TRAINER_ID, TEMPLATE_ID]);
    expect(res.json().template).toMatchObject({ id: NEW_VERSION_ID, name: 'Check-in semanal (cópia)', version: 1, isGeneral: false, hasRequests: false, milestones: [] });
    expect(res.json().template.questions).toHaveLength(1);
  });

  it('POST /trainer/student-feedbacks/templates/:id/duplicate should reject an id that is not a uuid with 400', async () => {
    const res = await call('POST', `${TEMPLATES_URL}/${NOT_A_UUID}/duplicate`, { token: trainerToken });

    expectValidationError(res);
    expectNoServiceCalled();
  });

  it('POST /trainer/student-feedbacks/templates/:id/duplicate should answer 404 when the service does not find the template', async () => {
    duplicateTemplate.mockRejectedValue(templateAppError('NOT_FOUND', HTTP_NOT_FOUND));

    const res = await call('POST', DUPLICATE_URL, { token: trainerToken });

    expectTemplateError(res, HTTP_NOT_FOUND, 'NOT_FOUND');
  });
});

describe('student-feedback template routes: save', () => {
  it('PUT /trainer/student-feedbacks/templates/:id should pass name and questions to saveTemplate and return the saved template', async () => {
    saveTemplate.mockResolvedValue(buildTemplate());
    const body = saveBody();

    const res = await call('PUT', TEMPLATE_URL, { token: trainerToken, payload: body });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(firstCallArgs(saveTemplate, 4)).toEqual([prisma, TRAINER_ID, TEMPLATE_ID, body]);
    expect(res.json().template).toMatchObject({ id: TEMPLATE_ID, version: 2, hasRequests: true });
  });

  it('PUT /trainer/student-feedbacks/templates/:id should return the id of the new version when the service created one', async () => {
    saveTemplate.mockResolvedValue(buildTemplate({ id: NEW_VERSION_ID, version: 3, hasRequests: false }));

    const res = await call('PUT', TEMPLATE_URL, { token: trainerToken });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json().template).toMatchObject({ id: NEW_VERSION_ID, version: 3, hasRequests: false });
  });

  it('PUT /trainer/student-feedbacks/templates/:id should keep the order of the questions sent', async () => {
    saveTemplate.mockResolvedValue(buildTemplate());
    const questions = questionList(4);

    await call('PUT', TEMPLATE_URL, { token: trainerToken, payload: saveBody({ questions }) });

    expect(saveTemplate.mock.calls[0][3].questions.map((question) => question.text)).toEqual(questions.map((question) => question.text));
  });

  it('PUT /trainer/student-feedbacks/templates/:id should accept the maximum number of questions', async () => {
    saveTemplate.mockResolvedValue(buildTemplate());

    const res = await call('PUT', TEMPLATE_URL, { token: trainerToken, payload: saveBody({ questions: questionList(STUDENT_FEEDBACK_TEMPLATE_LIMITS.maxQuestions) }) });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(saveTemplate.mock.calls[0][3].questions).toHaveLength(STUDENT_FEEDBACK_TEMPLATE_LIMITS.maxQuestions);
  });

  it('PUT /trainer/student-feedbacks/templates/:id should accept texts exactly at their limits', async () => {
    saveTemplate.mockResolvedValue(buildTemplate());
    const limits = STUDENT_FEEDBACK_TEMPLATE_LIMITS;
    const question = scoreQuestion({
      text: textOf(limits.questionTextMaxLength),
      helpText: textOf(limits.helpTextMaxLength),
      minLabel: textOf(limits.labelMaxLength),
      maxLabel: textOf(limits.labelMaxLength),
    });

    const res = await call('PUT', TEMPLATE_URL, { token: trainerToken, payload: saveBody({ name: textOf(limits.nameMaxLength), questions: [question] }) });

    expect(res.statusCode).toBe(HTTP_OK);
  });

  it('PUT /trainer/student-feedbacks/templates/:id should accept the optional fields as null, as the template is read', async () => {
    saveTemplate.mockResolvedValue(buildTemplate());
    const question = scoreQuestion({ helpText: null, condition: null, minLabel: null, maxLabel: null });

    const res = await call('PUT', TEMPLATE_URL, { token: trainerToken, payload: saveBody({ questions: [question] }) });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(saveTemplate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no question', () => saveBody({ questions: [] })],
    ['more questions than the limit', () => saveBody({ questions: questionList(STUDENT_FEEDBACK_TEMPLATE_LIMITS.maxQuestions + 1) })],
    ['no questions field', () => ({ name: 'Check-in semanal' })],
    ['questions that are not a list', () => saveBody({ questions: 'todas' })],
    ['no name', () => ({ questions: [openQuestion()] })],
    ['an empty name', () => saveBody({ name: '' })],
    ['a name over the limit', () => saveBody({ name: textOf(STUDENT_FEEDBACK_TEMPLATE_LIMITS.nameMaxLength + 1) })],
    ['an unknown question type', () => bodyWithQuestion({ type: 'slider' })],
    ['an unknown pillar', () => bodyWithQuestion({ pillar: 'mood' })],
    ['an unknown condition', () => bodyWithQuestion({ condition: 'has_trainer' })],
    ['an empty question text', () => bodyWithQuestion({ text: '' })],
    ['a question text over the limit', () => bodyWithQuestion({ text: textOf(STUDENT_FEEDBACK_TEMPLATE_LIMITS.questionTextMaxLength + 1) })],
    ['a help text over the limit', () => bodyWithQuestion({ helpText: textOf(STUDENT_FEEDBACK_TEMPLATE_LIMITS.helpTextMaxLength + 1) })],
    ['a minimum label over the limit', () => bodyWithQuestion({ minLabel: textOf(STUDENT_FEEDBACK_TEMPLATE_LIMITS.labelMaxLength + 1) })],
    ['a maximum label over the limit', () => bodyWithQuestion({ maxLabel: textOf(STUDENT_FEEDBACK_TEMPLATE_LIMITS.labelMaxLength + 1) })],
    ['a question without text', () => bodyWithoutQuestionField('text')],
    ['a question without type', () => bodyWithoutQuestionField('type')],
    ['a question without pillar', () => bodyWithoutQuestionField('pillar')],
    ['a required flag that is not a boolean', () => bodyWithQuestion({ required: 'sometimes' })],
    ['an invertScore flag that is not a boolean', () => bodyWithQuestion({ invertScore: 'sometimes' })],
  ])('PUT /trainer/student-feedbacks/templates/:id should reject %s with 400 validation.failed', async (_scenario, buildBody) => {
    const res = await call('PUT', TEMPLATE_URL, { token: trainerToken, payload: buildBody() });

    expectValidationError(res);
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it('PUT /trainer/student-feedbacks/templates/:id should reject an id that is not a uuid with 400', async () => {
    const res = await call('PUT', `${TEMPLATES_URL}/${NOT_A_UUID}`, { token: trainerToken, payload: saveBody() });

    expectValidationError(res);
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it.each([
    ['READ_ONLY', HTTP_FORBIDDEN],
    ['NOT_FOUND', HTTP_NOT_FOUND],
    ['INVALID', HTTP_BAD_REQUEST],
  ])('PUT /trainer/student-feedbacks/templates/:id should answer STUDENT_FEEDBACK_TEMPLATE_%s with %i in the unified contract', async (key, statusCode) => {
    saveTemplate.mockRejectedValue(templateAppError(key, statusCode));

    const res = await call('PUT', TEMPLATE_URL, { token: trainerToken });

    expectTemplateError(res, statusCode, key);
  });
});

describe('student-feedback template routes: delete', () => {
  it('DELETE /trainer/student-feedbacks/templates/:id should delete the template of the trainer and answer 204 without body', async () => {
    deleteTemplate.mockResolvedValue(undefined);

    const res = await call('DELETE', TEMPLATE_URL, { token: trainerToken });

    expect(res.statusCode).toBe(HTTP_NO_CONTENT);
    expect(res.body).toBe('');
    expect(firstCallArgs(deleteTemplate, 3)).toEqual([prisma, TRAINER_ID, TEMPLATE_ID]);
  });

  it('DELETE /trainer/student-feedbacks/templates/:id should reject an id that is not a uuid with 400', async () => {
    const res = await call('DELETE', `${TEMPLATES_URL}/${NOT_A_UUID}`, { token: trainerToken });

    expectValidationError(res);
    expect(deleteTemplate).not.toHaveBeenCalled();
  });

  it.each([
    ['READ_ONLY', HTTP_FORBIDDEN],
    ['NOT_FOUND', HTTP_NOT_FOUND],
  ])('DELETE /trainer/student-feedbacks/templates/:id should answer STUDENT_FEEDBACK_TEMPLATE_%s with %i in the unified contract', async (key, statusCode) => {
    deleteTemplate.mockRejectedValue(templateAppError(key, statusCode));

    const res = await call('DELETE', TEMPLATE_URL, { token: trainerToken });

    expectTemplateError(res, statusCode, key);
  });
});

describe('student-feedback milestone-templates routes', () => {
  it('GET /trainer/student-feedbacks/milestone-templates should return the template of each milestone', async () => {
    const stored = { ...NO_MILESTONE_TEMPLATES, d7: TEMPLATE_ID, recurring: NEW_VERSION_ID };
    getMilestoneTemplates.mockResolvedValue(stored);

    const res = await call('GET', MILESTONE_TEMPLATES_URL, { token: trainerToken });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(firstCallArgs(getMilestoneTemplates, 2)).toEqual([prisma, TRAINER_ID]);
    expect(res.json()).toEqual({ milestoneTemplates: stored });
  });

  it('GET /trainer/student-feedbacks/milestone-templates should keep the null of a milestone on the general template', async () => {
    getMilestoneTemplates.mockResolvedValue({ ...NO_MILESTONE_TEMPLATES });

    const res = await call('GET', MILESTONE_TEMPLATES_URL, { token: trainerToken });

    expect(res.json()).toEqual({ milestoneTemplates: NO_MILESTONE_TEMPLATES });
  });

  it('PUT /trainer/student-feedbacks/milestone-templates should pass the partial body to updateMilestoneTemplates', async () => {
    const updated = { ...NO_MILESTONE_TEMPLATES, d15: TEMPLATE_ID };
    updateMilestoneTemplates.mockResolvedValue(updated);

    const res = await call('PUT', MILESTONE_TEMPLATES_URL, { token: trainerToken, payload: { d15: TEMPLATE_ID } });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(firstCallArgs(updateMilestoneTemplates, 3)).toEqual([prisma, TRAINER_ID, { d15: TEMPLATE_ID }]);
    expect(res.json()).toEqual({ milestoneTemplates: updated });
  });

  it('PUT /trainer/student-feedbacks/milestone-templates should pass a null that sends the milestone back to the general template', async () => {
    updateMilestoneTemplates.mockResolvedValue({ ...NO_MILESTONE_TEMPLATES });

    const res = await call('PUT', MILESTONE_TEMPLATES_URL, { token: trainerToken, payload: { d7: null, recurring: TEMPLATE_ID } });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(firstCallArgs(updateMilestoneTemplates, 3)).toEqual([prisma, TRAINER_ID, { d7: null, recurring: TEMPLATE_ID }]);
  });

  it('PUT /trainer/student-feedbacks/milestone-templates should not pass a key that is not a milestone', async () => {
    updateMilestoneTemplates.mockResolvedValue({ ...NO_MILESTONE_TEMPLATES });

    await call('PUT', MILESTONE_TEMPLATES_URL, { token: trainerToken, payload: { d7: TEMPLATE_ID, d45: TEMPLATE_ID, autoSendEnabled: true } });

    expect(updateMilestoneTemplates).toHaveBeenCalledTimes(1);
    const passed = updateMilestoneTemplates.mock.calls[0][2];
    expect(passed).toMatchObject({ d7: TEMPLATE_ID });
    expect(passed).not.toHaveProperty('d45');
    expect(passed).not.toHaveProperty('autoSendEnabled');
  });

  it.each([
    ['a template id that is not a uuid', { d7: NOT_A_UUID }],
    ['a template id that is a boolean', { d21: true }],
    ['a template id that is a number', { recurring: 7 }],
  ])('PUT /trainer/student-feedbacks/milestone-templates should reject %s with 400 validation.failed', async (_scenario, payload) => {
    const res = await call('PUT', MILESTONE_TEMPLATES_URL, { token: trainerToken, payload });

    expectValidationError(res);
    expect(updateMilestoneTemplates).not.toHaveBeenCalled();
  });

  it('PUT /trainer/student-feedbacks/milestone-templates should answer 404 in the unified contract for a template the trainer cannot use', async () => {
    updateMilestoneTemplates.mockRejectedValue(templateAppError('NOT_FOUND', HTTP_NOT_FOUND));

    const res = await call('PUT', MILESTONE_TEMPLATES_URL, { token: trainerToken });

    expectTemplateError(res, HTTP_NOT_FOUND, 'NOT_FOUND');
  });

  it('GET /trainer/student-feedbacks/config should still return only the six switches', async () => {
    const config = { autoSendEnabled: true, d7: true, d15: false, d21: true, d30: true, recurring: true };
    getConfig.mockResolvedValue({ ...config, d7TemplateId: TEMPLATE_ID });

    const res = await call('GET', '/trainer/student-feedbacks/config', { token: trainerToken });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toEqual(config);
  });
});

describe('student-feedback ad-hoc send with a template', () => {
  const created = {
    id: FEEDBACK_ID,
    milestone: StudentFeedbackMilestone.ADHOC,
    status: StudentFeedbackStatus.PENDING,
    sentAt: SENT_AT,
    expiresAt: EXPIRES_AT,
  };

  it('POST /trainer/students/:studentId/feedbacks should pass the picked template to sendAdhocFeedback', async () => {
    sendAdhocFeedback.mockResolvedValue(created);

    const res = await call('POST', STUDENT_FEEDBACKS_URL, { token: trainerToken, payload: { templateId: TEMPLATE_ID } });

    expect(res.statusCode).toBe(HTTP_CREATED);
    expect(firstCallArgs(sendAdhocFeedback, 5)).toEqual([prisma, emailHandler, TRAINER_ID, STUDENT_ID, expect.any(Date)]);
    expect(sendAdhocFeedback.mock.calls[0][6]).toMatchObject({ templateId: TEMPLATE_ID });
    expect(res.json()).toMatchObject(created);
  });

  it('POST /trainer/students/:studentId/feedbacks should still answer 201 with no body and pick no template', async () => {
    sendAdhocFeedback.mockResolvedValue(created);

    const res = await app.inject({ method: 'POST', url: STUDENT_FEEDBACKS_URL, headers: bearer(trainerToken) });

    expect(res.statusCode).toBe(HTTP_CREATED);
    expect(firstCallArgs(sendAdhocFeedback, 5)).toEqual([prisma, emailHandler, TRAINER_ID, STUDENT_ID, expect.any(Date)]);
    expect(sendAdhocFeedback.mock.calls[0][6]?.templateId).toBeUndefined();
    expect(res.json()).toMatchObject(created);
  });

  it('POST /trainer/students/:studentId/feedbacks should still answer 201 with an empty JSON body', async () => {
    sendAdhocFeedback.mockResolvedValue(created);

    const res = await call('POST', STUDENT_FEEDBACKS_URL, { token: trainerToken, payload: {} });

    expect(res.statusCode).toBe(HTTP_CREATED);
    expect(sendAdhocFeedback.mock.calls[0][6]?.templateId).toBeUndefined();
  });

  it('POST /trainer/students/:studentId/feedbacks should reject a template id that is not a uuid with 400', async () => {
    const res = await call('POST', STUDENT_FEEDBACKS_URL, { token: trainerToken, payload: { templateId: NOT_A_UUID } });

    expectValidationError(res);
    expect(sendAdhocFeedback).not.toHaveBeenCalled();
  });

  it('POST /trainer/students/:studentId/feedbacks should answer 404 in the unified contract when the template is not usable by the trainer', async () => {
    sendAdhocFeedback.mockRejectedValue(templateAppError('NOT_FOUND', HTTP_NOT_FOUND));

    const res = await call('POST', STUDENT_FEEDBACKS_URL, { token: trainerToken, payload: { templateId: TEMPLATE_ID } });

    expectTemplateError(res, HTTP_NOT_FOUND, 'NOT_FOUND');
  });
});
