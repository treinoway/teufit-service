import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import * as service from '../../src/services/anamnesis-service.js';
import * as schema from '../schemas/anamnesis-route.schema.js';
import { runAfterResponse } from '../../src/helpers/run-after-response.js';

/**
 * Pushes the submission to each trainer who assigned the anamnesis; fire-and-forget, never throws.
 */
async function notifyAssignerTrainers(fastify, studentId, anamnesisId) {
  try {
    const trainerIds = await service.listAnamnesisAssignerTrainerIds(studentId, anamnesisId, fastify.prisma);
    await Promise.all(
      trainerIds.map((trainerId) =>
        fastify.trainerPush.notifyAnamnesisSubmitted({ studentId, anamnesisId, trainerId }),
      ),
    );
  } catch (error) {
    fastify.log.warn({ err: error }, 'anamnesis: trainer push lookup failed');
  }
}

export async function anamnesisRoutes(fastify) {
  // ═══════════════════════════════════════════════════════════
  // TRAINER ROUTES — Anamnesis CRUD
  // ═══════════════════════════════════════════════════════════

  // POST /trainer/anamneses — Create anamnesis with nested sections/questions/options
  fastify.post(
    '/trainer/anamneses',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.createAnamnesisSchema,
    },
    async (request, reply) => {
      const anamnesis = await service.createAnamnesis(request.user.id, request.body);
      return reply.status(201).send(anamnesis);
    },
  );

  // GET /trainer/anamneses — List anamneses (private + general)
  fastify.get(
    '/trainer/anamneses',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.listAnamnesisSchema,
    },
    async (request, reply) => {
      const anamneses = await service.listAnamneses(request.user.id);
      return reply.send(anamneses);
    },
  );

  // GET /trainer/anamneses/:anamnesisId — Get full detail
  fastify.get(
    '/trainer/anamneses/:anamnesisId',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getAnamnesisSchema,
    },
    async (request, reply) => {
      const anamnesis = await service.getAnamnesisById(request.user.id, request.params.anamnesisId);
      return reply.send(anamnesis);
    },
  );

  // PATCH /trainer/anamneses/:anamnesisId — Update metadata
  fastify.patch(
    '/trainer/anamneses/:anamnesisId',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.updateAnamnesisSchema,
    },
    async (request, reply) => {
      const anamnesis = await service.updateAnamnesis(
        request.user.id,
        request.params.anamnesisId,
        request.body,
      );
      return reply.send(anamnesis);
    },
  );

  // DELETE /trainer/anamneses/:anamnesisId — Soft delete
  fastify.delete(
    '/trainer/anamneses/:anamnesisId',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.deleteAnamnesisSchema,
    },
    async (request, reply) => {
      const result = await service.deleteAnamnesis(request.user.id, request.params.anamnesisId);
      return reply.send(result);
    },
  );

  // ═══════════════════════════════════════════════════════════
  // TRAINER ROUTES — Section CRUD
  // ═══════════════════════════════════════════════════════════

  // POST /trainer/anamneses/:anamnesisId/sections — Add section
  fastify.post(
    '/trainer/anamneses/:anamnesisId/sections',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.addSectionSchema,
    },
    async (request, reply) => {
      const section = await service.addSection(
        request.user.id,
        request.params.anamnesisId,
        request.body,
      );
      return reply.status(201).send(section);
    },
  );

  // PATCH /trainer/anamneses/:anamnesisId/sections/reorder — Reorder sections
  // IMPORTANT: must be registered BEFORE :sectionId to avoid Fastify treating
  // "reorder" as a sectionId param value.
  fastify.patch(
    '/trainer/anamneses/:anamnesisId/sections/reorder',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.reorderSectionsSchema,
    },
    async (request, reply) => {
      const sections = await service.reorderSections(
        request.user.id,
        request.params.anamnesisId,
        request.body.orderedIds,
      );
      return reply.send(sections);
    },
  );

  // PATCH /trainer/anamneses/:anamnesisId/sections/:sectionId — Update section
  fastify.patch(
    '/trainer/anamneses/:anamnesisId/sections/:sectionId',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.updateSectionSchema,
    },
    async (request, reply) => {
      const section = await service.updateSection(
        request.user.id,
        request.params.anamnesisId,
        request.params.sectionId,
        request.body,
      );
      return reply.send(section);
    },
  );

  // DELETE /trainer/anamneses/:anamnesisId/sections/:sectionId — Soft delete section
  fastify.delete(
    '/trainer/anamneses/:anamnesisId/sections/:sectionId',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.deleteSectionSchema,
    },
    async (request, reply) => {
      const result = await service.deleteSection(
        request.user.id,
        request.params.anamnesisId,
        request.params.sectionId,
      );
      return reply.send(result);
    },
  );

  // ═══════════════════════════════════════════════════════════
  // TRAINER ROUTES — Question CRUD
  // ═══════════════════════════════════════════════════════════

  // POST /trainer/anamneses/:anamnesisId/sections/:sectionId/questions — Add question
  fastify.post(
    '/trainer/anamneses/:anamnesisId/sections/:sectionId/questions',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.addQuestionSchema,
    },
    async (request, reply) => {
      const question = await service.addQuestion(
        request.user.id,
        request.params.anamnesisId,
        request.params.sectionId,
        request.body,
      );
      return reply.status(201).send(question);
    },
  );

  // PATCH /trainer/anamneses/:anamnesisId/sections/:sectionId/questions/:questionId — Update question
  fastify.patch(
    '/trainer/anamneses/:anamnesisId/sections/:sectionId/questions/:questionId',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.updateQuestionSchema,
    },
    async (request, reply) => {
      const question = await service.updateQuestion(
        request.user.id,
        request.params.anamnesisId,
        request.params.sectionId,
        request.params.questionId,
        request.body,
      );
      return reply.send(question);
    },
  );

  // DELETE /trainer/anamneses/:anamnesisId/sections/:sectionId/questions/:questionId — Soft delete question
  fastify.delete(
    '/trainer/anamneses/:anamnesisId/sections/:sectionId/questions/:questionId',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.deleteQuestionSchema,
    },
    async (request, reply) => {
      const result = await service.deleteQuestion(
        request.user.id,
        request.params.anamnesisId,
        request.params.sectionId,
        request.params.questionId,
      );
      return reply.send(result);
    },
  );

  // ═══════════════════════════════════════════════════════════
  // TRAINER ROUTES — Student linking
  // ═══════════════════════════════════════════════════════════

  // POST /trainer/students/:studentId/anamneses — Link anamnesis to student
  fastify.post(
    '/trainer/students/:studentId/anamneses',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.linkAnamnesisToStudentSchema,
    },
    async (request, reply) => {
      const link = await service.linkAnamnesisToStudent(
        request.user.id,
        request.params.studentId,
        request.body,
      );
      // After the response: an email outage must never fail or slow down the link.
      runAfterResponse(
        reply,
        () =>
          service.notifyStudentAnamnesisAssigned({
            trainerId: link.trainerId,
            studentId: link.studentId,
            anamnesisTitle: link.anamnesis.title,
          }),
        request.log,
        'anamnesis-assigned-email',
      );
      return reply.status(201).send(link);
    },
  );

  // GET /trainer/students/:studentId/anamneses — List student anamneses
  fastify.get(
    '/trainer/students/:studentId/anamneses',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.listStudentAnamnesisSchema,
    },
    async (request, reply) => {
      const links = await service.listStudentAnamneses(
        request.user.id,
        request.params.studentId,
      );
      return reply.send(links);
    },
  );

  // DELETE /trainer/students/:studentId/anamneses/:anamnesisId — Unlink anamnesis from student
  fastify.delete(
    '/trainer/students/:studentId/anamneses/:anamnesisId',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.unlinkAnamnesisFromStudentSchema,
    },
    async (request, reply) => {
      const result = await service.unlinkAnamnesisFromStudent(
        request.user.id,
        request.params.studentId,
        request.params.anamnesisId,
      );
      return reply.send(result);
    },
  );

  // ═══════════════════════════════════════════════════════════
  // TRAINER ROUTES — Fork
  // ═══════════════════════════════════════════════════════════

  // POST /trainer/anamneses/:anamnesisId/fork — Fork into a new version
  fastify.post(
    '/trainer/anamneses/:anamnesisId/fork',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.forkAnamnesisSchema,
    },
    async (request, reply) => {
      const forked = await service.forkAnamnesis(request.user.id, request.params.anamnesisId);
      return reply.status(201).send(forked);
    },
  );

  // ═══════════════════════════════════════════════════════════
  // TRAINER ROUTES — Copy
  // ═══════════════════════════════════════════════════════════

  // POST /trainer/anamneses/:anamnesisId/copy — Copy into a new independent private copy
  fastify.post(
    '/trainer/anamneses/:anamnesisId/copy',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.copyAnamnesisSchema,
    },
    async (request, reply) => {
      const copied = await service.copyAnamnesis(request.user.id, request.params.anamnesisId);
      return reply.status(201).send(copied);
    },
  );

  // ═══════════════════════════════════════════════════════════
  // TRAINER ROUTES — Student response (view)
  // ═══════════════════════════════════════════════════════════

  // GET /trainer/students/:studentId/anamneses/:anamnesisId/response — View student response
  fastify.get(
    '/trainer/students/:studentId/anamneses/:anamnesisId/response',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getStudentAnamnesisResponseSchema,
    },
    async (request, reply) => {
      const result = await service.getStudentAnamnesisResponse(
        request.user.id,
        request.params.studentId,
        request.params.anamnesisId,
      );
      return reply.send(result);
    },
  );

  // ═══════════════════════════════════════════════════════════
  // TRAINER ROUTES — Fill the anamnesis on behalf of the student
  // ═══════════════════════════════════════════════════════════

  // GET /trainer/students/:studentId/anamneses/:anamnesisId/fill?studentPresent=true
  fastify.get(
    '/trainer/students/:studentId/anamneses/:anamnesisId/fill',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getTrainerAnamnesisFillSchema,
    },
    async (request, reply) => {
      const result = await service.getTrainerFillContext(
        request.user.id,
        request.params.studentId,
        request.params.anamnesisId,
      );
      return reply.send(result);
    },
  );

  // PATCH /trainer/students/:studentId/anamneses/:anamnesisId/response/draft — Save a draft for the student
  fastify.patch(
    '/trainer/students/:studentId/anamneses/:anamnesisId/response/draft',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.saveTrainerAnamnesisResponseDraftSchema,
    },
    async (request, reply) => {
      const result = await service.saveTrainerAnamnesisResponseDraft(
        request.user.id,
        request.params.studentId,
        request.params.anamnesisId,
        request.body,
      );
      return reply.send(result);
    },
  );

  // POST /trainer/students/:studentId/anamneses/:anamnesisId/response — Finalize for the student
  fastify.post(
    '/trainer/students/:studentId/anamneses/:anamnesisId/response',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.submitTrainerAnamnesisResponseSchema,
    },
    async (request, reply) => {
      const result = await service.submitTrainerAnamnesisResponse(
        request.user.id,
        request.params.studentId,
        request.params.anamnesisId,
        request.body,
      );
      return reply.send(result);
    },
  );

  // ═══════════════════════════════════════════════════════════
  // STUDENT ROUTES — /my/
  // ═══════════════════════════════════════════════════════════

  // GET /my/anamneses — Get my linked anamneses
  fastify.get(
    '/my/anamneses',
    {
      preHandler: [authenticate],
      schema: schema.getMyAnamnesisSchema,
    },
    async (request, reply) => {
      const anamneses = await service.getMyAnamneses(request.user.id);
      return reply.send(anamneses);
    },
  );

  // GET /my/anamneses/:anamnesisId — One linked anamnesis with its full response (or null)
  fastify.get(
    '/my/anamneses/:anamnesisId',
    {
      preHandler: [authenticate],
      schema: schema.getMyAnamnesisDetailSchema,
    },
    async (request, reply) => {
      const detail = await service.getMyAnamnesisDetail(request.user.id, request.params.anamnesisId);
      return reply.send(detail);
    },
  );

  // POST /my/anamneses/:anamnesisId/response — Submit (finalize) response to an anamnesis
  fastify.post(
    '/my/anamneses/:anamnesisId/response',
    {
      preHandler: [authenticate],
      schema: schema.submitAnamnesisResponseSchema,
    },
    async (request, reply) => {
      const result = await service.submitAnamnesisResponse(
        request.user.id,
        request.params.anamnesisId,
        request.body,
      );
      notifyAssignerTrainers(fastify, request.user.id, request.params.anamnesisId);
      return reply.send(result);
    },
  );

  // PATCH /my/anamneses/:anamnesisId/response/draft — Save a partial (draft) response
  fastify.patch(
    '/my/anamneses/:anamnesisId/response/draft',
    {
      preHandler: [authenticate],
      schema: schema.saveAnamnesisResponseDraftSchema,
    },
    async (request, reply) => {
      const result = await service.saveAnamnesisResponseDraft(
        request.user.id,
        request.params.anamnesisId,
        request.body,
      );
      return reply.send(result);
    },
  );

  // POST /my/anamneses/:anamnesisId/response/confirm — Confirm a response the trainer filled for me
  fastify.post(
    '/my/anamneses/:anamnesisId/response/confirm',
    {
      preHandler: [authenticate],
      schema: schema.confirmAnamnesisResponseSchema,
    },
    async (request, reply) => {
      const result = await service.confirmAnamnesisResponse(
        request.user.id,
        request.params.anamnesisId,
      );
      return reply.send(result);
    },
  );

  // GET /my/anamneses/:anamnesisId/response — Get my response to an anamnesis
  fastify.get(
    '/my/anamneses/:anamnesisId/response',
    {
      preHandler: [authenticate],
      schema: schema.getMyAnamnesisResponseSchema,
    },
    async (request, reply) => {
      const result = await service.getMyAnamnesisResponse(
        request.user.id,
        request.params.anamnesisId,
      );
      return reply.send(result);
    },
  );
}
