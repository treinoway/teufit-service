import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    trainer: { findFirst: vi.fn() },
    nutritionist: { findFirst: vi.fn() },
    account: { deleteMany: vi.fn() },
    refreshToken: { deleteMany: vi.fn() },
    passwordResetToken: { deleteMany: vi.fn() },
    address: { deleteMany: vi.fn() },
    socialNetwork: { deleteMany: vi.fn() },
    userHealthDetail: { deleteMany: vi.fn() },
    userPreferences: { deleteMany: vi.fn() },
    patientMetabolicProfile: { deleteMany: vi.fn() },
    workoutSession: { deleteMany: vi.fn() },
    anamnesisResponse: { deleteMany: vi.fn() },
    studentAnamnesis: { deleteMany: vi.fn() },
    aiConversation: { deleteMany: vi.fn() },
    pointTransaction: { deleteMany: vi.fn() },
    pointBalance: { deleteMany: vi.fn() },
    challengeParticipant: { deleteMany: vi.fn() },
    trainerStudent: { deleteMany: vi.fn() },
    nutritionistPatient: { deleteMany: vi.fn() },
    waterLog: { deleteMany: vi.fn() },
    dietProtocol: { deleteMany: vi.fn() },
    patientInvite: { deleteMany: vi.fn() },
    studentInvite: { deleteMany: vi.fn() },
    aiInteractionLog: { updateMany: vi.fn() },
    trainerInvite: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../src/config/s3-bucket-handler.js', () => ({
  default: {
    deleteFile: vi.fn(),
  },
}));

import { prisma } from '../../src/db.js';
import s3BucketHandler from '../../src/config/s3-bucket-handler.js';
import { deleteOwnAccount } from '../../src/services/account-deletion-service.js';

const USER_ID = 'user-1';
const USER_EMAIL = 'user1@example.com';
const DELETION_TRANSACTION_OPTIONS = { timeout: 30_000, maxWait: 10_000 };

