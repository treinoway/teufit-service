import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { prisma } from '../../src/db.js';
import * as service from '../../src/services/advanced-technique-service.js';
import * as schema from '../schemas/advanced-technique.schema.js';

const trainerOnly = [authenticate, requireRole(Roles.TRAINER)];

// Registers the trainer advanced-technique library routes.
export async function advancedTechniqueRoutes(fastify) {
  fastify.get(
    '/trainer/advanced-techniques',
    { preHandler: trainerOnly, schema: schema.listAdvancedTechniquesSchema },
    async (request) => service.listAdvancedTechniques(prisma, request.user.id, request.query),
  );

  fastify.post(
    '/trainer/advanced-techniques',
    { preHandler: trainerOnly, schema: schema.createAdvancedTechniqueSchema },
    async (request, reply) => {
      const technique = await service.createAdvancedTechnique(prisma, request.user.id, request.body);
      return reply.status(201).send(technique);
    },
  );

  fastify.get(
    '/trainer/advanced-techniques/:id',
    { preHandler: trainerOnly, schema: schema.getAdvancedTechniqueSchema },
    async (request) => service.getAdvancedTechniqueById(prisma, request.user.id, request.params.id),
  );

  fastify.patch(
    '/trainer/advanced-techniques/:id',
    { preHandler: trainerOnly, schema: schema.updateAdvancedTechniqueSchema },
    async (request) => service.updateAdvancedTechnique(prisma, request.user.id, request.params.id, request.body),
  );

  fastify.delete(
    '/trainer/advanced-techniques/:id',
    { preHandler: trainerOnly, schema: schema.deleteAdvancedTechniqueSchema },
    async (request) => service.deleteAdvancedTechnique(prisma, request.user.id, request.params.id),
  );
}
