/**
 * Rate-limit key generator for authenticated routes: keys by user id so rotating
 * IPs does not bypass the limit. Requires the route's `authenticate` hook to run
 * before the rate-limit hook (route-level `onRequest: [authenticate]` does, since
 * @fastify/rate-limit appends its handler after existing route hooks). Falls back
 * to the IP when no user is present.
 *
 * @param {string} namespace - Prefix that keeps each route's counter separate.
 * @returns {(request: { user?: { id?: string }, ip: string }) => string}
 */
export function userRateLimitKey(namespace) {
  return (request) => `${namespace}:${request.user?.id ?? request.ip}`;
}
