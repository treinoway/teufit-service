import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstProtocolCreated: vi.fn(),
}));

import { maybeMarkFirstProtocolCreated } from '../../src/services/trainer-onboarding-service.js';
import { seedExampleRoutine } from '../../src/services/trainer-example-routine-service.js';

const TRAINER_ID = 'trainer-1';
const PROTOCOL_TEMPLATE_ID = 'protocol-template-1';
const TRAINING_TEMPLATE_ID = 'training-template-1';

const publicExercises = [
  { id: 'ex-1', name: 'Agachamento', type: 'strength', isPublic: true },
  { id: 'ex-2', name: 'Supino', type: 'strength', isPublic: true },
  { id: 'ex-3', name: 'Remada', type: 'strength', isPublic: true },
];

// Builds a mocked transaction client exposing the models the seeder touches.
function makeTx({ exercises = publicExercises } = {}) {
  return {
    exerciseTemplate: { findMany: vi.fn().mockResolvedValue(exercises) },
    trainingTemplate: { create: vi.fn().mockResolvedValue({ id: TRAINING_TEMPLATE_ID }) },
    trainingTemplateExerciseTemplate: {
      create: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockResolvedValue({ count: exercises.length }),
    },
    trainingProtocolTemplate: { create: vi.fn().mockResolvedValue({ id: PROTOCOL_TEMPLATE_ID }) },
    protocolTemplateTraining: {
      create: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    trainer: { updateMany: vi.fn() },
  };
}

describe('seedExampleRoutine', () => {
  beforeEach(() => {
    maybeMarkFirstProtocolCreated.mockResolvedValue(undefined);
  });

  it('reads only public, non-deleted exercise templates', async () => {
    const tx = makeTx();

    await seedExampleRoutine({ trainerId: TRAINER_ID, tx });

    expect(tx.exerciseTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isPublic: true, deletedAt: null }),
      }),
    );
  });

  it('creates exactly one protocol template flagged isExample for the trainer', async () => {
    const tx = makeTx();

    await seedExampleRoutine({ trainerId: TRAINER_ID, tx });

    expect(tx.trainingProtocolTemplate.create).toHaveBeenCalledTimes(1);
    expect(tx.trainingProtocolTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ trainerId: TRAINER_ID, isExample: true }),
    });
  });

  it('links the seeded protocol template to a training built from the public exercise templates', async () => {
    const tx = makeTx();

    await seedExampleRoutine({ trainerId: TRAINER_ID, tx });

    expect(tx.trainingTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ trainerId: TRAINER_ID }),
    });
    const linkedExerciseIds = [
      ...tx.trainingTemplateExerciseTemplate.createMany.mock.calls.flatMap(([args]) =>
        args.data.map((row) => row.exerciseTemplateId),
      ),
      ...tx.trainingTemplateExerciseTemplate.create.mock.calls.map(([args]) => args.data.exerciseTemplateId),
    ];
    expect(linkedExerciseIds.length).toBeGreaterThan(0);
    for (const id of linkedExerciseIds) {
      expect(publicExercises.map((e) => e.id)).toContain(id);
    }
    const protocolLinks = [
      ...tx.protocolTemplateTraining.createMany.mock.calls.flatMap(([args]) => args.data),
      ...tx.protocolTemplateTraining.create.mock.calls.map(([args]) => args.data),
    ];
    expect(protocolLinks).toEqual([
      expect.objectContaining({
        protocolTemplateId: PROTOCOL_TEMPLATE_ID,
        trainingTemplateId: TRAINING_TEMPLATE_ID,
      }),
    ]);
  });

  it('seeds nothing when no public exercise templates exist', async () => {
    const tx = makeTx({ exercises: [] });

    await seedExampleRoutine({ trainerId: TRAINER_ID, tx });

    expect(tx.trainingProtocolTemplate.create).not.toHaveBeenCalled();
    expect(tx.trainingTemplate.create).not.toHaveBeenCalled();
  });

  it('does not throw when no public exercise templates exist', async () => {
    const tx = makeTx({ exercises: [] });

    await expect(seedExampleRoutine({ trainerId: TRAINER_ID, tx })).resolves.not.toThrow();
  });

  it('never marks firstProtocolCreatedAt for the trainer', async () => {
    const tx = makeTx();

    await seedExampleRoutine({ trainerId: TRAINER_ID, tx });

    expect(maybeMarkFirstProtocolCreated).not.toHaveBeenCalled();
    expect(tx.trainer.updateMany).not.toHaveBeenCalled();
  });
});
