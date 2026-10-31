import { badRequestErrorResponseSchema } from './error-response.schema.js';
import {
  APP_VERSION_FIELD_MAX_LENGTH,
  mobilePlatformValues,
} from '../../src/constants/mobile-app.js';

export const getAppMinVersionSchema = {
  tags: ['App'],
  summary: 'Minimum supported app version',
  description:
    'Public. Returns the minimum version and store url configured for the app/platform. An unknown app answers 200 with null minVersion and storeUrl, so clients never block on missing configuration.',
  querystring: {
    type: 'object',
    required: ['appId', 'platform'],
    properties: {
      appId: { type: 'string', minLength: 1, maxLength: APP_VERSION_FIELD_MAX_LENGTH },
      platform: { type: 'string', enum: mobilePlatformValues },
    },
  },
  response: {
    200: {
      type: 'object',
      required: ['appId', 'platform', 'minVersion', 'storeUrl'],
      properties: {
        appId: { type: 'string' },
        platform: { type: 'string', enum: mobilePlatformValues },
        minVersion: { type: 'string', nullable: true },
        storeUrl: { type: 'string', nullable: true },
      },
    },
    400: badRequestErrorResponseSchema,
  },
};
