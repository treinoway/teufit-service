import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChallengeErrorCode } from '../../src/constants/challenge.js';

// ─── Prisma mock ───────────────────────────────────────────────────────────────

const mockPrisma = {
  trainer: { findUnique: vi.fn() },
  challenge: { findUnique: vi.fn() },
  challengeParticipant: { findUnique: vi.fn(), findMany: vi.fn() },
  pointTransaction: { groupBy: vi.fn() },
  user: { findMany: vi.fn() },
};

import {
  getChallengeRankingForTrainer,
  getChallengeRankingForStudent,
} from '../../src/services/challenge-ranking-service.js';

const TRAINER_ID = 'trainer-record-uuid';
const TRAINER_USER_ID = 'trainer-user-uuid';
const STUDENT_ID_1 = 'student-uuid-1';
const STUDENT_ID_2 = 'student-uuid-2';
const CHALLENGE_ID = 'challenge-uuid-1';

const makeChallengeRecord = (overrides = {}) => ({
  id: CHALLENGE_ID,
  trainerId: TRAINER_ID,
  name: 'Test Challenge',
  startDate: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)),
  endDate: new Date(Date.UTC(2026, 0, 31, 12, 0, 0)),
  cancelledAt: null,
  anonymousRanking: false,
  ...overrides,
});

