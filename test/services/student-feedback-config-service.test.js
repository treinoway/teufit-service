import { beforeEach, describe, expect, it } from 'vitest';
import { getConfig, updateConfig } from '../../src/services/student-feedback-config-service.js';
import {
  DEFAULT_STUDENT_FEEDBACK_CONFIG,
  StudentFeedbackBand,
  StudentFeedbackErrorCode,
  StudentFeedbackInboxFilter,
  StudentFeedbackMessageCode,
  StudentFeedbackMilestone,
  StudentFeedbackPillar,
  StudentFeedbackQuestionCondition,
  StudentFeedbackQuestionType,
  StudentFeedbackStatus,
} from '../../src/constants/student-feedback.js';
import { OTHER_TRAINER_ID, TRAINER_ID, createFeedbackWorld, seedConfig } from '../helpers/student-feedback-world.js';

const CONFIG_MODEL = 'studentFeedbackConfig';
const NOW = new Date('2026-11-17T15:00:00Z');
const LATER = new Date('2026-11-20T15:00:00Z');
const ENABLED_BEFORE = new Date('2026-10-01T12:00:00Z');
const DEFAULTS = Object.freeze({ autoSendEnabled: false, d7: true, d15: true, d21: true, d30: true, recurring: true });

// Stored config row of a trainer
function storedConfig(world, trainerId = TRAINER_ID) {
  return world.rows(CONFIG_MODEL).find((row) => row.trainerId === trainerId);
}

