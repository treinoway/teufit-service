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

export const WorkoutSessionStatus = Object.freeze({
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  ABANDONED: 'abandoned',
});

export const ExerciseLogStatus = Object.freeze({
  PENDING: 'pending',
  COMPLETED: 'completed',
  SKIPPED: 'skipped',
  SUBSTITUTED: 'substituted',
});

export const SupersetConstraints = Object.freeze({
  MIN_MEMBERS: 2,
  MAX_MEMBERS: 6,
});

export const PrescriptionMode = Object.freeze({
  REPS: 'reps',
  DURATION: 'duration',
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
export const workoutSessionStatusValues = Object.freeze(Object.values(WorkoutSessionStatus));
export const exerciseLogStatusValues = Object.freeze(Object.values(ExerciseLogStatus));
export const prescriptionModeValues = Object.freeze(Object.values(PrescriptionMode));

// Superset and substitute error/message codes
export const SupersetMessageCode = Object.freeze({
  MEMBERSHIP_INVALID: 'exercise.supersetMembershipInvalid',
  MIN_MEMBERS: 'exercise.supersetMinMembers',
  MAX_MEMBERS: 'exercise.supersetMaxMembers',
  ALREADY_IN_SUPERSET: 'exercise.alreadyInSuperset',
  GROUP_NOT_FOUND: 'exercise.supersetGroupNotFound',
});

export const SubstituteMessageCode = Object.freeze({
  SAME_TRAINING: 'exercise.substituteSameTraining',
  CANNOT_CHAIN: 'exercise.substituteCannotChain',
  CANNOT_BE_IN_SUPERSET: 'exercise.substituteCannotBeInSuperset',
  ALREADY_SUBSTITUTE: 'exercise.substitutedAlready',
  NOT_FOUND: 'exercise.substituteNotFound',
  LOG_ALREADY_SUBSTITUTED: 'exercise.logAlreadySubstituted',
});

// Workouts Today error codes and message codes
export const WorkoutsTodayErrorCode = Object.freeze({
  NO_ACTIVE_PROTOCOL: 'NO_ACTIVE_PROTOCOL',
  EMPTY_PROTOCOL: 'EMPTY_PROTOCOL',
});

export const WorkoutsTodayMessageCode = Object.freeze({
  NO_ACTIVE_PROTOCOL: 'workoutsToday.noActiveProtocol',
  EMPTY_PROTOCOL: 'workoutsToday.emptyProtocol',
});

export const DASHBOARD_DEFAULTS = Object.freeze({
  WINDOW_DAYS_DEFAULT: 90,
  WINDOW_DAYS_MAX: 365,
  RECENT_SESSIONS_DEFAULT: 10,
  RECENT_SESSIONS_MAX: 50,
  EXERCISES_LIST_DEFAULT: 20,
  EXERCISES_LIST_MAX: 20,
  SESSIONS_PER_EXERCISE_DEFAULT: 10,
  SESSIONS_PER_EXERCISE_MAX: 30,
  AI_SNAPSHOT_TOP_EXERCISES: 10,
});

export const DashboardMessageCode = Object.freeze({
  INVALID_DATE_RANGE: 'dashboard.invalidDateRange',
  WINDOW_TOO_LARGE: 'dashboard.windowTooLarge',
});
