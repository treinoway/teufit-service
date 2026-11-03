import { applySignedFileUrls } from '../../src/helpers/signed-file-walker.js';

// Picks the response schema registered for the current status code, with 2xx/default fallbacks.
function pickResponseSchema(request, reply) {
  const responseSchemas = request.routeOptions?.schema?.response;
  if (!responseSchemas) return null;
  return responseSchemas[reply.statusCode] ?? responseSchemas['2xx'] ?? responseSchemas.default ?? null;
}

/**
 * Builds a preSerialization hook that fills signed-URL siblings of schema fields annotated with `x-signed-file-url`.
 * @param {(key: string|null) => Promise<string|null>} resolveUrl - Maps a stored key to a URL
 * @returns {import('fastify').preSerializationAsyncHookHandler}
 */
export function createSignedFileHook(resolveUrl) {
  return async function signedFilePreSerializationHook(request, reply, payload) {
    if (reply.statusCode >= 400 || payload == null || typeof payload !== 'object') return payload;
    const schema = pickResponseSchema(request, reply);
    if (schema) await applySignedFileUrls(payload, schema, resolveUrl);
    return payload;
  };
}
