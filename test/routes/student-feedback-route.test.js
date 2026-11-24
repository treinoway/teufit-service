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
}));

import { buildServer } from '../../api/server.js';
import emailHandler from '../../src/config/email-handler.js';
import { prisma } from '../../src/db.js';
import { Roles } from '../../src/constants/roles.js';
import {
  DEFAULT_STUDENT_FEEDBACK_CONFIG,
  INBOX_DEFAULT_LIMIT,
  INBOX_MAX_LIMIT,
  StudentFeedbackErrorCode,
  StudentFeedbackInboxFilter,
  StudentFeedbackMessageCode,
  StudentFeedbackMilestone,
  StudentFeedbackStatus,
} from '../../src/constants/student-feedback.js';
import { alreadyPendingError } from '../../src/services/student-feedback-shared.js';
import { getConfig, updateConfig } from '../../src/services/student-feedback-config-service.js';
import { getFeedback, getPendingFeedback, saveDraft, submitFeedback } from '../../src/services/student-feedback-student-service.js';
import {
  countUnread,
  getStudentHistory,
  listInbox,
  markAsRead,
  sendAdhocFeedback,
} from '../../src/services/student-feedback-trainer-service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TRAINER_ID = '22222222-2222-4222-8222-222222222222';
const STUDENT_ID = '33333333-3333-4333-8333-333333333333';
const FEEDBACK_ID = '44444444-4444-4444-8444-444444444444';
const QUESTION_ID = '55555555-5555-4555-8555-555555555555';
const NOT_A_UUID = 'not-a-uuid';
const AVATAR_URL = 'https://cdn.example.com/avatar.png';
const SENT_AT = '2026-03-10T12:00:00.000Z';
const EXPIRES_AT = '2026-03-13T12:00:00.000Z';

// Booting the whole server cold (imports of every route and plugin) can take far longer than the 10 s default hook timeout on a loaded machine
const SERVER_LIFECYCLE_TIMEOUT_MS = 120000;

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const VALIDATION_ERROR = 'VALIDATION_ERROR';
const VALIDATION_MESSAGE_CODE = 'validation.failed';
const FORBIDDEN_ERROR = 'FORBIDDEN';
const FORBIDDEN_MESSAGE_CODE = 'auth.forbidden';
const TRAINER_PROFILE_MISSING_MESSAGE_CODE = 'trainer.notFound';

const PENDING_URL = '/my/feedbacks/pending';
const FEEDBACK_URL = `/my/feedbacks/${FEEDBACK_ID}`;
const DRAFT_URL = `${FEEDBACK_URL}/draft`;
const SUBMIT_URL = `${FEEDBACK_URL}/submit`;
const INBOX_URL = '/trainer/student-feedbacks';
const UNREAD_COUNT_URL = `${INBOX_URL}/unread-count`;
const CONFIG_URL = `${INBOX_URL}/config`;
const READ_URL = `${INBOX_URL}/${FEEDBACK_ID}/read`;
const STUDENT_FEEDBACKS_URL = `/trainer/students/${STUDENT_ID}/feedbacks`;

const ANSWERS_BODY = { answers: [{ questionId: QUESTION_ID, score: 8 }] };
const STUDENT_ROUTES = [
  ['GET', PENDING_URL],
  ['GET', FEEDBACK_URL],
  ['PATCH', DRAFT_URL],
  ['POST', SUBMIT_URL],
];
const TRAINER_ROUTES = [
  ['GET', INBOX_URL],
  ['GET', UNREAD_COUNT_URL],
  ['GET', CONFIG_URL],
  ['PUT', CONFIG_URL],
  ['PATCH', READ_URL],
  ['GET', STUDENT_FEEDBACKS_URL],
  ['POST', STUDENT_FEEDBACKS_URL],
];
const ALL_SERVICES = [
  getConfig,
  updateConfig,
  getFeedback,
  getPendingFeedback,
  saveDraft,
  submitFeedback,
  countUnread,
  getStudentHistory,
  listInbox,
  markAsRead,
  sendAdhocFeedback,
];

