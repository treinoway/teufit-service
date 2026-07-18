/**
 * Asaas Webhook Route
 *
 * POST /webhooks/asaas — no user auth.
 *
 * Auth: validates the `asaas-access-token` header against config.asaas.webhookSecret
 * using a timing-safe comparison. Asaas sends the literal webhook secret in this
 * header (no HMAC — per Asaas docs).
 *
 * Fail-closed: if config.asaas.webhookSecret is not configured, the route rejects
 * with 401 instead of skipping validation. In production/staging this should never
 * happen — buildServer() refuses to boot without the secret (see
 * assertAsaasWebhookSecretConfigured in api/server.js). This check is defense in
 * depth in case that guard is ever bypassed or misconfigured.
 *
 * Error handling: always returns 200 on internal errors (after logging) to prevent
 * Asaas retry storms. Only structurally invalid bodies or failed secret validation
 * return 4xx.
 */

import { prisma } from '../../src/db.js';
import { handleWebhookEvent } from '../../src/services/asaas-webhook-service.js';
import { webhookSchema } from '../schemas/asaas-webhook-route.schema.js';
import config from '../../config/index.js';
import { isValidAsaasWebhookToken } from '../../src/helpers/asaas-webhook-helpers.js';
import { ASAAS_WEBHOOK_ERRORS } from '../../src/constants/platform-plan.js';

const ASAAS_TOKEN_HEADER = 'asaas-access-token';

function unauthorizedWebhookResponse(reply) {
  const { code, messageCode, status } = ASAAS_WEBHOOK_ERRORS.INVALID_SECRET;
  return reply.status(status).send({
    error: code,
    messageCode,
    message: 'Invalid webhook secret.',
  });
}

export async function asaasWebhookRoutes(fastify) {
  fastify.post(
    '/webhooks/asaas',
    {
      schema: webhookSchema,
    },
    async (request, reply) => {
      const incomingToken = request.headers[ASAAS_TOKEN_HEADER];

      if (!config.asaas.webhookSecret) {
        request.log.error(
          { header: ASAAS_TOKEN_HEADER },
          '[asaas-webhook] ASAAS_WEBHOOK_SECRET is not configured — rejecting webhook request',
        );
        return unauthorizedWebhookResponse(reply);
      }

      if (!isValidAsaasWebhookToken(incomingToken, config.asaas.webhookSecret)) {
        request.log.warn(
          { header: ASAAS_TOKEN_HEADER },
          '[asaas-webhook] Invalid or missing webhook secret',
        );
        return unauthorizedWebhookResponse(reply);
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
