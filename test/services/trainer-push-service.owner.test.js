import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTrainerPushService } from '../../src/services/trainer-push-service.js';

const STUDENT_ID = '22222222-2222-4222-8222-222222222222';
const TRAINER_ID = '77777777-7777-4777-8777-777777777777';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const ANAMNESIS_ID = '66666666-6666-4666-8666-666666666666';

let prismaMock;
let service;

// Builds a Prisma stand-in whose trainer link lookup finds nobody, so only the where clause matters.
function buildPrismaMock() {
  return {
    trainerStudent: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findUnique: vi.fn() },
    device: { findMany: vi.fn(), deleteMany: vi.fn() },
  };
}

// Reads the where clause of the trainer link lookup.
function linkLookupWhere() {
  return prismaMock.trainerStudent.findMany.mock.calls[0][0].where;
}

describe('trainer-push-service link filtering', () => {
  beforeEach(() => {
    prismaMock = buildPrismaMock();
    service = createTrainerPushService({ prisma: prismaMock, fcmClient: { sendToToken: vi.fn() } });
  });

  describe('notifyAnamnesisSubmitted', () => {
    it('should restrict the link lookup to the given trainer', async () => {
      await service.notifyAnamnesisSubmitted({ studentId: STUDENT_ID, anamnesisId: ANAMNESIS_ID, trainerId: TRAINER_ID });

      expect(linkLookupWhere()).toMatchObject({ studentId: STUDENT_ID, trainerId: TRAINER_ID });
    });

    it('should not filter by trainer when none is given', async () => {
      await service.notifyAnamnesisSubmitted({ studentId: STUDENT_ID, anamnesisId: ANAMNESIS_ID });

      expect(linkLookupWhere()).not.toHaveProperty('trainerId');
    });

    it('should only consider links that are active on the plan', async () => {
      await service.notifyAnamnesisSubmitted({ studentId: STUDENT_ID, anamnesisId: ANAMNESIS_ID });

      expect(linkLookupWhere().activeOnPlan).toBe(true);
    });
  });

  describe('notifyWorkoutCompleted', () => {
    it('should only consider links that are active on the plan', async () => {
      await service.notifyWorkoutCompleted({ studentId: STUDENT_ID, sessionId: SESSION_ID });

      expect(linkLookupWhere()).toMatchObject({ studentId: STUDENT_ID, activeOnPlan: true });
    });

    it('should not filter by trainer', async () => {
      await service.notifyWorkoutCompleted({ studentId: STUDENT_ID, sessionId: SESSION_ID });

      expect(linkLookupWhere()).not.toHaveProperty('trainerId');
    });
  });
});
