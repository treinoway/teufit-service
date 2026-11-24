const SINGLE_ORIGIN_ENV_KEYS = ['FRONTEND_URL', 'FRONTEND_REDIRECT_URL', 'BACKEND_URL'];
const EXTRA_ORIGINS_ENV_KEY = 'CORS_EXTRA_ORIGINS';
const EXTRA_ORIGINS_SEPARATOR = ',';

// Trims an origin and strips its trailing slash; returns '' for missing values.
export function normalizeOrigin(origin) {
  return (origin ?? '').trim().replace(/\/$/, '');
}

// Builds the deduplicated, ordered CORS allowlist from env: single-valued URLs first, then CORS_EXTRA_ORIGINS.
export function buildAllowedOrigins(env) {
  const extraOrigins = (env[EXTRA_ORIGINS_ENV_KEY] ?? '').split(EXTRA_ORIGINS_SEPARATOR);
  const candidateOrigins = [...SINGLE_ORIGIN_ENV_KEYS.map((key) => env[key]), ...extraOrigins];
  const normalizedOrigins = candidateOrigins.map(normalizeOrigin).filter(Boolean);
  return [...new Set(normalizedOrigins)];
}
