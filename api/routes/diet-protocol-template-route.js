import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { prisma } from '../../src/db.js';
import * as service from '../../src/services/diet-protocol-template-service.js';
import * as schema from '../schemas/diet-protocol-template-route.schema.js';
import config from '../../config/index.js';

export async function dietProtocolTemplateRoutes(fastify) {
  // POST /nutritionist/diet-protocol-templates
  fastify.post(
    '/nutritionist/diet-protocol-templates',
    {
      config: { rateLimit: config.rateLimit.dietProtocolTemplate.create },
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: schema.createTemplateSchema,
    },
    async (request, reply) => {
      const template = await service.createTemplate(prisma, request.user.id, request.body);
      return reply.status(201).send(template);
    },
  );

  // GET /nutritionist/diet-protocol-templates
  fastify.get(
    '/nutritionist/diet-protocol-templates',
    {
      config: { rateLimit: config.rateLimit.dietProtocolTemplate.list },
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: schema.listTemplatesSchema,
    },
    async (request, reply) => {
      const templates = await service.listTemplates(prisma, request.user.id);
      return reply.send(templates);
    },
  );

  // GET /nutritionist/diet-protocol-templates/:id
  fastify.get(
    '/nutritionist/diet-protocol-templates/:id',
    {
      config: { rateLimit: config.rateLimit.dietProtocolTemplate.getById },
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: schema.getTemplateByIdSchema,
    },
    async (request, reply) => {
      const template = await service.getTemplateById(prisma, request.user.id, request.params.id);
      return reply.send(template);
    },
  );

  // PATCH /nutritionist/diet-protocol-templates/:id
  fastify.patch(
    '/nutritionist/diet-protocol-templates/:id',
    {
      config: { rateLimit: config.rateLimit.dietProtocolTemplate.update },
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: schema.updateTemplateSchema,
    },
    async (request, reply) => {
      const template = await service.updateTemplate(prisma, request.user.id, request.params.id, request.body);
      return reply.send(template);
    },
  );

  // DELETE /nutritionist/diet-protocol-templates/:id
  fastify.delete(
    '/nutritionist/diet-protocol-templates/:id',
    {
      config: { rateLimit: config.rateLimit.dietProtocolTemplate.delete },
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: schema.deleteTemplateSchema,
    },
    async (request, reply) => {
      const result = await service.deleteTemplate(prisma, request.user.id, request.params.id);
      return reply.send(result);
    },
  );
}
