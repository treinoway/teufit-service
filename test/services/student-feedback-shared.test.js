import { describe, it, expect, vi } from 'vitest';
import { AppError } from '../../src/errors/app-error.js';
import { PlanStatus } from '../../src/constants/nutrition.js';
import {
  RESPONSE_WINDOW_DAYS,
  StudentFeedbackErrorCode,
  StudentFeedbackMessageCode,
  StudentFeedbackMilestone,
  StudentFeedbackQuestionCondition,
  StudentFeedbackStatus,
} from '../../src/constants/student-feedback.js';
import {
  PERSON_NAME_SELECT,
  alreadyPendingError,
  alreadySubmittedError,
  createRequest,
  expiredError,
  findGeneralTemplate,
  fullNameOf,
  invalidAnswerError,
  notFoundError,
  openRequestWhere,
  requiredAnswerMissingError,
  sendEmailSafely,
  tryLockStudentFeedback,
  visibleQuestions,
} from '../../src/services/student-feedback-shared.js';
import {
  TEMPLATE_ID as GENERAL_TEMPLATE_ID,
  TEMPLATE_NAME as GENERAL_TEMPLATE_NAME,
  TRAINER_ID as WORLD_TRAINER_ID,
  createFeedbackWorld,
} from '../helpers/student-feedback-world.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const DAY_MS = 24 * 60 * 60 * 1000;
const TRAINER_ID = 'trainer-1';
const STUDENT_ID = 'student-1';
const TEMPLATE_ID = 'template-1';
const NOW = new Date('2026-03-10T12:00:00.000Z');

// Transaction double whose diet protocol lookup resolves to the given plan and whose create echoes the stored data
function buildRequestTx(plan) {
  return {
    dietProtocol: { findFirst: vi.fn().mockResolvedValue(plan) },
    studentFeedbackRequest: { create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'request-1', ...data })) },
  };
}

// Input of createRequest for the fixed trainer-student pair, with overrides
function buildRequestInput(overrides = {}) {
  return {
    trainerId: TRAINER_ID,
    studentId: STUDENT_ID,
    templateId: TEMPLATE_ID,
    milestone: StudentFeedbackMilestone.D7,
    dueAt: null,
    now: NOW,
    ...overrides,
  };
}

describe('PERSON_NAME_SELECT', () => {
  it('should select only the fields fullNameOf reads', () => {
    expect(PERSON_NAME_SELECT).toEqual({ firstName: true, lastName: true, username: true });
  });

  it('should be frozen so a service cannot widen the shared select', () => {
    expect(Object.isFrozen(PERSON_NAME_SELECT)).toBe(true);
  });
});

describe('student feedback errors', () => {
  const cases = [
    { name: 'notFoundError', build: () => notFoundError(), key: 'NOT_FOUND', httpStatus: HTTP_NOT_FOUND, details: {} },
    { name: 'expiredError', build: () => expiredError(), key: 'EXPIRED', httpStatus: HTTP_CONFLICT, details: {} },
    { name: 'alreadySubmittedError', build: () => alreadySubmittedError(), key: 'ALREADY_SUBMITTED', httpStatus: HTTP_CONFLICT, details: {} },
    { name: 'alreadyPendingError', build: () => alreadyPendingError(), key: 'ALREADY_PENDING', httpStatus: HTTP_CONFLICT, details: {} },
    {
      name: 'requiredAnswerMissingError',
      build: () => requiredAnswerMissingError(['q-1', 'q-2']),
      key: 'REQUIRED_ANSWER_MISSING',
      httpStatus: HTTP_BAD_REQUEST,
      details: { questionIds: ['q-1', 'q-2'] },
    },
    {
      name: 'invalidAnswerError',
      build: () => invalidAnswerError('q-9'),
      key: 'INVALID_ANSWER',
      httpStatus: HTTP_BAD_REQUEST,
      details: { questionId: 'q-9' },
    },
  ];

  it.each(cases)('$name should be an AppError with status $httpStatus and the $key codes', ({ build, key, httpStatus }) => {
    const error = build();

    expect(error).toBeInstanceOf(AppError);
    expect(error.httpStatus).toBe(httpStatus);
    expect(error.error).toBe(StudentFeedbackErrorCode[key]);
    expect(error.messageCode).toBe(StudentFeedbackMessageCode[key]);
  });

  it.each(cases)('$name should carry a fallback message and its details', ({ build, details }) => {
    const error = build();

    expect(error.message).toEqual(expect.any(String));
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.details).toEqual(details);
  });

  it('should build a new error on every call', () => {
    expect(notFoundError()).not.toBe(notFoundError());
  });
});

