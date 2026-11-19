import { prisma } from '../db.js';
import s3BucketHandler from '../config/s3-bucket-handler.js';
import { isS3Key } from './avatar-service.js';
import { ForbiddenAppError, NotFoundAppError, ConflictAppError } from '../errors/app-error.js';

const DELETION_TRANSACTION_OPTIONS = { timeout: 30_000, maxWait: 10_000 };

export async function deleteOwnAccount(userId, logger = console) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, avatarUrl: true, deletedAt: true },
  });

  if (!user) {
    throw new NotFoundAppError({
      error: 'USER_NOT_FOUND',
      message: 'User not found',
      messageCode: 'resource.notFound',
    });
  }

  if (user.deletedAt) {
    throw new ForbiddenAppError({
      error: 'USER_DELETED',
      message: 'User account is already deleted',
      messageCode: 'auth.user.deleted',
    });
  }

  const [activeTrainerProfile, activeNutritionistProfile] = await Promise.all([
    prisma.trainer.findFirst({ where: { userId, deletedAt: null }, select: { id: true } }),
    prisma.nutritionist.findFirst({ where: { userId, deletedAt: null }, select: { id: true } }),
  ]);

  if (activeTrainerProfile || activeNutritionistProfile) {
    throw new ConflictAppError({
      error: 'PROFESSIONAL_ACCOUNT_DELETION_UNSUPPORTED',
      message: 'Self-service deletion is not yet available for trainer or nutritionist accounts. Please contact support to close a professional account.',
      messageCode: 'account.deletion.professionalUnsupported',
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.account.deleteMany({ where: { userId } });

    await tx.refreshToken.deleteMany({ where: { userId } });
    await tx.passwordResetToken.deleteMany({ where: { userId } });

    await tx.address.deleteMany({ where: { userId } });
    await tx.socialNetwork.deleteMany({ where: { userId } });
    await tx.userHealthDetail.deleteMany({ where: { userId } });
    await tx.userPreferences.deleteMany({ where: { userId } });
    await tx.patientMetabolicProfile.deleteMany({ where: { patientId: userId } });

    await tx.workoutSession.deleteMany({ where: { userId } });

    await tx.anamnesisResponse.deleteMany({ where: { studentId: userId } });
    await tx.studentAnamnesis.deleteMany({ where: { studentId: userId } });
    await tx.studentFeedbackRequest.deleteMany({ where: { studentId: userId } });

    await tx.aiConversation.deleteMany({ where: { userId } });

    await tx.pointTransaction.deleteMany({ where: { studentId: userId } });
    await tx.pointBalance.deleteMany({ where: { studentId: userId } });
    await tx.challengeParticipant.deleteMany({ where: { studentId: userId } });

    await tx.trainerStudent.deleteMany({ where: { studentId: userId } });
    await tx.nutritionistPatient.deleteMany({ where: { patientId: userId } });
    await tx.waterLog.deleteMany({ where: { patientId: userId } });
    await tx.dietProtocol.deleteMany({ where: { assigneeId: userId } });
    await tx.patientInvite.deleteMany({
      where: user.email ? { OR: [{ patientId: userId }, { email: user.email.trim().toLowerCase() }] } : { patientId: userId },
    });

    await tx.aiInteractionLog.updateMany({
      where: { studentId: userId },
      data: { studentId: null, userMessage: null, responseText: null },
    });

    // TrainerInvite.email is always written lowercase (the only write path
    // normalizes it — see normalizeEmail/createInvite in
    // trainer-invite-service.js), so a plain lowercase equality match is
    // correct here and avoids ILIKE's wildcard risk: with
    // `mode: 'insensitive'` (which compiles to ILIKE), a `user.email`
    // containing `_`/`%` could match and delete a DIFFERENT person's invite.
    await tx.trainerInvite.deleteMany({
      where: user.email
        ? { OR: [{ userId }, { email: user.email.trim().toLowerCase() }] }
        : { userId },
    });

    await tx.user.update({
      where: { id: userId },
      data: {
        email: null,
        username: null,
        passwordHash: null,
        firstName: null,
        lastName: null,
        gender: null,
        birthDate: null,
        avatarUrl: null,
        deletedAt: new Date(),
      },
    });
  }, DELETION_TRANSACTION_OPTIONS);

  if (isS3Key(user.avatarUrl)) {
    s3BucketHandler.deleteFile({ key: user.avatarUrl }).catch((error) => {
      logger.error({ error }, 'Failed to delete avatar of deleted account (non-critical)');
    });
  }
}
