import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    workoutSession: { findUnique: vi.fn() },
    exerciseLog: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn() },
    setLog: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  },
}));

import { prisma } from '../../src/db.js';
import { getSession } from '../../src/services/workout-session-service.js';

const USER_ID = 'user-1';
const SESSION_ID = 'session-1';

describe('workout-session-service videoFileKey selection', () => {
  it('should select videoFileKey on the exercise and on its substitutes', async () => {
    prisma.workoutSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      userId: USER_ID,
      deletedAt: null,
      exerciseLogs: [],
    });

    await getSession(USER_ID, SESSION_ID);

    const exerciseSelect = prisma.workoutSession.findUnique.mock.calls[0][0].include.exerciseLogs.include.exercise;
    expect(exerciseSelect.select.videoFileKey).toBe(true);
    expect(exerciseSelect.select.substitutes.select.videoFileKey).toBe(true);
  });
});
