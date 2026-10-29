import {
  errorResponseSchema,
  badRequestErrorResponseSchema,
} from './error-response.schema.js';
import {
  TutorialVideoSource,
  TUTORIAL_TITLE_MAX,
  TUTORIAL_DESCRIPTION_MAX,
} from '../../src/constants/tutorial.js';

const videoSourceValues = Object.values(TutorialVideoSource);

const tutorialProperties = {
  id: { type: 'string', format: 'uuid' },
  title: { type: 'string' },
  description: { type: 'string', nullable: true },
  videoSource: { type: 'string', enum: videoSourceValues },
  videoUrl: { type: 'string', nullable: true },
  order: { type: 'integer' },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
};

const tutorialRequired = ['id', 'title', 'videoSource', 'videoUrl', 'order', 'createdAt', 'updatedAt'];

export const trainerTutorialSchema = {
  type: 'object',
  required: tutorialRequired,
  properties: tutorialProperties,
  additionalProperties: false,
};

export const adminTutorialSchema = {
  type: 'object',
  required: [...tutorialRequired, 'videoKey'],
  properties: { ...tutorialProperties, videoKey: { type: 'string', nullable: true } },
  additionalProperties: false,
};

export const adminTutorialListSchema = {
  type: 'object',
  required: ['items'],
  properties: { items: { type: 'array', items: adminTutorialSchema } },
  additionalProperties: false,
};

const tutorialBodyBase = {
  title: { type: 'string', maxLength: TUTORIAL_TITLE_MAX },
  description: { type: 'string', maxLength: TUTORIAL_DESCRIPTION_MAX, nullable: true },
  videoSource: { type: 'string', enum: videoSourceValues },
  videoUrl: { type: 'string', nullable: true },
  videoKey: { type: 'string', nullable: true },
};

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
};

const adminErrors = {
  401: errorResponseSchema,
  403: errorResponseSchema,
  429: errorResponseSchema,
  500: errorResponseSchema,
};

export const listTutorialsAdminSchema = {
  tags: ['Tutorials - Admin'],
  summary: 'List all tutorials ordered (admin, includes videoKey)',
  security: [{ bearerAuth: [] }],
  response: { 200: adminTutorialListSchema, ...adminErrors },
};

export const getTutorialAdminSchema = {
  tags: ['Tutorials - Admin'],
  summary: 'Get a tutorial by id (admin)',
  security: [{ bearerAuth: [] }],
  params: idParams,
  response: { 200: adminTutorialSchema, 404: errorResponseSchema, ...adminErrors },
};

export const createTutorialSchema = {
  tags: ['Tutorials - Admin'],
  summary: 'Create a tutorial (link or previously uploaded video)',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['title', 'videoSource'],
    properties: tutorialBodyBase,
    additionalProperties: false,
  },
  response: { 201: adminTutorialSchema, 400: badRequestErrorResponseSchema, ...adminErrors },
};

export const updateTutorialSchema = {
  tags: ['Tutorials - Admin'],
  summary: 'Update a tutorial; send videoSource with videoUrl/videoKey to change the video',
  security: [{ bearerAuth: [] }],
  params: idParams,
  body: {
    type: 'object',
    properties: tutorialBodyBase,
    additionalProperties: false,
    minProperties: 1,
  },
  response: {
    200: adminTutorialSchema,
    400: badRequestErrorResponseSchema,
    404: errorResponseSchema,
    ...adminErrors,
  },
};

export const deleteTutorialSchema = {
  tags: ['Tutorials - Admin'],
  summary: 'Delete a tutorial and its uploaded file',
  security: [{ bearerAuth: [] }],
  params: idParams,
  response: { 204: { type: 'null' }, 404: errorResponseSchema, ...adminErrors },
};

export const reorderTutorialsSchema = {
  tags: ['Tutorials - Admin'],
  summary: 'Reorder tutorials; orderedIds must list every tutorial id exactly once',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['orderedIds'],
    properties: { orderedIds: { type: 'array', items: { type: 'string' } } },
    additionalProperties: false,
  },
  response: { 200: adminTutorialListSchema, 400: badRequestErrorResponseSchema, ...adminErrors },
};

export const createUploadUrlSchema = {
  tags: ['Tutorials - Admin'],
  summary: 'Get a presigned PUT URL to upload a tutorial video directly to storage',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['contentType', 'fileSize'],
    properties: {
      contentType: { type: 'string' },
      fileSize: { type: 'integer' },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      required: ['uploadUrl', 'videoKey', 'expiresIn'],
      properties: {
        uploadUrl: { type: 'string' },
        videoKey: { type: 'string' },
        expiresIn: { type: 'integer' },
      },
      additionalProperties: false,
    },
    400: badRequestErrorResponseSchema,
    ...adminErrors,
  },
};

export const listTutorialsSchema = {
  tags: ['Tutorials'],
  summary: 'List tutorials ordered, with playable video URLs (trainer/admin)',
  security: [{ bearerAuth: [] }],
  response: {
    200: {
      type: 'object',
      required: ['items'],
      properties: { items: { type: 'array', items: trainerTutorialSchema } },
      additionalProperties: false,
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};
