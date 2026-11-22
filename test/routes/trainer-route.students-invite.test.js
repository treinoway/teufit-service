import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// Holder of the in-memory world the mocked database client reads from.
const database = vi.hoisted(() => ({ world: null }));

vi.mock('../../src/db.js', () => ({
  prisma: new Proxy({}, { get: (_target, property) => database.world?.prisma[property] }),
}));
vi.mock('../../src/services/platform-plan-service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  assertStudentCap: vi.fn(),
}));
vi.mock('../../src/services/trainer-service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  linkStudentByEmail: vi.fn(),
}));
vi.mock('../../src/services/trainer-onboarding-service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  maybeMarkFirstStudentInvited: vi.fn(),
  maybeMarkFirstStudentLinked: vi.fn(),
}));

import { setupApp } from '../helpers/setup-app.js';
import { AppError } from '../../src/errors/app-error.js';
import { Roles } from '../../src/constants/roles.js';
import { UserStatus } from '../../src/constants/user-status.js';
import { EMAIL_PROVIDER } from '../../src/constants/email-verification.js';
import { PLATFORM_PLAN_ERRORS } from '../../src/constants/platform-plan.js';
import {
  StudentInviteStatus,
  StudentInviteOutcome,
  StudentInviteErrorCode,
  StudentInviteMessageCode,
  STUDENT_INVITE_DAILY_MAX,
} from '../../src/constants/student-invite.js';
import { assertStudentCap } from '../../src/services/platform-plan-service.js';
import { linkStudentByEmail } from '../../src/services/trainer-service.js';
import { createInviteConsentWorld } from '../helpers/student-invite-consent-world.js';

const URL = '/trainer/students';
const ACCEPTED_FOR_PROCESSING = 202;
const TRAINER_USER_ID = '7d0f2b1c-6f0e-4a55-9f0e-0c1d2e3f4a5b';
const TRAINER_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const STUDENT_ID = '3b1f8a52-4c9e-4d7a-8a55-1f2e3d4c5b6a';
const TRAINER_EMAIL = 'coach@example.com';
const STUDENT_EMAIL = 'student@example.com';
const UNKNOWN_EMAIL = 'nobody@example.com';
const UNVERIFIED_SENDER_INVITE_CAP = 3;
const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
const VERIFIED_AT = new Date('2026-11-01T00:00:00.000Z');

// Builds invites the trainer sent to other addresses a minute ago.
function recentInvites(count) {
  const sentAt = new Date(Date.now() - MS_PER_MINUTE);
  return Array.from({ length: count }, (_unused, index) => ({
    trainerId: TRAINER_ID,
    email: `seeded-${index}@example.com`,
    status: StudentInviteStatus.PENDING,
    createdAt: sentAt,
    lastSentAt: sentAt,
    expiresAt: new Date(Date.now() + MS_PER_DAY),
  }));
}

// Builds the world of one trainer and one existing student account with a verified e-mail.
function makeWorld({ senderVerified = true, invites = [], links = [] } = {}) {
  return createInviteConsentWorld({
    users: [
      { id: TRAINER_USER_ID, email: TRAINER_EMAIL, firstName: 'Ana', lastName: 'Coach', deletedAt: null },
      { id: STUDENT_ID, email: STUDENT_EMAIL, firstName: 'Caio', lastName: 'Souza', avatarUrl: null, status: UserStatus.ACTIVE, deletedAt: null },
    ],
    accounts: [
      { id: 'account-trainer', userId: TRAINER_USER_ID, provider: EMAIL_PROVIDER, verifiedAt: senderVerified ? VERIFIED_AT : null },
      { id: 'account-student', userId: STUDENT_ID, provider: EMAIL_PROVIDER, verifiedAt: VERIFIED_AT },
    ],
    trainers: [{ id: TRAINER_ID, userId: TRAINER_USER_ID, deletedAt: null }],
    invites,
    links,
  });
}

