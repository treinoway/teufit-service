/**
 * Student Feedback Routes (student answers, trainer reads)
 *
 * GET   /my/feedbacks/pending
 * GET   /my/feedbacks/:id
 * PATCH /my/feedbacks/:id/draft
 * POST  /my/feedbacks/:id/submit
 * GET   /trainer/student-feedbacks
 * GET   /trainer/student-feedbacks/unread-count
 * GET   /trainer/student-feedbacks/config
 * PUT   /trainer/student-feedbacks/config
 * GET    /trainer/student-feedbacks/milestone-templates
 * PUT    /trainer/student-feedbacks/milestone-templates
 * GET    /trainer/student-feedbacks/templates
 * POST   /trainer/student-feedbacks/templates
 * GET    /trainer/student-feedbacks/templates/:id
 * POST   /trainer/student-feedbacks/templates/:id/duplicate
 * PUT    /trainer/student-feedbacks/templates/:id
 * DELETE /trainer/student-feedbacks/templates/:id
 * PATCH /trainer/student-feedbacks/:id/read
 * GET   /trainer/students/:studentId/feedbacks
 * POST  /trainer/students/:studentId/feedbacks
 *
 * Auth: /my/* authenticate; /trainer/* authenticate + trainer role (403), then the trainer profile lookup
 */

import emailHandler from '../../src/config/email-handler.js';
import s3BucketHandler from '../../src/config/s3-bucket-handler.js';
import { prisma } from '../../src/db.js';
import { ForbiddenAppError } from '../../src/errors/app-error.js';
import { getConfig, getMilestoneTemplates, updateConfig, updateMilestoneTemplates } from '../../src/services/student-feedback-config-service.js';
import { getFeedback, getPendingFeedback, saveDraft, submitFeedback } from '../../src/services/student-feedback-student-service.js';
import { getRequestLanguage } from '../../src/i18n/index.js';
import {
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  getTemplate,
  listTemplates,
  saveTemplate,
} from '../../src/services/student-feedback-template-service.js';
import {
  countUnread,
  getStudentHistory,
  listInbox,
  markAsRead,
  sendAdhocFeedback,
} from '../../src/services/student-feedback-trainer-service.js';
import { authenticate, requireTrainer } from '../middleware/auth.js';
import {
  countUnreadSchema,
  createTemplateSchema,
  deleteTemplateSchema,
  duplicateTemplateSchema,
  getConfigSchema,
  getFeedbackSchema,
  getMilestoneTemplatesSchema,
  getPendingFeedbackSchema,
  getStudentHistorySchema,
  getTemplateSchema,
  listInboxSchema,
  listTemplatesSchema,
  markAsReadSchema,
  saveDraftSchema,
  saveTemplateSchema,
  sendAdhocFeedbackSchema,
  submitFeedbackSchema,
  updateConfigSchema,
  updateMilestoneTemplatesSchema,
} from '../schemas/student-feedback-route.schema.js';

const TRAINER_PROFILE_MISSING_MESSAGE_CODE = 'trainer.notFound';
const TEMPLATES_PATH = '/trainer/student-feedbacks/templates';
const MILESTONE_TEMPLATES_PATH = '/trainer/student-feedbacks/milestone-templates';

// Trainer id of the authenticated user, or 403 trainer.notFound when the user has no trainer profile
async function requireTrainerId(userId) {
  const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
  if (!trainer) {
    throw new ForbiddenAppError({ messageCode: TRAINER_PROFILE_MISSING_MESSAGE_CODE, message: 'Trainer profile not found', details: {} });
  }
  return trainer.id;
}

// Copy of a person (trainer or student) with the stored avatar key resolved into a URL
async function withAvatarUrl(person) {
  return { ...person, avatarUrl: await s3BucketHandler.resolveUrl(person.avatarUrl) };
}

// Copy of a student-facing feedback with the trainer avatar resolved
async function withTrainerAvatar(feedback) {
  return { ...feedback, trainer: await withAvatarUrl(feedback.trainer) };
}

// Registers the /my/feedbacks endpoints of the student
function registerStudentRoutes(fastify) {
  const preHandler = [authenticate];

  fastify.get('/my/feedbacks/pending', { preHandler, schema: getPendingFeedbackSchema }, async (request, reply) => {
    const { feedback } = await getPendingFeedback(prisma, request.user.id, new Date());
    return reply.send({ feedback: feedback ? await withTrainerAvatar(feedback) : null });
  });

  fastify.get('/my/feedbacks/:id', { preHandler, schema: getFeedbackSchema }, async (request, reply) => {
    const feedback = await getFeedback(prisma, request.user.id, request.params.id, new Date());
    return reply.send(await withTrainerAvatar(feedback));
  });

  fastify.patch('/my/feedbacks/:id/draft', { preHandler, schema: saveDraftSchema }, async (request, reply) => {
    return reply.send(await saveDraft(prisma, request.user.id, request.params.id, request.body, new Date()));
  });

  fastify.post('/my/feedbacks/:id/submit', { preHandler, schema: submitFeedbackSchema }, async (request, reply) => {
    return reply.send(await submitFeedback(prisma, request.user.id, request.params.id, request.body, new Date()));
  });
}

