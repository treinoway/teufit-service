export const BmrFormula = Object.freeze({
  MIFFLIN: 'mifflin',
  HARRIS_BENEDICT: 'harris_benedict',
  FAO_WHO: 'fao_who',
  KATCH_MCARDLE: 'katch_mcardle',
});

export const Objective = Object.freeze({
  MAINTAIN: 'maintain',
  DEFICIT_10: 'deficit_10',
  DEFICIT_20: 'deficit_20',
  SURPLUS_10: 'surplus_10',
});

export const OBJECTIVE_ADJUSTMENT = Object.freeze({
  [Objective.MAINTAIN]: 0,
  [Objective.DEFICIT_10]: -0.1,
  [Objective.DEFICIT_20]: -0.2,
  [Objective.SURPLUS_10]: 0.1,
});

export const ACTIVITY_FACTORS = Object.freeze([1.2, 1.375, 1.55]);
export const DEFAULT_ACTIVITY_FACTOR = 1.375;

export const PlanStatus = Object.freeze({ DRAFT: 'draft', PUBLISHED: 'published' });
export const PatientLinkStatus = Object.freeze({ ACTIVE: 'active', INACTIVE: 'inactive' });
export const PatientInviteStatus = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
  DECLINED: 'declined',
});
export const patientInviteStatusValues = Object.freeze(Object.values(PatientInviteStatus));
export const FoodSource = Object.freeze({ TACO: 'taco', TBCA: 'tbca', CUSTOM: 'custom' });
export const foodSourceValues = Object.freeze(Object.values(FoodSource));
// Public sources hidden from search and lookup: TBCA is not licensed for commercial use.
export const HIDDEN_FOOD_SOURCES = Object.freeze([FoodSource.TBCA]);
export const SwapBasis = Object.freeze({ PROTEIN: 'protein', KCAL: 'kcal' });
export const MealLogStatus = Object.freeze({ DONE: 'done', DIFFERENT: 'different' });
export const MealStatus = Object.freeze({ PENDING: 'pending', DONE: 'done', DIFFERENT: 'different' });
export const Sex = Object.freeze({ FEMALE: 'female', MALE: 'male' });
export const GoalStatus = Object.freeze({ OK: 'ok', LOW: 'low', HIGH: 'high' });
export const QuantityUnit = Object.freeze({ GRAM: 'g', MILLILITER: 'ml' });

export const MAX_MEAL_OPTIONS = 3;
export const FIRST_OPTION_POSITION = 1;
export const GOAL_TOLERANCE = 0.05;
export const WATER_CUP_ML = 250;
export const WATER_MAX_TARGET_MULTIPLIER = 2;
export const DEFAULT_WATER_TARGET_ML = 2000;
export const ADHERENCE_WINDOW_DAYS = 7;
export const TRAINING_SESSIONS_LOOKBACK = 20;

export const WEIGHT_TRAINING_MET = 5;
export const WEIGHT_TRAINING_NAME = 'Musculação';
export const DEFAULT_SESSION_MINUTES = 60;
export const DAYS_PER_WEEK = 7;

export const KCAL_PER_GRAM = Object.freeze({ protein: 4, carbs: 4, fat: 9 });

export const FREE_MEAL_TEXT_MAX = 500;
export const OBSERVATIONS_MAX = 2000;
export const PATIENT_MESSAGE_MAX = 500;
export const FREE_MEALS_PER_WEEK_MAX = 2;
export const DEFAULT_FOOD_PORTION_GRAMS = 100;
export const MAX_MACRO_PER_100G = 100;
export const MAX_KCAL_PER_100G = 1000;
export const MAX_QUANTITY_COLUMN = 999999.99;
export const DAY_WINDOW_FUTURE_DAYS = 1;
export const FOOD_SEARCH_LIMIT_DEFAULT = 20;
export const FOOD_SEARCH_LIMIT_MAX = 100;

