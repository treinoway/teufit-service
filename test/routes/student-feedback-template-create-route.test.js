import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: { $disconnect: vi.fn(), trainer: { findUnique: vi.fn() } },
}));

vi.mock('../../src/services/student-feedback-template-service.js', () => ({
  listTemplates: vi.fn(),
  getTemplate: vi.fn(),
  createTemplate: vi.fn(),
  duplicateTemplate: vi.fn(),
  saveTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
}));

import { buildServer } from '../../api/server.js';
import { prisma } from '../../src/db.js';
import { AppError } from '../../src/errors/app-error.js';
import { Roles } from '../../src/constants/roles.js';
import {
  STUDENT_FEEDBACK_TEMPLATE_LIMITS,
  StudentFeedbackPillar,
  StudentFeedbackQuestionType,
  StudentFeedbackTemplateErrorCode,
  StudentFeedbackTemplateMessageCode,
} from '../../src/constants/student-feedback.js';
import {
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  getTemplate,
  listTemplates,
  saveTemplate,
} from '../../src/services/student-feedback-template-service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TRAINER_ID = '22222222-2222-4222-8222-222222222222';
const QUESTION_ID = '55555555-5555-4555-8555-555555555555';
const SOURCE_ID = '66666666-6666-4666-8666-666666666666';
const CREATED_ID = '77777777-7777-4777-8777-777777777777';
const NOT_A_UUID = 'not-a-uuid';
const NEW_NAME = 'Check-in mensal';

// Booting the whole server cold (imports of every route and plugin) can take far longer than the 10 s default hook timeout on a loaded machine
const SERVER_LIFECYCLE_TIMEOUT_MS = 120000;

const HTTP_CREATED = 201;
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
const TEMPLATE_SERVICES = [createTemplate, duplicateTemplate, getTemplate, listTemplates, saveTemplate, deleteTemplate];

let app = null;
let studentToken = null;
let trainerToken = null;

