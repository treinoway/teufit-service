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
import config from '../../config/index.js';

export async function subscriptionPaymentRoutes(fastify) {
  fastify.post(
    '/trainer/subscriptions/:subscriptionId/payments',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: createPaymentSchema,
      config: { rateLimit: config.rateLimit.subscriptionPayment.create },
    },
    async (request, reply) => {
      const payment = await createPayment(
        prisma,
        request.user.id,
        request.params.subscriptionId,
        request.body ?? {},
      );
      return reply.status(201).send(payment);
    },
  );

  fastify.get(
    '/trainer/subscriptions/:subscriptionId/payments',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: listPaymentsBySubscriptionSchema,
      config: { rateLimit: config.rateLimit.subscriptionPayment.list },
    },
    async (request, reply) => {
      const payments = await listPaymentsBySubscription(
        prisma,
        request.user.id,
        request.params.subscriptionId,
      );
      return reply.send(payments);
    },
  );

  fastify.patch(
    '/trainer/payments/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: updatePaymentSchema,
      config: { rateLimit: config.rateLimit.subscriptionPayment.update },
    },
    async (request, reply) => {
      const payment = await updatePayment(
        prisma,
        request.user.id,
        request.params.id,
        request.body,
      );
      return reply.send(payment);
    },
  );

  fastify.post(
    '/trainer/payments/:id/mark-paid',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: markPaymentPaidSchema,
      config: { rateLimit: config.rateLimit.subscriptionPayment.markPaid },
    },
    async (request, reply) => {
      const payment = await markPaymentPaid(
        prisma,
        request.user.id,
        request.params.id,
        request.body ?? {},
      );
      return reply.send(payment);
    },
  );

  fastify.post(
    '/trainer/payments/:id/mark-pending',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: markPaymentPendingSchema,
      config: { rateLimit: config.rateLimit.subscriptionPayment.markPending },
    },
    async (request, reply) => {
      const payment = await markPaymentPending(prisma, request.user.id, request.params.id);
      return reply.send(payment);
    },
  );

  fastify.delete(
    '/trainer/payments/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: deletePaymentSchema,
      config: { rateLimit: config.rateLimit.subscriptionPayment.delete },
    },
    async (request, reply) => {
      await voidPayment(prisma, request.user.id, request.params.id);
      return reply.status(204).send();
    },
  );

  fastify.post(
    '/trainer/payments/:id/void',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: voidPaymentSchema,
      config: { rateLimit: config.rateLimit.subscriptionPayment.void },
    },
    async (request, reply) => {
      const payment = await voidPayment(prisma, request.user.id, request.params.id);
      return reply.send(payment);
    },
  );

  fastify.get(
    '/trainer/students/:studentId/payments',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: listPaymentsByStudentSchema,
      config: { rateLimit: config.rateLimit.subscriptionPayment.listByStudent },
    },
    async (request, reply) => {
      const history = await listPaymentsByStudent(
        prisma,
        request.user.id,
        request.params.studentId,
        new Date(),
        { resolveAvatarUrl: (stored) => s3BucketHandler.resolveUrl(stored) },
      );
      return reply.send(history);
    },
  );
}
