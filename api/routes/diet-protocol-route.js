import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { prisma } from '../../src/db.js';
import * as service from '../../src/services/diet-protocol-service.js';
import * as schema from '../schemas/diet-protocol-route.schema.js';
import config from '../../config/index.js';

export async function dietProtocolRoutes(fastify) {
  // ========== NUTRITIONIST ROUTES ==========

  // POST /nutritionist/diet-protocols
  fastify.post(
    '/nutritionist/diet-protocols',
    {
      config: { rateLimit: config.rateLimit.dietProtocol.create },
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: schema.createProtocolSchema,
    },
    async (request, reply) => {
      const protocol = await service.createProtocol(prisma, request.user.id, request.body);
      return reply.status(201).send(protocol);
    },
  );

  // POST /nutritionist/diet-protocols/import-from-template
  // Must be registered BEFORE /:id to avoid route collision
  fastify.post(
    '/nutritionist/diet-protocols/import-from-template',
    {
      config: { rateLimit: config.rateLimit.dietProtocol.importFromTemplate },
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: schema.importFromTemplateSchema,
    },
    async (request, reply) => {
      const { templateId, ...data } = request.body;
      const protocol = await service.importFromTemplate(prisma, request.user.id, templateId, data);
      return reply.status(201).send(protocol);
    },
  );

  // GET /nutritionist/diet-protocols
  fastify.get(
    '/nutritionist/diet-protocols',
    {
      config: { rateLimit: config.rateLimit.dietProtocol.list },
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: schema.listProtocolsSchema,
    },
    async (request, reply) => {
      const protocols = await service.listProtocols(prisma, request.user.id, request.query);
      return reply.send(protocols);
    },
  );

  // GET /nutritionist/diet-protocols/:id
  fastify.get(
    '/nutritionist/diet-protocols/:id',
    {
      config: { rateLimit: config.rateLimit.dietProtocol.getById },
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: schema.getProtocolByIdSchema,
    },
    async (request, reply) => {
      const protocol = await service.getProtocolById(prisma, request.user.id, request.params.id, 'nutritionist');
      return reply.send(protocol);
    },
  );

  // PATCH /nutritionist/diet-protocols/:id
  fastify.patch(
    '/nutritionist/diet-protocols/:id',
    {
      config: { rateLimit: config.rateLimit.dietProtocol.update },
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: schema.updateProtocolSchema,
    },
    async (request, reply) => {
      const protocol = await service.updateProtocol(prisma, request.user.id, request.params.id, request.body);
      return reply.send(protocol);
    },
  );

  // DELETE /nutritionist/diet-protocols/:id
  fastify.delete(
    '/nutritionist/diet-protocols/:id',
    {
      config: { rateLimit: config.rateLimit.dietProtocol.delete },
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: schema.deleteProtocolSchema,
    },
    async (request, reply) => {
      const result = await service.deleteProtocol(prisma, request.user.id, request.params.id);
      return reply.send(result);
    },
  );

  // ========== MY ROUTES (patient view) ==========

  // GET /my/diet-protocols
  fastify.get(
    '/my/diet-protocols',
    {
      config: { rateLimit: config.rateLimit.dietProtocol.list },
      preHandler: [authenticate],
      schema: schema.getMyProtocolsSchema,
    },
    async (request, reply) => {
      const protocols = await service.getMyProtocols(prisma, request.user.id, request.query);
      return reply.send(protocols);
    },
  );

  // GET /my/diet-protocols/:id
  fastify.get(
    '/my/diet-protocols/:id',
    {
      config: { rateLimit: config.rateLimit.dietProtocol.getById },
      preHandler: [authenticate],
      schema: schema.getMyProtocolByIdSchema,
    },
    async (request, reply) => {
      const protocol = await service.getProtocolById(prisma, request.user.id, request.params.id, 'assignee');
      return reply.send(protocol);
    },
  );
}
