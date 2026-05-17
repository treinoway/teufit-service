/**
 * Asaas Webhook Route
 *
 * POST /webhooks/asaas — no user auth.
 *
 * Auth: validates the `asaas-access-token` header against config.asaas.webhookSecret.
 * Asaas sends the literal webhook secret in this header (no HMAC — per Asaas docs).
 *
 * Error handling: always returns 200 on internal errors (after logging) to prevent
 * Asaas retry storms. Only structurally invalid bodies or failed secret validation
 * return 4xx.
 */

import { prisma } from '../../src/db.js';
import { handleWebhookEvent } from '../../src/services/asaas-webhook-service.js';
import { webhookSchema } from '../schemas/asaas-webhook-route.schema.js';
import config from '../../config/index.js';

const ASAAS_TOKEN_HEADER = 'asaas-access-token';

export async function asaasWebhookRoutes(fastify) {
  fastify.post(
    '/webhooks/asaas',
    {
      schema: webhookSchema,
    },
    async (request, reply) => {
      const incomingToken = request.headers[ASAAS_TOKEN_HEADER];

      // Validate webhook secret if configured
      if (config.asaas.webhookSecret) {
        if (incomingToken !== config.asaas.webhookSecret) {
          request.log.warn(
            { header: ASAAS_TOKEN_HEADER },
            '[asaas-webhook] Invalid or missing webhook secret',
          );
          return reply.status(401).send({
            error: 'UNAUTHORIZED',
            messageCode: 'auth.unauthorized',
            message: 'Invalid webhook secret.',
          });
        }
      }

      try {
        await handleWebhookEvent(prisma, request.body, request.log);
      } catch (error) {
        // Log but always ACK to Asaas to prevent retry storms
        request.log.error(
          { err: error, event: request.body?.event },
          '[asaas-webhook] Error processing event',
        );
      }

      return reply.send({ received: true });
    },
  );
}
