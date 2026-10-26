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
import {
  assignPlanSchema,
  listSubscriptionsByStudentSchema,
  getActiveSubscriptionByStudentSchema,
  listSubscriptionsSchema,
  getSubscriptionByIdSchema,
  cancelSubscriptionSchema,
} from '../schemas/student-subscription-route.schema.js';

export async function studentSubscriptionRoutes(fastify) {
  fastify.post(
    '/trainer/students/:studentId/subscriptions',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: assignPlanSchema,
    },
    async (request, reply) => {
      const result = await assignPlanToStudent(
        prisma,
        request.user.id,
        request.params.studentId,
        request.body,
      );
      return reply.status(201).send(result);
    },
  );

  fastify.get(
    '/trainer/students/:studentId/subscriptions',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: listSubscriptionsByStudentSchema,
    },
    async (request, reply) => {
      const subscriptions = await listSubscriptionsByStudent(
        prisma,
        request.user.id,
        request.params.studentId,
      );
      return reply.send(subscriptions);
    },
  );

  fastify.get(
    '/trainer/students/:studentId/subscriptions/active',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: getActiveSubscriptionByStudentSchema,
    },
    async (request, reply) => {
      const subscription = await getActiveSubscriptionByStudent(
        prisma,
        request.user.id,
        request.params.studentId,
      );
      return reply.send(subscription);
    },
  );

  fastify.get(
    '/trainer/subscriptions',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: listSubscriptionsSchema,
    },
    async (request, reply) => {
      const subscriptions = await listSubscriptions(prisma, request.user.id, {
        status: request.query.status ?? null,
        planId: request.query.planId ?? null,
      });
      return reply.send(subscriptions);
    },
  );

  fastify.get(
    '/trainer/subscriptions/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: getSubscriptionByIdSchema,
    },
    async (request, reply) => {
      const subscription = await getSubscriptionById(
        prisma,
        request.user.id,
        request.params.id,
      );
      return reply.send(subscription);
    },
  );

  fastify.post(
    '/trainer/subscriptions/:id/cancel',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: cancelSubscriptionSchema,
    },
    async (request, reply) => {
      const subscription = await cancelSubscription(
        prisma,
        request.user.id,
        request.params.id,
        { reason: request.body?.reason ?? null },
      );
      return reply.send(subscription);
    },
  );
}
