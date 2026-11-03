import { errorResponseSchema, badRequestErrorResponseSchema } from './error-response.schema.js';
import { SIGNED_FILE_ANNOTATION } from '../../src/helpers/signed-file-walker.js';
import {
  EXERCISE_VIDEO_KEY_MAX_LENGTH,
  EXERCISE_VIDEO_KEY_SHAPE_PATTERN,
  VIDEO_FILE_URL_FIELD,
  EXERCISE_VIDEO_MAX_BYTES,
  EXERCISE_VIDEO_MIME_TO_EXTENSION,
  EXERCISE_VIDEO_UPLOAD_METHOD,
} from '../../src/constants/exercise-video.js';

// why: Fastify coerces numbers/booleans to strings, so a key-shaped pattern keeps `123` a validation error;
// ownership of the key is checked in the services.
export const videoFileKeyRequestSchema = {
  type: ['string', 'null'],
  maxLength: EXERCISE_VIDEO_KEY_MAX_LENGTH,
  pattern: EXERCISE_VIDEO_KEY_SHAPE_PATTERN,
};

// Response properties for an uploaded exercise video; videoFileUrl is filled by the signed-file hook.
export const videoFileResponseProperties = {
  videoFileKey: { type: ['string', 'null'], [SIGNED_FILE_ANNOTATION]: VIDEO_FILE_URL_FIELD },
  videoFileUrl: { type: ['string', 'null'] },
};

export const exerciseVideoUploadUrlSchema = {
  tags: ['Exercise Videos'],
  summary: 'Get a presigned PUT URL to upload an exercise video directly to storage',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['contentType', 'sizeBytes'],
    properties: {
      contentType: { type: 'string', enum: Object.keys(EXERCISE_VIDEO_MIME_TO_EXTENSION) },
      sizeBytes: { type: 'integer', minimum: 1, maximum: EXERCISE_VIDEO_MAX_BYTES },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      required: ['key', 'uploadUrl', 'method', 'headers', 'expiresAt'],
      properties: {
        key: { type: 'string' },
        uploadUrl: { type: 'string' },
        method: { type: 'string', enum: [EXERCISE_VIDEO_UPLOAD_METHOD] },
        headers: {
          type: 'object',
          properties: { 'Content-Type': { type: 'string' } },
          additionalProperties: false,
        },
        expiresAt: { type: 'string', format: 'date-time' },
      },
      additionalProperties: false,
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    409: errorResponseSchema,
  },
};
