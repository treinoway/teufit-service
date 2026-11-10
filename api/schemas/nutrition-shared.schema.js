import {
  BmrFormula,
  Objective,
  ACTIVITY_FACTORS,
  PlanStatus,
  foodSourceValues,
  SwapBasis,
  GoalStatus,
  QuantityUnit,
  MealStatus,
  Sex,
  FREE_MEAL_TEXT_MAX,
  OBSERVATIONS_MAX,
  PATIENT_MESSAGE_MAX,
  FREE_MEALS_PER_WEEK_MAX,
  MAX_MACRO_PER_100G,
  MAX_KCAL_PER_100G,
} from '../../src/constants/nutrition.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';

export const TIME_PATTERN = '^([01]\\d|2[0-3]):[0-5]\\d$';
const MAX_NAME_LENGTH = 255;
const MAX_SHORT_TEXT_LENGTH = 100;
const MAX_TIP_LENGTH = 500;
const MAX_SUPPLEMENTS = 30;
const MAX_PORTION_GRAMS = 10000;

export { badRequestErrorResponseSchema, errorResponseSchema };

// Params schema with one uuid path parameter.
export const uuidParam = (name) => ({
  type: 'object',
  required: [name],
  properties: { [name]: { type: 'string', format: 'uuid' } },
});

export const nullableString = { type: 'string', nullable: true };
export const nullableNumber = { type: 'number', nullable: true };
const isoDateTime = { type: 'string', format: 'date-time' };
const nullableDateTime = { type: 'string', format: 'date-time', nullable: true };

export const nutrientsSchema = {
  type: 'object',
  properties: {
    kcal: { type: 'number' },
    protein: { type: 'number' },
    carbs: { type: 'number' },
    fat: { type: 'number' },
    fiber: { type: 'number' },
  },
};

export const per100gInputSchema = {
  type: 'object',
  required: ['kcal', 'protein', 'carbs', 'fat', 'fiber'],
  additionalProperties: false,
  properties: Object.fromEntries(
    ['kcal', 'protein', 'carbs', 'fat', 'fiber'].map((key) => [
      key,
      { type: 'number', minimum: 0, maximum: key === 'kcal' ? MAX_KCAL_PER_100G : MAX_MACRO_PER_100G },
    ]),
  ),
};

export const portionInputSchema = {
  type: 'object',
  required: ['label', 'grams'],
  additionalProperties: false,
  properties: {
    label: { type: 'string', minLength: 1, maxLength: MAX_SHORT_TEXT_LENGTH },
    grams: { type: 'number', exclusiveMinimum: 0, maximum: MAX_PORTION_GRAMS },
  },
};

export const foodSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    source: { type: 'string', enum: foodSourceValues },
    groupId: { type: 'string', format: 'uuid' },
    groupName: nullableString,
    portion: {
      type: 'object',
      nullable: true,
      properties: { label: { type: 'string' }, grams: { type: 'number' } },
    },
    per100g: nutrientsSchema,
  },
};

// Nullable string enum property.
const statusEnum = (values) => ({ type: 'string', enum: values, nullable: true });

export const patientRowSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    firstName: nullableString,
    lastName: nullableString,
    email: { type: 'string' },
    avatarUrl: nullableString,
    age: { type: 'integer', nullable: true },
    weightKg: nullableNumber,
    objective: statusEnum(Object.values(Objective)),
    plan: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string', enum: Object.values(PlanStatus) },
        publishedAt: nullableDateTime,
        hasUnpublishedChanges: { type: 'boolean' },
      },
    },
    adherence7d: {
      type: 'object',
      nullable: true,
      properties: { done: { type: 'integer' }, expected: { type: 'integer' }, percent: { type: 'number' } },
    },
    linkedAt: isoDateTime,
  },
};

export const sheetSchema = {
  type: 'object',
  properties: {
    sex: statusEnum(Object.values(Sex)),
    birthDate: nullableString,
    age: { type: 'integer', nullable: true },
    weightKg: nullableNumber,
    heightCm: nullableNumber,
    bodyFatPct: nullableNumber,
    leanMassKg: nullableNumber,
    assessedAt: nullableString,
  },
};

const activitySchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    met: { type: 'number' },
    minutes: { type: 'number' },
    perWeek: { type: 'number' },
    included: { type: 'boolean' },
    fromTraining: { type: 'boolean' },
  },
};

const goalsSchema = {
  type: 'object',
  properties: {
    bmrFormula: { type: 'string', enum: Object.values(BmrFormula) },
    activityFactor: { type: 'number' },
    activities: { type: 'array', items: activitySchema },
    objective: { type: 'string', enum: Object.values(Objective) },
    kcalTarget: nullableNumber,
    proteinPerKg: nullableNumber,
    fatPerKg: nullableNumber,
    carbPerKg: nullableNumber,
    carbIsRemainder: { type: 'boolean' },
    fiberMinG: nullableNumber,
  },
};

const supplementSchema = {
  type: 'object',
  properties: { name: { type: 'string' }, dose: nullableString, when: nullableString },
};

const guidanceSchema = {
  type: 'object',
  properties: {
    waterTargetMl: { type: 'integer', nullable: true },
    freeMealsPerWeek: { type: 'integer' },
    freeMealText: nullableString,
    supplements: { type: 'array', items: supplementSchema },
    observations: nullableString,
    patientMessage: nullableString,
  },
};

const substituteSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    foodId: { type: 'string', format: 'uuid', nullable: true },
    name: { type: 'string' },
    source: { type: 'string' },
    householdMeasure: nullableString,
    quantity: { type: 'number' },
    nutrients: nutrientsSchema,
  },
};

const itemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    foodId: { type: 'string', format: 'uuid', nullable: true },
    name: { type: 'string' },
    source: { type: 'string', enum: foodSourceValues },
    householdMeasure: nullableString,
    quantity: { type: 'number' },
    unit: { type: 'string', enum: Object.values(QuantityUnit) },
    per100g: nutrientsSchema,
    nutrients: nutrientsSchema,
    swapBasis: { type: 'string', enum: Object.values(SwapBasis) },
    substitutes: { type: 'array', items: substituteSchema },
    order: { type: 'integer' },
  },
};

const mealSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    time: { type: 'string' },
    order: { type: 'integer' },
    tip: nullableString,
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          position: { type: 'integer' },
          items: { type: 'array', items: itemSchema },
          totals: nutrientsSchema,
        },
      },
    },
  },
};

const macroEntrySchema = {
  type: 'object',
  properties: { grams: { type: 'number' }, kcal: { type: 'number' }, pct: { type: 'number' } },
};

const goalStatusSchema = { type: 'string', enum: Object.values(GoalStatus), nullable: true };

const computedSchema = {
  type: 'object',
  properties: {
    bmr: nullableNumber,
    tee: nullableNumber,
    suggestedKcal: nullableNumber,
    macros: {
      type: 'object',
      nullable: true,
      properties: {
        protein: macroEntrySchema,
        carbs: macroEntrySchema,
        fat: macroEntrySchema,
        totalKcal: { type: 'number' },
        diffKcal: { type: 'number' },
      },
    },
    dayTotals: nutrientsSchema,
    dayStatus: {
      type: 'object',
      properties: {
        kcal: goalStatusSchema,
        protein: goalStatusSchema,
        carbs: goalStatusSchema,
        fat: goalStatusSchema,
        fiber: goalStatusSchema,
      },
    },
  },
};

export const planSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    patientId: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: Object.values(PlanStatus) },
    version: { type: 'integer' },
    publishedAt: nullableDateTime,
    hasUnpublishedChanges: { type: 'boolean' },
    goals: goalsSchema,
    guidance: guidanceSchema,
    meals: { type: 'array', items: mealSchema },
    computed: computedSchema,
  },
};

const todaySubstituteSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    householdMeasure: nullableString,
    quantity: { type: 'number' },
    nutrients: nutrientsSchema,
  },
};

const todayItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    householdMeasure: nullableString,
    quantity: { type: 'number' },
    unit: { type: 'string' },
    nutrients: nutrientsSchema,
    canSwap: { type: 'boolean' },
    swappedTo: {
      type: 'object',
      nullable: true,
      properties: {
        substituteId: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        householdMeasure: nullableString,
        quantity: { type: 'number' },
        nutrients: nutrientsSchema,
      },
    },
    substitutes: { type: 'array', items: todaySubstituteSchema },
  },
};

const todayMealSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    time: { type: 'string' },
    order: { type: 'integer' },
    tip: nullableString,
    status: { type: 'string', enum: Object.values(MealStatus) },
    doneAt: nullableDateTime,
    note: nullableString,
    selectedOptionId: { type: 'string', format: 'uuid' },
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          position: { type: 'integer' },
          items: { type: 'array', items: todayItemSchema },
          totals: nutrientsSchema,
        },
      },
    },
  },
};

export const todaySchema = {
  type: 'object',
  properties: {
    date: { type: 'string' },
    plan: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'string', format: 'uuid' },
        version: { type: 'integer' },
        nutritionist: {
          type: 'object',
          properties: { firstName: nullableString, lastName: nullableString, avatarUrl: nullableString },
        },
        patientMessage: nullableString,
        water: {
          type: 'object',
          properties: { targetMl: { type: 'integer', nullable: true }, consumedMl: { type: 'integer' }, cupMl: { type: 'integer' } },
        },
        freeMeal: {
          type: 'object',
          nullable: true,
          properties: { perWeek: { type: 'integer' }, text: nullableString },
        },
        supplements: { type: 'array', items: supplementSchema },
        meals: { type: 'array', items: todayMealSchema },
        mealsDone: { type: 'integer' },
        mealsTotal: { type: 'integer' },
        nextMealId: { type: 'string', format: 'uuid', nullable: true },
      },
    },
  },
};

const activityInputSchema = {
  type: 'object',
  required: ['name', 'met', 'minutes', 'perWeek', 'included', 'fromTraining'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: MAX_SHORT_TEXT_LENGTH },
    met: { type: 'number', exclusiveMinimum: 0, maximum: 30 },
    minutes: { type: 'number', minimum: 0, maximum: 1440 },
    perWeek: { type: 'number', minimum: 0, maximum: 7 },
    included: { type: 'boolean' },
    fromTraining: { type: 'boolean' },
  },
};

// Nullable g/kg number property.
const perKgInput = (maximum) => ({ type: 'number', minimum: 0, maximum, nullable: true });

export const goalsBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bmrFormula: { type: 'string', enum: Object.values(BmrFormula) },
    activityFactor: { type: 'number', enum: [...ACTIVITY_FACTORS] },
    activities: { type: 'array', maxItems: 30, items: activityInputSchema },
    objective: { type: 'string', enum: Object.values(Objective) },
    kcalTarget: { type: 'number', exclusiveMinimum: 0, maximum: 20000, nullable: true },
    proteinPerKg: perKgInput(10),
    fatPerKg: perKgInput(10),
    carbPerKg: perKgInput(30),
    carbIsRemainder: { type: 'boolean' },
    fiberMinG: { type: 'number', minimum: 0, maximum: 500, nullable: true },
  },
};

export const guidanceBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    waterTargetMl: { type: 'integer', minimum: 1, maximum: 20000, nullable: true },
    freeMealsPerWeek: { type: 'integer', minimum: 0, maximum: FREE_MEALS_PER_WEEK_MAX },
    freeMealText: { type: 'string', maxLength: FREE_MEAL_TEXT_MAX, nullable: true },
    supplements: {
      type: 'array',
      maxItems: MAX_SUPPLEMENTS,
      items: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: MAX_SHORT_TEXT_LENGTH },
          dose: { type: 'string', maxLength: MAX_SHORT_TEXT_LENGTH, nullable: true },
          when: { type: 'string', maxLength: MAX_SHORT_TEXT_LENGTH, nullable: true },
        },
      },
    },
    observations: { type: 'string', maxLength: OBSERVATIONS_MAX, nullable: true },
    patientMessage: { type: 'string', maxLength: PATIENT_MESSAGE_MAX, nullable: true },
  },
};

export const mealNameSchema = { type: 'string', minLength: 1, maxLength: MAX_NAME_LENGTH };
export const mealTimeSchema = { type: 'string', pattern: TIME_PATTERN };
export const mealTipSchema = { type: 'string', maxLength: MAX_TIP_LENGTH, nullable: true };
export const householdMeasureInput = { type: 'string', maxLength: MAX_SHORT_TEXT_LENGTH, nullable: true };