// Registers the inbox and settings endpoints of the trainer
function registerTrainerInboxRoutes(fastify, preHandler) {
  fastify.get('/trainer/student-feedbacks', { preHandler, schema: listInboxSchema }, async (request, reply) => {
    const trainerId = await requireTrainerId(request.user.id);
    const inbox = await listInbox(prisma, trainerId, request.query, new Date());
    const items = await Promise.all(inbox.items.map(async (item) => ({ ...item, student: await withAvatarUrl(item.student) })));
    return reply.send({ ...inbox, items });
  });

  fastify.get('/trainer/student-feedbacks/unread-count', { preHandler, schema: countUnreadSchema }, async (request, reply) => {
    const trainerId = await requireTrainerId(request.user.id);
    return reply.send(await countUnread(prisma, trainerId));
  });

  fastify.get('/trainer/student-feedbacks/config', { preHandler, schema: getConfigSchema }, async (request, reply) => {
    const trainerId = await requireTrainerId(request.user.id);
    return reply.send(await getConfig(prisma, trainerId));
  });

  fastify.put('/trainer/student-feedbacks/config', { preHandler, schema: updateConfigSchema }, async (request, reply) => {
    const trainerId = await requireTrainerId(request.user.id);
    return reply.send(await updateConfig(prisma, trainerId, request.body ?? {}, new Date()));
  });

  fastify.patch('/trainer/student-feedbacks/:id/read', { preHandler, schema: markAsReadSchema }, async (request, reply) => {
    const trainerId = await requireTrainerId(request.user.id);
    return reply.send(await markAsRead(prisma, trainerId, request.params.id, new Date()));
  });
}

// Registers the per-student history and ad-hoc send endpoints of the trainer
function registerTrainerStudentRoutes(fastify, preHandler) {
  fastify.get('/trainer/students/:studentId/feedbacks', { preHandler, schema: getStudentHistorySchema }, async (request, reply) => {
    const trainerId = await requireTrainerId(request.user.id);
    const history = await getStudentHistory(prisma, trainerId, request.params.studentId, new Date());
    return reply.send({ ...history, student: await withAvatarUrl(history.student) });
  });

  fastify.post('/trainer/students/:studentId/feedbacks', { preHandler, schema: sendAdhocFeedbackSchema }, async (request, reply) => {
    const trainerId = await requireTrainerId(request.user.id);
    // why: the options argument is passed only with a picked template, so a send without body keeps the call it always had.
    const options = request.body?.templateId ? [{ templateId: request.body.templateId }] : [];
    const created = await sendAdhocFeedback(prisma, emailHandler, trainerId, request.params.studentId, new Date(), request.log, ...options);
    return reply.code(201).send(created);
  });
}

// Registers the read, create, duplicate, save and delete endpoints of the trainer's templates
function registerTemplateRoutes(fastify, preHandler) {
  fastify.get(TEMPLATES_PATH, { preHandler, schema: listTemplatesSchema }, async (request, reply) => {
    const trainerId = await requireTrainerId(request.user.id);
    return reply.send({ templates: await listTemplates(prisma, trainerId) });
  });

  fastify.post(TEMPLATES_PATH, { preHandler, schema: createTemplateSchema }, async (request, reply) => {
    const trainerId = await requireTrainerId(request.user.id);
    const template = await createTemplate(prisma, trainerId, request.body, getRequestLanguage(request));
    return reply.code(201).send({ template });
  });

  fastify.get(`${TEMPLATES_PATH}/:id`, { preHandler, schema: getTemplateSchema }, async (request, reply) => {
    const trainerId = await requireTrainerId(request.user.id);
    return reply.send({ template: await getTemplate(prisma, trainerId, request.params.id) });
  });

  fastify.post(`${TEMPLATES_PATH}/:id/duplicate`, { preHandler, schema: duplicateTemplateSchema }, async (request, reply) => {
    const trainerId = await requireTrainerId(request.user.id);
    return reply.code(201).send({ template: await duplicateTemplate(prisma, trainerId, request.params.id) });
  });

  fastify.put(`${TEMPLATES_PATH}/:id`, { preHandler, schema: saveTemplateSchema }, async (request, reply) => {
    const trainerId = await requireTrainerId(request.user.id);
    return reply.send({ template: await saveTemplate(prisma, trainerId, request.params.id, request.body) });
  });

  fastify.delete(`${TEMPLATES_PATH}/:id`, { preHandler, schema: deleteTemplateSchema }, async (request, reply) => {
    const trainerId = await requireTrainerId(request.user.id);
    await deleteTemplate(prisma, trainerId, request.params.id);
    return reply.code(204).send();
  });
}

// Registers the endpoints that choose the template of each milestone
function registerMilestoneTemplateRoutes(fastify, preHandler) {
  fastify.get(MILESTONE_TEMPLATES_PATH, { preHandler, schema: getMilestoneTemplatesSchema }, async (request, reply) => {
    const trainerId = await requireTrainerId(request.user.id);
    return reply.send({ milestoneTemplates: await getMilestoneTemplates(prisma, trainerId) });
  });

  fastify.put(MILESTONE_TEMPLATES_PATH, { preHandler, schema: updateMilestoneTemplatesSchema }, async (request, reply) => {
    const trainerId = await requireTrainerId(request.user.id);
    return reply.send({ milestoneTemplates: await updateMilestoneTemplates(prisma, trainerId, request.body ?? {}) });
  });
}

// Route plugin registering the student feedback endpoints
export async function studentFeedbackRoutes(fastify) {
  registerStudentRoutes(fastify);
  const trainerPreHandler = [authenticate, requireTrainer()];
  registerTrainerInboxRoutes(fastify, trainerPreHandler);
  registerTrainerStudentRoutes(fastify, trainerPreHandler);
  registerTemplateRoutes(fastify, trainerPreHandler);
  registerMilestoneTemplateRoutes(fastify, trainerPreHandler);
}
