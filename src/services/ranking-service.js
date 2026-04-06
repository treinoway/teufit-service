/**
 * ranking-service.js
 *
 * The global trainer ranking has been removed in favour of challenge-scoped rankings.
 * Challenge rankings live in challenge-ranking-service.js.
 *
 * This file is intentionally empty — it is kept to preserve import paths that
 * may still reference it during the transition. Route handlers now return 410 Gone
 * for the deprecated global ranking endpoints.
 */
