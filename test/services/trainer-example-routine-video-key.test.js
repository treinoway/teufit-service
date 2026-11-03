import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstProtocolCreated: vi.fn().mockResolvedValue(undefined),
}));

import { seedExampleRoutine } from '../../src/services/trainer-example-routine-service.js';

const TRAINER_ID = 'trainer-1';
const VIDEO_FILE_KEY = 'exercise-videos/trainer-9/clip.mp4';

// Builds a mocked transaction client returning the given exercise templates.
function makeTx(exercises) {
  return {
    exerciseTemplate: { findMany: vi.fn().mockResolvedValue(exercises) },
    trainingTemplate: { create: vi.fn().mockResolvedValue({ id: 'tt-1' }) },
    trainingTemplateExerciseTemplate: {
      create: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockResolvedValue({ count: exercises.length }),
    },
    trainingProtocolTemplate: { create: vi.fn().mockResolvedValue({ id: 'ptt-1' }) },
    protocolTemplateTraining: {
      create: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    trainer: { updateMany: vi.fn() },
  };
}

// Collects every junction row written through create or createMany.
function collectRows(tx) {
  return [
    ...tx.trainingTemplateExerciseTemplate.createMany.mock.calls.flatMap(([args]) => args.data),
    ...tx.trainingTemplateExerciseTemplate.create.mock.calls.map(([args]) => args.data),
  ];
}

describe('seedExampleRoutine videoFileKey', () => {
  it('should copy videoFileKey from the exercise template onto the junction row', async () => {
    const tx = makeTx([{ id: 'ex-1', name: 'Agachamento', type: 'strength', videoFileKey: VIDEO_FILE_KEY }]);

    await seedExampleRoutine({ trainerId: TRAINER_ID, tx });

    expect(collectRows(tx)[0].videoFileKey).toBe(VIDEO_FILE_KEY);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('should store null when the template videoFileKey is %s', async (_label, videoFileKey) => {
    const tx = makeTx([{ id: 'ex-1', name: 'Agachamento', type: 'strength', videoFileKey }]);

    await seedExampleRoutine({ trainerId: TRAINER_ID, tx });

    expect(collectRows(tx)[0].videoFileKey).toBeNull();
  });
});
