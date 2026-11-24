import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { prisma } from '../../src/db.js';
import {
  assignPlanToStudent,
  listSubscriptionsByStudent,
  getActiveSubscriptionByStudent,
  listSubscriptions,
  getSubscriptionById,
  cancelSubscription,
} from '../../src/services/student-subscription-service.js';
import { resolveTrainerOwnerOrThrow } from '../../src/services/professional-owner-service.js';
import {
  assignPlanSchema,
  listSubscriptionsByStudentSchema,
  getActiveSubscriptionByStudentSchema,
  listSubscriptionsSchema,
  getSubscriptionByIdSchema,
  cancelSubscriptionSchema,
} from '../schemas/student-subscription-route.schema.js';

/**
 * Registers the student-subscription routes under a prefix for one kind of owner.
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {{ prefix: string, preHandler: Function[], resolveOwner: Function, schemas: object }} config
 */
export function registerStudentSubscriptionRoutes(fastify, { prefix, preHandler, resolveOwner, schemas }) {
  fastify.post(
    `${prefix}/students/:studentId/subscriptions`,
    { preHandler, schema: schemas.assignPlan },
    async (request, reply) => {
      const owner = await resolveOwner(prisma, request.user.id);
      const result = await assignPlanToStudent(prisma, owner, request.params.studentId, request.body);
      return reply.status(201).send(result);
    },
  );

  fastify.get(
    `${prefix}/students/:studentId/subscriptions`,
    { preHandler, schema: schemas.listSubscriptionsByStudent },
    async (request, reply) => {
      const owner = await resolveOwner(prisma, request.user.id);
      return reply.send(await listSubscriptionsByStudent(prisma, owner, request.params.studentId));
    },
  );

  fastify.get(
    `${prefix}/students/:studentId/subscriptions/active`,
    { preHandler, schema: schemas.getActiveSubscriptionByStudent },
    async (request, reply) => {
      const owner = await resolveOwner(prisma, request.user.id);
      return reply.send(await getActiveSubscriptionByStudent(prisma, owner, request.params.studentId));
    },
  );

  fastify.get(
    `${prefix}/subscriptions`,
    { preHandler, schema: schemas.listSubscriptions },
    async (request, reply) => {
      const owner = await resolveOwner(prisma, request.user.id);
      const subscriptions = await listSubscriptions(prisma, owner, {
        status: request.query.status ?? null,
        planId: request.query.planId ?? null,
      });
      return reply.send(subscriptions);
    },
  );

  fastify.get(
    `${prefix}/subscriptions/:id`,
    { preHandler, schema: schemas.getSubscriptionById },
    async (request, reply) => {
      const owner = await resolveOwner(prisma, request.user.id);
      return reply.send(await getSubscriptionById(prisma, owner, request.params.id));
    },
  );

  fastify.post(
    `${prefix}/subscriptions/:id/cancel`,
    { preHandler, schema: schemas.cancelSubscription },
    async (request, reply) => {
      const owner = await resolveOwner(prisma, request.user.id);
      const subscription = await cancelSubscription(prisma, owner, request.params.id, {
        reason: request.body?.reason ?? null,
      });
      return reply.send(subscription);
    },
  );
}

// Registers the trainer-only /trainer subscription routes.
export async function studentSubscriptionRoutes(fastify) {
  registerStudentSubscriptionRoutes(fastify, {
    prefix: '/trainer',
    preHandler: [authenticate, requireRole(Roles.TRAINER)],
    resolveOwner: resolveTrainerOwnerOrThrow,
    schemas: {
      assignPlan: assignPlanSchema,
      listSubscriptionsByStudent: listSubscriptionsByStudentSchema,
      getActiveSubscriptionByStudent: getActiveSubscriptionByStudentSchema,
      listSubscriptions: listSubscriptionsSchema,
      getSubscriptionById: getSubscriptionByIdSchema,
      cancelSubscription: cancelSubscriptionSchema,
    },
  });
}
