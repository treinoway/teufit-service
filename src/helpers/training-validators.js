import { trainingCategoryValues, bodySegmentValues, weekDayValues, genderOrdinationValues, trainingLevelValues } from '../constants/training.js';
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