export const NutritionErrorCode = Object.freeze({
  INVITE_SELF: 'NUTRITION_INVITE_SELF',
  INVITE_ALREADY_LINKED: 'NUTRITION_INVITE_ALREADY_LINKED',
  INVITE_ALREADY_PENDING: 'NUTRITION_INVITE_ALREADY_PENDING',
  INVITE_NOT_FOUND: 'NUTRITION_INVITE_NOT_FOUND',
  INVITE_NOT_PENDING: 'NUTRITION_INVITE_NOT_PENDING',
  INVITE_RESEND_COOLDOWN: 'NUTRITION_INVITE_RESEND_COOLDOWN',
  INVITE_MAX_SENDS: 'NUTRITION_INVITE_MAX_SENDS',
  INVITE_DAILY_LIMIT: 'NUTRITION_INVITE_DAILY_LIMIT',
  INVITE_EMAIL_SEND_FAILED: 'NUTRITION_INVITE_EMAIL_SEND_FAILED',
  INVITE_ACCOUNT_DEACTIVATED: 'NUTRITION_INVITE_ACCOUNT_DEACTIVATED',
  INVITE_EXPIRED: 'NUTRITION_INVITE_EXPIRED',
  PATIENT_NOT_FOUND: 'NUTRITION_PATIENT_NOT_FOUND',
  PLAN_NOT_FOUND: 'NUTRITION_PLAN_NOT_FOUND',
  PLAN_NO_MEALS: 'NUTRITION_PLAN_NO_MEALS',
  PLAN_NO_KCAL_TARGET: 'NUTRITION_PLAN_NO_KCAL_TARGET',
  MEAL_NOT_FOUND: 'NUTRITION_MEAL_NOT_FOUND',
  MEAL_MAX_OPTIONS: 'NUTRITION_MEAL_MAX_OPTIONS',
  MEAL_FIRST_OPTION_REQUIRED: 'NUTRITION_MEAL_FIRST_OPTION_REQUIRED',
  MEAL_INVALID_ORDER: 'NUTRITION_MEAL_INVALID_ORDER',
  OPTION_NOT_FOUND: 'NUTRITION_OPTION_NOT_FOUND',
  ITEM_NOT_FOUND: 'NUTRITION_ITEM_NOT_FOUND',
  SUBSTITUTE_NOT_FOUND: 'NUTRITION_SUBSTITUTE_NOT_FOUND',
  SUBSTITUTE_CANNOT_EQUATE: 'NUTRITION_SUBSTITUTE_CANNOT_EQUATE',
  SUBSTITUTE_QUANTITY_TOO_LARGE: 'NUTRITION_SUBSTITUTE_QUANTITY_TOO_LARGE',
  DAY_OUT_OF_RANGE: 'NUTRITION_DAY_OUT_OF_RANGE',
  SWAP_NOT_ALLOWED: 'NUTRITION_SWAP_NOT_ALLOWED',
  FOOD_NOT_FOUND: 'NUTRITION_FOOD_NOT_FOUND',
  FOOD_GROUP_NOT_FOUND: 'NUTRITION_FOOD_GROUP_NOT_FOUND',
  NUTRITIONIST_PROFILE_MISSING: 'NUTRITIONIST_PROFILE_MISSING',
});

export const NutritionMessageCode = Object.freeze({
  INVITE_SELF: 'nutrition.invite.selfInvite',
  INVITE_ALREADY_LINKED: 'nutrition.invite.alreadyLinked',
  INVITE_ALREADY_PENDING: 'nutrition.invite.alreadyPending',
  INVITE_NOT_FOUND: 'nutrition.invite.notFound',
  INVITE_NOT_PENDING: 'nutrition.invite.notPending',
  INVITE_RESEND_COOLDOWN: 'nutrition.invite.resendCooldown',
  INVITE_MAX_SENDS: 'nutrition.invite.maxSends',
  INVITE_DAILY_LIMIT: 'nutrition.invite.dailyLimit',
  INVITE_EMAIL_SEND_FAILED: 'nutrition.invite.emailSendFailed',
  INVITE_ACCOUNT_DEACTIVATED: 'nutrition.invite.accountDeactivated',
  INVITE_EXPIRED: 'nutrition.invite.expired',
  PATIENT_NOT_FOUND: 'nutrition.patient.notFound',
  PLAN_NOT_FOUND: 'nutrition.plan.notFound',
  PLAN_NO_MEALS: 'nutrition.plan.noMeals',
  PLAN_NO_KCAL_TARGET: 'nutrition.plan.noKcalTarget',
  MEAL_NOT_FOUND: 'nutrition.meal.notFound',
  MEAL_MAX_OPTIONS: 'nutrition.meal.maxOptions',
  MEAL_FIRST_OPTION_REQUIRED: 'nutrition.meal.firstOptionRequired',
  MEAL_INVALID_ORDER: 'nutrition.meal.invalidOrder',
  OPTION_NOT_FOUND: 'nutrition.option.notFound',
  ITEM_NOT_FOUND: 'nutrition.item.notFound',
  SUBSTITUTE_NOT_FOUND: 'nutrition.substitute.notFound',
  SUBSTITUTE_CANNOT_EQUATE: 'nutrition.substitute.cannotEquate',
  SUBSTITUTE_QUANTITY_TOO_LARGE: 'nutrition.substitute.quantityTooLarge',
  DAY_OUT_OF_RANGE: 'nutrition.day.outOfRange',
  SWAP_NOT_ALLOWED: 'nutrition.swap.notAllowed',
  FOOD_NOT_FOUND: 'nutrition.food.notFound',
  FOOD_GROUP_NOT_FOUND: 'nutrition.foodGroup.notFound',
  NUTRITIONIST_PROFILE_MISSING: 'nutritionist.notFound',
});