describe('challenge-ranking-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
    mockPrisma.challengeParticipant.findMany.mockResolvedValue([]);
    mockPrisma.pointTransaction.groupBy.mockResolvedValue([]);
    mockPrisma.user.findMany.mockResolvedValue([]);
  });

  // ─── getChallengeRankingForTrainer ─────────────────────────────────────────

  describe('getChallengeRankingForTrainer', () => {
    it('reads anonymousRanking from the challenge, not from GamificationConfig', async () => {
      const challenge = makeChallengeRecord({ anonymousRanking: true });
      mockPrisma.challenge.findUnique.mockResolvedValue(challenge);
      mockPrisma.challengeParticipant.findMany.mockResolvedValue([
        { studentId: STUDENT_ID_1 },
        { studentId: STUDENT_ID_2 },
      ]);
      mockPrisma.pointTransaction.groupBy.mockResolvedValue([
        { studentId: STUDENT_ID_1, _sum: { points: 100 }, _min: { createdAt: new Date('2026-01-05T10:00:00Z') } },
        { studentId: STUDENT_ID_2, _sum: { points: 80 }, _min: { createdAt: new Date('2026-01-05T11:00:00Z') } },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: STUDENT_ID_1, firstName: 'Alice', lastName: 'Smith', avatarUrl: null },
        { id: STUDENT_ID_2, firstName: 'Bob', lastName: 'Jones', avatarUrl: null },
      ]);

      const entries = await getChallengeRankingForTrainer({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        challengeId: CHALLENGE_ID,
      });

      // anonymousRanking=true from challenge: trainer sees full names (requestingStudentId=null)
      // When requestingStudentId is null, trainer always sees anonymised names
      expect(entries[0].firstName).toBe('Aluno #1');
      expect(entries[0].lastName).toBeNull();
      expect(entries[1].firstName).toBe('Aluno #2');
    });

    it('shows real names when challenge anonymousRanking is false', async () => {
      const challenge = makeChallengeRecord({ anonymousRanking: false });
      mockPrisma.challenge.findUnique.mockResolvedValue(challenge);
      mockPrisma.challengeParticipant.findMany.mockResolvedValue([
        { studentId: STUDENT_ID_1 },
      ]);
      mockPrisma.pointTransaction.groupBy.mockResolvedValue([
        { studentId: STUDENT_ID_1, _sum: { points: 50 }, _min: { createdAt: new Date('2026-01-05T10:00:00Z') } },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: STUDENT_ID_1, firstName: 'Alice', lastName: 'Smith', avatarUrl: null },
      ]);

      const entries = await getChallengeRankingForTrainer({
        prisma: mockPrisma,
        trainerUserId: TRAINER_USER_ID,
        challengeId: CHALLENGE_ID,
      });

      expect(entries[0].firstName).toBe('Alice');
      expect(entries[0].lastName).toBe('Smith');
    });

    it('throws TRAINER_PROFILE_MISSING when trainer not found', async () => {
      mockPrisma.trainer.findUnique.mockResolvedValue(null);

      await expect(
        getChallengeRankingForTrainer({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          challengeId: CHALLENGE_ID,
        }),
      ).rejects.toMatchObject({
        httpStatus: 404,
        error: ChallengeErrorCode.TRAINER_PROFILE_MISSING,
      });
    });

    it('throws CHALLENGE_NOT_FOUND when challenge does not exist', async () => {
      mockPrisma.challenge.findUnique.mockResolvedValue(null);

      await expect(
        getChallengeRankingForTrainer({
          prisma: mockPrisma,
          trainerUserId: TRAINER_USER_ID,
          challengeId: CHALLENGE_ID,
        }),
      ).rejects.toMatchObject({
        httpStatus: 404,
        error: ChallengeErrorCode.CHALLENGE_NOT_FOUND,
      });
    });
  });

  // ─── getChallengeRankingForStudent ─────────────────────────────────────────

  describe('getChallengeRankingForStudent', () => {
    it('reads anonymousRanking from the challenge record, not from GamificationConfig', async () => {
      const challenge = makeChallengeRecord({ anonymousRanking: true });
      mockPrisma.challenge.findUnique.mockResolvedValue(challenge);
      mockPrisma.challengeParticipant.findUnique.mockResolvedValue({
        challengeId: CHALLENGE_ID,
        studentId: STUDENT_ID_1,
      });
      mockPrisma.challengeParticipant.findMany.mockResolvedValue([
        { studentId: STUDENT_ID_1 },
        { studentId: STUDENT_ID_2 },
      ]);
      mockPrisma.pointTransaction.groupBy.mockResolvedValue([
        { studentId: STUDENT_ID_1, _sum: { points: 100 }, _min: { createdAt: new Date('2026-01-05T10:00:00Z') } },
        { studentId: STUDENT_ID_2, _sum: { points: 80 }, _min: { createdAt: new Date('2026-01-05T11:00:00Z') } },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: STUDENT_ID_1, firstName: 'Alice', lastName: 'Smith', avatarUrl: null },
        { id: STUDENT_ID_2, firstName: 'Bob', lastName: 'Jones', avatarUrl: null },
      ]);

      const result = await getChallengeRankingForStudent({
        prisma: mockPrisma,
        studentId: STUDENT_ID_1,
        challengeId: CHALLENGE_ID,
      });

      // The requester (STUDENT_ID_1) sees their own real name
      const myEntry = result.entries.find((e) => e.studentId === STUDENT_ID_1);
      expect(myEntry.firstName).toBe('Alice');
      // Other students are anonymised
      const otherEntry = result.entries.find((e) => e.studentId === STUDENT_ID_2);
      expect(otherEntry.firstName).toBe('Aluno #2');
      expect(otherEntry.lastName).toBeNull();
    });

    it('shows all real names when challenge anonymousRanking is false', async () => {
      const challenge = makeChallengeRecord({ anonymousRanking: false });
      mockPrisma.challenge.findUnique.mockResolvedValue(challenge);
      mockPrisma.challengeParticipant.findUnique.mockResolvedValue({
        challengeId: CHALLENGE_ID,
        studentId: STUDENT_ID_1,
      });
      mockPrisma.challengeParticipant.findMany.mockResolvedValue([
        { studentId: STUDENT_ID_1 },
        { studentId: STUDENT_ID_2 },
      ]);
      mockPrisma.pointTransaction.groupBy.mockResolvedValue([
        { studentId: STUDENT_ID_1, _sum: { points: 100 }, _min: { createdAt: new Date('2026-01-05T10:00:00Z') } },
        { studentId: STUDENT_ID_2, _sum: { points: 80 }, _min: { createdAt: new Date('2026-01-05T11:00:00Z') } },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: STUDENT_ID_1, firstName: 'Alice', lastName: 'Smith', avatarUrl: null },
        { id: STUDENT_ID_2, firstName: 'Bob', lastName: 'Jones', avatarUrl: null },
      ]);

      const result = await getChallengeRankingForStudent({
        prisma: mockPrisma,
        studentId: STUDENT_ID_1,
        challengeId: CHALLENGE_ID,
      });

      expect(result.entries[0].firstName).toBe('Alice');
      expect(result.entries[1].firstName).toBe('Bob');
    });

    it('returns myPosition and myPoints for the requesting student', async () => {
      const challenge = makeChallengeRecord({ anonymousRanking: false });
      mockPrisma.challenge.findUnique.mockResolvedValue(challenge);
      mockPrisma.challengeParticipant.findUnique.mockResolvedValue({
        challengeId: CHALLENGE_ID,
        studentId: STUDENT_ID_1,
      });
      mockPrisma.challengeParticipant.findMany.mockResolvedValue([
        { studentId: STUDENT_ID_1 },
      ]);
      mockPrisma.pointTransaction.groupBy.mockResolvedValue([
        { studentId: STUDENT_ID_1, _sum: { points: 75 }, _min: { createdAt: new Date('2026-01-05T10:00:00Z') } },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: STUDENT_ID_1, firstName: 'Alice', lastName: 'Smith', avatarUrl: null },
      ]);

      const result = await getChallengeRankingForStudent({
        prisma: mockPrisma,
        studentId: STUDENT_ID_1,
        challengeId: CHALLENGE_ID,
      });

      expect(result.myPosition).toBe(1);
      expect(result.myPoints).toBe(75);
    });

    it('throws CHALLENGE_FORBIDDEN_NOT_OWNER when student is not a participant', async () => {
      const challenge = makeChallengeRecord();
      mockPrisma.challenge.findUnique.mockResolvedValue(challenge);
      mockPrisma.challengeParticipant.findUnique.mockResolvedValue(null);

      await expect(
        getChallengeRankingForStudent({
          prisma: mockPrisma,
          studentId: STUDENT_ID_1,
          challengeId: CHALLENGE_ID,
        }),
      ).rejects.toMatchObject({
        httpStatus: 403,
        error: ChallengeErrorCode.CHALLENGE_FORBIDDEN_NOT_OWNER,
      });
    });
  });
});
