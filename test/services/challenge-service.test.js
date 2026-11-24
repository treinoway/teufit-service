import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ChallengeErrorCode,
  ChallengeMessageCode,
  ChallengeParticipantMode,
  ChallengeStatus,
} from '../../src/constants/challenge.js';
import { AppError } from '../../src/errors/app-error.js';
import { AppearAs, CONSISTENCY_PRIVACY_TERM_VERSION, Faixa } from '../../src/constants/consistency-ranking.js';
import { materializeTargets } from '../../src/services/consistency-target-service.js';
import { countDone } from '../../src/services/consistency-progress-service.js';
import { countsFrom, createWorld, weeklyResult } from '../helpers/consistency-student-world.js';

// Mock platform-plan-service — gating is tested separately
vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertCanCreateChallenge: vi.fn().mockResolvedValue(undefined),
}));

// Targets and done counts come from protocols and SQL; the student list tests read them from the in-memory world
vi.mock('../../src/services/consistency-target-service.js', async (importOriginal) => ({ ...(await importOriginal()), materializeTargets: vi.fn() }));
vi.mock('../../src/services/consistency-progress-service.js', async (importOriginal) => ({ ...(await importOriginal()), countDone: vi.fn() }));

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
  consistencyRankingConfig: { findUnique: vi.fn() },
  consistencyScoringRule: { findFirst: vi.fn() },
  $transaction: vi.fn(async (fn) => fn(mockTx)),
  $queryRaw: vi.fn(),
};

import {
  createChallenge,
  listChallenges,
  getChallenge,
  updateChallenge,
  cancelChallenge,
  deleteChallenge,
  addParticipants,
  removeParticipant,
  getStudentChallenge,
  listStudentChallenges,
} from '../../src/services/challenge-service.js';
import { assertCanCreateChallenge } from '../../src/services/platform-plan-service.js';
import { joinAllModeChallenges } from '../../src/services/challenge-participant-sync.js';

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

// Wednesday 2026-11-18 12:00 in São Paulo; the current week starts Monday 2026-11-16
const WEDNESDAY_SP = new Date('2026-11-18T15:00:00.000Z');

// Date-only column value (midnight UTC), as Prisma returns @db.Date
const dateOnly = (iso) => new Date(`${iso}T00:00:00.000Z`);

// Request body of a weekly championship starting next Monday
const weeklyBody = (overrides = {}) => ({
  name: 'Verão 2027',
  format: 'weeks',
  startWeek: '2026-11-23',
  weeks: 4,
  description: 'Prêmio: camiseta',
  participantMode: ChallengeParticipantMode.EXPLICIT,
  studentIds: [],
  ...overrides,
});

// Scoring rule saved in the trainer's ranking config
const SAVED_RULE = {
  weights: { workouts: 60, diet: 0, cardio: 40, feedback: 0, hydration: 0 },
  activePillars: ['workouts', 'cardio'],
};

// Scoring rule a trainer sets on one championship
const CHAMPIONSHIP_RULE = {
  weights: { workouts: 100, diet: 0, cardio: 0, feedback: 0, hydration: 0 },
  activePillars: ['workouts'],
};

// Fake findMany over stored championships: those whose fields equal every value of the where clause
const storedMatching = (records) => async ({ where }) => records.filter((record) => (
  Object.entries(where).every(([field, value]) => (record[field] ?? null) === value)
));

// Row Prisma would return for the created data
const echoCreated = (data) => ({
  id: CHALLENGE_ID,
  cancelledAt: null,
  closedAt: null,
  closeRequestedAt: null,
  filterCriteria: null,
  createdAt: new Date('2026-11-18T15:00:00.000Z'),
  updatedAt: null,
  ...data,
});

// Stored weekly championship (4 weeks from Monday 2026-11-09) unless overridden
const weeklyRecord = (overrides = {}) => makeChallengeRecord({
  format: 'weeks',
  weeks: 4,
  minPodiumWeeks: 2,
  description: null,
  visibility: 'full',
  ownerType: 'trainer',
  closeRequestedAt: null,
  closedAt: null,
  startDate: dateOnly('2026-11-09'),
  endDate: dateOnly('2026-12-06'),
  ...overrides,
});

