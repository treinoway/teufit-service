import { errorResponseSchema } from './error-response.schema.js';

export const rollbarTestSchema = {
  tags: ['Admin - Debug'],
  summary: 'TEMPORARY — always fails with 500 to verify error reporting (Rollbar/Sentry) — admin only',
  security: [{ bearerAuth: [] }],
  response: {
    401: errorResponseSchema,
    403: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};
