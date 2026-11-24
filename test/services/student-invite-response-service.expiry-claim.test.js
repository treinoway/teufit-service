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

import { AppError } from '../../src/errors/app-error.js';
import { EMAIL_PROVIDER } from '../../src/constants/email-verification.js';
import { StudentInviteStatus, StudentInviteMessageCode } from '../../src/constants/student-invite.js';
import { assertStudentCap } from '../../src/services/platform-plan-service.js';
import { maybeMarkFirstStudentLinked } from '../../src/services/trainer-onboarding-service.js';
import { markBriefingDirty } from '../../src/services/briefing-service.js';
import { joinAllModeChallenges } from '../../src/services/challenge-participant-sync.js';
import { acceptStudentInvite, declineStudentInvite } from '../../src/services/student-invite-response-service.js';
import { createInviteConsentWorld } from '../helpers/student-invite-consent-world.js';

const NOW = new Date('2026-11-19T12:00:00.000Z');
const ONE_MS = 1;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const STUDENT_ID = 'student-1';
const STUDENT_EMAIL = 'student@example.com';
const TRAINER_ID = 'trainer-1';
const TRAINER_USER_ID = 'trainer-user-1';
const INVITE_ID = 'invite-1';
const DECLINED_STATUS = 'declined';
const VERIFIED_AT = new Date('2026-11-01T00:00:00.000Z');
const LOST_CLAIM_MESSAGE_CODES = [StudentInviteMessageCode.NOT_PENDING, StudentInviteMessageCode.EXPIRED];
const ANSWERS = [
  ['acceptStudentInvite', acceptStudentInvite, StudentInviteStatus.ACCEPTED],
  ['declineStudentInvite', declineStudentInvite, DECLINED_STATUS],
];

// Builds the world: one verified student, one active trainer and one pending, unexpired consent invite.
function makeWorld() {
  return createInviteConsentWorld({
    users: [
      { id: STUDENT_ID, email: STUDENT_EMAIL, firstName: 'Caio', lastName: 'Souza', avatarUrl: null, status: 'active', deletedAt: null },
      { id: TRAINER_USER_ID, email: 'coach@example.com', firstName: 'Ana', lastName: 'Coach', avatarUrl: null, deletedAt: null },
    ],
    accounts: [{ id: 'account-student', userId: STUDENT_ID, provider: EMAIL_PROVIDER, verifiedAt: VERIFIED_AT }],
    trainers: [{ id: TRAINER_ID, userId: TRAINER_USER_ID, deletedAt: null }],
    invites: [
      {
        id: INVITE_ID,
        trainerId: TRAINER_ID,
        email: STUDENT_EMAIL,
        status: StudentInviteStatus.PENDING,
        requiresConsent: true,
        createdAt: new Date(NOW.getTime() - ONE_DAY_MS),
        lastSentAt: new Date(NOW.getTime() - ONE_DAY_MS),
        expiresAt: new Date(NOW.getTime() + ONE_DAY_MS),
      },
    ],
  });
}

// Where clause of the updateMany that claims the invite into the given final status.
function claimWhere(prisma, finalStatus) {
  const claim = prisma.studentInvite.updateMany.mock.calls.map(([args]) => args).find((args) => args.data?.status === finalStatus);
  return claim?.where;
}

// Lower bound (gte or gt) a where clause puts on expiresAt, or undefined.
function expiryLowerBound(where) {
  return where?.expiresAt?.gte ?? where?.expiresAt?.gt;
}

describe('student-invite-response-service: the expiry is part of the atomic claim', () => {
  const asStudent = { studentId: STUDENT_ID, inviteId: INVITE_ID };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    assertStudentCap.mockResolvedValue(undefined);
    maybeMarkFirstStudentLinked.mockResolvedValue(undefined);
    markBriefingDirty.mockResolvedValue(undefined);
    joinAllModeChallenges.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe.each(ANSWERS)('%s', (_name, answer, finalStatus) => {
    it('should claim the invite by id while it is still pending', async () => {
      const { prisma } = makeWorld();

      await answer(prisma, asStudent);

      expect(claimWhere(prisma, finalStatus)).toMatchObject({ id: INVITE_ID, status: StudentInviteStatus.PENDING });
    });

    it('should claim the invite only while its expiry is not before now', async () => {
      const { prisma } = makeWorld();

      await answer(prisma, asStudent);

      const bound = expiryLowerBound(claimWhere(prisma, finalStatus));
      expect(bound).toBeInstanceOf(Date);
      expect(bound.getTime()).toBe(NOW.getTime());
    });

    describe('when the invite expires between the check and the claim', () => {
      async function answerWhileExpiring(world) {
        world.raceInviteWith(() => {
          world.state.studentInvites[0].expiresAt = new Date(NOW.getTime() - ONE_MS);
        });
        return answer(world.prisma, asStudent).then(
          () => undefined,
          (error) => error,
        );
      }

      it('should reject with an AppError saying the invite is no longer pending or has expired', async () => {
        const rejection = await answerWhileExpiring(makeWorld());

        expect(rejection).toBeInstanceOf(AppError);
        expect(LOST_CLAIM_MESSAGE_CODES).toContain(rejection.messageCode);
      });

      it('should link nothing', async () => {
        const world = makeWorld();

        await answerWhileExpiring(world);

        expect(world.state.trainerStudents).toEqual([]);
      });

      it(`should not leave the invite ${finalStatus}`, async () => {
        const world = makeWorld();

        await answerWhileExpiring(world);

        expect(world.state.studentInvites[0].status).not.toBe(finalStatus);
      });

      it('should fire no link side effect', async () => {
        await answerWhileExpiring(makeWorld());

        expect(maybeMarkFirstStudentLinked).not.toHaveBeenCalled();
        expect(markBriefingDirty).not.toHaveBeenCalled();
        expect(joinAllModeChallenges).not.toHaveBeenCalled();
      });
    });
  });
});
