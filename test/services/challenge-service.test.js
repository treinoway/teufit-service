import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ChallengeErrorCode,
  ChallengeParticipantMode,
  ChallengeStatus,
} from '../../src/constants/challenge.js';

// Mock platform-plan-service — gating is tested separately
vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertCanCreateChallenge: vi.fn().mockResolvedValue(undefined),
}));

// ─── Prisma mock ───────────────────────────────────────────────────────────────

const mockTx = {
  challenge: { create: vi.fn() },
  challengeParticipant: { createMany: vi.fn() },
};

const mockPrisma = {
  trainer: { findUnique: vi.fn() },
  trainerStudent: { findMany: vi.fn(), findUnique: vi.fn() },
  user: { findMany: vi.fn() },
  challenge: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  challengeParticipant: {
    create: vi.fn(),
    createMany: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    delete: vi.fn(),
  },
  gamificationConfig: { findUnique: vi.fn(), upsert: vi.fn() },
  $transaction: vi.fn(async (fn) => fn(mockTx)),
};

import {
  createChallenge,
  updateChallenge,
  cancelChallenge,
  deleteChallenge,
  addParticipants,
  removeParticipant,
  getStudentChallenge,
} from '../../src/services/challenge-service.js';
import { assertCanCreateChallenge } from '../../src/services/platform-plan-service.js';

const TRAINER_ID = 'trainer-record-uuid';
const TRAINER_USER_ID = 'trainer-user-uuid';
const STUDENT_ID_1 = 'student-uuid-1';
const STUDENT_ID_2 = 'student-uuid-2';
const CHALLENGE_ID = 'challenge-uuid-1';

// Future date helpers
const futureDate = (daysFromNow) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

const makeChallengeRecord = (overrides = {}) => ({
  id: CHALLENGE_ID,
  trainerId: TRAINER_ID,
  name: 'Summer Challenge',
  startDate: new Date(futureDate(5) + 'T12:00:00Z'),
  endDate: new Date(futureDate(15) + 'T12:00:00Z'),
  cancelledAt: null,
  participantMode: ChallengeParticipantMode.EXPLICIT,
  filterCriteria: null,
  ptsWorkoutCompleted: null,
  ptsStreak7Days: null,
  ptsStreak30Days: null,
  ptsDailyCheckin: null,
  ptsEvolutionRecord: null,
  ptsWorkoutFeedback: null,
  dailyPointsCap: null,
  anonymousRanking: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: null,
  ...overrides,
});

const makeActiveChallenge = () => {
  const now = new Date();
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 3));
  return makeChallengeRecord({ startDate: yesterday, endDate: tomorrow });
};

const makeCompletedChallenge = () => {
  const past1 = new Date(Date.UTC(2020, 0, 1));
  const past2 = new Date(Date.UTC(2020, 0, 10));
  return makeChallengeRecord({ startDate: past1, endDate: past2 });
};