// Sends the create request with an optional access token and the given body
function create({ token, payload = { name: NEW_NAME } } = {}) {
  return app.inject({ method: 'POST', url: TEMPLATES_URL, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
}

// The starter question as the template service returns it, without the label siblings
function starterQuestion() {
  return {
    id: QUESTION_ID,
    order: 1,
    text: 'Nova pergunta',
    helpText: null,
    type: StudentFeedbackQuestionType.SCORE,
    pillar: StudentFeedbackPillar.OTHER,
    required: true,
    condition: null,
    invertScore: false,
    minLabel: null,
    maxLabel: null,
  };
}

// A freshly created template as the template service returns it
function buildCreated(overrides = {}) {
  return { id: CREATED_ID, name: NEW_NAME, isGeneral: false, version: 1, hasRequests: false, milestones: [], questions: [starterQuestion()], ...overrides };
}

// Template error of the unified contract, as the service throws it
function templateAppError(key, httpStatus) {
  return new AppError({
    httpStatus,
    error: StudentFeedbackTemplateErrorCode[key],
    messageCode: StudentFeedbackTemplateMessageCode[key],
    message: 'Template error',
    details: {},
  });
}

// Asserts a schema rejection in the unified contract
function expectValidationError(res) {
  expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
  expect(res.json()).toMatchObject({ error: VALIDATION_ERROR, messageCode: VALIDATION_MESSAGE_CODE, message: expect.any(String) });
  expect(Array.isArray(res.json().details)).toBe(true);
}

// Asserts that no template service ran
function expectNoServiceCalled() {
  for (const service of TEMPLATE_SERVICES) expect(service).not.toHaveBeenCalled();
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

describe('POST /trainer/student-feedbacks/templates authentication', () => {
  it('should reject a call without a token with 401', async () => {
    const res = await create();

    expect(res.statusCode).toBe(HTTP_UNAUTHORIZED);
    expect(res.json()).toMatchObject({ error: expect.any(String), messageCode: expect.any(String), message: expect.any(String) });
    expectNoServiceCalled();
  });

  it('should reject a non-trainer with 403 in the unified contract', async () => {
    const res = await create({ token: studentToken });

    expect(res.statusCode).toBe(HTTP_FORBIDDEN);
    expect(res.json()).toMatchObject({ error: FORBIDDEN_ERROR, messageCode: FORBIDDEN_MESSAGE_CODE, message: expect.any(String) });
    expect(res.json()).toHaveProperty('details');
    expect(prisma.trainer.findUnique).not.toHaveBeenCalled();
    expectNoServiceCalled();
  });

  it('should reject with 403 trainer.notFound when the user has no trainer profile', async () => {
    prisma.trainer.findUnique.mockResolvedValue(null);

    const res = await create({ token: trainerToken });

    expect(res.statusCode).toBe(HTTP_FORBIDDEN);
    expect(res.json()).toMatchObject({ error: FORBIDDEN_ERROR, messageCode: TRAINER_PROFILE_MISSING_MESSAGE_CODE });
    expectNoServiceCalled();
  });
});

describe('POST /trainer/student-feedbacks/templates', () => {
  it('should answer 201 with the created template under the template key', async () => {
    createTemplate.mockResolvedValue(buildCreated());

    const res = await create({ token: trainerToken });

    expect(res.statusCode).toBe(HTTP_CREATED);
    expect(Object.keys(res.json())).toEqual(['template']);
    const { questions, ...header } = buildCreated();
    expect(res.json().template).toMatchObject(header);
    expect(res.json().template.questions).toEqual([expect.objectContaining(questions[0])]);
  });

  it('should return exactly the fields of the template read endpoint', async () => {
    createTemplate.mockResolvedValue(buildCreated({ internalNote: 'not part of the contract' }));

    const res = await create({ token: trainerToken });

    const { template } = res.json();
    expect(Object.keys(template).sort()).toEqual(['hasRequests', 'id', 'isGeneral', 'milestones', 'name', 'questions', 'version']);
    expect(Object.keys(template.questions[0]).sort()).toEqual(
      ['condition', 'helpText', 'id', 'invertScore', 'maxLabel', 'minLabel', 'order', 'pillar', 'pillarLabel', 'required', 'text', 'type', 'typeLabel'],
    );
  });

  it('should add the translated type and pillar labels to each question', async () => {
    createTemplate.mockResolvedValue(buildCreated());

    const res = await create({ token: trainerToken });

    const [question] = res.json().template.questions;
    expect(question.typeLabel).toEqual(expect.any(String));
    expect(question.typeLabel.length).toBeGreaterThan(0);
    expect(question.pillarLabel).toEqual(expect.any(String));
    expect(question.pillarLabel.length).toBeGreaterThan(0);
  });

  it('should call createTemplate for the trainer with the name and no source when none is sent', async () => {
    createTemplate.mockResolvedValue(buildCreated());

    await create({ token: trainerToken, payload: { name: NEW_NAME } });

    expect(createTemplate).toHaveBeenCalledTimes(1);
    const [db, trainerId, input] = createTemplate.mock.calls[0];
    expect(db).toBe(prisma);
    expect(trainerId).toBe(TRAINER_ID);
    expect(input.name).toBe(NEW_NAME);
    expect(input.sourceTemplateId ?? null).toBeNull();
  });

  it('should pass the source template id to createTemplate', async () => {
    createTemplate.mockResolvedValue(buildCreated());

    const res = await create({ token: trainerToken, payload: { name: NEW_NAME, sourceTemplateId: SOURCE_ID } });

    expect(res.statusCode).toBe(HTTP_CREATED);
    expect(createTemplate.mock.calls[0].slice(0, 3)).toEqual([prisma, TRAINER_ID, { name: NEW_NAME, sourceTemplateId: SOURCE_ID }]);
  });

  it('should accept a name exactly at the name limit', async () => {
    createTemplate.mockResolvedValue(buildCreated());
    const name = 'N'.repeat(STUDENT_FEEDBACK_TEMPLATE_LIMITS.nameMaxLength);

    const res = await create({ token: trainerToken, payload: { name } });

    expect(res.statusCode).toBe(HTTP_CREATED);
    expect(createTemplate.mock.calls[0][2].name).toBe(name);
  });

  it('should strip unknown body properties instead of rejecting them', async () => {
    createTemplate.mockResolvedValue(buildCreated());

    const res = await create({ token: trainerToken, payload: { name: NEW_NAME, isGeneral: true, version: 9, questions: [] } });

    expect(res.statusCode).toBe(HTTP_CREATED);
    const input = createTemplate.mock.calls[0][2];
    expect(input.name).toBe(NEW_NAME);
    for (const stripped of ['isGeneral', 'version', 'questions']) expect(input).not.toHaveProperty(stripped);
  });

  it.each([
    ['no body', undefined],
    ['no name', { sourceTemplateId: SOURCE_ID }],
    ['an empty name', { name: '' }],
    ['a name over the limit', { name: 'N'.repeat(STUDENT_FEEDBACK_TEMPLATE_LIMITS.nameMaxLength + 1) }],
    ['a name that is an object', { name: { text: NEW_NAME } }],
    ['a source template id that is not a uuid', { name: NEW_NAME, sourceTemplateId: NOT_A_UUID }],
    ['a source template id that is a number', { name: NEW_NAME, sourceTemplateId: 7 }],
  ])('should reject %s with 400 validation.failed', async (_scenario, payload) => {
    const res = await app.inject({ method: 'POST', url: TEMPLATES_URL, headers: { authorization: `Bearer ${trainerToken}` }, payload });

    expectValidationError(res);
    expectNoServiceCalled();
  });

  it.each([
    ['INVALID', HTTP_BAD_REQUEST],
    ['NOT_FOUND', HTTP_NOT_FOUND],
  ])('should answer STUDENT_FEEDBACK_TEMPLATE_%s with %i in the unified contract', async (key, statusCode) => {
    createTemplate.mockRejectedValue(templateAppError(key, statusCode));

    const res = await create({ token: trainerToken, payload: { name: NEW_NAME, sourceTemplateId: SOURCE_ID } });

    expect(res.statusCode).toBe(statusCode);
    expect(res.json()).toMatchObject({
      error: StudentFeedbackTemplateErrorCode[key],
      messageCode: StudentFeedbackTemplateMessageCode[key],
      message: expect.any(String),
    });
    expect(res.json()).toHaveProperty('details');
  });
});