describe('account-deletion-service', () => {
  describe('deleteOwnAccount', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
      s3BucketHandler.deleteFile.mockResolvedValue(undefined);
      prisma.trainer.findFirst.mockResolvedValue(null);
      prisma.nutritionist.findFirst.mockResolvedValue(null);
    });

    it('throws NotFoundAppError when the user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(deleteOwnAccount(USER_ID)).rejects.toMatchObject({
        error: 'USER_NOT_FOUND',
        messageCode: 'resource.notFound',
        httpStatus: 404,
      });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: USER_ID },
        select: { id: true, email: true, avatarUrl: true, deletedAt: true },
      });
      expect(prisma.trainer.findFirst).not.toHaveBeenCalled();
      expect(prisma.nutritionist.findFirst).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws ForbiddenAppError when the account is already deleted', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: USER_ID,
        email: null,
        avatarUrl: null,
        deletedAt: new Date('2026-01-01T00:00:00Z'),
      });

      await expect(deleteOwnAccount(USER_ID)).rejects.toMatchObject({
        error: 'USER_DELETED',
        messageCode: 'auth.user.deleted',
        httpStatus: 403,
      });

      expect(prisma.trainer.findFirst).not.toHaveBeenCalled();
      expect(prisma.nutritionist.findFirst).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    describe('professional-account guard', () => {
      beforeEach(() => {
        prisma.user.findUnique.mockResolvedValue({
          id: USER_ID,
          email: USER_EMAIL,
          avatarUrl: null,
          deletedAt: null,
        });
      });

      it('throws ConflictAppError when an active Trainer profile exists', async () => {
        prisma.trainer.findFirst.mockResolvedValue({ id: 'trainer-1' });
        prisma.nutritionist.findFirst.mockResolvedValue(null);

        await expect(deleteOwnAccount(USER_ID)).rejects.toMatchObject({
          error: 'PROFESSIONAL_ACCOUNT_DELETION_UNSUPPORTED',
          messageCode: 'account.deletion.professionalUnsupported',
          httpStatus: 409,
        });

        expect(prisma.trainer.findFirst).toHaveBeenCalledExactlyOnceWith({
          where: { userId: USER_ID, deletedAt: null },
          select: { id: true },
        });
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('throws ConflictAppError when an active Nutritionist profile exists', async () => {
        prisma.trainer.findFirst.mockResolvedValue(null);
        prisma.nutritionist.findFirst.mockResolvedValue({ id: 'nutritionist-1' });

        await expect(deleteOwnAccount(USER_ID)).rejects.toMatchObject({
          error: 'PROFESSIONAL_ACCOUNT_DELETION_UNSUPPORTED',
          messageCode: 'account.deletion.professionalUnsupported',
          httpStatus: 409,
        });

        expect(prisma.nutritionist.findFirst).toHaveBeenCalledExactlyOnceWith({
          where: { userId: USER_ID, deletedAt: null },
          select: { id: true },
        });
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });
    });

    describe('happy path', () => {
      beforeEach(() => {
        prisma.user.findUnique.mockResolvedValue({
          id: USER_ID,
          email: USER_EMAIL,
          avatarUrl: null,
          deletedAt: null,
        });
      });

      it('checks for an active professional profile before proceeding', async () => {
        await deleteOwnAccount(USER_ID);

        expect(prisma.trainer.findFirst).toHaveBeenCalledExactlyOnceWith({
          where: { userId: USER_ID, deletedAt: null },
          select: { id: true },
        });
        expect(prisma.nutritionist.findFirst).toHaveBeenCalledExactlyOnceWith({
          where: { userId: USER_ID, deletedAt: null },
          select: { id: true },
        });
      });

      it('runs the transaction with the deletion timeout options', async () => {
        await deleteOwnAccount(USER_ID);

        expect(prisma.$transaction).toHaveBeenCalledExactlyOnceWith(
          expect.any(Function),
          DELETION_TRANSACTION_OPTIONS,
        );
      });

      it('deletes every related record with the correct where clause', async () => {
        const result = await deleteOwnAccount(USER_ID);

        expect(prisma.account.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { userId: USER_ID } });
        expect(prisma.refreshToken.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { userId: USER_ID } });
        expect(prisma.passwordResetToken.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { userId: USER_ID } });
        expect(prisma.address.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { userId: USER_ID } });
        expect(prisma.socialNetwork.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { userId: USER_ID } });
        expect(prisma.userHealthDetail.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { userId: USER_ID } });
        expect(prisma.userPreferences.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { userId: USER_ID } });
        expect(prisma.patientMetabolicProfile.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { patientId: USER_ID } });
        expect(prisma.workoutSession.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { userId: USER_ID } });
        expect(prisma.anamnesisResponse.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { studentId: USER_ID } });
        expect(prisma.studentAnamnesis.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { studentId: USER_ID } });
        expect(prisma.aiConversation.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { userId: USER_ID } });
        expect(prisma.pointTransaction.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { studentId: USER_ID } });
        expect(prisma.pointBalance.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { studentId: USER_ID } });
        expect(prisma.challengeParticipant.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { studentId: USER_ID } });
        expect(prisma.trainerStudent.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { studentId: USER_ID } });
        expect(prisma.nutritionistPatient.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { patientId: USER_ID } });
        expect(prisma.waterLog.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { patientId: USER_ID } });
        expect(prisma.dietProtocol.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { assigneeId: USER_ID } });
        expect(prisma.patientInvite.deleteMany).toHaveBeenCalledExactlyOnceWith({
          where: { OR: [{ patientId: USER_ID }, { email: USER_EMAIL.trim().toLowerCase() }] },
        });
        expect(prisma.aiInteractionLog.updateMany).toHaveBeenCalledExactlyOnceWith({
          where: { studentId: USER_ID },
          data: { studentId: null, userMessage: null, responseText: null },
        });
        expect(prisma.trainerInvite.deleteMany).toHaveBeenCalledExactlyOnceWith({
          where: { OR: [{ userId: USER_ID }, { email: USER_EMAIL.trim().toLowerCase() }] },
        });

        expect(prisma.user.update).toHaveBeenCalledExactlyOnceWith({
          where: { id: USER_ID },
          data: {
            email: null,
            username: null,
            passwordHash: null,
            firstName: null,
            lastName: null,
            gender: null,
            birthDate: null,
            avatarUrl: null,
            deletedAt: expect.any(Date),
          },
        });

        expect(result).toBeUndefined();
      });

      it('deletes TrainerInvite rows keyed only by userId when the user has no email', async () => {
        prisma.user.findUnique.mockResolvedValue({
          id: USER_ID,
          email: null,
          avatarUrl: null,
          deletedAt: null,
        });

        await deleteOwnAccount(USER_ID);

        expect(prisma.trainerInvite.deleteMany).toHaveBeenCalledExactlyOnceWith({
          where: { userId: USER_ID },
        });
      });

      it('normalizes (trims + lowercases) a mixed-case stored user email before matching TrainerInvite rows, as a plain string (no ILIKE/wildcard object)', async () => {
        prisma.user.findUnique.mockResolvedValue({
          id: USER_ID,
          email: '  User1@Example.COM  ',
          avatarUrl: null,
          deletedAt: null,
        });

        await deleteOwnAccount(USER_ID);

        expect(prisma.trainerInvite.deleteMany).toHaveBeenCalledExactlyOnceWith({
          where: { OR: [{ userId: USER_ID }, { email: 'user1@example.com' }] },
        });
      });

      it('deletes the S3 avatar when avatarUrl is an S3 key', async () => {
        prisma.user.findUnique.mockResolvedValue({
          id: USER_ID,
          email: USER_EMAIL,
          avatarUrl: 'avatars/xyz.png',
          deletedAt: null,
        });

        await deleteOwnAccount(USER_ID);

        await new Promise((resolve) => setImmediate(resolve));

        expect(s3BucketHandler.deleteFile).toHaveBeenCalledExactlyOnceWith({ key: 'avatars/xyz.png' });
      });

      it('does not delete the avatar when avatarUrl is an external URL', async () => {
        prisma.user.findUnique.mockResolvedValue({
          id: USER_ID,
          email: USER_EMAIL,
          avatarUrl: 'https://lh3.googleusercontent.com/a/some-google-avatar',
          deletedAt: null,
        });

        await deleteOwnAccount(USER_ID);
        await new Promise((resolve) => setImmediate(resolve));

        expect(s3BucketHandler.deleteFile).not.toHaveBeenCalled();
      });

      it('does not delete the avatar when avatarUrl is null', async () => {
        prisma.user.findUnique.mockResolvedValue({
          id: USER_ID,
          email: USER_EMAIL,
          avatarUrl: null,
          deletedAt: null,
        });

        await deleteOwnAccount(USER_ID);
        await new Promise((resolve) => setImmediate(resolve));

        expect(s3BucketHandler.deleteFile).not.toHaveBeenCalled();
      });

      it('resolves successfully even when the S3 deletion rejects', async () => {
        prisma.user.findUnique.mockResolvedValue({
          id: USER_ID,
          email: USER_EMAIL,
          avatarUrl: 'avatars/will-fail.png',
          deletedAt: null,
        });
        s3BucketHandler.deleteFile.mockRejectedValue(new Error('S3 unavailable'));

        await expect(deleteOwnAccount(USER_ID)).resolves.toBeUndefined();

        await new Promise((resolve) => setImmediate(resolve));

        expect(s3BucketHandler.deleteFile).toHaveBeenCalledExactlyOnceWith({ key: 'avatars/will-fail.png' });
      });

      it('logs the S3 deletion failure via the provided logger, pino-style', async () => {
        prisma.user.findUnique.mockResolvedValue({
          id: USER_ID,
          email: USER_EMAIL,
          avatarUrl: 'avatars/will-fail.png',
          deletedAt: null,
        });
        const s3Error = new Error('S3 unavailable');
        s3BucketHandler.deleteFile.mockRejectedValue(s3Error);
        const logger = { error: vi.fn() };

        await deleteOwnAccount(USER_ID, logger);
        await new Promise((resolve) => setImmediate(resolve));

        expect(logger.error).toHaveBeenCalledExactlyOnceWith(
          { error: expect.any(Error) },
          'Failed to delete avatar of deleted account (non-critical)',
        );
      });

      it('defaults to console as the logger when none is passed', async () => {
        prisma.user.findUnique.mockResolvedValue({
          id: USER_ID,
          email: USER_EMAIL,
          avatarUrl: 'avatars/will-fail.png',
          deletedAt: null,
        });
        s3BucketHandler.deleteFile.mockRejectedValue(new Error('S3 unavailable'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        await deleteOwnAccount(USER_ID);
        await new Promise((resolve) => setImmediate(resolve));

        expect(consoleErrorSpy).toHaveBeenCalledExactlyOnceWith(
          { error: expect.any(Error) },
          'Failed to delete avatar of deleted account (non-critical)',
        );

        consoleErrorSpy.mockRestore();
      });
    });
  });
});
