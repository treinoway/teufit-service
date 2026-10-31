const DEVICE_TOKEN_PATH_PATTERN = /(\/me\/devices\/)[^\s?#"']+/g;
const MAX_REDACTION_DEPTH = 12;
const REDACTED_PLACEHOLDER = '[redacted]';

/**
 * Masks secrets carried in a request URL (the FCM token in /me/devices/:token) before logging it.
 *
 * @param {string | undefined} url
 * @returns {string | undefined}
 */
export function redactSensitiveUrl(url) {
  if (typeof url !== 'string') return url;
  return url.replace(DEVICE_TOKEN_PATH_PATTERN, `$1${REDACTED_PLACEHOLDER}`);
}

/**
 * Fastify's default request log shape, with the url redacted.
 *
 * @param {import('fastify').FastifyRequest} request
 */
export function serializeRequestForLog(request) {
  return {
    method: request.method,
    url: redactSensitiveUrl(request.url),
    version: request.headers?.['accept-version'],
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

/**
 * Adds the redacting `req` serializer to the Fastify logger option; custom logger instances and `false` pass through.
 *
 * @param {boolean | object | undefined} logger
 * @returns {boolean | object}
 */
export function withRedactedRequestSerializer(logger) {
  if (logger === false) return false;
  if (logger && typeof logger.info === 'function') return logger;

  const baseOptions = logger && typeof logger === 'object' ? logger : {};
  return { ...baseOptions, serializers: { ...baseOptions.serializers, req: serializeRequestForLog } };
}

/**
 * Deep-copies a Sentry event/transaction masking the device token in every string (url, transaction name, spans, breadcrumbs).
 *
 * @template T
 * @param {T} value
 * @param {number} [depth]
 * @returns {T}
 */
export function redactSentryEvent(value, depth = 0) {
  if (typeof value === 'string') return redactSensitiveUrl(value);
  if (depth >= MAX_REDACTION_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactSentryEvent(item, depth + 1));

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactSentryEvent(item, depth + 1)]),
  );
}
