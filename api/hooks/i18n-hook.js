import { resolveLanguage, applyLabels } from '../../src/i18n/index.js';
import { LANGUAGE_HEADER } from '../../src/i18n/constants.js';

/**
 * onRequest hook — reads the `app-language` header and decorates
 * `request.language` with the resolved locale tag.
 * Must be registered BEFORE auth so all downstream hooks and handlers
 * can read `request.language`.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @param {Function} done
 */
export function languageOnRequestHook(request, reply, done) {
  request.language = resolveLanguage(request.headers[LANGUAGE_HEADER]);
  done();
}

/**
 * preSerialization hook — applies translated `*Label` siblings to the
 * response payload for routes that use `i18nField()` / `i18nArrayField()`
 * in their response schemas.
 *
 * Must be registered AFTER the existing error-normalizing preSerialization hook
 * since this hook early-returns for status >= 400 (errors are owned by the
 * error handler path).
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @param {unknown} payload
 * @param {Function} done
 */
export function applyLabelsPreSerializationHook(request, reply, payload, done) {
  // Error responses are handled by the error handler + its own preSerialization hook
  if (reply.statusCode >= 400) {
    done(null, payload);
    return;
  }

  if (payload == null) {
    done(null, payload);
    return;
  }

  const routeSchema = request.routeOptions?.schema?.response;
  if (!routeSchema) {
    done(null, payload);
    return;
  }

  // Resolve schema for the current status code with fallbacks
  const schema =
    routeSchema[reply.statusCode] ??
    routeSchema['2xx'] ??
    routeSchema['default'];

  if (!schema) {
    done(null, payload);
    return;
  }

  applyLabels(payload, schema, request.language);
  done(null, payload);
}
