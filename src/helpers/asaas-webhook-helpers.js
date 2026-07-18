import { timingSafeEqual } from 'node:crypto';

const SECRET_REQUIRED_ENVIRONMENTS = new Set(['production', 'staging']);

/**
 * Boot-time guard: refuses to start the server when Asaas billing is actually wired
 * up (config.asaas.apiKey is set) in an internet-reachable environment
 * (production/staging) but ASAAS_WEBHOOK_SECRET is missing. Without the secret,
 * /webhooks/asaas fails open — an attacker can POST a forged PAYMENT_CONFIRMED event
 * and upgrade any trainer's tier for free (see parseTierFromExternalReference in
 * asaas-subscription-service.js).
 *
 * Gated on `apiKey`, not just `env`, and intentionally so:
 *
 *   - Asaas is not integrated in production/staging yet (no ASAAS_API_KEY set
 *     anywhere). A bare `env === production` gate would throw on every boot right
 *     now and block deploys for an integration that doesn't exist — this gate
 *     self-activates the day someone sets ASAAS_API_KEY in production/staging,
 *     with zero code changes needed then.
 *   - `apiKey` alone (regardless of env) was considered and rejected: this repo's
 *     own local `.env` already sets a real Asaas sandbox ASAAS_API_KEY (for manual
 *     testing of checkout flows) with no ASAAS_WEBHOOK_SECRET. Gating on apiKey
 *     alone would break `npm run dev` on every machine configured that way. Local
 *     dev boxes aren't reachable from the public internet by default, so an
 *     unprotected local webhook isn't the same class of risk as an unprotected
 *     production/staging one — the env check stays as a second, AND'd condition.
 *
 * @param {object} params
 * @param {string} params.env - resolved environment name (config.env)
 * @param {string|undefined} params.apiKey - config.asaas.apiKey
 * @param {string|undefined} params.webhookSecret - config.asaas.webhookSecret
 * @throws {Error} when Asaas is configured in production/staging but the webhook secret is missing
 */
export function assertAsaasWebhookSecretConfigured({ env, apiKey, webhookSecret }) {
  if (!apiKey) return;
  if (!SECRET_REQUIRED_ENVIRONMENTS.has(env)) return;
  if (webhookSecret) return;

  throw new Error(
    `Missing ASAAS_WEBHOOK_SECRET. ASAAS_API_KEY is configured in the "${env}" environment, ` +
      'which means Asaas will send real webhook requests to /webhooks/asaas — that route ' +
      'must be protected by a shared secret before it can safely go live. ' +
      'Set ASAAS_WEBHOOK_SECRET before starting the server.',
  );
}

/**
 * Timing-safe comparison of the incoming `asaas-access-token` header against the
 * configured webhook secret. Uses crypto.timingSafeEqual instead of `!==` to avoid
 * leaking information about the secret via response-time side channels.
 *
 * Never throws — returns false for a missing/non-string/empty incomingToken OR
 * expectedSecret, and for length mismatches (crypto.timingSafeEqual itself throws
 * on unequal-length buffers, so both inputs are type/length-checked first). The
 * expectedSecret guard matters even though the only current caller already checks
 * `config.asaas.webhookSecret` truthiness before calling this — a security primitive
 * should not depend on the caller getting that order right.
 *
 * @param {unknown} incomingToken - request.headers['asaas-access-token']
 * @param {unknown} expectedSecret - config.asaas.webhookSecret
 * @returns {boolean}
 */
export function isValidAsaasWebhookToken(incomingToken, expectedSecret) {
  if (typeof incomingToken !== 'string' || incomingToken.length === 0) return false;
  if (typeof expectedSecret !== 'string' || expectedSecret.length === 0) return false;

  const incomingBuffer = Buffer.from(incomingToken);
  const expectedBuffer = Buffer.from(expectedSecret);

  if (incomingBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(incomingBuffer, expectedBuffer);
}
