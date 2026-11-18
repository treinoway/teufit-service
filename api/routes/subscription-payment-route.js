import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { prisma } from '../../src/db.js';
import {
  createPayment,
  listPaymentsBySubscription,
  markPaymentPaid,
  markPaymentPending,
  updatePayment,
  voidPayment,
  listPaymentsByStudent,
} from '../../src/services/subscription-payment-service.js';
import { resolveTrainerOwnerOrThrow } from '../../src/services/professional-owner-service.js';
import {
  createPaymentSchema,
  listPaymentsBySubscriptionSchema,
  updatePaymentSchema,
  markPaymentPaidSchema,
  markPaymentPendingSchema,
  deletePaymentSchema,
  voidPaymentSchema,
  listPaymentsByStudentSchema,
} from '../schemas/subscription-payment-route.schema.js';
import s3BucketHandler from '../../src/config/s3-bucket-handler.js';

/**
 * Registers the subscription-payment routes under a prefix for one kind of owner.
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {{ prefix: string, preHandler: Function[], resolveOwner: Function, schemas: object }} config
 */
export function registerSubscriptionPaymentRoutes(fastify, { prefix, preHandler, resolveOwner, schemas }) {
  fastify.post(
    `${prefix}/subscriptions/:subscriptionId/payments`,
    { preHandler, schema: schemas.createPayment },
    async (request, reply) => {
      const owner = await resolveOwner(prisma, request.user.id);
      const payment = await createPayment(prisma, owner, request.params.subscriptionId, request.body ?? {});
      return reply.status(201).send(payment);
    },
  );

  fastify.get(
    `${prefix}/subscriptions/:subscriptionId/payments`,
    { preHandler, schema: schemas.listPaymentsBySubscription },
    async (request, reply) => {
      const owner = await resolveOwner(prisma, request.user.id);
      return reply.send(await listPaymentsBySubscription(prisma, owner, request.params.subscriptionId));
    },
  );

  fastify.patch(
    `${prefix}/payments/:id`,
    { preHandler, schema: schemas.updatePayment },
    async (request, reply) => {
      const owner = await resolveOwner(prisma, request.user.id);
      return reply.send(await updatePayment(prisma, owner, request.params.id, request.body));
    },
  );

  fastify.post(
    `${prefix}/payments/:id/mark-paid`,
    { preHandler, schema: schemas.markPaymentPaid },
    async (request, reply) => {
      const owner = await resolveOwner(prisma, request.user.id);
      return reply.send(await markPaymentPaid(prisma, owner, request.params.id, request.body ?? {}));
    },
  );

  fastify.post(
    `${prefix}/payments/:id/mark-pending`,
    { preHandler, schema: schemas.markPaymentPending },
    async (request, reply) => {
      const owner = await resolveOwner(prisma, request.user.id);
      return reply.send(await markPaymentPending(prisma, owner, request.params.id));
    },
  );

  fastify.delete(
    `${prefix}/payments/:id`,
    { preHandler, schema: schemas.deletePayment },
    async (request, reply) => {
      const owner = await resolveOwner(prisma, request.user.id);
      await voidPayment(prisma, owner, request.params.id);
      return reply.status(204).send();
    },
  );

  fastify.post(
    `${prefix}/payments/:id/void`,
    { preHandler, schema: schemas.voidPayment },
    async (request, reply) => {
      const owner = await resolveOwner(prisma, request.user.id);
      return reply.send(await voidPayment(prisma, owner, request.params.id));
    },
  );

  fastify.get(
    `${prefix}/students/:studentId/payments`,
    { preHandler, schema: schemas.listPaymentsByStudent },
    async (request, reply) => {
      const owner = await resolveOwner(prisma, request.user.id);
      const history = await listPaymentsByStudent(prisma, owner, request.params.studentId, new Date(), {
        resolveAvatarUrl: (stored) => s3BucketHandler.resolveUrl(stored),
      });
      return reply.send(history);
    },
  );
}

// Registers the trainer-only /trainer payment routes.
export async function subscriptionPaymentRoutes(fastify) {
  registerSubscriptionPaymentRoutes(fastify, {
    prefix: '/trainer',
    preHandler: [authenticate, requireRole(Roles.TRAINER)],
    resolveOwner: resolveTrainerOwnerOrThrow,
    schemas: {
      createPayment: createPaymentSchema,
      listPaymentsBySubscription: listPaymentsBySubscriptionSchema,
      updatePayment: updatePaymentSchema,
      markPaymentPaid: markPaymentPaidSchema,
      markPaymentPending: markPaymentPendingSchema,
      deletePayment: deletePaymentSchema,
      voidPayment: voidPaymentSchema,
      listPaymentsByStudent: listPaymentsByStudentSchema,
    },
  });
}
