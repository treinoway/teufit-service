import {
  trainingCategoryValues,
  bodySegmentValues,
  weekDayValues,
  genderOrdinationValues,
  trainingLevelValues,
  exerciseTypeValues,
  protocolTypeValues,
  workoutSessionStatusValues,
  exerciseLogStatusValues,
} from '../constants/training.js';
import { AppError } from '../errors/app-error.js';

export function buildError(code, message, statusCode = 400) {
  return new AppError({
    httpStatus: statusCode,
    error: code,
    messageCode: `legacy.${code}`,
    message,
  });
}

export function validateWeekDay(weekDay, fieldName = 'weekDay') {
  if (weekDay && !weekDayValues.includes(weekDay)) {
    throw buildError(
      'INVALID_WEEK_DAY',
      `Invalid ${fieldName}: ${weekDay}. Valid values are: ${weekDayValues.join(', ')}`,
    );
  }
}

export function validateCategory(category) {
  if (!trainingCategoryValues.includes(category)) {
    throw buildError(
      'INVALID_CATEGORY',
      `Invalid category: ${category}. Valid values are: ${trainingCategoryValues.join(', ')}`,
    );
  }
}

export function validateBodySegment(bodySegment) {
  if (bodySegment && !bodySegmentValues.includes(bodySegment)) {
    throw buildError(
      'INVALID_BODY_SEGMENT',
      `Invalid body segment: ${bodySegment}. Valid values are: ${bodySegmentValues.join(', ')}`,
    );
  }
}

export function validateGenderOrdination(value) {
  if (value && !genderOrdinationValues.includes(value)) {
    throw buildError(
      'INVALID_GENDER_ORDINATION',
      `Invalid gender ordination: ${value}. Valid values are: ${genderOrdinationValues.join(', ')}`,
    );
  }
}

export function validateTrainingLevel(value) {
  if (value && !trainingLevelValues.includes(value)) {
    throw buildError(
      'INVALID_TRAINING_LEVEL',
      `Invalid training level: ${value}. Valid values are: ${trainingLevelValues.join(', ')}`,
    );
  }
}

export function validateExerciseType(type) {
  if (!exerciseTypeValues.includes(type)) {
    throw buildError(
      'INVALID_EXERCISE_TYPE',
      `Invalid exercise type: ${type}. Valid values are: ${exerciseTypeValues.join(', ')}`,
    );
  }
}

export function validateRepetitions(repetitions) {
  if (repetitions === undefined || repetitions === null) return;
  const { min, max } = repetitions;
  if (min !== null && (!Number.isInteger(min) || min < 1)) {
    throw buildError('INVALID_REPETITIONS', 'repetitions.min must be a positive integer or null');
  }
  if (max !== null && (!Number.isInteger(max) || max < 1)) {
    throw buildError('INVALID_REPETITIONS', 'repetitions.max must be a positive integer or null');
  }
}

export function validateProtocolType(type) {
  if (type && !protocolTypeValues.includes(type)) {
    throw buildError(
      'INVALID_PROTOCOL_TYPE',
      `Invalid protocol type: ${type}. Valid values are: ${protocolTypeValues.join(', ')}`,
    );
  }
}

export function validateWorkoutSessionStatus(status) {
  if (status && !workoutSessionStatusValues.includes(status)) {
    throw buildError(
      'INVALID_WORKOUT_SESSION_STATUS',
      `Invalid workout session status: ${status}. Valid values are: ${workoutSessionStatusValues.join(', ')}`,
    );
  }
}

export function validateExerciseLogStatus(status) {
  if (status && !exerciseLogStatusValues.includes(status)) {
    throw buildError(
      'INVALID_EXERCISE_LOG_STATUS',
      `Invalid exercise log status: ${status}. Valid values are: ${exerciseLogStatusValues.join(', ')}`,
    );
  }
}
