import { beforeEach, describe, expect, it, vi } from 'vitest';
import { updateConfig } from '../../src/services/student-feedback-config-service.js';
import { DEFAULT_STUDENT_FEEDBACK_CONFIG } from '../../src/constants/student-feedback.js';
import { TRAINER_ID, createFeedbackWorld } from '../helpers/student-feedback-world.js';

const CONFIG_MODEL = 'studentFeedbackConfig';
const UNIQUE_VIOLATION_CODE = 'P2002';
const NOW = new Date('2026-11-17T15:00:00Z');

// Error the Prisma client raises with the given code
function prismaError(code) {
  return Object.assign(new TypeError(`prisma error ${code}`), { code });
}

// Makes the next upsert lose the insert race: the winner's row gets stored and the upsert raises the unique violation
function loseFirstSaveTo(world, winnerRow) {
  return vi.spyOn(world.prisma.studentFeedbackConfig, 'upsert').mockImplementationOnce(async () => {
    world.seed(CONFIG_MODEL, winnerRow);
    throw prismaError(UNIQUE_VIOLATION_CODE);
  });
}

describe('student feedback config service review fixes', () => {
  let world;

  beforeEach(() => {
    world = createFeedbackWorld();
  });

  describe('updateConfig when two first saves race', () => {
    const WINNER_ROW = Object.freeze({ trainerId: TRAINER_ID, ...DEFAULT_STUDENT_FEEDBACK_CONFIG, d7: false, enabledAt: null });

    it('saves again once after a unique violation and returns the full config', async () => {
      const upsert = loseFirstSaveTo(world, WINNER_ROW);

      const config = await updateConfig(world.prisma, TRAINER_ID, { autoSendEnabled: true }, NOW);

      expect(upsert).toHaveBeenCalledTimes(2);
      expect(config).toEqual({ ...DEFAULT_STUDENT_FEEDBACK_CONFIG, autoSendEnabled: true, d7: false });
    });

    it('applies the retry over the row the winner stored, keeping one row for the trainer', async () => {
      loseFirstSaveTo(world, WINNER_ROW);

      await updateConfig(world.prisma, TRAINER_ID, { autoSendEnabled: true }, NOW);

      const rows = world.rows(CONFIG_MODEL).filter((row) => row.trainerId === TRAINER_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ autoSendEnabled: true, d7: false, enabledAt: NOW });
    });

    it('reads the stored settings again before the retry', async () => {
      loseFirstSaveTo(world, WINNER_ROW);
      const findUnique = vi.spyOn(world.prisma.studentFeedbackConfig, 'findUnique');

      await updateConfig(world.prisma, TRAINER_ID, { autoSendEnabled: true }, NOW);

      expect(findUnique).toHaveBeenCalledTimes(2);
    });

    it('gives up after one retry and rethrows the unique violation', async () => {
      const failure = prismaError(UNIQUE_VIOLATION_CODE);
      const upsert = vi.spyOn(world.prisma.studentFeedbackConfig, 'upsert').mockRejectedValue(failure);

      await expect(updateConfig(world.prisma, TRAINER_ID, { autoSendEnabled: true }, NOW)).rejects.toBe(failure);

      expect(upsert).toHaveBeenCalledTimes(2);
    });

    it('does not retry an error that is not a unique violation', async () => {
      const failure = prismaError('P1001');
      const upsert = vi.spyOn(world.prisma.studentFeedbackConfig, 'upsert').mockRejectedValue(failure);

      await expect(updateConfig(world.prisma, TRAINER_ID, { autoSendEnabled: true }, NOW)).rejects.toBe(failure);

      expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('saves only once when nothing fails', async () => {
      const upsert = vi.spyOn(world.prisma.studentFeedbackConfig, 'upsert');

      await updateConfig(world.prisma, TRAINER_ID, { autoSendEnabled: true }, NOW);

      expect(upsert).toHaveBeenCalledTimes(1);
    });
  });
});