describe('challenge-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply platform-plan-service mocks after mockReset (mockReset: true in vitest config).
    assertCanCreateChallenge.mockResolvedValue(undefined);
    mockPrisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
    // Return null config by default — resolveChallengePtsSnapshot will use system defaults
    mockPrisma.gamificationConfig.findUnique.mockResolvedValue(null);
    // Silent template upsert is fire-and-forget — resolve by default to avoid unhandled rejection noise
    mockPrisma.gamificationConfig.upsert.mockResolvedValue({});
  });

  // ─── createChallenge ───────────────────────────────────────────────────────

  describe('createChallenge', () => {
    it('creates challenge with EXPLICIT mode and valid student IDs', async () => {
      const startDate = futureDate(1);
      const endDate = futureDate(10);
      mockPrisma.trainerStudent.findMany.mockResolvedValue([
        { studentId: STUDENT_ID_1 },
        { studentId: STUDENT_ID_2 },
      ]);
      mockTx.challenge.create.mockResolvedValue(
        makeChallengeRecord({
          startDate: new Date(startDate + 'T12:00:00Z'),
          endDate: new Date(endDate + 'T12:00:00Z'),
        }),
      );
      mockTx.challengeParticipant.createMany.mockResolvedValue({ count: 2 });

      const result = await createChallenge({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        data: {
          name: 'Summer Challenge',
          startDate,
          endDate,
          participantMode: ChallengeParticipantMode.EXPLICIT,
          studentIds: [STUDENT_ID_1, STUDENT_ID_2],
        },
      });

      expect(result.name).toBe('Summer Challenge');
      expect(result.participantCount).toBe(2);
      expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
    });

    it('throws TRAINER_PROFILE_MISSING when trainer not found', async () => {
      mockPrisma.trainer.findUnique.mockResolvedValue(null);

      await expect(
        createChallenge({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          data: {
            name: 'Test',
            startDate: futureDate(1),
            endDate: futureDate(5),
            participantMode: ChallengeParticipantMode.ALL,
          },
        }),
      ).rejects.toMatchObject({ httpStatus: 404, error: ChallengeErrorCode.TRAINER_PROFILE_MISSING });
    });

    it('throws CHALLENGE_INVALID_DATES when startDate is in the past', async () => {
      await expect(
        createChallenge({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          data: {
            name: 'Past Challenge',
            startDate: '2020-01-01',
            endDate: '2020-01-10',
            participantMode: ChallengeParticipantMode.EXPLICIT,
            studentIds: [STUDENT_ID_1],
          },
        }),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: ChallengeErrorCode.CHALLENGE_INVALID_DATES,
      });
    });

    it('throws CHALLENGE_INVALID_DATES when endDate is before startDate', async () => {
      const startDate = futureDate(10);
      const endDate = futureDate(5);

      await expect(
        createChallenge({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          data: {
            name: 'Backwards',
            startDate,
            endDate,
            participantMode: ChallengeParticipantMode.EXPLICIT,
            studentIds: [STUDENT_ID_1],
          },
        }),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: ChallengeErrorCode.CHALLENGE_INVALID_DATES,
      });
    });

    it('throws CHALLENGE_DURATION_EXCEEDED when duration > 365 days', async () => {
      const startDate = futureDate(1);
      const endDate = futureDate(370);

      await expect(
        createChallenge({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          data: {
            name: 'Too Long',
            startDate,
            endDate,
            participantMode: ChallengeParticipantMode.EXPLICIT,
            studentIds: [STUDENT_ID_1],
          },
        }),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: ChallengeErrorCode.CHALLENGE_DURATION_EXCEEDED,
      });
    });

    it('throws CHALLENGE_PARTICIPANT_NOT_TRAINEE when some student IDs are invalid', async () => {
      const startDate = futureDate(1);
      const endDate = futureDate(5);
      // Only student 1 is a valid trainee
      mockPrisma.trainerStudent.findMany.mockResolvedValue([{ studentId: STUDENT_ID_1 }]);

      await expect(
        createChallenge({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          data: {
            name: 'Challenge',
            startDate,
            endDate,
            participantMode: ChallengeParticipantMode.EXPLICIT,
            studentIds: [STUDENT_ID_1, STUDENT_ID_2],
          },
        }),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: ChallengeErrorCode.CHALLENGE_PARTICIPANT_NOT_TRAINEE,
      });
    });

    it('throws CHALLENGE_FILTER_EMPTY when FILTER mode resolves 0 students', async () => {
      const startDate = futureDate(1);
      const endDate = futureDate(5);
      // No students match the filter
      mockPrisma.user.findMany.mockResolvedValue([]);

      await expect(
        createChallenge({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          data: {
            name: 'Empty Challenge',
            startDate,
            endDate,
            participantMode: ChallengeParticipantMode.FILTER,
            filter: { gender: 'female' },
          },
        }),
      ).rejects.toMatchObject({
        httpStatus: 422,
        error: ChallengeErrorCode.CHALLENGE_FILTER_EMPTY,
      });
    });

    it('silently upserts GamificationConfig template with the values used after challenge creation', async () => {
      const startDate = futureDate(1);
      const endDate = futureDate(10);
      const challengeRecord = makeChallengeRecord({
        startDate: new Date(startDate + 'T12:00:00Z'),
        endDate: new Date(endDate + 'T12:00:00Z'),
        ptsWorkoutCompleted: 50,
        ptsStreak7Days: 100,
        anonymousRanking: true,
      });
      mockPrisma.trainerStudent.findMany.mockResolvedValue([{ studentId: STUDENT_ID_1 }]);
      mockTx.challenge.create.mockResolvedValue(challengeRecord);
      mockTx.challengeParticipant.createMany.mockResolvedValue({ count: 1 });

      await createChallenge({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        data: {
          name: 'Summer Challenge',
          startDate,
          endDate,
          participantMode: ChallengeParticipantMode.EXPLICIT,
          studentIds: [STUDENT_ID_1],
          ptsWorkoutCompleted: 50,
          ptsStreak7Days: 100,
          anonymousRanking: true,
        },
      });

      expect(mockPrisma.gamificationConfig.upsert).toHaveBeenCalledOnce();
      expect(mockPrisma.gamificationConfig.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { trainerId: TRAINER_ID },
          update: expect.objectContaining({
            ptsWorkoutCompleted: 50,
            ptsStreak7Days: 100,
            anonymousRanking: true,
          }),
          create: expect.objectContaining({
            trainerId: TRAINER_ID,
            enabled: true,
            ptsWorkoutCompleted: 50,
            ptsStreak7Days: 100,
            anonymousRanking: true,
          }),
        }),
      );
    });

    it('does not block challenge creation when silent template upsert fails', async () => {
      const startDate = futureDate(1);
      const endDate = futureDate(10);
      const challengeRecord = makeChallengeRecord({
        startDate: new Date(startDate + 'T12:00:00Z'),
        endDate: new Date(endDate + 'T12:00:00Z'),
      });
      mockPrisma.trainerStudent.findMany.mockResolvedValue([{ studentId: STUDENT_ID_1 }]);
      mockTx.challenge.create.mockResolvedValue(challengeRecord);
      mockTx.challengeParticipant.createMany.mockResolvedValue({ count: 1 });
      // Simulate upsert failure
      mockPrisma.gamificationConfig.upsert.mockRejectedValue(new Error('DB connection lost'));

      const result = await createChallenge({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        data: {
          name: 'Summer Challenge',
          startDate,
          endDate,
          participantMode: ChallengeParticipantMode.EXPLICIT,
          studentIds: [STUDENT_ID_1],
        },
      });

      // Challenge was still created successfully
      expect(result.id).toBe(CHALLENGE_ID);
    });

    it('snapshots anonymousRanking from GamificationConfig when not provided in request', async () => {
      const startDate = futureDate(1);
      const endDate = futureDate(10);
      mockPrisma.gamificationConfig.findUnique.mockResolvedValue({
        ptsWorkoutCompleted: 10,
        ptsStreak7Days: null,
        ptsStreak30Days: null,
        ptsDailyCheckin: null,
        ptsEvolutionRecord: null,
        ptsWorkoutFeedback: null,
        dailyPointsCap: null,
        anonymousRanking: true,
      });
      const challengeRecord = makeChallengeRecord({
        startDate: new Date(startDate + 'T12:00:00Z'),
        endDate: new Date(endDate + 'T12:00:00Z'),
        ptsWorkoutCompleted: 10,
        anonymousRanking: true,
      });
      mockPrisma.trainerStudent.findMany.mockResolvedValue([{ studentId: STUDENT_ID_1 }]);
      mockTx.challenge.create.mockResolvedValue(challengeRecord);
      mockTx.challengeParticipant.createMany.mockResolvedValue({ count: 1 });

      const result = await createChallenge({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        data: {
          name: 'Challenge',
          startDate,
          endDate,
          participantMode: ChallengeParticipantMode.EXPLICIT,
          studentIds: [STUDENT_ID_1],
        },
      });

      expect(result.anonymousRanking).toBe(true);
      // The tx.challenge.create should have been called with anonymousRanking: true from config
      expect(mockTx.challenge.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ anonymousRanking: true }),
        }),
      );
    });
  });

  // ─── cancelChallenge ───────────────────────────────────────────────────────

  describe('cancelChallenge', () => {
    it('sets cancelledAt on a scheduled challenge', async () => {
      const challenge = makeChallengeRecord();
      mockPrisma.challenge.findUnique.mockResolvedValue(challenge);
      const cancelled = { ...challenge, cancelledAt: new Date() };
      mockPrisma.challenge.update.mockResolvedValue(cancelled);

      const result = await cancelChallenge({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        challengeId: CHALLENGE_ID,
      });

      expect(result.status).toBe(ChallengeStatus.CANCELLED);
    });

    it('throws CHALLENGE_ALREADY_CANCELLED when already cancelled', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(
        makeChallengeRecord({ cancelledAt: new Date('2026-01-01T00:00:00Z') }),
      );

      await expect(
        cancelChallenge({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          challengeId: CHALLENGE_ID,
        }),
      ).rejects.toMatchObject({
        httpStatus: 409,
        error: ChallengeErrorCode.CHALLENGE_ALREADY_CANCELLED,
      });
    });

    it('throws CHALLENGE_ALREADY_ENDED when challenge is completed', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(makeCompletedChallenge());

      await expect(
        cancelChallenge({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          challengeId: CHALLENGE_ID,
        }),
      ).rejects.toMatchObject({
        httpStatus: 409,
        error: ChallengeErrorCode.CHALLENGE_ALREADY_ENDED,
      });
    });
  });

  // ─── deleteChallenge ───────────────────────────────────────────────────────

  describe('deleteChallenge', () => {
    it('deletes a scheduled challenge', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(makeChallengeRecord());
      mockPrisma.challenge.delete.mockResolvedValue({});

      await expect(
        deleteChallenge({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          challengeId: CHALLENGE_ID,
        }),
      ).resolves.toBeUndefined();

      expect(mockPrisma.challenge.delete).toHaveBeenCalledWith({ where: { id: CHALLENGE_ID } });
    });

    it('throws CHALLENGE_NOT_DELETABLE for an active challenge', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(makeActiveChallenge());

      await expect(
        deleteChallenge({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          challengeId: CHALLENGE_ID,
        }),
      ).rejects.toMatchObject({
        httpStatus: 409,
        error: ChallengeErrorCode.CHALLENGE_NOT_DELETABLE,
      });
    });

    it('throws CHALLENGE_NOT_DELETABLE for a completed challenge', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(makeCompletedChallenge());

      await expect(
        deleteChallenge({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          challengeId: CHALLENGE_ID,
        }),
      ).rejects.toMatchObject({
        httpStatus: 409,
        error: ChallengeErrorCode.CHALLENGE_NOT_DELETABLE,
      });
    });

    it('throws CHALLENGE_NOT_DELETABLE for a cancelled challenge', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(
        makeChallengeRecord({ cancelledAt: new Date('2026-01-01T00:00:00Z') }),
      );

      await expect(
        deleteChallenge({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          challengeId: CHALLENGE_ID,
        }),
      ).rejects.toMatchObject({
        httpStatus: 409,
        error: ChallengeErrorCode.CHALLENGE_NOT_DELETABLE,
      });
    });

    it('throws CHALLENGE_NOT_FOUND when challenge does not exist', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(null);

      await expect(
        deleteChallenge({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          challengeId: CHALLENGE_ID,
        }),
      ).rejects.toMatchObject({ httpStatus: 404, error: ChallengeErrorCode.CHALLENGE_NOT_FOUND });
    });

    it('throws CHALLENGE_FORBIDDEN_NOT_OWNER when trainer does not own challenge', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(
        makeChallengeRecord({ trainerId: 'other-trainer-id' }),
      );

      await expect(
        deleteChallenge({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          challengeId: CHALLENGE_ID,
        }),
      ).rejects.toMatchObject({
        httpStatus: 403,
        error: ChallengeErrorCode.CHALLENGE_FORBIDDEN_NOT_OWNER,
      });
    });
  });

  // ─── updateChallenge ───────────────────────────────────────────────────────

  describe('updateChallenge', () => {
    it('throws CHALLENGE_ALREADY_STARTED when updating startDate of active challenge', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(makeActiveChallenge());

      await expect(
        updateChallenge({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          challengeId: CHALLENGE_ID,
          data: { startDate: futureDate(2) },
        }),
      ).rejects.toMatchObject({
        httpStatus: 409,
        error: ChallengeErrorCode.CHALLENGE_ALREADY_STARTED,
      });
    });

    it('throws CHALLENGE_ALREADY_CANCELLED when updating a cancelled challenge', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(
        makeChallengeRecord({ cancelledAt: new Date('2026-01-01T00:00:00Z') }),
      );

      await expect(
        updateChallenge({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          challengeId: CHALLENGE_ID,
          data: { name: 'New Name' },
        }),
      ).rejects.toMatchObject({
        httpStatus: 409,
        error: ChallengeErrorCode.CHALLENGE_ALREADY_CANCELLED,
      });
    });

    it('updates name of scheduled challenge', async () => {
      const challenge = makeChallengeRecord();
      mockPrisma.challenge.findUnique.mockResolvedValue(challenge);
      const updated = { ...challenge, name: 'New Name' };
      mockPrisma.challenge.update.mockResolvedValue(updated);
      mockPrisma.challengeParticipant.count.mockResolvedValue(0);

      const result = await updateChallenge({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        challengeId: CHALLENGE_ID,
        data: { name: 'New Name' },
      });

      expect(result.name).toBe('New Name');
    });
  });

  // ─── addParticipants ───────────────────────────────────────────────────────

  describe('addParticipants', () => {
    it('throws CHALLENGE_PARTICIPANT_DUPLICATE when student already in challenge', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(makeChallengeRecord());
      mockPrisma.trainerStudent.findMany.mockResolvedValue([{ studentId: STUDENT_ID_1 }]);
      mockPrisma.challengeParticipant.findMany.mockResolvedValue([{ studentId: STUDENT_ID_1 }]);

      await expect(
        addParticipants({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          challengeId: CHALLENGE_ID,
          studentIds: [STUDENT_ID_1],
        }),
      ).rejects.toMatchObject({
        httpStatus: 409,
        error: ChallengeErrorCode.CHALLENGE_PARTICIPANT_DUPLICATE,
      });
    });

    it('throws CHALLENGE_PARTICIPANT_NOT_TRAINEE for non-trainee student IDs', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(makeChallengeRecord());
      mockPrisma.trainerStudent.findMany.mockResolvedValue([]); // no valid trainees

      await expect(
        addParticipants({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          challengeId: CHALLENGE_ID,
          studentIds: [STUDENT_ID_1],
        }),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: ChallengeErrorCode.CHALLENGE_PARTICIPANT_NOT_TRAINEE,
      });
    });
  });

  // ─── removeParticipant ─────────────────────────────────────────────────────

  describe('removeParticipant', () => {
    it('throws CHALLENGE_PARTICIPANT_NOT_FOUND when participant does not exist', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(makeChallengeRecord());
      mockPrisma.challengeParticipant.findUnique.mockResolvedValue(null);

      await expect(
        removeParticipant({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          challengeId: CHALLENGE_ID,
          studentId: STUDENT_ID_1,
        }),
      ).rejects.toMatchObject({
        httpStatus: 404,
        error: ChallengeErrorCode.CHALLENGE_PARTICIPANT_NOT_FOUND,
      });
    });
  });

  // ─── getStudentChallenge ───────────────────────────────────────────────────

  describe('getStudentChallenge', () => {
    it('throws CHALLENGE_FORBIDDEN_NOT_OWNER when student is not a participant', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(makeChallengeRecord());
      mockPrisma.challengeParticipant.findUnique.mockResolvedValue(null);

      await expect(
        getStudentChallenge({
          prisma: mockPrisma,
          studentId: STUDENT_ID_1,
          challengeId: CHALLENGE_ID,
        }),
      ).rejects.toMatchObject({
        httpStatus: 403,
        error: ChallengeErrorCode.CHALLENGE_FORBIDDEN_NOT_OWNER,
      });
    });

    it('returns challenge when student is a participant', async () => {
      const challenge = makeChallengeRecord();
      mockPrisma.challenge.findUnique.mockResolvedValue(challenge);
      mockPrisma.challengeParticipant.findUnique.mockResolvedValue({ challengeId: CHALLENGE_ID, studentId: STUDENT_ID_1 });
      mockPrisma.challengeParticipant.count.mockResolvedValue(5);

      const result = await getStudentChallenge({
        prisma: mockPrisma,
        studentId: STUDENT_ID_1,
        challengeId: CHALLENGE_ID,
      });

      expect(result.id).toBe(CHALLENGE_ID);
      expect(result.participantCount).toBe(5);
    });
  });
});