describe('student feedback constants', () => {
  it('keeps the contract values of the enums', () => {
    expect(Object.values(StudentFeedbackMilestone)).toEqual(['D7', 'D15', 'D21', 'D30', 'RECURRING', 'ADHOC']);
    expect(Object.values(StudentFeedbackStatus)).toEqual(['pending', 'answered', 'expired']);
    expect(Object.values(StudentFeedbackQuestionType)).toEqual(['score', 'stars', 'open']);
    expect(Object.values(StudentFeedbackPillar)).toEqual(['training_adherence', 'diet_adherence', 'evolution', 'routine', 'sleep', 'hydration', 'report', 'other']);
    expect(Object.values(StudentFeedbackBand)).toEqual(['attention', 'stable', 'good']);
    expect(Object.values(StudentFeedbackInboxFilter)).toEqual(['all', 'unread', 'unanswered']);
    expect(StudentFeedbackQuestionCondition.HAS_MEAL_PLAN).toBe('has_meal_plan');
  });

  it('keeps the contract values of the error codes', () => {
    expect(StudentFeedbackErrorCode).toEqual({
      NOT_FOUND: 'STUDENT_FEEDBACK_NOT_FOUND',
      EXPIRED: 'STUDENT_FEEDBACK_EXPIRED',
      ALREADY_SUBMITTED: 'STUDENT_FEEDBACK_ALREADY_SUBMITTED',
      ALREADY_PENDING: 'STUDENT_FEEDBACK_ALREADY_PENDING',
      REQUIRED_ANSWER_MISSING: 'STUDENT_FEEDBACK_REQUIRED_ANSWER_MISSING',
      INVALID_ANSWER: 'STUDENT_FEEDBACK_INVALID_ANSWER',
    });
  });

  it('has one distinct message code per error code', () => {
    const codes = Object.keys(StudentFeedbackErrorCode).map((key) => StudentFeedbackMessageCode[key]);

    expect(codes.every((code) => typeof code === 'string' && code.length > 0)).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('defaults to auto-send off with every milestone on', () => {
    expect(DEFAULT_STUDENT_FEEDBACK_CONFIG).toEqual(DEFAULTS);
  });
});

describe('student feedback config service', () => {
  let world;

  beforeEach(() => {
    world = createFeedbackWorld();
  });

  describe('getConfig', () => {
    it('returns the defaults for a trainer that never saved: auto-send off', async () => {
      expect(await getConfig(world.prisma, TRAINER_ID)).toEqual(DEFAULTS);
    });

    it('does not store anything on read', async () => {
      await getConfig(world.prisma, TRAINER_ID);

      expect(world.rows(CONFIG_MODEL)).toHaveLength(0);
    });

    it('returns the stored settings with only the contract fields', async () => {
      seedConfig(world, { d15: false, recurring: false, enabledAt: ENABLED_BEFORE });

      expect(await getConfig(world.prisma, TRAINER_ID)).toEqual({ autoSendEnabled: true, d7: true, d15: false, d21: true, d30: true, recurring: false });
    });

    it('does not read the settings of another trainer', async () => {
      seedConfig(world, { d7: false });

      expect(await getConfig(world.prisma, OTHER_TRAINER_ID)).toEqual(DEFAULTS);
    });
  });

  describe('updateConfig', () => {
    it('changes only the fields sent and returns the full config', async () => {
      seedConfig(world, { d15: false, enabledAt: ENABLED_BEFORE });

      const config = await updateConfig(world.prisma, TRAINER_ID, { d21: false }, NOW);

      expect(config).toEqual({ autoSendEnabled: true, d7: true, d15: false, d21: false, d30: true, recurring: true });
      expect(await getConfig(world.prisma, TRAINER_ID)).toEqual(config);
    });

    it('creates the settings from the defaults on the first save', async () => {
      const config = await updateConfig(world.prisma, TRAINER_ID, { d7: false }, NOW);

      expect(config).toEqual({ ...DEFAULTS, d7: false });
      expect(world.rows(CONFIG_MODEL)).toHaveLength(1);
      expect(storedConfig(world)).toMatchObject({ trainerId: TRAINER_ID, autoSendEnabled: false, d7: false, d15: true });
    });

    it('keeps one row per trainer across saves', async () => {
      await updateConfig(world.prisma, TRAINER_ID, { d7: false }, NOW);
      await updateConfig(world.prisma, TRAINER_ID, { d30: false }, LATER);

      expect(world.rows(CONFIG_MODEL)).toHaveLength(1);
      expect(await getConfig(world.prisma, TRAINER_ID)).toEqual({ ...DEFAULTS, d7: false, d30: false });
    });

    it('accepts every field at once', async () => {
      const input = { autoSendEnabled: true, d7: false, d15: false, d21: false, d30: false, recurring: false };

      expect(await updateConfig(world.prisma, TRAINER_ID, input, NOW)).toEqual(input);
    });

    it('changes nothing with an empty body', async () => {
      seedConfig(world, { d15: false, enabledAt: ENABLED_BEFORE });

      const config = await updateConfig(world.prisma, TRAINER_ID, {}, NOW);

      expect(config).toEqual({ autoSendEnabled: true, d7: true, d15: false, d21: true, d30: true, recurring: true });
      expect(storedConfig(world).enabledAt).toEqual(ENABLED_BEFORE);
    });

    it('stamps enabledAt when auto-send is turned on for the first time', async () => {
      await updateConfig(world.prisma, TRAINER_ID, { autoSendEnabled: true }, NOW);

      expect(storedConfig(world)).toMatchObject({ autoSendEnabled: true, enabledAt: NOW });
    });

    it('keeps enabledAt when a milestone changes while auto-send stays on', async () => {
      seedConfig(world, { enabledAt: ENABLED_BEFORE });

      await updateConfig(world.prisma, TRAINER_ID, { d7: false }, NOW);

      expect(storedConfig(world).enabledAt).toEqual(ENABLED_BEFORE);
    });

    it('keeps enabledAt when auto-send is sent as on again', async () => {
      seedConfig(world, { enabledAt: ENABLED_BEFORE });

      await updateConfig(world.prisma, TRAINER_ID, { autoSendEnabled: true }, NOW);

      expect(storedConfig(world).enabledAt).toEqual(ENABLED_BEFORE);
    });

    it('stamps a new enabledAt when auto-send is turned off and on again', async () => {
      seedConfig(world, { enabledAt: ENABLED_BEFORE });

      await updateConfig(world.prisma, TRAINER_ID, { autoSendEnabled: false }, NOW);
      await updateConfig(world.prisma, TRAINER_ID, { autoSendEnabled: true }, LATER);

      expect(storedConfig(world)).toMatchObject({ autoSendEnabled: true, enabledAt: LATER });
    });

    it('does not touch the settings of another trainer', async () => {
      seedConfig(world, { trainerId: OTHER_TRAINER_ID, enabledAt: ENABLED_BEFORE });

      await updateConfig(world.prisma, TRAINER_ID, { autoSendEnabled: true, recurring: false }, NOW);

      expect(storedConfig(world, OTHER_TRAINER_ID)).toMatchObject({ autoSendEnabled: true, recurring: true, enabledAt: ENABLED_BEFORE });
    });
  });
});