describe('fullNameOf', () => {
  it('should join first and last name', () => {
    expect(fullNameOf({ firstName: 'Ana', lastName: 'Souza', username: 'ana.s' })).toBe('Ana Souza');
  });

  it('should return only the first name when the last name is null', () => {
    expect(fullNameOf({ firstName: 'Ana', lastName: null, username: 'ana.s' })).toBe('Ana');
  });

  it('should return only the last name when the first name is missing', () => {
    expect(fullNameOf({ lastName: 'Souza', username: 'ana.s' })).toBe('Souza');
  });

  it('should fall back to the username when both names are null', () => {
    expect(fullNameOf({ firstName: null, lastName: null, username: 'ana.s' })).toBe('ana.s');
  });

  it('should fall back to the username when both names are empty strings', () => {
    expect(fullNameOf({ firstName: '', lastName: '', username: 'ana.s' })).toBe('ana.s');
  });

  it('should return an empty string when there is no name and no username', () => {
    expect(fullNameOf({ firstName: null, lastName: null, username: null })).toBe('');
  });

  it.each([null, undefined])('should return an empty string for a %s user', (user) => {
    expect(fullNameOf(user)).toBe('');
  });
});

describe('visibleQuestions', () => {
  const always = { id: 'q-always', order: 2, condition: null };
  const first = { id: 'q-first', order: 1 };
  const mealPlanOnly = { id: 'q-meal', order: 0, condition: StudentFeedbackQuestionCondition.HAS_MEAL_PLAN };

  it('should hide meal plan questions when the request has no meal plan', () => {
    const request = { hasMealPlan: false, template: { questions: [always, mealPlanOnly, first] } };

    expect(visibleQuestions(request).map((question) => question.id)).toEqual(['q-first', 'q-always']);
  });

  it('should include meal plan questions when the request has a meal plan', () => {
    const request = { hasMealPlan: true, template: { questions: [always, mealPlanOnly, first] } };

    expect(visibleQuestions(request).map((question) => question.id)).toEqual(['q-meal', 'q-first', 'q-always']);
  });

  it('should return the questions sorted by ascending order', () => {
    const questions = [{ id: 'c', order: 30 }, { id: 'a', order: 10 }, { id: 'b', order: 20 }];

    expect(visibleQuestions({ hasMealPlan: false, template: { questions } }).map((question) => question.id)).toEqual(['a', 'b', 'c']);
  });

  it('should not reorder the questions array of the template', () => {
    const questions = [always, mealPlanOnly, first];

    visibleQuestions({ hasMealPlan: true, template: { questions } });

    expect(questions).toEqual([always, mealPlanOnly, first]);
  });

  it('should return an empty array when the template has no questions', () => {
    expect(visibleQuestions({ hasMealPlan: true, template: { questions: [] } })).toEqual([]);
  });
});

describe('openRequestWhere', () => {
  it('should match pending requests of the pair that expire after now', () => {
    expect(openRequestWhere(TRAINER_ID, STUDENT_ID, NOW)).toEqual({
      trainerId: TRAINER_ID,
      studentId: STUDENT_ID,
      status: StudentFeedbackStatus.PENDING,
      expiresAt: { gt: NOW },
    });
  });
});

