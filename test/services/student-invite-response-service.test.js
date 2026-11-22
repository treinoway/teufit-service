import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/db.js', () => ({ prisma: {} }));
vi.mock('../../src/config/s3-bucket-handler.js', () => ({
  default: { resolveUrl: vi.fn() },
}));
vi.mock('../../src/config/email-handler.js', () => ({
  default: { sendStudentInviteEmail: vi.fn(), sendStudentInviteOpenAppEmail: vi.fn(), sendExistingUserStudentInviteEmail: vi.fn() },
}));
vi.mock('../../src/services/platform-plan-service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  assertStudentCap: vi.fn(),
}));
vi.mock('../../src/services/trainer-onboarding-service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  maybeMarkFirstStudentLinked: vi.fn(),
  maybeMarkFirstStudentInvited: vi.fn(),
}));
vi.mock('../../src/services/briefing-service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  markBriefingDirty: vi.fn(),
}));
vi.mock('../../src/services/challenge-participant-sync.js', async (importOriginal) => ({
  ...(await importOriginal()),
  joinAllModeChallenges: vi.fn(),
}));

import s3BucketHandler from '../../src/config/s3-bucket-handler.js';
import { AppError } from '../../src/errors/app-error.js';
import { PLATFORM_PLAN_ERRORS } from '../../src/constants/platform-plan.js';
import { EMAIL_PROVIDER } from '../../src/constants/email-verification.js';
import { StudentInviteStatus, StudentInviteErrorCode, StudentInviteMessageCode } from '../../src/constants/student-invite.js';
import { assertStudentCap } from '../../src/services/platform-plan-service.js';
import { maybeMarkFirstStudentLinked } from '../../src/services/trainer-onboarding-service.js';
import { markBriefingDirty } from '../../src/services/briefing-service.js';
import { joinAllModeChallenges } from '../../src/services/challenge-participant-sync.js';
import { listStudentInvites } from '../../src/services/student-invite-service.js';
import {
  listInvitesForStudent,
  acceptStudentInvite,
  declineStudentInvite,
} from '../../src/services/student-invite-response-service.js';
import { createInviteConsentWorld } from '../helpers/student-invite-consent-world.js';

const NOW = new Date('2026-11-19T12:00:00.000Z');
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const STUDENT_ID = 'student-1';
const STORED_STUDENT_EMAIL = 'Student@Example.com';
const STUDENT_EMAIL = 'student@example.com';
const STRANGER_ID = 'stranger-1';
const TRAINER_ID = 'trainer-1';
const TRAINER_USER_ID = 'trainer-user-1';
const DELETED_TRAINER_ID = 'trainer-deleted';
const DELETED_TRAINER_USER_ID = 'trainer-user-deleted';
const INVITE_ID = 'invite-1';
const UNKNOWN_INVITE_ID = 'invite-unknown';
const AVATAR_KEY = 'avatars/ana.png';
const DECLINED_STATUS = 'declined';
const ACCEPTED_STATUS = 'accepted';
const INVITE_NOT_FOUND = Object.freeze({
  httpStatus: 404,
  error: 'STUDENT_INVITE_NOT_FOUND',
  messageCode: 'studentInvite.notFound',
});
const INVITE_NOT_PENDING = Object.freeze({
  httpStatus: 409,
  error: 'STUDENT_INVITE_NOT_PENDING',
  messageCode: 'studentInvite.notPending',
});
const INVITE_EXPIRED = Object.freeze({
  httpStatus: 422,
  error: 'STUDENT_INVITE_EXPIRED',
  messageCode: 'studentInvite.expired',
});
const ANSWERED_STATUSES = [StudentInviteStatus.REVOKED, DECLINED_STATUS, StudentInviteStatus.ACCEPTED];
const ANSWERS = [
  ['acceptStudentInvite', (prisma, args) => acceptStudentInvite(prisma, args)],
  ['declineStudentInvite', (prisma, args) => declineStudentInvite(prisma, args)],
];

