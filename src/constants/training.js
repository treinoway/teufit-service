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

export const GenderOrdination = Object.freeze({
  MALE: 'male',
  FEMALE: 'female',
  OTHER: 'other',
});

export const TrainingLevel = Object.freeze({
  BEGINNER: 'beginner',
  INTERMEDIATE: 'intermediate',
  ADVANCED: 'advanced',
  ATHLETE: 'athlete',
});

export const ExerciseType = Object.freeze({
  STRENGTH: 'strength',
  CARDIO: 'cardio',
  MOBILITY: 'mobility',
  STRETCHING: 'stretching',
});

export const ProtocolType = Object.freeze({
  STRENGTH: 'strength',
  CARDIO: 'cardio',
  STRETCHING: 'stretching',
  MOBILITY: 'mobility',
  ACTIVATION: 'activation',
});

// Export arrays of values for validation
export const weekDayValues = Object.freeze(Object.values(WeekDays));
export const trainingCategoryValues = Object.freeze(Object.values(TrainingCategory));
export const bodySegmentValues = Object.freeze(Object.values(BodySegment));
export const trainingStatusValues = Object.freeze(Object.values(TrainingStatus));
export const genderOrdinationValues = Object.freeze(Object.values(GenderOrdination));
export const trainingLevelValues = Object.freeze(Object.values(TrainingLevel));
export const exerciseTypeValues = Object.freeze(Object.values(ExerciseType));
export const protocolTypeValues = Object.freeze(Object.values(ProtocolType));
