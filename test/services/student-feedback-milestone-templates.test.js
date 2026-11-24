import { beforeEach, describe, expect, it } from 'vitest';
import {
  getConfig,
  getMilestoneTemplates,
  updateConfig,
  updateMilestoneTemplates,
} from '../../src/services/student-feedback-config-service.js';
import {
  DEFAULT_STUDENT_FEEDBACK_CONFIG,
  StudentFeedbackTemplateErrorCode,
  StudentFeedbackTemplateMessageCode,
} from '../../src/constants/student-feedback.js';
import { OTHER_TRAINER_ID } from '../helpers/student-feedback-world.js';
import {
  CONFIG_MODEL,
  NO_MILESTONE_TEMPLATES,
  OTHER_TEMPLATE_ID,
  OWN_TEMPLATE_ID,
  TRAINER_ID,
  UNKNOWN_TEMPLATE_ID,
  configOf,
  createTemplateWorld,
  seedOwnTemplate,
  seedTemplateConfig,
  snapshotTemplates,
  storedMilestoneTemplates,
} from '../helpers/student-feedback-template-world.js';

const HTTP_NOT_FOUND = 404;
const SECOND_TEMPLATE_ID = 'template-second';
const DELETED_TEMPLATE_ID = 'template-deleted';
const ENABLED_AT = new Date('2026-01-01T00:00:00Z');
const NOW = new Date('2026-11-18T15:00:00Z');
const TEMPLATE_NOT_FOUND = Object.freeze({ httpStatus: HTTP_NOT_FOUND, error: 'STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND', messageCode: 'studentFeedbackTemplate.notFound' });

