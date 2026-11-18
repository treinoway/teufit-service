import { foodSourceValues, FOOD_SEARCH_LIMIT_DEFAULT, FOOD_SEARCH_LIMIT_MAX } from '../../src/constants/nutrition.js';
import {
  badRequestErrorResponseSchema,
  errorResponseSchema,
  uuidParam,
  foodSchema,
  per100gInputSchema,
  portionInputSchema,
} from './nutrition-shared.schema.js';

const MAX_FOOD_NAME_LENGTH = 255;
const foodNameSchema = { type: 'string', minLength: 1, maxLength: MAX_FOOD_NAME_LENGTH };
const security = [{ bearerAuth: [] }];

export const searchFoodsSchema = {
  tags: ['Foods'],
  summary: 'Search foods (TACO and the caller own custom foods; TBCA is currently hidden), accent/case-insensitive',
  security,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      q: { type: 'string', maxLength: MAX_FOOD_NAME_LENGTH },
      groupId: { type: 'string', format: 'uuid' },
      sources: {
        type: 'string',
        description: `Comma separated: ${foodSourceValues.join(',')}. Defaults to all; custom returns only the caller's own foods; tbca is accepted but currently hidden (returns no foods).`,
      },
      limit: { type: 'integer', minimum: 1, maximum: FOOD_SEARCH_LIMIT_MAX, default: FOOD_SEARCH_LIMIT_DEFAULT },
    },
  },
  response: {
    200: { type: 'object', properties: { items: { type: 'array', items: foodSchema } } },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getFoodByIdSchema = {
  tags: ['Foods'],
  summary: 'Get a food by id',
  security,
  params: uuidParam('id'),
  response: { 200: foodSchema, 400: badRequestErrorResponseSchema, 401: errorResponseSchema, 404: errorResponseSchema, 500: errorResponseSchema },
};

export const listFoodGroupsSchema = {
  tags: ['Foods'],
  summary: 'List food groups',
  security,
  response: {
    200: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, code: { type: 'string', nullable: true } },
          },
        },
      },
    },
    401: errorResponseSchema,
    500: errorResponseSchema,
  },
};

const customFoodResponses = {
  400: badRequestErrorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  500: errorResponseSchema,
};

export const createCustomFoodSchema = {
  tags: ['Nutritionist - Foods'],
  summary: 'Create a custom food ("Meus alimentos")',
  security,
  body: {
    type: 'object',
    required: ['name', 'groupId', 'portion', 'per100g'],
    additionalProperties: false,
    properties: {
      name: foodNameSchema,
      groupId: { type: 'string', format: 'uuid' },
      portion: portionInputSchema,
      per100g: per100gInputSchema,
    },
  },
  response: { 201: foodSchema, ...customFoodResponses },
};

export const updateCustomFoodSchema = {
  tags: ['Nutritionist - Foods'],
  summary: 'Update an owned custom food (partial)',
  security,
  params: uuidParam('id'),
  body: {
    type: 'object',
    minProperties: 1,
    additionalProperties: false,
    properties: {
      name: foodNameSchema,
      groupId: { type: 'string', format: 'uuid' },
      portion: portionInputSchema,
      per100g: per100gInputSchema,
    },
  },
  response: { 200: foodSchema, ...customFoodResponses },
};

export const deleteCustomFoodSchema = {
  tags: ['Nutritionist - Foods'],
  summary: 'Delete an owned custom food',
  security,
  params: uuidParam('id'),
  response: { 204: { type: 'null' }, ...customFoodResponses },
};
