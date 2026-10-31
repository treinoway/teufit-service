import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';
import {
  DEVICE_APP_ID_MAX_LENGTH,
  DEVICE_TOKEN_MAX_LENGTH,
  mobilePlatformValues,
} from '../../src/constants/mobile-app.js';

const authorizationHeaders = {
  type: 'object',
  required: ['authorization'],
  properties: {
    authorization: {
      type: 'string',
      description: 'Bearer access token (e.g., "Bearer <token>")',
    },
  },
};

export const registerDeviceSchema = {
  tags: ['devices'],
  summary: 'Register a push device token',
  description:
    'Upserts the FCM token of this app installation, keyed by token. A token already registered by another user moves to the authenticated user.',
  security: [{ bearerAuth: [] }],
  headers: authorizationHeaders,
  body: {
    type: 'object',
    required: ['token', 'platform', 'appId'],
    properties: {
      token: { type: 'string', minLength: 1, maxLength: DEVICE_TOKEN_MAX_LENGTH },
      platform: { type: 'string', enum: mobilePlatformValues },
      appId: { type: 'string', minLength: 1, maxLength: DEVICE_APP_ID_MAX_LENGTH },
    },
  },
  response: {
    200: {
      type: 'object',
      required: ['token', 'platform', 'appId'],
      properties: {
        token: { type: 'string' },
        platform: { type: 'string', enum: mobilePlatformValues },
        appId: { type: 'string' },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
  },
};

export const removeDeviceSchema = {
  tags: ['devices'],
  summary: 'Remove a push device token',
  description:
    'Removes the token only when it belongs to the authenticated user. Answers 204 even when the token is unknown. The token must be URL-encoded.',
  security: [{ bearerAuth: [] }],
  headers: authorizationHeaders,
  params: {
    type: 'object',
    required: ['token'],
    properties: {
      token: { type: 'string', minLength: 1, maxLength: DEVICE_TOKEN_MAX_LENGTH },
    },
  },
  response: {
    204: { type: 'null', description: 'Token removed or not registered. No content returned.' },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
  },
};
