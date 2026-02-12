/**
 * Training system constants
 * Used for validation and type safety across the training protocol feature
 */

export const TrainingStatus = Object.freeze({
  ACTIVE: 'active',
  COMPLETED: 'completed',
  ARCHIVED: 'archived',
});

export const WeekDays = Object.freeze({
  MONDAY: 'monday',
  TUESDAY: 'tuesday',
  WEDNESDAY: 'wednesday',
  THURSDAY: 'thursday',
  FRIDAY: 'friday',
  SATURDAY: 'saturday',
  SUNDAY: 'sunday',
});

export const TrainingCategory = Object.freeze({
  STRENGTH: 'strength',
  CARDIO: 'cardio',
  FLEXIBILITY: 'flexibility',
  REST: 'rest',
  FUNCTIONAL: 'functional',
  MOBILITY: 'mobility',
});

export const BodySegment = Object.freeze({
  UPPER: 'upper',
  LOWER: 'lower',
  CORE: 'core',
  FULL_BODY: 'full_body',
});

// Export arrays of values for validation
export const weekDayValues = Object.freeze(Object.values(WeekDays));
export const trainingCategoryValues = Object.freeze(Object.values(TrainingCategory));
export const bodySegmentValues = Object.freeze(Object.values(BodySegment));
export const trainingStatusValues = Object.freeze(Object.values(TrainingStatus));
