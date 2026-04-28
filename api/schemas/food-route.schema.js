import { errorResponseSchema } from './error-response.schema.js';

const foodGroupSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    code: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const foodSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    foodGroupId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    tacoId: { type: 'string', nullable: true },
    tbcaId: { type: 'string', nullable: true },
    source: { type: 'string' },
    servingSizeG: { type: 'number', nullable: true },
    servingSizeDescription: { type: 'string', nullable: true },
    ediblePortionPercent: { type: 'number', nullable: true },
    energyKcal: { type: 'number', nullable: true },
    energyKj: { type: 'number', nullable: true },
    proteinG: { type: 'number', nullable: true },
    totalFatG: { type: 'number', nullable: true },
    carbohydratesG: { type: 'number', nullable: true },
    fiberG: { type: 'number', nullable: true },
    ashG: { type: 'number', nullable: true },
    saturatedFatG: { type: 'number', nullable: true },
    monounsaturatedFatG: { type: 'number', nullable: true },
    polyunsaturatedFatG: { type: 'number', nullable: true },
    transFatG: { type: 'number', nullable: true },
    cholesterolMg: { type: 'number', nullable: true },
    calciumMg: { type: 'number', nullable: true },
    phosphorusMg: { type: 'number', nullable: true },
    ironMg: { type: 'number', nullable: true },
    sodiumMg: { type: 'number', nullable: true },
    potassiumMg: { type: 'number', nullable: true },
    copperMg: { type: 'number', nullable: true },
    magnesiumMg: { type: 'number', nullable: true },
    manganeseMg: { type: 'number', nullable: true },
    zincMg: { type: 'number', nullable: true },
    seleniumUg: { type: 'number', nullable: true },
    vitaminAUgRae: { type: 'number', nullable: true },
    vitaminDUg: { type: 'number', nullable: true },
    vitaminEMg: { type: 'number', nullable: true },
    vitaminKUg: { type: 'number', nullable: true },
    thiamineMg: { type: 'number', nullable: true },
    riboflavinMg: { type: 'number', nullable: true },
    niacinMg: { type: 'number', nullable: true },
    vitaminB6Mg: { type: 'number', nullable: true },
    folateUg: { type: 'number', nullable: true },
    vitaminB12Ug: { type: 'number', nullable: true },
    vitaminCMg: { type: 'number', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    foodGroup: foodGroupSchema,
  },
};

export const searchFoodsSchema = {
  tags: ['Foods'],
  summary: 'Search foods by name',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'Search query (partial match on name)' },
      groupId: { type: 'string', format: 'uuid', description: 'Filter by food group ID' },
      source: { type: 'string', enum: ['taco', 'tbca'], default: 'taco', description: 'Food database source (default: taco)' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        items: { type: 'array', items: foodSchema },
        total: { type: 'integer' },
      },
    },
    401: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getFoodByIdSchema = {
  tags: ['Foods'],
  summary: 'Get food by ID',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: foodSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const listFoodGroupsSchema = {
  tags: ['Foods'],
  summary: 'List all food groups',
  security: [{ bearerAuth: [] }],
  response: {
    200: {
      type: 'array',
      items: foodGroupSchema,
    },
    401: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};
