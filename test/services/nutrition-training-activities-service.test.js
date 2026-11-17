import { describe, it, expect, vi, beforeEach } from 'vitest';
import { suggestActivitiesFromTraining } from '../../src/services/nutrition-training-activities-service.js';

const PATIENT_ID = 'patient-1';
const WEIGHT_TRAINING_MET = 5;
const SECONDS_PER_MINUTE = 60;

// Test helper: make prisma.
function makePrisma() {
  return {
    trainingProtocol: { findFirst: vi.fn().mockResolvedValue(null) },
    workoutSession: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

// Test helper: protocol with.
function protocolWith(trainings) {
  return { id: 'protocol-1', status: 'active', trainings };
}

// Test helper: training.
function training(weekDay, estimatedDurationSeconds = 0) {
  return { id: `t-${weekDay}`, weekDay, estimatedDurationSeconds };
}

describe('suggestActivitiesFromTraining', () => {
  let prisma;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('should return no items when the patient has no active training protocol', async () => {
    await expect(suggestActivitiesFromTraining(prisma, { patientId: PATIENT_ID })).resolves.toEqual({ items: [] });
  });

  it('should suggest one weight-training activity at MET 5.0', async () => {
    prisma.trainingProtocol.findFirst.mockResolvedValue(protocolWith([training('monday', 3000)]));

    const { items } = await suggestActivitiesFromTraining(prisma, { patientId: PATIENT_ID });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ met: WEIGHT_TRAINING_MET, name: expect.any(String) });
  });

  it('should count sessions per week as the distinct week days of the protocol trainings', async () => {
    prisma.trainingProtocol.findFirst.mockResolvedValue(
      protocolWith([training('monday', 3000), training('wednesday', 3000), training('friday', 3000)]),
    );

    const { items } = await suggestActivitiesFromTraining(prisma, { patientId: PATIENT_ID });

    expect(items[0].perWeek).toBe(3);
  });

  it('should use the average duration of recent sessions, in minutes', async () => {
    prisma.trainingProtocol.findFirst.mockResolvedValue(protocolWith([training('monday', 1800)]));
    prisma.workoutSession.findMany.mockResolvedValue([
      { durationSeconds: 60 * SECONDS_PER_MINUTE },
      { durationSeconds: 70 * SECONDS_PER_MINUTE },
    ]);

    const { items } = await suggestActivitiesFromTraining(prisma, { patientId: PATIENT_ID });

    expect(items[0].minutes).toBe(65);
  });

  it('should fall back to the estimated duration of the trainings when there are no sessions', async () => {
    prisma.trainingProtocol.findFirst.mockResolvedValue(
      protocolWith([training('monday', 50 * SECONDS_PER_MINUTE), training('thursday', 50 * SECONDS_PER_MINUTE)]),
    );

    const { items } = await suggestActivitiesFromTraining(prisma, { patientId: PATIENT_ID });

    expect(items[0].minutes).toBe(50);
  });

  it('should return no items when the active protocol has no trainings', async () => {
    prisma.trainingProtocol.findFirst.mockResolvedValue(protocolWith([]));

    const { items } = await suggestActivitiesFromTraining(prisma, { patientId: PATIENT_ID });

    expect(items).toEqual([]);
  });
});