describe('tryLockStudentFeedback', () => {
  it('should return true when the advisory lock is granted', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]) };

    await expect(tryLockStudentFeedback(tx, TRAINER_ID, STUDENT_ID)).resolves.toBe(true);
  });

  it('should return false when another transaction holds the lock', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ locked: false }]) };

    await expect(tryLockStudentFeedback(tx, TRAINER_ID, STUDENT_ID)).resolves.toBe(false);
  });

  it('should take a non-blocking transaction-scoped advisory lock exactly once', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]) };

    await tryLockStudentFeedback(tx, TRAINER_ID, STUDENT_ID);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const [strings] = tx.$queryRaw.mock.calls[0];
    expect(strings.join('?')).toContain('pg_try_advisory_xact_lock(hashtext(?))');
  });

  it('should pass the key as a bound parameter that contains both ids', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]) };

    await tryLockStudentFeedback(tx, TRAINER_ID, STUDENT_ID);

    const [, key] = tx.$queryRaw.mock.calls[0];
    expect(key).toContain(`${TRAINER_ID}:${STUDENT_ID}`);
  });

  it('should use a different key for each trainer-student pair', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]) };

    await tryLockStudentFeedback(tx, TRAINER_ID, STUDENT_ID);
    await tryLockStudentFeedback(tx, TRAINER_ID, 'student-2');
    await tryLockStudentFeedback(tx, 'trainer-2', STUDENT_ID);

    const keys = tx.$queryRaw.mock.calls.map(([, key]) => key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('findGeneralTemplate', () => {
  it('should find the general template among the templates of the trainers', async () => {
    const world = createFeedbackWorld();
    world.seed('studentFeedbackTemplate', { id: 'template-own', trainerId: WORLD_TRAINER_ID, isGeneral: false, name: 'Check-in semanal', version: 5, deletedAt: null });

    await expect(findGeneralTemplate(world.prisma)).resolves.toMatchObject({ id: GENERAL_TEMPLATE_ID, name: GENERAL_TEMPLATE_NAME });
  });

  it('should ignore a deleted general template', async () => {
    const world = createFeedbackWorld();
    world.seed('studentFeedbackTemplate', { id: 'template-general-old', trainerId: null, isGeneral: true, name: 'Geral antigo', version: 9, deletedAt: NOW });

    await expect(findGeneralTemplate(world.prisma)).resolves.toMatchObject({ id: GENERAL_TEMPLATE_ID, name: GENERAL_TEMPLATE_NAME });
  });

  it('should return the template found', async () => {
    const template = { id: TEMPLATE_ID, name: 'Padrão TeuFit' };
    const prisma = { studentFeedbackTemplate: { findFirst: vi.fn().mockResolvedValue(template) } };

    await expect(findGeneralTemplate(prisma)).resolves.toEqual(template);
  });

  it('should return null when the database has no general template', async () => {
    const prisma = { studentFeedbackTemplate: { findFirst: vi.fn().mockResolvedValue(null) } };

    await expect(findGeneralTemplate(prisma)).resolves.toBeNull();
  });
});

describe('createRequest', () => {
  it('should look for a published diet protocol of the student under an active nutritionist link', async () => {
    const tx = buildRequestTx(null);

    await createRequest(tx, buildRequestInput());

    expect(tx.dietProtocol.findFirst).toHaveBeenCalledWith({
      where: {
        assigneeId: STUDENT_ID,
        status: PlanStatus.PUBLISHED,
        nutritionist: { patients: { some: { patientId: STUDENT_ID, deletedAt: null } } },
      },
      select: { id: true },
    });
  });

  it('should store hasMealPlan true when the student has a published diet protocol', async () => {
    const tx = buildRequestTx({ id: 'plan-1' });

    await createRequest(tx, buildRequestInput());

    expect(tx.studentFeedbackRequest.create.mock.calls[0][0].data.hasMealPlan).toBe(true);
  });

  it('should store hasMealPlan false when the student has no published diet protocol', async () => {
    const tx = buildRequestTx(null);

    await createRequest(tx, buildRequestInput());

    expect(tx.studentFeedbackRequest.create.mock.calls[0][0].data.hasMealPlan).toBe(false);
  });

  it('should create a pending request sent now that expires after the response window', async () => {
    const tx = buildRequestTx(null);
    const dueAt = new Date('2026-03-10T12:00:00.000Z');

    await createRequest(tx, buildRequestInput({ milestone: StudentFeedbackMilestone.D15, dueAt }));

    expect(tx.studentFeedbackRequest.create).toHaveBeenCalledTimes(1);
    expect(tx.studentFeedbackRequest.create).toHaveBeenCalledWith({
      data: {
        trainerId: TRAINER_ID,
        studentId: STUDENT_ID,
        templateId: TEMPLATE_ID,
        milestone: StudentFeedbackMilestone.D15,
        status: StudentFeedbackStatus.PENDING,
        hasMealPlan: false,
        dueAt,
        sentAt: NOW,
        expiresAt: new Date(NOW.getTime() + RESPONSE_WINDOW_DAYS * DAY_MS),
      },
    });
  });

  it('should keep a null dueAt for a request sent by hand', async () => {
    const tx = buildRequestTx(null);

    await createRequest(tx, buildRequestInput({ milestone: StudentFeedbackMilestone.ADHOC, dueAt: null }));

    expect(tx.studentFeedbackRequest.create.mock.calls[0][0].data.dueAt).toBeNull();
  });

  it('should return the stored request', async () => {
    const tx = buildRequestTx(null);

    const request = await createRequest(tx, buildRequestInput());

    expect(request).toMatchObject({ id: 'request-1', trainerId: TRAINER_ID, studentId: STUDENT_ID, status: StudentFeedbackStatus.PENDING });
  });

  it('should not create the request when the meal plan lookup fails', async () => {
    const tx = buildRequestTx(null);
    const lookupFailure = new AppError({ httpStatus: 500, error: 'INTERNAL', messageCode: 'internal.error', message: 'lookup failed' });
    tx.dietProtocol.findFirst.mockRejectedValue(lookupFailure);

    await expect(createRequest(tx, buildRequestInput())).rejects.toBe(lookupFailure);
    expect(tx.studentFeedbackRequest.create).not.toHaveBeenCalled();
  });
});

describe('sendEmailSafely', () => {
  const payload = { to: 'student@example.com', studentName: 'Ana', trainerName: 'Bruno Lima', expiresAt: NOW };

  it('should call the sender once with the payload', async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: 'email-1' }, error: null });

    await sendEmailSafely(send, payload, { warn: vi.fn() });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(payload);
  });

  it('should not log when the provider accepts the e-mail', async () => {
    const logger = { warn: vi.fn() };

    await sendEmailSafely(vi.fn().mockResolvedValue({ data: { id: 'email-1' }, error: null }), payload, logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('should not log when the sender resolves with nothing', async () => {
    const logger = { warn: vi.fn() };

    await sendEmailSafely(vi.fn().mockResolvedValue(undefined), payload, logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('should log only the error name when the provider returns an error', async () => {
    const logger = { warn: vi.fn() };
    const providerError = { name: 'validation_error', message: `Invalid recipient ${payload.to}` };

    await sendEmailSafely(vi.fn().mockResolvedValue({ data: null, error: providerError }), payload, logger);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toEqual({ providerError: 'validation_error' });
    expect(JSON.stringify(logger.warn.mock.calls[0])).not.toContain(payload.to);
  });

  it('should log a placeholder name when the provider error has no name', async () => {
    const logger = { warn: vi.fn() };

    await sendEmailSafely(vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }), payload, logger);

    expect(logger.warn.mock.calls[0][0]).toEqual({ providerError: 'unknown_error' });
  });

  it('should resolve and log the error when the sender rejects', async () => {
    const logger = { warn: vi.fn() };
    const failure = new AppError({ httpStatus: 502, error: 'EMAIL_FAILED', messageCode: 'email.failed', message: 'smtp down' });

    await expect(sendEmailSafely(vi.fn().mockRejectedValue(failure), payload, logger)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toEqual({ err: failure });
  });

  it('should resolve when the sender throws synchronously', async () => {
    const logger = { warn: vi.fn() };
    const failure = new AppError({ httpStatus: 500, error: 'EMAIL_FAILED', messageCode: 'email.failed', message: 'sync failure' });
    const send = vi.fn().mockImplementation(() => {
      throw failure;
    });

    await expect(sendEmailSafely(send, payload, logger)).resolves.toBeUndefined();

    expect(logger.warn.mock.calls[0][0]).toEqual({ err: failure });
  });

  it.each([null, undefined, {}])('should resolve on a failed send when the logger is %o', async (logger) => {
    const failure = new AppError({ httpStatus: 502, error: 'EMAIL_FAILED', messageCode: 'email.failed', message: 'smtp down' });

    await expect(sendEmailSafely(vi.fn().mockRejectedValue(failure), payload, logger)).resolves.toBeUndefined();
  });

  it.each([null, undefined, {}])('should resolve on a provider error when the logger is %o', async (logger) => {
    const send = vi.fn().mockResolvedValue({ data: null, error: { name: 'rate_limit_exceeded' } });

    await expect(sendEmailSafely(send, payload, logger)).resolves.toBeUndefined();
  });
});
