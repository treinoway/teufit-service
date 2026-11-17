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
import { resolveTrainerOwnerOrThrow } from '../../src/services/professional-owner-service.js';
import {
  createPlanSchema,
  listPlansSchema,
  getPlanByIdSchema,
  updatePlanSchema,
  archivePlanSchema,
  unarchivePlanSchema,
} from '../schemas/subscription-plan-route.schema.js';

/**
 * Registers the subscription-plan routes under a prefix for one kind of owner.
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {{ prefix: string, preHandler: Function[], resolveOwner: Function, schemas: object, includeKindCounts?: boolean }} config
 */
export function registerSubscriptionPlanRoutes(
  fastify,
  { prefix, preHandler, resolveOwner, schemas, includeKindCounts = false },
) {
  const base = `${prefix}/subscription-plans`;

  fastify.post(base, { preHandler, schema: schemas.createPlan }, async (request, reply) => {
    const owner = await resolveOwner(prisma, request.user.id);
    const plan = await createPlan(prisma, owner, request.body);
    return reply.status(201).send(plan);
  });

  fastify.get(base, { preHandler, schema: schemas.listPlans }, async (request, reply) => {
    const owner = await resolveOwner(prisma, request.user.id);
    const plans = await listPlans(prisma, owner, {
      includeArchived: request.query.includeArchived ?? false,
      includeKindCounts,
    });
    return reply.send(plans);
  });

  fastify.get(`${base}/:id`, { preHandler, schema: schemas.getPlanById }, async (request, reply) => {
    const owner = await resolveOwner(prisma, request.user.id);
    return reply.send(await getPlanById(prisma, owner, request.params.id));
  });

  fastify.patch(`${base}/:id`, { preHandler, schema: schemas.updatePlan }, async (request, reply) => {
    const owner = await resolveOwner(prisma, request.user.id);
    return reply.send(await updatePlan(prisma, owner, request.params.id, request.body));
  });

  fastify.post(`${base}/:id/archive`, { preHandler, schema: schemas.archivePlan }, async (request, reply) => {
    const owner = await resolveOwner(prisma, request.user.id);
    return reply.send(await archivePlan(prisma, owner, request.params.id));
  });

  fastify.post(`${base}/:id/unarchive`, { preHandler, schema: schemas.unarchivePlan }, async (request, reply) => {
    const owner = await resolveOwner(prisma, request.user.id);
    return reply.send(await unarchivePlan(prisma, owner, request.params.id));
  });
}

// Registers the trainer-only /trainer/subscription-plans routes.
export async function subscriptionPlanRoutes(fastify) {
  registerSubscriptionPlanRoutes(fastify, {
    prefix: '/trainer',
    preHandler: [authenticate, requireRole(Roles.TRAINER)],
    resolveOwner: resolveTrainerOwnerOrThrow,
    schemas: {
      createPlan: createPlanSchema,
      listPlans: listPlansSchema,
      getPlanById: getPlanByIdSchema,
      updatePlan: updatePlanSchema,
      archivePlan: archivePlanSchema,
      unarchivePlan: unarchivePlanSchema,
    },
  });
}