let app = null;
let studentToken = null;
let trainerToken = null;

// Authorization header carrying the given access token
function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

// A body that passes the schema of the route, so only auth can reject the call
function validPayloadFor(method, url) {
  if (url === DRAFT_URL || url === SUBMIT_URL) return ANSWERS_BODY;
  if (method === 'PUT') return { autoSendEnabled: true };
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

// Student-facing feedback header as the student service returns it, with the trainer avatar still a stored value
function buildStudentFeedback() {
  return {
    id: FEEDBACK_ID,
    milestone: StudentFeedbackMilestone.D7,
    title: 'Padrão TeuFit',
    trainer: { name: 'Bruno Lima', avatarUrl: AVATAR_URL },
    questionCount: 1,
    estimatedMinutes: 1,
    expiresAt: EXPIRES_AT,
    daysLeft: 3,
  };
}

// Asserts that no service of the feature ran
function expectNoServiceCalled() {
  for (const service of ALL_SERVICES) expect(service).not.toHaveBeenCalled();
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

describe('student-feedback-route authentication', () => {
  it.each([...STUDENT_ROUTES, ...TRAINER_ROUTES])('should reject %s %s without a token with 401', async (method, url) => {
    const res = await call(method, url);

    expect(res.statusCode).toBe(HTTP_UNAUTHORIZED);
    expect(res.json()).toMatchObject({ error: expect.any(String), messageCode: expect.any(String), message: expect.any(String) });
    expectNoServiceCalled();
  });

  it.each([STUDENT_ROUTES[0], TRAINER_ROUTES[0]])('should reject %s %s with an invalid token with 401', async (method, url) => {
    const res = await call(method, url, { token: 'aaa.bbb.ccc' });

    expect(res.statusCode).toBe(HTTP_UNAUTHORIZED);
    expectNoServiceCalled();
  });
});

describe('student-feedback-route trainer authorization', () => {
  it.each(TRAINER_ROUTES)('should reject a non-trainer on %s %s with 403 in the unified contract', async (method, url) => {
    const res = await call(method, url, { token: studentToken });

    expect(res.statusCode).toBe(HTTP_FORBIDDEN);
    expect(res.json()).toMatchObject({ error: FORBIDDEN_ERROR, messageCode: FORBIDDEN_MESSAGE_CODE, message: expect.any(String) });
    expect(res.json()).toHaveProperty('details');
  });

  it('should not look up the trainer profile nor call a service for a non-trainer', async () => {
    await call('GET', INBOX_URL, { token: studentToken });

    expect(prisma.trainer.findUnique).not.toHaveBeenCalled();
    expectNoServiceCalled();
  });

  it.each(TRAINER_ROUTES)('should reject %s %s with 403 trainer.notFound when the user has no trainer profile', async (method, url) => {
    prisma.trainer.findUnique.mockResolvedValue(null);

    const res = await call(method, url, { token: trainerToken });

    expect(res.statusCode).toBe(HTTP_FORBIDDEN);
    expect(res.json()).toMatchObject({ error: FORBIDDEN_ERROR, messageCode: TRAINER_PROFILE_MISSING_MESSAGE_CODE });
    expectNoServiceCalled();
  });

  it('should look up the trainer profile by the id of the authenticated user', async () => {
    countUnread.mockResolvedValue({ count: 0 });

    await call('GET', UNREAD_COUNT_URL, { token: trainerToken });

    expect(prisma.trainer.findUnique).toHaveBeenCalledWith({ where: { userId: USER_ID }, select: { id: true } });
  });

  it.each(STUDENT_ROUTES)('should let a user without the trainer role reach %s %s', async (method, url) => {
    getPendingFeedback.mockResolvedValue({ feedback: null });
    getFeedback.mockResolvedValue(buildStudentFeedback());
    saveDraft.mockResolvedValue({ answers: [] });
    submitFeedback.mockResolvedValue({ nextFeedbackAt: null });

    const res = await call(method, url, { token: studentToken });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(prisma.trainer.findUnique).not.toHaveBeenCalled();
  });
});

describe('student-feedback-route schema validation', () => {
  const invalidRequests = [
    ['a feedback id that is not a uuid', 'GET', `/my/feedbacks/${NOT_A_UUID}`, undefined, 'student'],
    ['a draft without answers', 'PATCH', DRAFT_URL, {}, 'student'],
    ['a draft answer without questionId', 'PATCH', DRAFT_URL, { answers: [{ score: 5 }] }, 'student'],
    ['a draft answer whose questionId is not a uuid', 'PATCH', DRAFT_URL, { answers: [{ questionId: NOT_A_UUID, score: 5 }] }, 'student'],
    ['a submit whose answers is not an array', 'POST', SUBMIT_URL, { answers: 'all good' }, 'student'],
    ['an unknown inbox status filter', 'GET', `${INBOX_URL}?status=archived`, undefined, 'trainer'],
    ['an unknown inbox milestone filter', 'GET', `${INBOX_URL}?milestone=D99`, undefined, 'trainer'],
    ['a config toggle that is not a boolean', 'PUT', CONFIG_URL, { d7: 'sometimes' }, 'trainer'],
    ['a read on an id that is not a uuid', 'PATCH', `${INBOX_URL}/${NOT_A_UUID}/read`, undefined, 'trainer'],
    ['a history of a student id that is not a uuid', 'GET', `/trainer/students/${NOT_A_UUID}/feedbacks`, undefined, 'trainer'],
    ['a send to a student id that is not a uuid', 'POST', `/trainer/students/${NOT_A_UUID}/feedbacks`, undefined, 'trainer'],
  ];

  it.each(invalidRequests)('should reject %s with 400 validation.failed', async (_scenario, method, url, payload, role) => {
    const token = role === 'trainer' ? trainerToken : studentToken;

    const res = await app.inject({ method, url, headers: bearer(token), payload });

    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(res.json()).toMatchObject({ error: VALIDATION_ERROR, messageCode: VALIDATION_MESSAGE_CODE, message: expect.any(String) });
    expect(Array.isArray(res.json().details)).toBe(true);
    expectNoServiceCalled();
  });

  it('should reject more than 100 answers in one request with 400', async () => {
    const answers = Array.from({ length: 101 }, () => ({ questionId: QUESTION_ID, score: 1 }));

    const res = await call('PATCH', DRAFT_URL, { token: studentToken, payload: { answers } });

    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(saveDraft).not.toHaveBeenCalled();
  });
});

describe('student-feedback-route unknown properties', () => {
  it('should strip an unknown property of the draft body before calling saveDraft', async () => {
    saveDraft.mockResolvedValue({ answers: [] });

    const res = await call('PATCH', DRAFT_URL, { token: studentToken, payload: { ...ANSWERS_BODY, extra: true } });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(saveDraft).toHaveBeenCalledWith(prisma, USER_ID, FEEDBACK_ID, ANSWERS_BODY, expect.any(Date));
  });

  it('should strip an unknown property of a submitted answer before calling submitFeedback', async () => {
    submitFeedback.mockResolvedValue({ nextFeedbackAt: null });
    const payload = { answers: [{ questionId: QUESTION_ID, score: 8, stars: 5 }] };

    const res = await call('POST', SUBMIT_URL, { token: studentToken, payload });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(submitFeedback).toHaveBeenCalledWith(prisma, USER_ID, FEEDBACK_ID, ANSWERS_BODY, expect.any(Date));
  });

  it('should strip an unknown toggle of the config body before calling updateConfig', async () => {
    updateConfig.mockResolvedValue({ ...DEFAULT_STUDENT_FEEDBACK_CONFIG });

    const res = await call('PUT', CONFIG_URL, { token: trainerToken, payload: { d7: false, d45: true } });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(updateConfig).toHaveBeenCalledWith(prisma, TRAINER_ID, { d7: false }, expect.any(Date));
  });
});

describe('student-feedback-route student endpoints', () => {
  it('GET /my/feedbacks/pending should return the pending feedback of the authenticated user', async () => {
    getPendingFeedback.mockResolvedValue({ feedback: buildStudentFeedback() });

    const res = await call('GET', PENDING_URL, { token: studentToken });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(getPendingFeedback).toHaveBeenCalledWith(prisma, USER_ID, expect.any(Date));
    expect(res.json().feedback).toMatchObject({
      id: FEEDBACK_ID,
      milestone: StudentFeedbackMilestone.D7,
      trainer: { name: 'Bruno Lima', avatarUrl: AVATAR_URL },
      questionCount: 1,
      expiresAt: EXPIRES_AT,
      daysLeft: 3,
    });
  });

  it('GET /my/feedbacks/pending should return a null feedback when there is none', async () => {
    getPendingFeedback.mockResolvedValue({ feedback: null });

    const res = await call('GET', PENDING_URL, { token: studentToken });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toEqual({ feedback: null });
  });

  it('GET /my/feedbacks/pending should add the translated milestone label', async () => {
    getPendingFeedback.mockResolvedValue({ feedback: buildStudentFeedback() });

    const res = await call('GET', PENDING_URL, { token: studentToken });

    expect(res.json().feedback.milestoneLabel).toEqual(expect.any(String));
  });

  it('GET /my/feedbacks/:id should return the feedback with questions and answers', async () => {
    const question = { id: QUESTION_ID, order: 1, text: 'Como foi a semana?', helpText: null, type: 'score', required: true, minLabel: 'Ruim', maxLabel: 'Ótima' };
    getFeedback.mockResolvedValue({
      ...buildStudentFeedback(),
      status: StudentFeedbackStatus.PENDING,
      questions: [question],
      answers: [{ questionId: QUESTION_ID, score: 8, text: null }],
    });

    const res = await call('GET', FEEDBACK_URL, { token: studentToken });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(getFeedback).toHaveBeenCalledWith(prisma, USER_ID, FEEDBACK_ID, expect.any(Date));
    expect(res.json()).toMatchObject({
      id: FEEDBACK_ID,
      status: StudentFeedbackStatus.PENDING,
      trainer: { name: 'Bruno Lima', avatarUrl: AVATAR_URL },
      questions: [expect.objectContaining(question)],
      answers: [{ questionId: QUESTION_ID, score: 8, text: null }],
    });
  });

  it('GET /my/feedbacks/:id should return a null trainer avatar when none is stored', async () => {
    getFeedback.mockResolvedValue({ ...buildStudentFeedback(), trainer: { name: 'Bruno Lima', avatarUrl: null } });

    const res = await call('GET', FEEDBACK_URL, { token: studentToken });

    expect(res.json().trainer).toEqual({ name: 'Bruno Lima', avatarUrl: null });
  });

  it('PATCH /my/feedbacks/:id/draft should pass the body to saveDraft and return the saved answers', async () => {
    const saved = { answers: [{ questionId: QUESTION_ID, score: 8, text: null }] };
    saveDraft.mockResolvedValue(saved);

    const res = await call('PATCH', DRAFT_URL, { token: studentToken });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(saveDraft).toHaveBeenCalledWith(prisma, USER_ID, FEEDBACK_ID, ANSWERS_BODY, expect.any(Date));
    expect(res.json()).toEqual(saved);
  });

  it('POST /my/feedbacks/:id/submit should pass the body to submitFeedback and return the next feedback date', async () => {
    submitFeedback.mockResolvedValue({ nextFeedbackAt: EXPIRES_AT });

    const res = await call('POST', SUBMIT_URL, { token: studentToken });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(submitFeedback).toHaveBeenCalledWith(prisma, USER_ID, FEEDBACK_ID, ANSWERS_BODY, expect.any(Date));
    expect(res.json()).toEqual({ nextFeedbackAt: EXPIRES_AT });
  });
});

describe('student-feedback-route trainer inbox endpoints', () => {
  const summary = { responseRate30d: 50, averageIndex: 72, unansweredCount: 1, unreadCount: 2 };
  const inboxItem = {
    id: FEEDBACK_ID,
    student: { id: STUDENT_ID, name: 'Ana Souza', avatarUrl: AVATAR_URL },
    milestone: StudentFeedbackMilestone.D15,
    status: StudentFeedbackStatus.ANSWERED,
    sentAt: SENT_AT,
    expiresAt: EXPIRES_AT,
    submittedAt: SENT_AT,
    readAt: null,
    overallIndex: 72,
    band: null,
  };

  it('GET /trainer/student-feedbacks should list the inbox of the trainer with the query filters', async () => {
    listInbox.mockResolvedValue({ summary, items: [inboxItem] });
    const query = { status: StudentFeedbackInboxFilter.UNREAD, milestone: StudentFeedbackMilestone.D15 };

    const res = await call('GET', `${INBOX_URL}?status=${query.status}&milestone=${query.milestone}`, { token: trainerToken });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(listInbox).toHaveBeenCalledWith(prisma, TRAINER_ID, expect.objectContaining(query), expect.any(Date));
    expect(res.json().summary).toEqual(summary);
    expect(res.json().items).toEqual([expect.objectContaining({ id: FEEDBACK_ID, student: inboxItem.student, overallIndex: 72, readAt: null })]);
  });

  it('GET /trainer/student-feedbacks should return an empty list when the inbox is empty', async () => {
    listInbox.mockResolvedValue({ summary: { ...summary, responseRate30d: null, averageIndex: null }, items: [] });

    const res = await call('GET', INBOX_URL, { token: trainerToken });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json().items).toEqual([]);
  });

  it.each([
    ['above the maximum of 200', INBOX_MAX_LIMIT + 1],
    ['below 1', 0],
    ['negative', -1],
    ['not an integer', 2.5],
    ['not a number', 'many'],
  ])('GET /trainer/student-feedbacks should reject a limit %s with 400 validation.failed', async (_scenario, limit) => {
    const res = await call('GET', `${INBOX_URL}?limit=${limit}`, { token: trainerToken });

    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(res.json()).toMatchObject({ error: VALIDATION_ERROR, messageCode: VALIDATION_MESSAGE_CODE, message: expect.any(String) });
    expect(Array.isArray(res.json().details)).toBe(true);
    expect(listInbox).not.toHaveBeenCalled();
  });

  it.each([1, 50, INBOX_MAX_LIMIT])('GET /trainer/student-feedbacks should pass the limit %i to listInbox as a number', async (limit) => {
    listInbox.mockResolvedValue({ summary, items: [] });

    const res = await call('GET', `${INBOX_URL}?limit=${limit}`, { token: trainerToken });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(listInbox).toHaveBeenCalledWith(prisma, TRAINER_ID, expect.objectContaining({ limit }), expect.any(Date));
  });

  it('GET /trainer/student-feedbacks should pass the default limit of 100 when none is given', async () => {
    listInbox.mockResolvedValue({ summary, items: [] });

    await call('GET', INBOX_URL, { token: trainerToken });

    expect(listInbox).toHaveBeenCalledWith(prisma, TRAINER_ID, expect.objectContaining({ limit: INBOX_DEFAULT_LIMIT }), expect.any(Date));
  });

  it('GET /trainer/student-feedbacks should pass the limit together with the filters', async () => {
    listInbox.mockResolvedValue({ summary, items: [] });
    const filters = { status: StudentFeedbackInboxFilter.UNANSWERED, milestone: StudentFeedbackMilestone.D7, limit: 20 };

    await call('GET', `${INBOX_URL}?status=${filters.status}&milestone=${filters.milestone}&limit=${filters.limit}`, { token: trainerToken });

    expect(listInbox).toHaveBeenCalledWith(prisma, TRAINER_ID, filters, expect.any(Date));
  });

  it('GET /trainer/student-feedbacks/unread-count should return the count of the trainer', async () => {
    countUnread.mockResolvedValue({ count: 4 });

    const res = await call('GET', UNREAD_COUNT_URL, { token: trainerToken });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(countUnread).toHaveBeenCalledWith(prisma, TRAINER_ID);
    expect(res.json()).toEqual({ count: 4 });
  });

  it('GET /trainer/student-feedbacks/config should return the settings of the trainer', async () => {
    getConfig.mockResolvedValue({ ...DEFAULT_STUDENT_FEEDBACK_CONFIG });

    const res = await call('GET', CONFIG_URL, { token: trainerToken });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(getConfig).toHaveBeenCalledWith(prisma, TRAINER_ID);
    expect(res.json()).toEqual(DEFAULT_STUDENT_FEEDBACK_CONFIG);
  });

  it('PUT /trainer/student-feedbacks/config should pass the partial body to updateConfig', async () => {
    const updated = { ...DEFAULT_STUDENT_FEEDBACK_CONFIG, autoSendEnabled: true, d21: false };
    updateConfig.mockResolvedValue(updated);

    const res = await call('PUT', CONFIG_URL, { token: trainerToken, payload: { autoSendEnabled: true, d21: false } });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(updateConfig).toHaveBeenCalledWith(prisma, TRAINER_ID, { autoSendEnabled: true, d21: false }, expect.any(Date));
    expect(res.json()).toEqual(updated);
  });

  it('PATCH /trainer/student-feedbacks/:id/read should mark the feedback of the trainer as read', async () => {
    markAsRead.mockResolvedValue({ id: FEEDBACK_ID, readAt: SENT_AT });

    const res = await call('PATCH', READ_URL, { token: trainerToken });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(markAsRead).toHaveBeenCalledWith(prisma, TRAINER_ID, FEEDBACK_ID, expect.any(Date));
    expect(res.json()).toEqual({ id: FEEDBACK_ID, readAt: SENT_AT });
  });
});

describe('student-feedback-route trainer student endpoints', () => {
  it('GET /trainer/students/:studentId/feedbacks should return the history of the student', async () => {
    const student = { id: STUDENT_ID, name: 'Ana Souza', avatarUrl: AVATAR_URL };
    getStudentHistory.mockResolvedValue({ student, hasPending: true, feedbacks: [] });

    const res = await call('GET', STUDENT_FEEDBACKS_URL, { token: trainerToken });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(getStudentHistory).toHaveBeenCalledWith(prisma, TRAINER_ID, STUDENT_ID, expect.any(Date));
    expect(res.json()).toEqual({ student, hasPending: true, feedbacks: [] });
  });

  it('POST /trainer/students/:studentId/feedbacks should send an ad-hoc feedback and answer 201', async () => {
    sendAdhocFeedback.mockResolvedValue({
      id: FEEDBACK_ID,
      milestone: StudentFeedbackMilestone.ADHOC,
      status: StudentFeedbackStatus.PENDING,
      sentAt: SENT_AT,
      expiresAt: EXPIRES_AT,
    });

    const res = await call('POST', STUDENT_FEEDBACKS_URL, { token: trainerToken });

    expect(res.statusCode).toBe(HTTP_CREATED);
    expect(sendAdhocFeedback).toHaveBeenCalledWith(prisma, emailHandler, TRAINER_ID, STUDENT_ID, expect.any(Date), expect.anything());
    expect(res.json()).toMatchObject({
      id: FEEDBACK_ID,
      milestone: StudentFeedbackMilestone.ADHOC,
      status: StudentFeedbackStatus.PENDING,
      sentAt: SENT_AT,
      expiresAt: EXPIRES_AT,
    });
  });

  it('POST /trainer/students/:studentId/feedbacks should answer 409 in the unified contract when the service reports a pending feedback', async () => {
    sendAdhocFeedback.mockRejectedValue(alreadyPendingError());

    const res = await call('POST', STUDENT_FEEDBACKS_URL, { token: trainerToken });

    expect(res.statusCode).toBe(HTTP_CONFLICT);
    expect(res.json()).toMatchObject({
      error: StudentFeedbackErrorCode.ALREADY_PENDING,
      messageCode: StudentFeedbackMessageCode.ALREADY_PENDING,
      message: expect.any(String),
    });
  });
});
