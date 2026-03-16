import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import * as service from '../../src/services/admin-anamnesis-service.js';
import * as schema from '../schemas/admin-anamnesis-route.schema.js';

export async function adminAnamnesisRoutes(fastify) {
  // ═══════════════════════════════════════════════════════════
  // ADMIN ROUTES — Public Anamnesis CRUD
  // ═══════════════════════════════════════════════════════════

  // POST /admin/anamneses — Create public anamnesis
  fastify.post(
    '/admin/anamneses',
    {
      preHandler: [authenticate, requireRole(Roles.ADMIN)],
      schema: schema.createPublicAnamnesisSchema,
    },
    async (request, reply) => {
      const anamnesis = await service.createPublicAnamnesis(request.body);
      return reply.status(201).send(anamnesis);
    },
  );

  // GET /admin/anamneses — List all public anamneses
  fastify.get(
    '/admin/anamneses',
    {
      preHandler: [authenticate, requireRole(Roles.ADMIN)],
      schema: schema.listPublicAnamnesisSchema,
    },
    async (request, reply) => {
      const anamneses = await service.listPublicAnamneses();
      return reply.send(anamneses);
    },
  );

  // GET /admin/anamneses/:anamnesisId — Get full detail
  fastify.get(
    '/admin/anamneses/:anamnesisId',
    {
      preHandler: [authenticate, requireRole(Roles.ADMIN)],
      schema: schema.getPublicAnamnesisSchema,
    },
    async (request, reply) => {
      const anamnesis = await service.getPublicAnamnesisById(request.params.anamnesisId);
      return reply.send(anamnesis);
    },
  );

  // PATCH /admin/anamneses/:anamnesisId — Update metadata
  fastify.patch(
    '/admin/anamneses/:anamnesisId',
    {
      preHandler: [authenticate, requireRole(Roles.ADMIN)],
      schema: schema.updatePublicAnamnesisSchema,
    },
    async (request, reply) => {
      const anamnesis = await service.updatePublicAnamnesis(
        request.params.anamnesisId,
        request.body,
      );
      return reply.send(anamnesis);
    },
  );

  // DELETE /admin/anamneses/:anamnesisId — Soft delete
  fastify.delete(
    '/admin/anamneses/:anamnesisId',
    {
      preHandler: [authenticate, requireRole(Roles.ADMIN)],
      schema: schema.deletePublicAnamnesisSchema,
    },
    async (request, reply) => {
      const result = await service.deletePublicAnamnesis(request.params.anamnesisId);
      return reply.send(result);
    },
  );

  // ═══════════════════════════════════════════════════════════
  // ADMIN ROUTES — Section CRUD
  // ═══════════════════════════════════════════════════════════

  // POST /admin/anamneses/:anamnesisId/sections — Add section
  fastify.post(
    '/admin/anamneses/:anamnesisId/sections',
    {
      preHandler: [authenticate, requireRole(Roles.ADMIN)],
      schema: schema.addPublicSectionSchema,
    },
    async (request, reply) => {
      const section = await service.addPublicSection(
        request.params.anamnesisId,
        request.body,
      );
      return reply.status(201).send(section);
    },
  );

  // PATCH /admin/anamneses/:anamnesisId/sections/reorder — Reorder sections
  // IMPORTANT: must be registered BEFORE :sectionId to avoid Fastify treating
  // "reorder" as a sectionId param value.
  fastify.patch(
    '/admin/anamneses/:anamnesisId/sections/reorder',
    {
      preHandler: [authenticate, requireRole(Roles.ADMIN)],
      schema: schema.reorderPublicSectionsSchema,
    },
    async (request, reply) => {
      const sections = await service.reorderPublicSections(
        request.params.anamnesisId,
        request.body.orderedIds,
      );
      return reply.send(sections);
    },
  );

  // PATCH /admin/anamneses/:anamnesisId/sections/:sectionId — Update section
  fastify.patch(
    '/admin/anamneses/:anamnesisId/sections/:sectionId',
    {
      preHandler: [authenticate, requireRole(Roles.ADMIN)],
      schema: schema.updatePublicSectionSchema,
    },
    async (request, reply) => {
      const section = await service.updatePublicSection(
        request.params.anamnesisId,
        request.params.sectionId,
        request.body,
      );
      return reply.send(section);
    },
  );

  // DELETE /admin/anamneses/:anamnesisId/sections/:sectionId — Soft delete section
  fastify.delete(
    '/admin/anamneses/:anamnesisId/sections/:sectionId',
    {
      preHandler: [authenticate, requireRole(Roles.ADMIN)],
      schema: schema.deletePublicSectionSchema,
    },
    async (request, reply) => {
      const result = await service.deletePublicSection(
        request.params.anamnesisId,
        request.params.sectionId,
      );
      return reply.send(result);
    },
  );

  // ═══════════════════════════════════════════════════════════
  // ADMIN ROUTES — Question CRUD
  // ═══════════════════════════════════════════════════════════

  // POST /admin/anamneses/:anamnesisId/sections/:sectionId/questions — Add question
  fastify.post(
    '/admin/anamneses/:anamnesisId/sections/:sectionId/questions',
    {
      preHandler: [authenticate, requireRole(Roles.ADMIN)],
      schema: schema.addPublicQuestionSchema,
    },
    async (request, reply) => {
      const question = await service.addPublicQuestion(
        request.params.anamnesisId,
        request.params.sectionId,
        request.body,
      );
      return reply.status(201).send(question);
    },
  );

  // PATCH /admin/anamneses/:anamnesisId/sections/:sectionId/questions/:questionId — Update question
  fastify.patch(
    '/admin/anamneses/:anamnesisId/sections/:sectionId/questions/:questionId',
    {
      preHandler: [authenticate, requireRole(Roles.ADMIN)],
      schema: schema.updatePublicQuestionSchema,
    },
    async (request, reply) => {
      const question = await service.updatePublicQuestion(
        request.params.anamnesisId,
        request.params.sectionId,
        request.params.questionId,
        request.body,
      );
      return reply.send(question);
    },
  );

  // DELETE /admin/anamneses/:anamnesisId/sections/:sectionId/questions/:questionId — Soft delete question
  fastify.delete(
    '/admin/anamneses/:anamnesisId/sections/:sectionId/questions/:questionId',
    {
      preHandler: [authenticate, requireRole(Roles.ADMIN)],
      schema: schema.deletePublicQuestionSchema,
    },
    async (request, reply) => {
      const result = await service.deletePublicQuestion(
        request.params.anamnesisId,
        request.params.sectionId,
        request.params.questionId,
      );
      return reply.send(result);
    },
  );
}