describe('student feedback milestone templates', () => {
  let world;

  beforeEach(() => {
    world = createTemplateWorld();
    seedOwnTemplate(world);
    seedOwnTemplate(world, { id: SECOND_TEMPLATE_ID, name: 'Outro modelo' });
    seedOwnTemplate(world, { id: DELETED_TEMPLATE_ID, name: 'Apagado', deletedAt: new Date('2026-10-20T12:00:00Z') });
    seedOwnTemplate(world, { id: OTHER_TEMPLATE_ID, trainerId: OTHER_TRAINER_ID, name: 'Modelo da Paula' });
  });

  describe('the not-found error of a template', () => {
    it('uses the template constants', () => {
      expect(TEMPLATE_NOT_FOUND.error).toBe(StudentFeedbackTemplateErrorCode.NOT_FOUND);
      expect(TEMPLATE_NOT_FOUND.messageCode).toBe(StudentFeedbackTemplateMessageCode.NOT_FOUND);
    });
  });

  describe('getMilestoneTemplates', () => {
    it('returns null for every milestone when the trainer never saved anything', async () => {
      await expect(getMilestoneTemplates(world.prisma, TRAINER_ID)).resolves.toEqual(NO_MILESTONE_TEMPLATES);
    });

    it('creates no config row on a read', async () => {
      await getMilestoneTemplates(world.prisma, TRAINER_ID);

      expect(world.rows(CONFIG_MODEL)).toHaveLength(0);
    });

    it('returns null for every milestone of a config saved before templates existed', async () => {
      seedTemplateConfig(world);

      await expect(getMilestoneTemplates(world.prisma, TRAINER_ID)).resolves.toEqual(NO_MILESTONE_TEMPLATES);
    });

    it('returns the template chosen for each milestone', async () => {
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID, d30TemplateId: SECOND_TEMPLATE_ID, recurringTemplateId: OWN_TEMPLATE_ID });

      await expect(getMilestoneTemplates(world.prisma, TRAINER_ID)).resolves.toEqual({
        d7: OWN_TEMPLATE_ID,
        d15: null,
        d21: null,
        d30: SECOND_TEMPLATE_ID,
        recurring: OWN_TEMPLATE_ID,
      });
    });

    it('never returns the choices of another trainer', async () => {
      seedTemplateConfig(world, { trainerId: OTHER_TRAINER_ID, d7TemplateId: OTHER_TEMPLATE_ID });

      await expect(getMilestoneTemplates(world.prisma, TRAINER_ID)).resolves.toEqual(NO_MILESTONE_TEMPLATES);
    });
  });

  describe('updateMilestoneTemplates', () => {
    it('stores the template of the milestones sent and returns every milestone', async () => {
      seedTemplateConfig(world);

      const result = await updateMilestoneTemplates(world.prisma, TRAINER_ID, { d7: OWN_TEMPLATE_ID, d21: SECOND_TEMPLATE_ID });

      expect(result).toEqual({ d7: OWN_TEMPLATE_ID, d15: null, d21: SECOND_TEMPLATE_ID, d30: null, recurring: null });
      expect(storedMilestoneTemplates(world)).toEqual(result);
    });

    it('keeps the milestones that were not sent', async () => {
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID, d15TemplateId: SECOND_TEMPLATE_ID });

      const result = await updateMilestoneTemplates(world.prisma, TRAINER_ID, { recurring: SECOND_TEMPLATE_ID });

      expect(result).toEqual({ d7: OWN_TEMPLATE_ID, d15: SECOND_TEMPLATE_ID, d21: null, d30: null, recurring: SECOND_TEMPLATE_ID });
    });

    it('clears a milestone sent as null, back to the general template', async () => {
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID, d15TemplateId: SECOND_TEMPLATE_ID });

      const result = await updateMilestoneTemplates(world.prisma, TRAINER_ID, { d7: null });

      expect(result).toEqual({ ...NO_MILESTONE_TEMPLATES, d15: SECOND_TEMPLATE_ID });
      expect(storedMilestoneTemplates(world)).toEqual(result);
    });

    it('changes nothing for an empty body', async () => {
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID });

      const result = await updateMilestoneTemplates(world.prisma, TRAINER_ID, {});

      expect(result).toEqual({ ...NO_MILESTONE_TEMPLATES, d7: OWN_TEMPLATE_ID });
    });

    it('creates the config with the default settings when the trainer never saved one', async () => {
      const result = await updateMilestoneTemplates(world.prisma, TRAINER_ID, { d15: OWN_TEMPLATE_ID });

      expect(result).toEqual({ ...NO_MILESTONE_TEMPLATES, d15: OWN_TEMPLATE_ID });
      expect(world.rows(CONFIG_MODEL)).toHaveLength(1);
      expect(configOf(world)).toMatchObject({ trainerId: TRAINER_ID, ...DEFAULT_STUDENT_FEEDBACK_CONFIG, d15TemplateId: OWN_TEMPLATE_ID });
      expect(configOf(world).enabledAt ?? null).toBeNull();
    });

    it('does not touch the switches or the enabled date of a stored config', async () => {
      seedTemplateConfig(world, { d21: false });

      await updateMilestoneTemplates(world.prisma, TRAINER_ID, { d21: OWN_TEMPLATE_ID });

      expect(configOf(world)).toMatchObject({ autoSendEnabled: true, enabledAt: ENABLED_AT, d7: true, d15: true, d21: false, d30: true, recurring: true });
    });

    it('does not touch the config of another trainer', async () => {
      seedTemplateConfig(world, { trainerId: OTHER_TRAINER_ID, d7TemplateId: OTHER_TEMPLATE_ID });

      await updateMilestoneTemplates(world.prisma, TRAINER_ID, { d7: OWN_TEMPLATE_ID });

      expect(storedMilestoneTemplates(world, OTHER_TRAINER_ID)).toEqual({ ...NO_MILESTONE_TEMPLATES, d7: OTHER_TEMPLATE_ID });
    });

    it.each([
      ['a template that does not exist', UNKNOWN_TEMPLATE_ID],
      ['a template of another trainer', OTHER_TEMPLATE_ID],
      ['a deleted template', DELETED_TEMPLATE_ID],
    ])('answers STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND for %s and stores nothing', async (_scenario, templateId) => {
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID });
      const before = snapshotTemplates(world);

      await expect(updateMilestoneTemplates(world.prisma, TRAINER_ID, { d15: SECOND_TEMPLATE_ID, d30: templateId })).rejects.toMatchObject(TEMPLATE_NOT_FOUND);

      expect(snapshotTemplates(world)).toEqual(before);
    });

    it('creates no config row when the template is rejected and none was saved', async () => {
      await expect(updateMilestoneTemplates(world.prisma, TRAINER_ID, { d7: UNKNOWN_TEMPLATE_ID })).rejects.toMatchObject(TEMPLATE_NOT_FOUND);

      expect(world.rows(CONFIG_MODEL)).toHaveLength(0);
    });
  });

  describe('the existing config contract', () => {
    it('getConfig still returns only the six switches after templates were chosen', async () => {
      seedTemplateConfig(world);
      await updateMilestoneTemplates(world.prisma, TRAINER_ID, { d7: OWN_TEMPLATE_ID, recurring: SECOND_TEMPLATE_ID });

      await expect(getConfig(world.prisma, TRAINER_ID)).resolves.toEqual({ ...DEFAULT_STUDENT_FEEDBACK_CONFIG, autoSendEnabled: true });
    });

    it('getConfig still returns the defaults for a config created by choosing a template', async () => {
      await updateMilestoneTemplates(world.prisma, TRAINER_ID, { d7: OWN_TEMPLATE_ID });

      await expect(getConfig(world.prisma, TRAINER_ID)).resolves.toEqual(DEFAULT_STUDENT_FEEDBACK_CONFIG);
    });

    it('updateConfig still returns only the six switches and keeps the chosen templates', async () => {
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID, d30TemplateId: SECOND_TEMPLATE_ID });

      const config = await updateConfig(world.prisma, TRAINER_ID, { d7: false }, NOW);

      expect(config).toEqual({ ...DEFAULT_STUDENT_FEEDBACK_CONFIG, autoSendEnabled: true, d7: false });
      await expect(getMilestoneTemplates(world.prisma, TRAINER_ID)).resolves.toEqual({ ...NO_MILESTONE_TEMPLATES, d7: OWN_TEMPLATE_ID, d30: SECOND_TEMPLATE_ID });
    });

    it('turning a milestone off keeps its chosen template', async () => {
      seedTemplateConfig(world, { d15TemplateId: OWN_TEMPLATE_ID });

      await updateConfig(world.prisma, TRAINER_ID, { d15: false }, NOW);

      expect(storedMilestoneTemplates(world).d15).toBe(OWN_TEMPLATE_ID);
    });
  });
});