// Stored row the mocked challenge.update merges its data into
let currentRecord;

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
    mockPrisma.$queryRaw.mockResolvedValue([]);
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

    it('CPD-14 changes the weights of a scheduled championship', async () => {
      currentRecord = weeklyRecord({ startDate: dateOnly('2026-11-23'), endDate: dateOnly('2026-12-20'), ...SAVED_RULE });
      mockPrisma.challenge.findUnique.mockResolvedValue(currentRecord);
      mockPrisma.challenge.update.mockImplementation(async ({ data }) => ({ ...currentRecord, ...data }));
      mockPrisma.challengeParticipant.count.mockResolvedValue(3);
      const update = (data) => updateChallenge({
        prisma: mockPrisma, trainerUserId: TRAINER_USER_ID, challengeId: CHALLENGE_ID, now: WEDNESDAY_SP, data,
      });

      const result = await update({ ...CHAMPIONSHIP_RULE });

      expect(mockPrisma.challenge.update).toHaveBeenCalledWith({
        where: { id: CHALLENGE_ID },
        data: { weights: CHAMPIONSHIP_RULE.weights, activePillars: CHAMPIONSHIP_RULE.activePillars },
      });
      expect(result).toMatchObject({ status: ChallengeStatus.SCHEDULED, ...CHAMPIONSHIP_RULE });

      const onlyWeights = { workouts: 50, diet: 0, cardio: 50, feedback: 0, hydration: 0 };
      await update({ weights: onlyWeights });
      expect(mockPrisma.challenge.update).toHaveBeenLastCalledWith({ where: { id: CHALLENGE_ID }, data: { weights: onlyWeights } });

      mockPrisma.challenge.update.mockClear();
      const invalid = [
        [{ weights: { ...CHAMPIONSHIP_RULE.weights, workouts: 90 } }, 'weights'],
        [{ weights: { workouts: 100 } }, 'weights'],
        [{ activePillars: [] }, 'activePillars'],
        [{ ...CHAMPIONSHIP_RULE, activePillars: ['workouts', 'steps'] }, 'activePillars'],
      ];
      for (const [data, field] of invalid) {
        await expect(update(data)).rejects.toMatchObject({
          httpStatus: 400,
          error: ChallengeErrorCode.CHALLENGE_INVALID_SCORING_RULE,
          messageCode: ChallengeMessageCode.CHALLENGE_INVALID_SCORING_RULE,
          details: { field },
        });
      }
      expect(mockPrisma.challenge.update).not.toHaveBeenCalled();
    });

    it('CPD-15 answers 409 for weights of a running championship', async () => {
      const update = (data) => updateChallenge({
        prisma: mockPrisma, trainerUserId: TRAINER_USER_ID, challengeId: CHALLENGE_ID, now: WEDNESDAY_SP, data,
      });

      mockPrisma.challenge.findUnique.mockResolvedValue(weeklyRecord(SAVED_RULE));
      for (const data of [{ ...CHAMPIONSHIP_RULE }, { weights: CHAMPIONSHIP_RULE.weights }, { name: 'Junto', activePillars: ['workouts'] }]) {
        await expect(update(data)).rejects.toMatchObject({
          httpStatus: 409,
          error: ChallengeErrorCode.CHALLENGE_ALREADY_STARTED,
          messageCode: ChallengeMessageCode.CHALLENGE_ALREADY_STARTED,
        });
      }

      mockPrisma.challenge.findUnique.mockResolvedValueOnce(weeklyRecord({ ...SAVED_RULE, closedAt: new Date('2026-11-16T00:10:00.000Z') }));
      await expect(update({ ...CHAMPIONSHIP_RULE })).rejects.toMatchObject({
        httpStatus: 409, error: ChallengeErrorCode.CHALLENGE_ALREADY_ENDED,
      });

      mockPrisma.challenge.findUnique.mockResolvedValueOnce(weeklyRecord({ ...SAVED_RULE, cancelledAt: new Date('2026-11-17T10:00:00.000Z') }));
      await expect(update({ ...CHAMPIONSHIP_RULE })).rejects.toMatchObject({
        httpStatus: 409, error: ChallengeErrorCode.CHALLENGE_ALREADY_CANCELLED,
      });

      expect(mockPrisma.challenge.update).not.toHaveBeenCalled();
    });
  });

  describe('getChallenge', () => {
    it('CPD-16 returns the weights and active pillars of a weekly championship', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(weeklyRecord(SAVED_RULE));
      mockPrisma.challengeParticipant.count.mockResolvedValue(2);

      const weekly = await getChallenge({
        prisma: mockPrisma, trainerUserId: TRAINER_USER_ID, challengeId: CHALLENGE_ID, now: WEDNESDAY_SP,
      });

      expect(weekly).toMatchObject({ format: 'weeks', weights: SAVED_RULE.weights, activePillars: SAVED_RULE.activePillars });

      mockPrisma.challenge.findUnique.mockResolvedValue(makeChallengeRecord({ weights: null, activePillars: [] }));
      const dates = await getChallenge({ prisma: mockPrisma, trainerUserId: TRAINER_USER_ID, challengeId: CHALLENGE_ID });

      expect(dates).toMatchObject({ format: 'dates', weights: null, activePillars: [] });
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

  describe('createChallenge', () => {
    beforeEach(() => {
      mockTx.challenge.create.mockImplementation(async ({ data }) => echoCreated(data));
      mockTx.challengeParticipant.createMany.mockResolvedValue({ count: 0 });
    });

    it('CAMP-04 stores a weekly championship from the start Monday to the Sunday of the last week', async () => {
      mockPrisma.trainerStudent.findMany.mockResolvedValue([{ studentId: STUDENT_ID_1 }]);
      mockPrisma.consistencyRankingConfig.findUnique.mockResolvedValue({ minPodiumWeeks: 3 });

      const result = await createChallenge({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        now: WEDNESDAY_SP,
        data: weeklyBody({ weeks: 8, studentIds: [STUDENT_ID_1] }),
      });

      const stored = mockTx.challenge.create.mock.calls[0][0].data;
      expect(stored.format).toBe('weeks');
      expect(stored.weeks).toBe(8);
      expect(stored.minPodiumWeeks).toBe(3);
      expect(stored.visibility).toBe('full');
      expect(stored.ownerType).toBe('trainer');
      expect(stored.description).toBe('Prêmio: camiseta');
      expect(stored.startDate).toEqual(new Date('2026-11-23T00:00:00.000Z'));
      expect(stored.endDate).toEqual(new Date('2027-01-17T00:00:00.000Z'));
      expect(result).toMatchObject({
        format: 'weeks',
        startDate: '2026-11-23',
        endDate: '2027-01-17',
        status: ChallengeStatus.SCHEDULED,
        weeks: 8,
        currentWeek: null,
        minPodiumWeeks: 3,
        visibility: 'full',
        ownerType: 'trainer',
        participantCount: 1,
      });
    });

    it('CAMP-61 ignores an owner type sent in the body', async () => {
      await createChallenge({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        now: WEDNESDAY_SP,
        data: weeklyBody({ ownerType: 'platform', trainerId: 'someone-else' }),
      });

      const stored = mockTx.challenge.create.mock.calls[0][0].data;
      expect(stored.ownerType).toBe('trainer');
      expect(stored.trainerId).toBe(TRAINER_ID);
    });

    it('CAMP-07 defaults the podium minimum to the trainer config, capped at the number of weeks', async () => {
      mockPrisma.consistencyRankingConfig.findUnique.mockResolvedValue({ minPodiumWeeks: 2 });

      await createChallenge({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        now: WEDNESDAY_SP,
        data: weeklyBody({ startWeek: '2026-11-16', weeks: 1 }),
      });

      expect(mockTx.challenge.create.mock.calls[0][0].data.minPodiumWeeks).toBe(1);
    });

    it('CAMP-06 rejects an invalid start Monday with 400 without storing anything', async () => {
      await expect(createChallenge({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        now: WEDNESDAY_SP,
        data: weeklyBody({ startWeek: '2026-11-24' }),
      })).rejects.toMatchObject({
        httpStatus: 400,
        error: ChallengeErrorCode.CHALLENGE_INVALID_WEEKS,
        messageCode: ChallengeMessageCode.CHALLENGE_INVALID_WEEKS,
      });
      expect(mockTx.challenge.create).not.toHaveBeenCalled();
    });

    it('CAMP-07 rejects a podium minimum above the weeks with 400 without storing anything', async () => {
      await expect(createChallenge({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        now: WEDNESDAY_SP,
        data: weeklyBody({ weeks: 2, minPodiumWeeks: 3 }),
      })).rejects.toMatchObject({
        httpStatus: 400,
        error: ChallengeErrorCode.CHALLENGE_INVALID_MIN_PODIUM,
        messageCode: ChallengeMessageCode.CHALLENGE_INVALID_MIN_PODIUM,
      });
      expect(mockTx.challenge.create).not.toHaveBeenCalled();
    });

    it('CAMP-10 blocks weekly creation when the plan has no championships', async () => {
      assertCanCreateChallenge.mockRejectedValue(new AppError({
        httpStatus: 403,
        error: 'CHAMPIONSHIPS_NOT_AVAILABLE',
        messageCode: 'platformPlan.championshipsNotAvailable',
        message: 'Championships Not Available',
      }));

      await expect(createChallenge({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        now: WEDNESDAY_SP,
        data: weeklyBody(),
      })).rejects.toMatchObject({
        httpStatus: 403,
        error: 'CHAMPIONSHIPS_NOT_AVAILABLE',
        messageCode: 'platformPlan.championshipsNotAvailable',
      });
      expect(assertCanCreateChallenge).toHaveBeenCalledWith(mockPrisma, TRAINER_ID);
      expect(mockTx.challenge.create).not.toHaveBeenCalled();
      expect(mockTx.challengeParticipant.createMany).not.toHaveBeenCalled();
    });

    it('CAMP-14 does not add students who match the filter later', async () => {
      mockPrisma.user.findMany.mockResolvedValueOnce([{ id: STUDENT_ID_1 }]);

      const created = await createChallenge({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        now: WEDNESDAY_SP,
        data: weeklyBody({ participantMode: ChallengeParticipantMode.FILTER, filter: { gender: 'female' } }),
      });

      expect(created.participantCount).toBe(1);
      expect(mockTx.challengeParticipant.createMany).toHaveBeenCalledWith({
        data: [{ challengeId: CHALLENGE_ID, studentId: STUDENT_ID_1 }],
        skipDuplicates: true,
      });

      mockPrisma.user.findMany.mockResolvedValue([{ id: STUDENT_ID_1 }, { id: STUDENT_ID_2 }]);
      mockPrisma.challenge.findUnique.mockResolvedValue(echoCreated(mockTx.challenge.create.mock.calls[0][0].data));
      mockPrisma.challengeParticipant.count.mockResolvedValue(1);

      const read = await getChallenge({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        challengeId: CHALLENGE_ID,
        now: WEDNESDAY_SP,
      });

      expect(read.participantCount).toBe(1);
      expect(read.participantMode).toBe(ChallengeParticipantMode.FILTER);
      expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.challengeParticipant.createMany).not.toHaveBeenCalled();
      expect(mockTx.challengeParticipant.createMany).toHaveBeenCalledTimes(1);

      const filterChampionship = echoCreated(mockTx.challenge.create.mock.calls[0][0].data);
      const allModeChampionship = { ...filterChampionship, id: 'all-mode-uuid', participantMode: ChallengeParticipantMode.ALL };
      mockPrisma.challenge.findMany.mockImplementation(storedMatching([filterChampionship, allModeChampionship]));
      mockPrisma.challengeParticipant.createMany.mockResolvedValue({ count: 1 });

      const joined = await joinAllModeChallenges(mockPrisma, TRAINER_ID, STUDENT_ID_2, WEDNESDAY_SP);

      expect(joined).toBe(1);
      expect(mockPrisma.challengeParticipant.createMany).toHaveBeenCalledWith({
        data: [{ challengeId: 'all-mode-uuid', studentId: STUDENT_ID_2, createdAt: WEDNESDAY_SP }],
        skipDuplicates: true,
      });
    });

    it('CPD-07 copies the saved ranking config when the body has no weights', async () => {
      mockPrisma.consistencyScoringRule.findFirst.mockResolvedValue({
        ...SAVED_RULE,
        closeWeekday: 0,
        closeHour: 21,
        timeZone: 'America/Sao_Paulo',
      });

      await createChallenge({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        now: WEDNESDAY_SP,
        data: weeklyBody(),
      });

      const stored = mockTx.challenge.create.mock.calls[0][0].data;
      expect(stored.weights).toEqual(SAVED_RULE.weights);
      expect(stored.activePillars).toEqual(SAVED_RULE.activePillars);
    });

    it('CPD-06 stores the weights and active pillars sent in the body', async () => {
      mockPrisma.consistencyScoringRule.findFirst.mockResolvedValue({
        ...SAVED_RULE,
        closeWeekday: 0,
        closeHour: 21,
        timeZone: 'America/Sao_Paulo',
      });

      await createChallenge({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        now: WEDNESDAY_SP,
        data: weeklyBody(CHAMPIONSHIP_RULE),
      });

      const stored = mockTx.challenge.create.mock.calls[0][0].data;
      expect(stored.weights).toEqual(CHAMPIONSHIP_RULE.weights);
      expect(stored.activePillars).toEqual(CHAMPIONSHIP_RULE.activePillars);
    });

    it('CPD-08 rejects an invalid or partial scoring rule with 400 and the field', async () => {
      const invalid = [
        [{ weights: CHAMPIONSHIP_RULE.weights }, 'activePillars'],
        [{ activePillars: CHAMPIONSHIP_RULE.activePillars }, 'weights'],
        [{ ...CHAMPIONSHIP_RULE, weights: { ...CHAMPIONSHIP_RULE.weights, workouts: 90 } }, 'weights'],
        [{ ...CHAMPIONSHIP_RULE, weights: { workouts: 100 } }, 'weights'],
        [{ ...CHAMPIONSHIP_RULE, activePillars: [] }, 'activePillars'],
        [{ ...CHAMPIONSHIP_RULE, activePillars: ['workouts', 'workouts'] }, 'activePillars'],
        [{ ...CHAMPIONSHIP_RULE, activePillars: ['steps'] }, 'activePillars'],
      ];

      for (const [rule, field] of invalid) {
        await expect(createChallenge({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          now: WEDNESDAY_SP,
          data: weeklyBody(rule),
        })).rejects.toMatchObject({
          httpStatus: 400,
          error: ChallengeErrorCode.CHALLENGE_INVALID_SCORING_RULE,
          messageCode: ChallengeMessageCode.CHALLENGE_INVALID_SCORING_RULE,
          details: { field },
        });
      }
      expect(mockTx.challenge.create).not.toHaveBeenCalled();
      expect(mockTx.challengeParticipant.createMany).not.toHaveBeenCalled();
    });

    it('CAMP-12 creates a dates championship as today when no weekly format is sent', async () => {
      const startDate = futureDate(1);
      const endDate = futureDate(10);

      const result = await createChallenge({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        data: {
          name: 'Datas livres',
          startDate,
          endDate,
          participantMode: ChallengeParticipantMode.EXPLICIT,
          ownerType: 'platform',
        },
      });

      const stored = mockTx.challenge.create.mock.calls[0][0].data;
      expect(stored.format).toBeUndefined();
      expect(stored.ownerType).toBeUndefined();
      expect(stored.weeks).toBeUndefined();
      expect(result.startDate).toBe(startDate);
      expect(result.endDate).toBe(endDate);
      expect(result.format).toBe('dates');
      expect(result.currentWeek).toBeNull();
      expect(mockPrisma.consistencyRankingConfig.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('listChallenges', () => {
    it('CAMP-36 derives the weekly status and week number in the trainer time zone, the dates status as today', async () => {
      const running = weeklyRecord({ id: 'weekly-running', startDate: dateOnly('2026-11-09'), endDate: dateOnly('2026-12-06') });
      const scheduled = weeklyRecord({ id: 'weekly-next', startDate: dateOnly('2026-11-23'), endDate: dateOnly('2026-12-20') });
      const dates = makeChallengeRecord({ id: 'dates-one' });
      mockPrisma.challenge.findMany.mockResolvedValue(
        [running, scheduled, dates].map((c) => ({ ...c, _count: { participants: 2 } })),
      );

      const sundayNightSp = new Date('2026-11-23T02:00:00.000Z');
      const result = await listChallenges({ prisma: mockPrisma, trainerUserId: TRAINER_USER_ID, now: sundayNightSp });

      const byId = Object.fromEntries(result.map((c) => [c.id, c]));
      expect(byId['weekly-running']).toMatchObject({ status: ChallengeStatus.ACTIVE, currentWeek: 2, weeks: 4 });
      expect(byId['weekly-next']).toMatchObject({ status: ChallengeStatus.SCHEDULED, currentWeek: null });
      expect(byId['dates-one']).toMatchObject({ status: ChallengeStatus.SCHEDULED, format: 'dates', currentWeek: null });
      expect(mockPrisma.consistencyRankingConfig.findUnique).toHaveBeenCalledTimes(1);
    });

    it('CAMP-36 filters weekly championships by their derived status', async () => {
      const running = weeklyRecord({ id: 'weekly-running' });
      const closed = weeklyRecord({ id: 'weekly-closed', closedAt: new Date('2026-11-16T00:10:00.000Z') });
      mockPrisma.challenge.findMany.mockResolvedValue([running, closed].map((c) => ({ ...c, _count: { participants: 0 } })));

      const result = await listChallenges({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        status: ChallengeStatus.COMPLETED,
        now: WEDNESDAY_SP,
      });

      expect(result.map((c) => c.id)).toEqual(['weekly-closed']);
    });
  });

  describe('updateChallenge (weekly format)', () => {
    beforeEach(() => {
      mockPrisma.challenge.update.mockImplementation(async ({ data }) => ({ ...currentRecord, ...data }));
      mockPrisma.challengeParticipant.count.mockResolvedValue(3);
    });

    it('CAMP-39 edits every field of a scheduled weekly championship with the creation validations', async () => {
      currentRecord = weeklyRecord({ startDate: dateOnly('2026-11-23'), endDate: dateOnly('2026-12-20') });
      mockPrisma.challenge.findUnique.mockResolvedValue(currentRecord);

      const result = await updateChallenge({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        challengeId: CHALLENGE_ID,
        now: WEDNESDAY_SP,
        data: {
          name: '  Inverno  ',
          description: 'Nova descrição',
          startWeek: '2026-11-30',
          weeks: 2,
          minPodiumWeeks: 1,
          anonymousRanking: true,
          visibility: 'position',
          ptsWorkoutCompleted: 20,
          dailyPointsCap: 80,
        },
      });

      expect(mockPrisma.challenge.update).toHaveBeenCalledWith({
        where: { id: CHALLENGE_ID },
        data: {
          name: 'Inverno',
          description: 'Nova descrição',
          anonymousRanking: true,
          visibility: 'position',
          ptsWorkoutCompleted: 20,
          dailyPointsCap: 80,
          weeks: 2,
          minPodiumWeeks: 1,
          startDate: dateOnly('2026-11-30'),
          endDate: dateOnly('2026-12-13'),
        },
      });
      expect(result).toMatchObject({
        startDate: '2026-11-30',
        endDate: '2026-12-13',
        weeks: 2,
        status: ChallengeStatus.SCHEDULED,
        participantCount: 3,
      });
    });

    it('CAMP-39 keeps the stored start when only the weeks change', async () => {
      currentRecord = weeklyRecord({ startDate: dateOnly('2026-11-23'), endDate: dateOnly('2026-12-20') });
      mockPrisma.challenge.findUnique.mockResolvedValue(currentRecord);

      await updateChallenge({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        challengeId: CHALLENGE_ID,
        now: WEDNESDAY_SP,
        data: { weeks: 12 },
      });

      expect(mockPrisma.challenge.update.mock.calls[0][0].data).toEqual({
        weeks: 12,
        minPodiumWeeks: 2,
        startDate: dateOnly('2026-11-23'),
        endDate: dateOnly('2027-02-14'),
      });
    });

    it('CAMP-39 rejects invalid weeks, podium minimum or free dates on a scheduled championship', async () => {
      currentRecord = weeklyRecord({ startDate: dateOnly('2026-11-23'), endDate: dateOnly('2026-12-20') });
      mockPrisma.challenge.findUnique.mockResolvedValue(currentRecord);
      const update = (data) => updateChallenge({
        prisma: mockPrisma, trainerUserId: TRAINER_USER_ID, challengeId: CHALLENGE_ID, now: WEDNESDAY_SP, data,
      });

      await expect(update({ weeks: 13 })).rejects.toMatchObject({
        httpStatus: 400, error: ChallengeErrorCode.CHALLENGE_INVALID_WEEKS,
      });
      await expect(update({ startWeek: '2026-11-25' })).rejects.toMatchObject({
        httpStatus: 400, error: ChallengeErrorCode.CHALLENGE_INVALID_WEEKS,
      });
      await expect(update({ minPodiumWeeks: 5 })).rejects.toMatchObject({
        httpStatus: 400, error: ChallengeErrorCode.CHALLENGE_INVALID_MIN_PODIUM,
      });
      await expect(update({ endDate: '2026-12-31' })).rejects.toMatchObject({
        httpStatus: 400, error: ChallengeErrorCode.CHALLENGE_INVALID_WEEKS,
      });
      expect(mockPrisma.challenge.update).not.toHaveBeenCalled();
    });

    it('CAMP-40 edits name, description, anonymous ranking and visibility while running', async () => {
      currentRecord = weeklyRecord();
      mockPrisma.challenge.findUnique.mockResolvedValue(currentRecord);

      const result = await updateChallenge({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        challengeId: CHALLENGE_ID,
        now: WEDNESDAY_SP,
        data: { name: 'Novo nome', description: 'Prêmio novo', anonymousRanking: true, visibility: 'off' },
      });

      expect(mockPrisma.challenge.update).toHaveBeenCalledWith({
        where: { id: CHALLENGE_ID },
        data: { name: 'Novo nome', description: 'Prêmio novo', anonymousRanking: true, visibility: 'off' },
      });
      expect(result).toMatchObject({ status: ChallengeStatus.ACTIVE, currentWeek: 2, name: 'Novo nome' });
    });

    it('CAMP-41 answers 409 for start, weeks, end, minimum or points while running', async () => {
      currentRecord = weeklyRecord();
      mockPrisma.challenge.findUnique.mockResolvedValue(currentRecord);
      const forbidden = [
        { startWeek: '2026-11-23' },
        { weeks: 6 },
        { startDate: '2026-11-23' },
        { endDate: '2026-12-31' },
        { minPodiumWeeks: 1 },
        { ptsWorkoutCompleted: 30 },
        { dailyPointsCap: 50 },
        { name: 'Junto', weeks: 6 },
      ];

      for (const data of forbidden) {
        await expect(updateChallenge({
          prisma: mockPrisma, trainerUserId: TRAINER_USER_ID, challengeId: CHALLENGE_ID, now: WEDNESDAY_SP, data,
        })).rejects.toMatchObject({
          httpStatus: 409,
          error: ChallengeErrorCode.CHALLENGE_ALREADY_STARTED,
          messageCode: ChallengeMessageCode.CHALLENGE_ALREADY_STARTED,
        });
      }
      expect(mockPrisma.challenge.update).not.toHaveBeenCalled();
    });

    it('CAMP-45 answers 409 to edit a closed or cancelled weekly championship', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValueOnce(weeklyRecord({ closedAt: new Date('2026-11-16T00:10:00.000Z') }));
      await expect(updateChallenge({
        prisma: mockPrisma, trainerUserId: TRAINER_USER_ID, challengeId: CHALLENGE_ID, now: WEDNESDAY_SP, data: { name: 'X' },
      })).rejects.toMatchObject({ httpStatus: 409, error: ChallengeErrorCode.CHALLENGE_ALREADY_ENDED });

      mockPrisma.challenge.findUnique.mockResolvedValueOnce(weeklyRecord({ cancelledAt: new Date('2026-11-17T10:00:00.000Z') }));
      await expect(updateChallenge({
        prisma: mockPrisma, trainerUserId: TRAINER_USER_ID, challengeId: CHALLENGE_ID, now: WEDNESDAY_SP, data: { name: 'X' },
      })).rejects.toMatchObject({ httpStatus: 409, error: ChallengeErrorCode.CHALLENGE_ALREADY_CANCELLED });

      expect(mockPrisma.challenge.update).not.toHaveBeenCalled();
    });

    it('CAMP-47 still moves the end of a running dates championship', async () => {
      const running = makeActiveChallenge();
      mockPrisma.challenge.findUnique.mockResolvedValue(running);
      mockPrisma.challenge.update.mockImplementation(async ({ data }) => ({ ...running, ...data }));
      const newEnd = futureDate(20);

      const result = await updateChallenge({
        prisma: mockPrisma, trainerUserId: TRAINER_USER_ID, challengeId: CHALLENGE_ID, data: { endDate: newEnd },
      });

      expect(result.endDate).toBe(newEnd);
      expect(result.status).toBe(ChallengeStatus.ACTIVE);
      expect(mockPrisma.consistencyRankingConfig.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('cancelChallenge (weekly format)', () => {
    it('CAMP-43 cancels a scheduled or running weekly championship without final standings', async () => {
      for (const record of [weeklyRecord(), weeklyRecord({ startDate: dateOnly('2026-11-23'), endDate: dateOnly('2026-12-20') })]) {
        mockPrisma.challenge.findUnique.mockResolvedValueOnce(record);
        mockPrisma.challenge.update.mockImplementationOnce(async ({ data }) => ({ ...record, ...data }));

        const result = await cancelChallenge({
          prisma: mockPrisma, trainerUserId: TRAINER_USER_ID, challengeId: CHALLENGE_ID, now: WEDNESDAY_SP,
        });

        expect(result.status).toBe(ChallengeStatus.CANCELLED);
        expect(result.closedAt).toBeNull();
      }
      expect(mockPrisma.challenge.update).toHaveBeenCalledTimes(2);
      expect(mockPrisma.challenge.update.mock.calls[0][0]).toEqual({
        where: { id: CHALLENGE_ID },
        data: { cancelledAt: expect.any(Date) },
      });
    });

    it('CAMP-43 cancels a weekly championship whose last Sunday passed but which is not closed yet', async () => {
      const record = weeklyRecord({ startDate: dateOnly('2026-10-19'), endDate: dateOnly('2026-11-15'), weeks: 4 });
      mockPrisma.challenge.findUnique.mockResolvedValue(record);
      mockPrisma.challenge.update.mockImplementation(async ({ data }) => ({ ...record, ...data }));

      const result = await cancelChallenge({
        prisma: mockPrisma, trainerUserId: TRAINER_USER_ID, challengeId: CHALLENGE_ID, now: WEDNESDAY_SP,
      });

      expect(result.status).toBe(ChallengeStatus.CANCELLED);
    });

    it('CAMP-45 answers 409 to cancel a closed or cancelled weekly championship', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValueOnce(weeklyRecord({ closedAt: new Date('2026-11-16T00:10:00.000Z') }));
      await expect(cancelChallenge({
        prisma: mockPrisma, trainerUserId: TRAINER_USER_ID, challengeId: CHALLENGE_ID, now: WEDNESDAY_SP,
      })).rejects.toMatchObject({ httpStatus: 409, error: ChallengeErrorCode.CHALLENGE_ALREADY_ENDED });

      mockPrisma.challenge.findUnique.mockResolvedValueOnce(weeklyRecord({ cancelledAt: new Date('2026-11-17T10:00:00.000Z') }));
      await expect(cancelChallenge({
        prisma: mockPrisma, trainerUserId: TRAINER_USER_ID, challengeId: CHALLENGE_ID, now: WEDNESDAY_SP,
      })).rejects.toMatchObject({ httpStatus: 409, error: ChallengeErrorCode.CHALLENGE_ALREADY_CANCELLED });

      expect(mockPrisma.challenge.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteChallenge (weekly format)', () => {
    it('CAMP-44 deletes a weekly championship still scheduled in the trainer time zone', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(
        weeklyRecord({ startDate: dateOnly('2026-11-23'), endDate: dateOnly('2026-12-20') }),
      );
      mockPrisma.challenge.delete.mockResolvedValue({});

      await deleteChallenge({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        challengeId: CHALLENGE_ID,
        now: new Date('2026-11-23T02:00:00.000Z'),
      });

      expect(mockPrisma.challenge.delete).toHaveBeenCalledWith({ where: { id: CHALLENGE_ID } });
    });

    it('CAMP-44 refuses to delete a running or closed weekly championship', async () => {
      for (const record of [weeklyRecord(), weeklyRecord({ closedAt: new Date('2026-11-16T00:10:00.000Z') })]) {
        mockPrisma.challenge.findUnique.mockResolvedValueOnce(record);
        await expect(deleteChallenge({
          prisma: mockPrisma, trainerUserId: TRAINER_USER_ID, challengeId: CHALLENGE_ID, now: WEDNESDAY_SP,
        })).rejects.toMatchObject({ httpStatus: 409, error: ChallengeErrorCode.CHALLENGE_NOT_DELETABLE });
      }
      expect(mockPrisma.challenge.delete).not.toHaveBeenCalled();
    });
  });

  describe('participants (weekly format)', () => {
    const ended = () => [
      [weeklyRecord({ closedAt: new Date('2026-11-16T00:10:00.000Z') }), ChallengeErrorCode.CHALLENGE_ALREADY_ENDED],
      [weeklyRecord({ cancelledAt: new Date('2026-11-17T10:00:00.000Z') }), ChallengeErrorCode.CHALLENGE_ALREADY_CANCELLED],
    ];

    it('CAMP-18 answers 409 when adding participants to a closed or cancelled weekly championship', async () => {
      for (const [record, code] of ended()) {
        mockPrisma.challenge.findUnique.mockResolvedValueOnce(record);
        await expect(addParticipants({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          challengeId: CHALLENGE_ID,
          studentIds: [STUDENT_ID_1],
          now: WEDNESDAY_SP,
        })).rejects.toMatchObject({ httpStatus: 409, error: code });
      }
      expect(mockTx.challengeParticipant.createMany).not.toHaveBeenCalled();
    });

    it('CAMP-18 answers 409 when removing a participant of a closed or cancelled weekly championship', async () => {
      for (const [record, code] of ended()) {
        mockPrisma.challenge.findUnique.mockResolvedValueOnce(record);
        mockPrisma.challengeParticipant.findUnique.mockResolvedValueOnce({ challengeId: CHALLENGE_ID, studentId: STUDENT_ID_1 });
        await expect(removeParticipant({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          challengeId: CHALLENGE_ID,
          studentId: STUDENT_ID_1,
          now: WEDNESDAY_SP,
        })).rejects.toMatchObject({ httpStatus: 409, error: code });
      }
      expect(mockPrisma.challengeParticipant.delete).not.toHaveBeenCalled();
    });

    it('CAMP-15 adds and CAMP-16 removes participants of a running weekly championship', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(weeklyRecord());
      mockPrisma.trainerStudent.findMany.mockResolvedValue([{ studentId: STUDENT_ID_2 }]);
      mockPrisma.challengeParticipant.findMany.mockResolvedValue([]);
      mockPrisma.challengeParticipant.count.mockResolvedValue(2);
      mockTx.challengeParticipant.createMany.mockResolvedValue({ count: 1 });

      const added = await addParticipants({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        challengeId: CHALLENGE_ID,
        studentIds: [STUDENT_ID_2],
        now: WEDNESDAY_SP,
      });
      expect(added).toEqual({ added: 1, participantCount: 2 });
      expect(mockTx.challengeParticipant.createMany).toHaveBeenCalledWith({
        data: [{ challengeId: CHALLENGE_ID, studentId: STUDENT_ID_2 }],
      });

      mockPrisma.challengeParticipant.findUnique.mockResolvedValue({ challengeId: CHALLENGE_ID, studentId: STUDENT_ID_2 });
      await removeParticipant({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        challengeId: CHALLENGE_ID,
        studentId: STUDENT_ID_2,
        now: WEDNESDAY_SP,
      });
      expect(mockPrisma.challengeParticipant.delete).toHaveBeenCalledWith({
        where: { challengeId_studentId: { challengeId: CHALLENGE_ID, studentId: STUDENT_ID_2 } },
      });
    });

    it('CAMP-71 keeps adding participants to a completed dates championship as today', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(makeCompletedChallenge());
      mockPrisma.trainerStudent.findMany.mockResolvedValue([{ studentId: STUDENT_ID_1 }]);
      mockPrisma.challengeParticipant.findMany.mockResolvedValue([]);
      mockPrisma.challengeParticipant.count.mockResolvedValue(1);
      mockTx.challengeParticipant.createMany.mockResolvedValue({ count: 1 });

      const added = await addParticipants({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        challengeId: CHALLENGE_ID,
        studentIds: [STUDENT_ID_1],
      });

      expect(added).toEqual({ added: 1, participantCount: 1 });
      expect(mockPrisma.consistencyRankingConfig.findUnique).not.toHaveBeenCalled();
    });
  });
});

// Wednesday 2026-11-25 12:00 in São Paulo; the running week starts Monday 2026-11-23 (student list tests)
const LIST_NOW = new Date('2026-11-25T15:00:00.000Z');
const LIST_OLD_LINK = new Date('2026-01-01T12:00:00.000Z');
const LIST_JOINED = new Date('2026-10-01T12:00:00.000Z');
// In-memory world of the student list tests
let world;

// Championship row as Prisma stores it, weekly by default; endDate is the Sunday of its last week
const storedChampionship = (id, name, startWeek, weeks, overrides = {}) => {
  const startDate = dateOnly(startWeek);
  return {
    ...weeklyRecord({ id, name, startDate, endDate: new Date(startDate.getTime() + (weeks * 7 - 1) * 86400000), weeks }),
    trainerId: TRAINER_ID,
    startScheduledAt: null,
    weights: { workouts: 30, diet: 30, cardio: 15, feedback: 15, hydration: 10 },
    activePillars: ['workouts', 'cardio'],
    ...overrides,
  };
};

// Adds a linked student who chose to appear by name
const addListStudent = (id, firstName, lastName) => {
  world.tables.user.push({ id, firstName, lastName, username: id, avatarUrl: null, birthDate: null });
  world.tables.trainerStudent.push({ id: `ts-${id}`, trainerId: TRAINER_ID, studentId: id, activeOnPlan: true, createdAt: LIST_OLD_LINK });
  world.tables.consistencyPrivacyPref.push({ id: `pp-${id}`, studentId: id, appearAs: AppearAs.NAME, termVersion: CONSISTENCY_PRIVACY_TERM_VERSION, acceptedAt: LIST_OLD_LINK });
};

// Adds a championship with its participants
const addListChampionship = (row, studentIds) => {
  world.tables.challenge.push(row);
  for (const studentId of studentIds) {
    world.tables.challengeParticipant.push({ id: `cp-${row.id}-${studentId}`, challengeId: row.id, studentId, createdAt: LIST_JOINED });
  }
  return row;
};

// Ana (100, 100), Camila (66.6667, 100 -> 83.3334) and Bruno (33.3333, 66.6667 -> 50) in the two closed weeks before the running one
const listExampleTeam = () => {
  addListStudent('ana', 'Ana', 'Souza');
  addListStudent('camila', 'Camila', 'Rocha');
  addListStudent('bruno', 'Bruno', 'Costa');
  for (const [studentId, done] of [['ana', [4, 4]], ['camila', [2, 4]], ['bruno', [0, 2]]]) {
    ['2026-11-09', '2026-11-16'].forEach((week, index) => {
      world.tables.consistencyWeeklyResult.push(weeklyResult(TRAINER_ID, studentId, week, { workouts: [done[index], 4], cardio: [2, 2] }));
    });
  }
};

// List of Camila
const camilaList = (options = {}) => listStudentChallenges({ prisma: world.prisma, studentId: 'camila', now: LIST_NOW, ...options });

describe('listStudentChallenges', () => {
  beforeEach(() => {
    world = createWorld();
    materializeTargets.mockImplementation(countsFrom(world.targets));
    countDone.mockImplementation(countsFrom(world.done));
  });

  it('APP-39 adds position, average and band to each weekly championship', async () => {
    listExampleTeam();
    addListChampionship(storedChampionship('verao', 'Verão 2027', '2026-11-09', 6), ['ana', 'camila', 'bruno']);
    addListChampionship(storedChampionship('so-posicao', 'Só a posição', '2026-11-09', 6, { visibility: 'position' }), ['ana', 'camila', 'bruno']);
    addListChampionship(storedChampionship('outubro', 'Outubro', '2026-10-05', 4, { closedAt: new Date('2026-11-02T00:30:00.000Z') }), ['ana', 'camila']);
    world.tables.challengeConsistencyStanding.push(
      { id: 'cs-1', challengeId: 'outubro', studentId: 'camila', position: 1, eligible: true, average: 96, validWeeks: 4, weeks100: 2, streak: 2, frozenAt: LIST_NOW },
      { id: 'cs-2', challengeId: 'outubro', studentId: 'ana', position: 2, eligible: true, average: 91, validWeeks: 4, weeks100: 1, streak: 0, frozenAt: LIST_NOW },
    );
    addListChampionship(storedChampionship('dezembro', 'Dezembro', '2026-12-07', 4), ['camila']);
    addListChampionship(makeChallengeRecord({ id: 'xp', name: 'Só XP', format: 'dates', startDate: dateOnly('2026-11-01'), endDate: dateOnly('2026-11-30') }), ['camila']);

    const list = await camilaList();
    const byId = Object.fromEntries(list.map((item) => [item.id, item]));

    expect(byId.verao).toMatchObject({ name: 'Verão 2027', status: ChallengeStatus.ACTIVE, currentWeek: 3, participantCount: 3 });
    expect(byId.verao.consistency).toEqual({ visibility: 'full', position: 2, total: 3, faixa: Faixa.STEADY, average: 83.3334 });
    expect(byId['so-posicao'].consistency).toEqual({ visibility: 'position', position: 2, total: 3, faixa: Faixa.STEADY, average: null });
    expect(byId.outubro.consistency).toEqual({ visibility: 'full', position: 1, total: 2, faixa: Faixa.CONSTANT, average: 96 });
    expect(byId.dezembro.consistency).toBeNull();
    expect(byId.xp).toMatchObject({ format: 'dates', consistency: null });
    expect(await camilaList({ format: 'weeks' })).toHaveLength(4);
  });

  it('APP-52 orders running by nearest end, next by nearest start and closed by latest end', async () => {
    addListStudent('camila', 'Camila', 'Rocha');
    const closedAt = new Date('2026-11-10T00:30:00.000Z');
    addListChampionship(storedChampionship('running-late', 'Termina 20/12', '2026-11-09', 6), ['camila']);
    addListChampionship(storedChampionship('running-soon', 'Termina 06/12', '2026-11-16', 3), ['camila']);
    addListChampionship(storedChampionship('next-late', 'Começa 14/12', '2026-12-14', 2), ['camila']);
    addListChampionship(storedChampionship('next-soon', 'Começa 07/12', '2026-12-07', 2), ['camila']);
    addListChampionship(storedChampionship('closed-old', 'Fechou 25/10', '2026-10-12', 2, { closedAt }), ['camila']);
    addListChampionship(storedChampionship('closed-recent', 'Fechou 08/11', '2026-10-26', 2, { closedAt }), ['camila']);

    const list = await camilaList();

    expect(list.map((item) => item.id)).toEqual(['running-soon', 'running-late', 'next-soon', 'next-late', 'closed-recent', 'closed-old']);
  });

  it('APP-62 drops a championship the student was removed from', async () => {
    listExampleTeam();
    addListChampionship(storedChampionship('verao', 'Verão 2027', '2026-11-09', 6), ['ana', 'camila', 'bruno']);
    addListChampionship(storedChampionship('turma', 'Turma da manhã', '2026-11-16', 6), ['camila']);
    const before = await camilaList();

    world.tables.challengeParticipant = world.tables.challengeParticipant.filter((row) => !(row.challengeId === 'verao' && row.studentId === 'camila'));
    const after = await camilaList();

    expect(before.map((item) => item.id)).toEqual(['verao', 'turma']);
    expect(after.map((item) => item.id)).toEqual(['turma']);
  });

  it('APP-63 drops a cancelled championship', async () => {
    listExampleTeam();
    const verao = addListChampionship(storedChampionship('verao', 'Verão 2027', '2026-11-09', 6), ['ana', 'camila', 'bruno']);
    addListChampionship(storedChampionship('turma', 'Turma da manhã', '2026-11-16', 6), ['camila']);
    addListChampionship(makeChallengeRecord({ id: 'xp-cancelado', name: 'XP cancelado', cancelledAt: new Date('2026-11-20T12:00:00.000Z') }), ['camila']);

    verao.cancelledAt = new Date('2026-11-24T12:00:00.000Z');
    const list = await camilaList();

    expect(list.map((item) => item.id)).toEqual(['turma']);
    expect(await camilaList({ status: ChallengeStatus.CANCELLED })).toEqual([]);
  });
});