describe(`POST ${URL} (legacy direct link) goes through the invite flow`, () => {
  let app;
  let trainerToken;

  const post = (email, headers = { authorization: `Bearer ${trainerToken}` }) =>
    app.inject({ method: 'POST', url: URL, headers, payload: { email } });
  const invitesFor = (email) => database.world.state.studentInvites.filter((row) => row.email === email);

  beforeAll(async () => {
    app = await setupApp();
    await app.ready();
    trainerToken = app.jwt.sign({ sub: TRAINER_USER_ID, email: TRAINER_EMAIL, roles: [Roles.TRAINER], status: UserStatus.ACTIVE });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    database.world = makeWorld();
    assertStudentCap.mockResolvedValue(undefined);
    linkStudentByEmail.mockResolvedValue({ id: STUDENT_ID, email: STUDENT_EMAIL, firstName: 'Caio', lastName: 'Souza', avatarUrl: null });
  });

  describe('when the e-mail belongs to an existing account', () => {
    it('should answer 202 { outcome: invited, invite } and no student profile', async () => {
      const res = await post(STUDENT_EMAIL);

      expect(res.statusCode).toBe(ACCEPTED_FOR_PROCESSING);
      expect(res.json()).toMatchObject({
        outcome: StudentInviteOutcome.INVITED,
        invite: { id: expect.any(String), email: STUDENT_EMAIL, status: StudentInviteStatus.PENDING },
      });
      expect(res.json()).not.toHaveProperty('student');
    });

    it('should never link the student directly', async () => {
      await post(STUDENT_EMAIL);

      expect(linkStudentByEmail).not.toHaveBeenCalled();
      expect(database.world.state.trainerStudents).toEqual([]);
    });

    it('should store a pending invite that needs the consent of the student', async () => {
      await post(STUDENT_EMAIL);

      expect(invitesFor(STUDENT_EMAIL)).toEqual([
        expect.objectContaining({ trainerId: TRAINER_ID, status: StudentInviteStatus.PENDING, requiresConsent: true }),
      ]);
    });

    it('should answer the id of the stored invite', async () => {
      const res = await post(STUDENT_EMAIL);

      expect(invitesFor(STUDENT_EMAIL)).toHaveLength(1);
      expect(res.json().invite?.id).toBe(invitesFor(STUDENT_EMAIL)[0].id);
    });
  });

  describe('when the e-mail has no account', () => {
    it('should answer 202 { outcome: invited, invite } too', async () => {
      const res = await post(UNKNOWN_EMAIL);

      expect(res.statusCode).toBe(ACCEPTED_FOR_PROCESSING);
      expect(res.json()).toMatchObject({ outcome: StudentInviteOutcome.INVITED, invite: { email: UNKNOWN_EMAIL } });
    });

    it('should store an invite that is accepted automatically later', async () => {
      await post(UNKNOWN_EMAIL);

      expect(invitesFor(UNKNOWN_EMAIL)).toEqual([expect.objectContaining({ status: StudentInviteStatus.PENDING, requiresConsent: false })]);
    });
  });

  describe('invite caps', () => {
    it('should answer 403 emailVerification.required to the 4th invite of an unverified sender and create nothing', async () => {
      database.world = makeWorld({ senderVerified: false, invites: recentInvites(UNVERIFIED_SENDER_INVITE_CAP) });

      const res = await post(STUDENT_EMAIL);

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'EMAIL_VERIFICATION_REQUIRED', messageCode: 'emailVerification.required', message: expect.any(String) });
      expect(invitesFor(STUDENT_EMAIL)).toEqual([]);
      expect(database.world.state.trainerStudents).toEqual([]);
    });

    it('should answer 429 studentInvite.dailyLimit once the daily cap is reached', async () => {
      database.world = makeWorld({ invites: recentInvites(STUDENT_INVITE_DAILY_MAX) });

      const res = await post(STUDENT_EMAIL);

      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ error: StudentInviteErrorCode.DAILY_LIMIT, messageCode: StudentInviteMessageCode.DAILY_LIMIT });
      expect(invitesFor(STUDENT_EMAIL)).toEqual([]);
    });

    it('should answer the plan student cap error and create nothing when the trainer is over the cap', async () => {
      const { status, code, messageCode } = PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED;
      assertStudentCap.mockRejectedValue(new AppError({ httpStatus: status, error: code, messageCode, message: 'cap' }));

      const res = await post(STUDENT_EMAIL);

      expect(res.statusCode).toBe(status);
      expect(res.json()).toMatchObject({ error: code, messageCode });
      expect(database.world.state.studentInvites).toEqual([]);
      expect(database.world.state.trainerStudents).toEqual([]);
    });
  });

  describe('refusals kept from the invite flow', () => {
    it('should answer 409 student.alreadyLinked for a student already linked to the trainer', async () => {
      database.world = makeWorld({ links: [{ trainerId: TRAINER_ID, studentId: STUDENT_ID, activeOnPlan: true }] });

      const res = await post(STUDENT_EMAIL);

      expect(res.statusCode).toBe(409);
      expect(res.json().messageCode).toBe(StudentInviteMessageCode.ALREADY_LINKED);
      expect(database.world.state.studentInvites).toEqual([]);
    });

    it('should answer 422 student.cannotLinkSelf for the own e-mail of the trainer', async () => {
      const res = await post(TRAINER_EMAIL);

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: StudentInviteErrorCode.CANNOT_LINK_SELF, messageCode: StudentInviteMessageCode.CANNOT_LINK_SELF });
    });

    it('should answer 401 without authentication', async () => {
      const res = await post(STUDENT_EMAIL, {});

      expect(res.statusCode).toBe(401);
      expect(database.world.state.studentInvites).toEqual([]);
    });

    it('should answer 403 to a user without the trainer role', async () => {
      const plainToken = app.jwt.sign({ sub: STUDENT_ID, email: STUDENT_EMAIL, roles: [], status: UserStatus.ACTIVE });

      const res = await post(UNKNOWN_EMAIL, { authorization: `Bearer ${plainToken}` });

      expect(res.statusCode).toBe(403);
      expect(database.world.state.studentInvites).toEqual([]);
    });
  });
});
