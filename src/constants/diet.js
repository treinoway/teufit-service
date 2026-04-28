/**
 * Diet / Nutrition system constants
 */

export const DietProtocolStatus = Object.freeze({
  ACTIVE: 'active',
  COMPLETED: 'completed',
  ARCHIVED: 'archived',
});

export const MealType = Object.freeze({
  BREAKFAST: 'breakfast',
  LUNCH: 'lunch',
  DINNER: 'dinner',
  MORNING_SNACK: 'morning_snack',
  AFTERNOON_SNACK: 'afternoon_snack',
  SUPPER: 'supper',
});

export const DietType = Object.freeze({
  STANDARD: 'standard',
  LOW_CARB: 'low_carb',
  HIGH_PROTEIN: 'high_protein',
  MEDITERRANEAN: 'mediterranean',
  VEGETARIAN: 'vegetarian',
  VEGAN: 'vegan',
});

export const GoalType = Object.freeze({
  WEIGHT_LOSS: 'weight_loss',
  MUSCLE_GAIN: 'muscle_gain',
  MAINTENANCE: 'maintenance',
  HEALTH: 'health',
});

export const TmbFormula = Object.freeze({
  HARRIS_BENEDICT: 'harris_benedict',
  MIFFLIN_ST_JEOR: 'mifflin_st_jeor',
  FAO_WHO: 'fao_who',
  CUNNINGHAM: 'cunningham',
});

export const ActivityLevel = Object.freeze({
  SEDENTARIO: 'sedentario',
  LEVEMENTE_ATIVO: 'levemente_ativo',
  MODERADAMENTE_ATIVO: 'moderadamente_ativo',
  MUITO_ATIVO: 'muito_ativo',
  EXTREMAMENTE_ATIVO: 'extremamente_ativo',
});

export const PAL_MULTIPLIERS = Object.freeze({
  sedentario: 1.2,
  levemente_ativo: 1.375,
  moderadamente_ativo: 1.55,
  muito_ativo: 1.725,
  extremamente_ativo: 1.9,
});

// Arrays for schema validation
export const dietProtocolStatusValues = Object.freeze(Object.values(DietProtocolStatus));
export const mealTypeValues = Object.freeze(Object.values(MealType));
export const dietTypeValues = Object.freeze(Object.values(DietType));
export const goalTypeValues = Object.freeze(Object.values(GoalType));
export const tmbFormulaValues = Object.freeze(Object.values(TmbFormula));
export const activityLevelValues = Object.freeze(Object.values(ActivityLevel));

// Error codes
export const DietErrorCode = Object.freeze({
  PATIENT_NOT_FOUND: 'PATIENT_NOT_FOUND',
  PATIENT_ALREADY_LINKED: 'PATIENT_ALREADY_LINKED',
  PATIENT_NOT_LINKED: 'PATIENT_NOT_LINKED',
  TEMPLATE_NOT_FOUND: 'TEMPLATE_NOT_FOUND',
  PROTOCOL_NOT_FOUND: 'PROTOCOL_NOT_FOUND',
  FORBIDDEN_NOT_TEMPLATE_OWNER: 'FORBIDDEN_NOT_TEMPLATE_OWNER',
  FORBIDDEN_NOT_PROTOCOL_OWNER: 'FORBIDDEN_NOT_PROTOCOL_OWNER',
  FORBIDDEN_NOT_YOUR_PROTOCOL: 'FORBIDDEN_NOT_YOUR_PROTOCOL',
  MEAL_NOT_FOUND: 'MEAL_NOT_FOUND',
  FOOD_ITEM_NOT_FOUND: 'FOOD_ITEM_NOT_FOUND',
  NUTRITIONIST_NOT_FOUND: 'NUTRITIONIST_NOT_FOUND',
  FOOD_NOT_FOUND: 'FOOD_NOT_FOUND',
  INVALID_TMB_FORMULA: 'INVALID_TMB_FORMULA',
  INVALID_ACTIVITY_LEVEL: 'INVALID_ACTIVITY_LEVEL',
  MISSING_LEAN_BODY_MASS: 'MISSING_LEAN_BODY_MASS',
  MISSING_TMB_PARAMETERS: 'MISSING_TMB_PARAMETERS',
});

export const DietMessageCode = Object.freeze({
  PATIENT_NOT_FOUND: 'diet.patientNotFound',
  PATIENT_ALREADY_LINKED: 'diet.patientAlreadyLinked',
  PATIENT_NOT_LINKED: 'diet.patientNotLinked',
  TEMPLATE_NOT_FOUND: 'diet.templateNotFound',
  PROTOCOL_NOT_FOUND: 'diet.protocolNotFound',
  FORBIDDEN_NOT_TEMPLATE_OWNER: 'diet.forbiddenNotTemplateOwner',
  FORBIDDEN_NOT_PROTOCOL_OWNER: 'diet.forbiddenNotProtocolOwner',
  FORBIDDEN_NOT_YOUR_PROTOCOL: 'diet.forbiddenNotYourProtocol',
  MEAL_NOT_FOUND: 'diet.mealNotFound',
  FOOD_ITEM_NOT_FOUND: 'diet.foodItemNotFound',
});
