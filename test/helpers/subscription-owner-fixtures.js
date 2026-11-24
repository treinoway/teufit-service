// Shared fixtures for the professional (trainer and/or nutritionist) billing tests.

// Wire values of the plan tag (epic nutritionist-finance, "Contract changes").
export const ServiceType = Object.freeze({
  TRAINING: 'training',
  NUTRITION: 'nutrition',
  BOTH: 'both',
});

export const SERVICE_TYPE_NOT_ALLOWED_MESSAGE_CODE = 'subscription.serviceTypeNotAllowed';
export const PROFESSIONAL_NOT_FOUND_MESSAGE_CODE = 'professional.notFound';
export const TRAINER_NOT_FOUND_MESSAGE_CODE = 'trainer.notFound';

export const OWNER_USER_ID = 'professional-user-uuid';
export const OWNER_TRAINER_ID = 'owner-trainer-uuid';
export const OWNER_NUTRITIONIST_ID = 'owner-nutritionist-uuid';

// Owner object of a user that only has a trainer row.
export function trainerOwner() {
  return { userId: OWNER_USER_ID, trainerId: OWNER_TRAINER_ID, nutritionistId: null };
}

// Owner object of a user that only has a nutritionist row.
export function nutritionistOwner() {
  return { userId: OWNER_USER_ID, trainerId: null, nutritionistId: OWNER_NUTRITIONIST_ID };
}

// Owner object of a user that has both a trainer and a nutritionist row.
export function dualOwner() {
  return { userId: OWNER_USER_ID, trainerId: OWNER_TRAINER_ID, nutritionistId: OWNER_NUTRITIONIST_ID };
}

// Advisory lock key of an assign/unlink for one professional user and student (spec: Design, "Service internal interface").
export function expectedAssignmentLockKey(userId, studentId) {
  return `subscription-assign:user:${userId}:${studentId}`;
}
