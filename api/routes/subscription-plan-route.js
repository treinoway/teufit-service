import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { prisma } from '../../src/db.js';
import {
  createPlan,
  listPlans,
  getPlanById,
  updatePlan,
  archivePlan,
  unarchivePlan,
} from '../../src/services/subscription-plan-service.js';
import {
  createPlanSchema,
  listPlansSchema,
  getPlanByIdSchema,
  updatePlanSchema,
  archivePlanSchema,
  unarchivePlanSchema,
} from '../schemas/subscription-plan-route.schema.js';

export async function subscriptionPlanRoutes(fastify) {
  fastify.post(
    '/trainer/subscription-plans',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: createPlanSchema,
    },
    async (request, reply) => {
      const plan = await createPlan(prisma, request.user.id, request.body);
      return reply.status(201).send(plan);
    },
  );

  fastify.get(
    '/trainer/subscription-plans',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: listPlansSchema,
    },
    async (request, reply) => {
      const plans = await listPlans(prisma, request.user.id, {
        includeArchived: request.query.includeArchived ?? false,
      });
      return reply.send(plans);
    },
  );

  fastify.get(
    '/trainer/subscription-plans/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: getPlanByIdSchema,
    },
    async (request, reply) => {
      const plan = await getPlanById(prisma, request.user.id, request.params.id);
      return reply.send(plan);
    },
  );

  fastify.patch(
    '/trainer/subscription-plans/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: updatePlanSchema,
    },
    async (request, reply) => {
      const plan = await updatePlan(prisma, request.user.id, request.params.id, request.body);
      return reply.send(plan);
    },
  );

  fastify.post(
    '/trainer/subscription-plans/:id/archive',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: archivePlanSchema,
    },
    async (request, reply) => {
      const plan = await archivePlan(prisma, request.user.id, request.params.id);
      return reply.send(plan);
    },
  );

  fastify.post(
    '/trainer/subscription-plans/:id/unarchive',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: unarchivePlanSchema,
    },
    async (request, reply) => {
      const plan = await unarchivePlan(prisma, request.user.id, request.params.id);
      return reply.send(plan);
    },
  );
}