// Builds a pending, unexpired consent invite of the trainer addressed to the student.
function makeInvite(overrides = {}) {
  return {
    id: INVITE_ID,
    trainerId: TRAINER_ID,
    email: STUDENT_EMAIL,
    status: StudentInviteStatus.PENDING,
    requiresConsent: true,
    createdAt: new Date(NOW.getTime() - ONE_DAY_MS),
    lastSentAt: new Date(NOW.getTime() - ONE_DAY_MS),
    expiresAt: new Date(NOW.getTime() + ONE_DAY_MS),
    ...overrides,
  };
}

// Builds the world: one student, one stranger, one active trainer and one deleted trainer.
function makeWorld({ invites = [makeInvite()], studentVerified = true, studentDeletedAt = null, trainerUser = {}, links = [] } = {}) {
  const deletedAt = new Date('2026-11-10T00:00:00.000Z');
  return createInviteConsentWorld({
    users: [
      { id: STUDENT_ID, email: STORED_STUDENT_EMAIL, firstName: 'Caio', lastName: 'Souza', avatarUrl: null, status: 'active', deletedAt: studentDeletedAt },
      { id: STRANGER_ID, email: 'stranger@example.com', firstName: 'Edu', lastName: 'Reis', avatarUrl: null, status: 'active', deletedAt: null },
      { id: TRAINER_USER_ID, email: 'coach@example.com', firstName: 'Ana', lastName: 'Coach', avatarUrl: AVATAR_KEY, deletedAt: null, ...trainerUser },
      { id: DELETED_TRAINER_USER_ID, email: 'gone@example.com', firstName: 'Old', lastName: 'Coach', avatarUrl: null, deletedAt },
    ],
    accounts: [
      { id: 'account-student', userId: STUDENT_ID, provider: EMAIL_PROVIDER, verifiedAt: studentVerified ? new Date('2026-11-01T00:00:00.000Z') : null },
      { id: 'account-stranger', userId: STRANGER_ID, provider: EMAIL_PROVIDER, verifiedAt: new Date('2026-11-01T00:00:00.000Z') },
    ],
    trainers: [
      { id: TRAINER_ID, userId: TRAINER_USER_ID, deletedAt: null },
      { id: DELETED_TRAINER_ID, userId: DELETED_TRAINER_USER_ID, deletedAt },
    ],
    invites,
    links,
  });
}

// Builds the error the plan service throws when the trainer is over the student cap.
function capExceededError() {
  return new AppError({
    httpStatus: PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED.status,
    error: PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED.code,
    messageCode: PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED.messageCode,
    message: 'cap',
  });
}

