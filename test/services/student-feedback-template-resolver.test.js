import { beforeEach, describe, expect, it } from 'vitest';
import { resolveTemplate } from '../../src/services/student-feedback-shared.js';
import {
  StudentFeedbackMilestone,
  StudentFeedbackTemplateErrorCode,
  StudentFeedbackTemplateMessageCode,
} from '../../src/constants/student-feedback.js';
import { OTHER_TRAINER_ID, TEMPLATE_NAME } from '../helpers/student-feedback-world.js';
import {
  GENERAL_TEMPLATE_ID,
  OTHER_TEMPLATE_ID,
  OTHER_TEMPLATE_NAME,
  OWN_TEMPLATE_ID,
  OWN_TEMPLATE_NAME,
  TEMPLATE_MODEL,
  TRAINER_ID,
  UNKNOWN_TEMPLATE_ID,
  createTemplateWorld,
  seedOwnTemplate,
  seedTemplateConfig,
} from '../helpers/student-feedback-template-world.js';

const HTTP_NOT_FOUND = 404;
const SECOND_TEMPLATE_ID = 'template-second';
const SECOND_TEMPLATE_NAME = 'Outro modelo';
const DELETED_TEMPLATE_ID = 'template-deleted';
const GENERAL = Object.freeze({ id: GENERAL_TEMPLATE_ID, name: TEMPLATE_NAME });
const OWN = Object.freeze({ id: OWN_TEMPLATE_ID, name: OWN_TEMPLATE_NAME });

// Expectation of the 404 of a template the trainer cannot use
function notFound() {
  return {
    httpStatus: HTTP_NOT_FOUND,
    error: StudentFeedbackTemplateErrorCode.NOT_FOUND,
    messageCode: StudentFeedbackTemplateMessageCode.NOT_FOUND,
  };
}

describe('resolveTemplate', () => {
  let world;

  beforeEach(() => {
    world = createTemplateWorld();
    seedOwnTemplate(world);
    seedOwnTemplate(world, { id: SECOND_TEMPLATE_ID, name: SECOND_TEMPLATE_NAME });
    seedOwnTemplate(world, { id: DELETED_TEMPLATE_ID, name: 'Apagado', deletedAt: new Date('2026-10-20T12:00:00Z') });
    seedOwnTemplate(world, { id: OTHER_TEMPLATE_ID, trainerId: OTHER_TRAINER_ID, name: OTHER_TEMPLATE_NAME });
  });

  describe('with an explicit template id', () => {
    it('returns an own template', async () => {
      const template = await resolveTemplate(world.prisma, { trainerId: TRAINER_ID, milestone: StudentFeedbackMilestone.ADHOC, config: null, templateId: OWN_TEMPLATE_ID });

      expect(template).toMatchObject(OWN);
    });

    it('returns the general template', async () => {
      const template = await resolveTemplate(world.prisma, { trainerId: TRAINER_ID, milestone: StudentFeedbackMilestone.ADHOC, config: null, templateId: GENERAL_TEMPLATE_ID });

      expect(template).toMatchObject(GENERAL);
    });

    it('wins over the template chosen for the milestone', async () => {
      const config = seedTemplateConfig(world, { d7TemplateId: SECOND_TEMPLATE_ID });

      const template = await resolveTemplate(world.prisma, { trainerId: TRAINER_ID, milestone: StudentFeedbackMilestone.D7, config, templateId: OWN_TEMPLATE_ID });

      expect(template).toMatchObject(OWN);
    });

    it.each([
      ['of another trainer', OTHER_TEMPLATE_ID],
      ['that does not exist', UNKNOWN_TEMPLATE_ID],
      ['that was deleted', DELETED_TEMPLATE_ID],
    ])('answers STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND for a template %s', async (_scenario, templateId) => {
      const input = { trainerId: TRAINER_ID, milestone: StudentFeedbackMilestone.ADHOC, config: null, templateId };

      await expect(resolveTemplate(world.prisma, input)).rejects.toMatchObject(notFound());
    });

    it('does not fall back to the general template when the explicit one is not usable', async () => {
      const config = seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID });
      const input = { trainerId: TRAINER_ID, milestone: StudentFeedbackMilestone.D7, config, templateId: OTHER_TEMPLATE_ID };

      await expect(resolveTemplate(world.prisma, input)).rejects.toMatchObject(notFound());
    });
  });

  describe('without an explicit template id', () => {
    it.each([
      [StudentFeedbackMilestone.D7, 'd7TemplateId'],
      [StudentFeedbackMilestone.D15, 'd15TemplateId'],
      [StudentFeedbackMilestone.D21, 'd21TemplateId'],
      [StudentFeedbackMilestone.D30, 'd30TemplateId'],
      [StudentFeedbackMilestone.RECURRING, 'recurringTemplateId'],
    ])('returns the template chosen for %s (config column %s)', async (milestone, column) => {
      const config = seedTemplateConfig(world, { [column]: OWN_TEMPLATE_ID });

      const template = await resolveTemplate(world.prisma, { trainerId: TRAINER_ID, milestone, config });

      expect(template).toMatchObject(OWN);
    });

    it('returns the general template for a milestone without a chosen template, even when another milestone has one', async () => {
      const config = seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID });

      const template = await resolveTemplate(world.prisma, { trainerId: TRAINER_ID, milestone: StudentFeedbackMilestone.D15, config });

      expect(template).toMatchObject(GENERAL);
    });

    it('returns the general template when the chosen one was deleted', async () => {
      const config = seedTemplateConfig(world, { d7TemplateId: DELETED_TEMPLATE_ID });

      const template = await resolveTemplate(world.prisma, { trainerId: TRAINER_ID, milestone: StudentFeedbackMilestone.D7, config });

      expect(template).toMatchObject(GENERAL);
    });

    it('returns the general template when the chosen one no longer exists', async () => {
      const config = seedTemplateConfig(world, { d7TemplateId: UNKNOWN_TEMPLATE_ID });

      const template = await resolveTemplate(world.prisma, { trainerId: TRAINER_ID, milestone: StudentFeedbackMilestone.D7, config });

      expect(template).toMatchObject(GENERAL);
    });

    it.each([
      ['a null config', null],
      ['an undefined config', undefined],
    ])('returns the general template with %s', async (_scenario, config) => {
      const template = await resolveTemplate(world.prisma, { trainerId: TRAINER_ID, milestone: StudentFeedbackMilestone.D7, config });

      expect(template).toMatchObject(GENERAL);
    });

    it('returns the general template for a config stored before the template columns existed', async () => {
      const config = { trainerId: TRAINER_ID, autoSendEnabled: true, d7: true, d15: true, d21: true, d30: true, recurring: true };

      const template = await resolveTemplate(world.prisma, { trainerId: TRAINER_ID, milestone: StudentFeedbackMilestone.D7, config });

      expect(template).toMatchObject(GENERAL);
    });

    it('returns the general template for an ad-hoc send, whatever the milestones use', async () => {
      const config = seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID, recurringTemplateId: SECOND_TEMPLATE_ID });

      const template = await resolveTemplate(world.prisma, { trainerId: TRAINER_ID, milestone: StudentFeedbackMilestone.ADHOC, config });

      expect(template).toMatchObject(GENERAL);
    });

    it('ignores a deleted general template and a trainer template when falling back', async () => {
      world.seed(TEMPLATE_MODEL, { id: 'template-general-old', trainerId: null, isGeneral: true, name: 'Geral antigo', version: 9, deletedAt: new Date('2026-09-01T12:00:00Z') });

      const template = await resolveTemplate(world.prisma, { trainerId: TRAINER_ID, milestone: StudentFeedbackMilestone.D7, config: null });

      expect(template).toMatchObject(GENERAL);
    });
  });
});