describe('student-invite-response-service', () => {
  const asStudent = { studentId: STUDENT_ID, inviteId: INVITE_ID };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    s3BucketHandler.resolveUrl.mockImplementation(async (key) => (key ? `https://cdn/${key}` : null));
    assertStudentCap.mockResolvedValue(undefined);
    maybeMarkFirstStudentLinked.mockResolvedValue(undefined);
    markBriefingDirty.mockResolvedValue(undefined);
    joinAllModeChallenges.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('listInvitesForStudent', () => {
    it('should return the pending consent invite with the trainer name, a resolved avatar and both dates', async () => {
      const { prisma, state } = makeWorld();

      const result = await listInvitesForStudent(prisma, { studentId: STUDENT_ID });

      expect(result).toEqual({
        items: [
          {
            id: INVITE_ID,
            trainer: { firstName: 'Ana', lastName: 'Coach', avatarUrl: `https://cdn/${AVATAR_KEY}` },
            createdAt: state.studentInvites[0].createdAt,
            expiresAt: state.studentInvites[0].expiresAt,
          },
        ],
      });
    });

    it('should answer empty strings for missing trainer names and a null avatar', async () => {
      const { prisma } = makeWorld({ trainerUser: { firstName: null, lastName: null, avatarUrl: null } });

      const result = await listInvitesForStudent(prisma, { studentId: STUDENT_ID });

      expect(result.items[0].trainer).toEqual({ firstName: '', lastName: '', avatarUrl: null });
    });

    it('should list the newest invite first', async () => {
      const older = makeInvite({ id: 'invite-older', createdAt: new Date(NOW.getTime() - 3 * ONE_DAY_MS) });
      const newer = makeInvite({ id: 'invite-newer', trainerId: 'trainer-2', createdAt: new Date(NOW.getTime() - ONE_HOUR_MS) });
      const world = makeWorld({ invites: [older, newer] });
      world.state.users.push({ id: 'trainer-user-2', email: 'bia@example.com', firstName: 'Bia', lastName: 'Lima', avatarUrl: null, deletedAt: null });
      world.state.trainers.push({ id: 'trainer-2', userId: 'trainer-user-2', deletedAt: null });

      const result = await listInvitesForStudent(world.prisma, { studentId: STUDENT_ID });

      expect(result.items.map((item) => item.id)).toEqual(['invite-newer', 'invite-older']);
    });

    it.each([
      ['an invite that needs no consent', { requiresConsent: false }],
      ['an expired invite', { expiresAt: new Date(NOW.getTime() - 1) }],
      ['a revoked invite', { status: StudentInviteStatus.REVOKED }],
      ['a declined invite', { status: DECLINED_STATUS }],
      ['an accepted invite', { status: StudentInviteStatus.ACCEPTED }],
      ['an invite flagged expired', { status: StudentInviteStatus.EXPIRED }],
      ['an invite addressed to another e-mail', { email: 'someone.else@example.com' }],
      ['an invite of a deleted trainer', { trainerId: DELETED_TRAINER_ID }],
    ])('should leave out %s', async (_label, overrides) => {
      const { prisma } = makeWorld({ invites: [makeInvite(overrides)] });

      const result = await listInvitesForStudent(prisma, { studentId: STUDENT_ID });

      expect(result).toEqual({ items: [] });
    });

    it('should return no items for a caller whose e-mail is not verified', async () => {
      const { prisma } = makeWorld({ studentVerified: false });

      await expect(listInvitesForStudent(prisma, { studentId: STUDENT_ID })).resolves.toEqual({ items: [] });
    });

    it('should return no items for a deactivated caller', async () => {
      const { prisma } = makeWorld({ studentDeletedAt: NOW });

      await expect(listInvitesForStudent(prisma, { studentId: STUDENT_ID })).resolves.toEqual({ items: [] });
    });

    it('should return no items for a caller without a user row', async () => {
      const { prisma } = makeWorld();

      await expect(listInvitesForStudent(prisma, { studentId: 'user-gone' })).resolves.toEqual({ items: [] });
    });

    it('should not show the invite to another user', async () => {
      const { prisma } = makeWorld();

      await expect(listInvitesForStudent(prisma, { studentId: STRANGER_ID })).resolves.toEqual({ items: [] });
    });
  });

  describe('acceptStudentInvite', () => {
    it('should answer { status: accepted }', async () => {
      const { prisma } = makeWorld();

      await expect(acceptStudentInvite(prisma, asStudent)).resolves.toEqual({ status: ACCEPTED_STATUS });
    });

    it('should mark the invite accepted by the student now', async () => {
      const { prisma, state } = makeWorld();

      await acceptStudentInvite(prisma, asStudent);

      expect(state.studentInvites[0]).toMatchObject({ status: StudentInviteStatus.ACCEPTED, studentId: STUDENT_ID, acceptedAt: NOW });
    });

    it('should create the trainer-student link active on the plan', async () => {
      const { prisma, state } = makeWorld();

      await acceptStudentInvite(prisma, asStudent);

      expect(state.trainerStudents).toEqual([expect.objectContaining({ trainerId: TRAINER_ID, studentId: STUDENT_ID, activeOnPlan: true })]);
    });

    it('should create the link inactive when the trainer is over the plan student cap', async () => {
      const { prisma, state } = makeWorld();
      assertStudentCap.mockRejectedValue(capExceededError());

      const result = await acceptStudentInvite(prisma, asStudent);

      expect(result).toEqual({ status: ACCEPTED_STATUS });
      expect(state.trainerStudents).toEqual([expect.objectContaining({ trainerId: TRAINER_ID, studentId: STUDENT_ID, activeOnPlan: false })]);
    });

    it('should fire the first-student-linked milestone of the trainer', async () => {
      const { prisma } = makeWorld();

      await acceptStudentInvite(prisma, asStudent);

      expect(maybeMarkFirstStudentLinked).toHaveBeenCalledTimes(1);
      expect(maybeMarkFirstStudentLinked).toHaveBeenCalledWith(expect.objectContaining({ trainerId: TRAINER_ID }));
    });

    it('should mark the briefing of the trainer dirty', async () => {
      const { prisma } = makeWorld();

      await acceptStudentInvite(prisma, asStudent);

      expect(markBriefingDirty).toHaveBeenCalledWith(expect.anything(), TRAINER_ID);
    });

    it('should join the student to the open all-mode championships of the trainer', async () => {
      const { prisma } = makeWorld();

      await acceptStudentInvite(prisma, asStudent);

      expect(joinAllModeChallenges).toHaveBeenCalledTimes(1);
      expect(joinAllModeChallenges.mock.calls[0].slice(1, 3)).toEqual([TRAINER_ID, STUDENT_ID]);
    });

    it('should keep the link when joining the championships fails', async () => {
      const { prisma, state } = makeWorld();
      joinAllModeChallenges.mockRejectedValue(new AppError({ httpStatus: 500, error: 'SYNC_FAILED', messageCode: 'sync.failed', message: 'sync' }));

      await expect(acceptStudentInvite(prisma, asStudent)).resolves.toEqual({ status: ACCEPTED_STATUS });
      expect(state.trainerStudents).toHaveLength(1);
    });

    it('should link nothing and reject with 409 notPending when the invite is revoked while it is being accepted', async () => {
      const world = makeWorld();
      world.raceInviteWith(() => {
        world.state.studentInvites[0].status = StudentInviteStatus.REVOKED;
      });

      await expect(acceptStudentInvite(world.prisma, asStudent)).rejects.toMatchObject(INVITE_NOT_PENDING);
      expect(world.state.trainerStudents).toEqual([]);
      expect(world.state.studentInvites[0].status).toBe(StudentInviteStatus.REVOKED);
    });
  });

  describe('declineStudentInvite', () => {
    it('should answer { status: declined }', async () => {
      const { prisma } = makeWorld();

      await expect(declineStudentInvite(prisma, asStudent)).resolves.toEqual({ status: DECLINED_STATUS });
    });

    it('should mark the invite declined and link nothing', async () => {
      const { prisma, state } = makeWorld();

      await declineStudentInvite(prisma, asStudent);

      expect(state.studentInvites[0].status).toBe(DECLINED_STATUS);
      expect(state.trainerStudents).toEqual([]);
    });

    it('should fire no link side effect', async () => {
      const { prisma } = makeWorld();

      await declineStudentInvite(prisma, asStudent);

      expect(maybeMarkFirstStudentLinked).not.toHaveBeenCalled();
      expect(markBriefingDirty).not.toHaveBeenCalled();
      expect(joinAllModeChallenges).not.toHaveBeenCalled();
    });

    it('should report the invite as declined, not resendable, in the invite list of the trainer', async () => {
      const { prisma } = makeWorld();

      await declineStudentInvite(prisma, asStudent);
      const listed = await listStudentInvites(prisma, { trainerId: TRAINER_ID });

      expect(listed.items).toEqual([expect.objectContaining({ id: INVITE_ID, status: DECLINED_STATUS, canResend: false })]);
    });

    it('should drop the invite from the list of the student', async () => {
      const { prisma } = makeWorld();

      await declineStudentInvite(prisma, asStudent);

      await expect(listInvitesForStudent(prisma, { studentId: STUDENT_ID })).resolves.toEqual({ items: [] });
    });

    it('should keep a concurrent revoke and reject with 409 notPending', async () => {
      const world = makeWorld();
      world.raceInviteWith(() => {
        world.state.studentInvites[0].status = StudentInviteStatus.REVOKED;
      });

      await expect(declineStudentInvite(world.prisma, asStudent)).rejects.toMatchObject(INVITE_NOT_PENDING);
      expect(world.state.studentInvites[0].status).toBe(StudentInviteStatus.REVOKED);
    });
  });

  describe.each(ANSWERS)('%s refusals', (_name, answer) => {
    it('should reject with 404 studentInvite.notFound for an unknown invite id', async () => {
      const { prisma } = makeWorld();

      await expect(answer(prisma, { studentId: STUDENT_ID, inviteId: UNKNOWN_INVITE_ID })).rejects.toMatchObject(INVITE_NOT_FOUND);
    });

    it('should reject with 404 studentInvite.notFound and change nothing for an invite addressed to another e-mail', async () => {
      const { prisma, state } = makeWorld();

      await expect(answer(prisma, { studentId: STRANGER_ID, inviteId: INVITE_ID })).rejects.toMatchObject(INVITE_NOT_FOUND);
      expect(state.studentInvites[0].status).toBe(StudentInviteStatus.PENDING);
      expect(state.trainerStudents).toEqual([]);
    });

    it('should reject with 404 studentInvite.notFound and change nothing while the caller e-mail is unverified', async () => {
      const { prisma, state } = makeWorld({ studentVerified: false });

      await expect(answer(prisma, asStudent)).rejects.toMatchObject(INVITE_NOT_FOUND);
      expect(state.studentInvites[0].status).toBe(StudentInviteStatus.PENDING);
      expect(state.trainerStudents).toEqual([]);
    });

    it('should reject with 404 studentInvite.notFound for a deactivated caller', async () => {
      const { prisma, state } = makeWorld({ studentDeletedAt: NOW });

      await expect(answer(prisma, asStudent)).rejects.toMatchObject(INVITE_NOT_FOUND);
      expect(state.trainerStudents).toEqual([]);
    });

    it('should reject with 422 studentInvite.expired and link nothing for a pending invite past its expiry', async () => {
      const { prisma, state } = makeWorld({ invites: [makeInvite({ expiresAt: new Date(NOW.getTime() - 1) })] });

      await expect(answer(prisma, asStudent)).rejects.toMatchObject(INVITE_EXPIRED);
      expect(state.trainerStudents).toEqual([]);
      expect(state.studentInvites[0].status).not.toBe(StudentInviteStatus.ACCEPTED);
      expect(state.studentInvites[0].status).not.toBe(DECLINED_STATUS);
    });

    it.each(ANSWERED_STATUSES)('should reject with 409 studentInvite.notPending and change nothing for a %s invite', async (status) => {
      const { prisma, state } = makeWorld({ invites: [makeInvite({ status })] });

      await expect(answer(prisma, asStudent)).rejects.toMatchObject(INVITE_NOT_PENDING);
      expect(state.studentInvites[0].status).toBe(status);
      expect(state.trainerStudents).toEqual([]);
    });

    it('should reject with an AppError so the route answers the unified error contract', async () => {
      const { prisma } = makeWorld();

      const rejection = await answer(prisma, { studentId: STUDENT_ID, inviteId: UNKNOWN_INVITE_ID }).catch((error) => error);

      expect(rejection).toBeInstanceOf(AppError);
      expect(rejection.message).toEqual(expect.any(String));
    });
  });

  describe('error constants', () => {
    it('should expose the codes this service answers with', () => {
      expect(StudentInviteErrorCode.EXPIRED).toBe(INVITE_EXPIRED.error);
      expect(StudentInviteMessageCode.EXPIRED).toBe(INVITE_EXPIRED.messageCode);
      expect(StudentInviteStatus.DECLINED).toBe(DECLINED_STATUS);
    });
  });
});
