import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainerBranding: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    trainingProtocol: {
      findFirst: vi.fn(),
    },
    trainerStudent: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('../../src/config/s3-bucket-handler.js', () => ({
  default: {
    uploadFile: vi.fn(),
    deleteFile: vi.fn(),
    resolveUrl: vi.fn(),
  },
}));

import { prisma } from '../../src/db.js';
import s3BucketHandler from '../../src/config/s3-bucket-handler.js';
import {
  upsertBranding,
  uploadBrandingImage,
  getBrandingByTrainerId,
  getStudentTrainerBranding,
} from '../../src/services/trainer-branding-service.js';

const TRAINER_ID = 'trainer-uuid-1';

const baseBranding = {
  id: 'branding-uuid-1',
  trainerId: TRAINER_ID,
  primaryColor: '#FF5733',
  secondaryColor: null,
  logoUrl: null,
  coverImageUrl: null,
  welcomeMessage: null,
  createdAt: new Date(),
  updatedAt: null,
};

describe('trainer-branding-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    s3BucketHandler.resolveUrl.mockResolvedValue(null);
  });

  // ─── upsertBranding ────────────────────────────────────────────────────────

  describe('upsertBranding', () => {
    it('throws ValidationAppError for invalid hex color (no hash)', async () => {
      await expect(
        upsertBranding({ trainerId: TRAINER_ID, data: { primaryColor: 'FF5733' } }),
      ).rejects.toMatchObject({
        name: 'ValidationAppError',
        httpStatus: 400,
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
      });

      expect(prisma.trainerBranding.upsert).not.toHaveBeenCalled();
    });

    it('throws ValidationAppError for invalid hex color (wrong length)', async () => {
      await expect(
        upsertBranding({ trainerId: TRAINER_ID, data: { primaryColor: '#FFF' } }),
      ).rejects.toMatchObject({
        name: 'ValidationAppError',
        httpStatus: 400,
      });
    });

    it('throws ValidationAppError for welcomeMessage exceeding 200 chars', async () => {
      const longMessage = 'a'.repeat(201);
      await expect(
        upsertBranding({ trainerId: TRAINER_ID, data: { primaryColor: '#FF5733', welcomeMessage: longMessage } }),
      ).rejects.toMatchObject({
        name: 'ValidationAppError',
        httpStatus: 400,
        messageCode: 'validation.failed',
      });

      expect(prisma.trainerBranding.upsert).not.toHaveBeenCalled();
    });

    it('creates branding when none exists', async () => {
      prisma.trainerBranding.upsert.mockResolvedValue(baseBranding);

      const result = await upsertBranding({
        trainerId: TRAINER_ID,
        data: { primaryColor: '#FF5733' },
      });

      expect(prisma.trainerBranding.upsert).toHaveBeenCalledWith({
        where: { trainerId: TRAINER_ID },
        create: { trainerId: TRAINER_ID, primaryColor: '#FF5733', secondaryColor: null, welcomeMessage: null },
        update: { primaryColor: '#FF5733', secondaryColor: null, welcomeMessage: null },
      });

      expect(result).toMatchObject({ primaryColor: '#FF5733' });
    });

    it('updates branding with welcome message', async () => {
      const withMessage = { ...baseBranding, welcomeMessage: 'Welcome!' };
      prisma.trainerBranding.upsert.mockResolvedValue(withMessage);

      const result = await upsertBranding({
        trainerId: TRAINER_ID,
        data: { primaryColor: '#AABBCC', welcomeMessage: 'Welcome!' },
      });

      expect(prisma.trainerBranding.upsert).toHaveBeenCalledWith({
        where: { trainerId: TRAINER_ID },
        create: { trainerId: TRAINER_ID, primaryColor: '#AABBCC', secondaryColor: null, welcomeMessage: 'Welcome!' },
        update: { primaryColor: '#AABBCC', secondaryColor: null, welcomeMessage: 'Welcome!' },
      });
      expect(result.welcomeMessage).toBe('Welcome!');
    });

    it('throws ValidationAppError for invalid secondaryColor (no hash)', async () => {
      await expect(
        upsertBranding({ trainerId: TRAINER_ID, data: { primaryColor: '#FF5733', secondaryColor: 'AABBCC' } }),
      ).rejects.toMatchObject({
        name: 'ValidationAppError',
        httpStatus: 400,
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
      });

      expect(prisma.trainerBranding.upsert).not.toHaveBeenCalled();
    });

    it('throws ValidationAppError for invalid secondaryColor (wrong length)', async () => {
      await expect(
        upsertBranding({ trainerId: TRAINER_ID, data: { primaryColor: '#FF5733', secondaryColor: '#FFF' } }),
      ).rejects.toMatchObject({
        name: 'ValidationAppError',
        httpStatus: 400,
      });
    });

    it('accepts null secondaryColor without throwing', async () => {
      prisma.trainerBranding.upsert.mockResolvedValue(baseBranding);

      await expect(
        upsertBranding({ trainerId: TRAINER_ID, data: { primaryColor: '#FF5733', secondaryColor: null } }),
      ).resolves.not.toThrow();

      expect(prisma.trainerBranding.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ secondaryColor: null }),
          update: expect.objectContaining({ secondaryColor: null }),
        }),
      );
    });

    it('creates branding with secondaryColor', async () => {
      const withSecondary = { ...baseBranding, secondaryColor: '#33A1FF' };
      prisma.trainerBranding.upsert.mockResolvedValue(withSecondary);

      const result = await upsertBranding({
        trainerId: TRAINER_ID,
        data: { primaryColor: '#FF5733', secondaryColor: '#33A1FF' },
      });

      expect(prisma.trainerBranding.upsert).toHaveBeenCalledWith({
        where: { trainerId: TRAINER_ID },
        create: { trainerId: TRAINER_ID, primaryColor: '#FF5733', secondaryColor: '#33A1FF', welcomeMessage: null },
        update: { primaryColor: '#FF5733', secondaryColor: '#33A1FF', welcomeMessage: null },
      });
      expect(result.secondaryColor).toBe('#33A1FF');
    });

    it('defaults secondaryColor to null when not provided', async () => {
      prisma.trainerBranding.upsert.mockResolvedValue(baseBranding);

      await upsertBranding({ trainerId: TRAINER_ID, data: { primaryColor: '#FF5733' } });

      expect(prisma.trainerBranding.upsert).toHaveBeenCalledWith({
        where: { trainerId: TRAINER_ID },
        create: { trainerId: TRAINER_ID, primaryColor: '#FF5733', secondaryColor: null, welcomeMessage: null },
        update: { primaryColor: '#FF5733', secondaryColor: null, welcomeMessage: null },
      });
    });

    it('accepts exactly 200 character welcomeMessage without throwing', async () => {
      const exactly200 = 'a'.repeat(200);
      prisma.trainerBranding.upsert.mockResolvedValue({ ...baseBranding, welcomeMessage: exactly200 });

      await expect(
        upsertBranding({ trainerId: TRAINER_ID, data: { primaryColor: '#FF5733', welcomeMessage: exactly200 } }),
      ).resolves.not.toThrow();
    });

    it('resolves S3 URLs on returned branding', async () => {
      const brandingWithLogo = { ...baseBranding, logoUrl: 'branding/logos/trainer-uuid-1.jpg' };
      prisma.trainerBranding.upsert.mockResolvedValue(brandingWithLogo);
      s3BucketHandler.resolveUrl.mockImplementation((key) =>
        key ? Promise.resolve(`https://cdn.example.com/${key}`) : Promise.resolve(null),
      );

      const result = await upsertBranding({ trainerId: TRAINER_ID, data: { primaryColor: '#FF5733' } });

      expect(result.logoUrl).toBe('https://cdn.example.com/branding/logos/trainer-uuid-1.jpg');
    });
  });

  // ─── uploadBrandingImage ───────────────────────────────────────────────────

  describe('uploadBrandingImage', () => {
    const validJpegFile = {
      mimetype: 'image/jpeg',
      buffer: Buffer.from('fake-jpeg'),
    };

    it('throws NotFoundAppError when branding does not exist', async () => {
      prisma.trainerBranding.findUnique.mockResolvedValue(null);

      await expect(
        uploadBrandingImage({ trainerId: TRAINER_ID, imageType: 'logo', file: validJpegFile }),
      ).rejects.toMatchObject({
        name: 'NotFoundAppError',
        httpStatus: 404,
        messageCode: 'branding.notFound',
      });

      expect(s3BucketHandler.uploadFile).not.toHaveBeenCalled();
    });

    it('throws ValidationAppError for invalid MIME type', async () => {
      prisma.trainerBranding.findUnique.mockResolvedValue(baseBranding);

      await expect(
        uploadBrandingImage({
          trainerId: TRAINER_ID,
          imageType: 'logo',
          file: { mimetype: 'image/gif', buffer: Buffer.from('gif') },
        }),
      ).rejects.toMatchObject({
        name: 'ValidationAppError',
        httpStatus: 400,
        messageCode: 'validation.failed',
      });

      expect(s3BucketHandler.uploadFile).not.toHaveBeenCalled();
    });

    it('throws ValidationAppError for file exceeding 5MB', async () => {
      prisma.trainerBranding.findUnique.mockResolvedValue(baseBranding);
      const largeBuffer = Buffer.alloc(6 * 1024 * 1024);

      await expect(
        uploadBrandingImage({
          trainerId: TRAINER_ID,
          imageType: 'logo',
          file: { mimetype: 'image/jpeg', buffer: largeBuffer },
        }),
      ).rejects.toMatchObject({
        name: 'ValidationAppError',
        httpStatus: 400,
        messageCode: 'validation.failed',
      });
    });

    it('generates correct S3 key for logo upload', async () => {
      prisma.trainerBranding.findUnique.mockResolvedValue(baseBranding);
      s3BucketHandler.uploadFile.mockResolvedValue(`branding/logos/${TRAINER_ID}.jpg`);
      prisma.trainerBranding.update.mockResolvedValue({
        ...baseBranding,
        logoUrl: `branding/logos/${TRAINER_ID}.jpg`,
      });
      s3BucketHandler.resolveUrl.mockResolvedValue(null);

      await uploadBrandingImage({ trainerId: TRAINER_ID, imageType: 'logo', file: validJpegFile });

      expect(s3BucketHandler.uploadFile).toHaveBeenCalledWith({
        key: `branding/logos/${TRAINER_ID}.jpg`,
        buffer: validJpegFile.buffer,
        contentType: 'image/jpeg',
      });
    });

    it('generates correct S3 key for cover upload', async () => {
      prisma.trainerBranding.findUnique.mockResolvedValue(baseBranding);
      s3BucketHandler.uploadFile.mockResolvedValue(`branding/covers/${TRAINER_ID}.png`);
      prisma.trainerBranding.update.mockResolvedValue({
        ...baseBranding,
        coverImageUrl: `branding/covers/${TRAINER_ID}.png`,
      });
      s3BucketHandler.resolveUrl.mockResolvedValue(null);

      const pngFile = { mimetype: 'image/png', buffer: Buffer.from('fake-png') };
      await uploadBrandingImage({ trainerId: TRAINER_ID, imageType: 'cover', file: pngFile });

      expect(s3BucketHandler.uploadFile).toHaveBeenCalledWith({
        key: `branding/covers/${TRAINER_ID}.png`,
        buffer: pngFile.buffer,
        contentType: 'image/png',
      });
    });

    it('updates logoUrl field after logo upload', async () => {
      const logoKey = `branding/logos/${TRAINER_ID}.jpg`;
      prisma.trainerBranding.findUnique.mockResolvedValue(baseBranding);
      s3BucketHandler.uploadFile.mockResolvedValue(logoKey);
      prisma.trainerBranding.update.mockResolvedValue({ ...baseBranding, logoUrl: logoKey });

      await uploadBrandingImage({ trainerId: TRAINER_ID, imageType: 'logo', file: validJpegFile });

      expect(prisma.trainerBranding.update).toHaveBeenCalledWith({
        where: { trainerId: TRAINER_ID },
        data: { logoUrl: logoKey },
      });
    });

    it('updates coverImageUrl field after cover upload', async () => {
      const coverKey = `branding/covers/${TRAINER_ID}.webp`;
      prisma.trainerBranding.findUnique.mockResolvedValue(baseBranding);
      s3BucketHandler.uploadFile.mockResolvedValue(coverKey);
      prisma.trainerBranding.update.mockResolvedValue({ ...baseBranding, coverImageUrl: coverKey });

      const webpFile = { mimetype: 'image/webp', buffer: Buffer.from('fake-webp') };
      await uploadBrandingImage({ trainerId: TRAINER_ID, imageType: 'cover', file: webpFile });

      expect(prisma.trainerBranding.update).toHaveBeenCalledWith({
        where: { trainerId: TRAINER_ID },
        data: { coverImageUrl: coverKey },
      });
    });

    it('deletes old logo from S3 when replacing an existing one', async () => {
      const oldLogoKey = `branding/logos/${TRAINER_ID}.png`;
      const newLogoKey = `branding/logos/${TRAINER_ID}.jpg`;
      const brandingWithLogo = { ...baseBranding, logoUrl: oldLogoKey };

      prisma.trainerBranding.findUnique.mockResolvedValue(brandingWithLogo);
      s3BucketHandler.uploadFile.mockResolvedValue(newLogoKey);
      s3BucketHandler.deleteFile.mockResolvedValue(undefined);
      prisma.trainerBranding.update.mockResolvedValue({ ...brandingWithLogo, logoUrl: newLogoKey });

      await uploadBrandingImage({ trainerId: TRAINER_ID, imageType: 'logo', file: validJpegFile });

      expect(s3BucketHandler.deleteFile).toHaveBeenCalledWith({ key: oldLogoKey });
    });

    it('does not delete old image if new key is the same', async () => {
      const sameKey = `branding/logos/${TRAINER_ID}.jpg`;
      const brandingWithLogo = { ...baseBranding, logoUrl: sameKey };

      prisma.trainerBranding.findUnique.mockResolvedValue(brandingWithLogo);
      s3BucketHandler.uploadFile.mockResolvedValue(sameKey);
      prisma.trainerBranding.update.mockResolvedValue(brandingWithLogo);

      await uploadBrandingImage({ trainerId: TRAINER_ID, imageType: 'logo', file: validJpegFile });

      expect(s3BucketHandler.deleteFile).not.toHaveBeenCalled();
    });

    it('does not delete when there is no previous image', async () => {
      const logoKey = `branding/logos/${TRAINER_ID}.jpg`;
      prisma.trainerBranding.findUnique.mockResolvedValue(baseBranding); // logoUrl: null
      s3BucketHandler.uploadFile.mockResolvedValue(logoKey);
      prisma.trainerBranding.update.mockResolvedValue({ ...baseBranding, logoUrl: logoKey });

      await uploadBrandingImage({ trainerId: TRAINER_ID, imageType: 'logo', file: validJpegFile });

      expect(s3BucketHandler.deleteFile).not.toHaveBeenCalled();
    });

    it('continues successfully even if old image deletion fails (fire-and-forget)', async () => {
      const oldKey = `branding/logos/${TRAINER_ID}.png`;
      const newKey = `branding/logos/${TRAINER_ID}.jpg`;
      prisma.trainerBranding.findUnique.mockResolvedValue({ ...baseBranding, logoUrl: oldKey });
      s3BucketHandler.uploadFile.mockResolvedValue(newKey);
      s3BucketHandler.deleteFile.mockRejectedValue(new Error('S3 delete failed'));
      prisma.trainerBranding.update.mockResolvedValue({ ...baseBranding, logoUrl: newKey });

      await expect(
        uploadBrandingImage({ trainerId: TRAINER_ID, imageType: 'logo', file: validJpegFile }),
      ).resolves.not.toThrow();
    });
  });

  // ─── getBrandingByTrainerId ────────────────────────────────────────────────

  describe('getBrandingByTrainerId', () => {
    it('returns null when no branding exists', async () => {
      prisma.trainerBranding.findUnique.mockResolvedValue(null);

      const result = await getBrandingByTrainerId({ trainerId: TRAINER_ID });

      expect(result).toBeNull();
    });

    it('returns branding with resolved S3 URLs', async () => {
      const brandingWithMedia = {
        ...baseBranding,
        logoUrl: 'branding/logos/trainer-uuid-1.jpg',
        coverImageUrl: 'branding/covers/trainer-uuid-1.png',
      };
      prisma.trainerBranding.findUnique.mockResolvedValue(brandingWithMedia);
      s3BucketHandler.resolveUrl.mockImplementation((key) =>
        key ? Promise.resolve(`https://cdn.example.com/${key}`) : Promise.resolve(null),
      );

      const result = await getBrandingByTrainerId({ trainerId: TRAINER_ID });

      expect(result.logoUrl).toBe('https://cdn.example.com/branding/logos/trainer-uuid-1.jpg');
      expect(result.coverImageUrl).toBe('https://cdn.example.com/branding/covers/trainer-uuid-1.png');
    });
  });

  // ─── getStudentTrainerBranding ─────────────────────────────────────────────

  describe('getStudentTrainerBranding', () => {
    const STUDENT_ID = 'student-user-uuid-1';

    const trainerWithBranding = {
      id: TRAINER_ID,
      gymName: 'FitGym',
      user: { firstName: 'John', lastName: 'Doe', avatarUrl: null },
      branding: baseBranding,
    };

    const trainerWithoutBranding = {
      id: TRAINER_ID,
      gymName: null,
      user: { firstName: 'Jane', lastName: null, avatarUrl: null },
      branding: null,
    };

    it('returns null when student has no trainer (no protocol, no link)', async () => {
      prisma.trainingProtocol.findFirst.mockResolvedValue(null);
      prisma.trainerStudent.findFirst.mockResolvedValue(null);

      const result = await getStudentTrainerBranding({ studentUserId: STUDENT_ID });

      expect(result).toBeNull();
    });

    it('resolves trainer from active protocol (primary path)', async () => {
      prisma.trainingProtocol.findFirst.mockResolvedValue({
        trainer: trainerWithBranding,
      });

      const result = await getStudentTrainerBranding({ studentUserId: STUDENT_ID });

      expect(prisma.trainingProtocol.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { assigneeId: STUDENT_ID, status: 'active', deletedAt: null },
        }),
      );
      expect(result.gymName).toBe('FitGym');
      expect(result.trainerName).toBe('John Doe');
      expect(result.branding).not.toBeNull();
      expect(result.branding.primaryColor).toBe('#FF5733');
      expect(result.branding.secondaryColor).toBeNull();
    });

    it('falls back to TrainerStudent link when no active protocol exists', async () => {
      prisma.trainingProtocol.findFirst.mockResolvedValue(null);
      prisma.trainerStudent.findFirst.mockResolvedValue({
        trainer: trainerWithBranding,
      });

      const result = await getStudentTrainerBranding({ studentUserId: STUDENT_ID });

      expect(prisma.trainerStudent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { studentId: STUDENT_ID },
        }),
      );
      expect(result.gymName).toBe('FitGym');
    });

    it('returns branding: null when trainer has not configured branding', async () => {
      prisma.trainingProtocol.findFirst.mockResolvedValue({
        trainer: trainerWithoutBranding,
      });

      const result = await getStudentTrainerBranding({ studentUserId: STUDENT_ID });

      expect(result.branding).toBeNull();
    });

    it('returns null gymName when trainer has no gymName', async () => {
      prisma.trainingProtocol.findFirst.mockResolvedValue({
        trainer: trainerWithoutBranding,
      });

      const result = await getStudentTrainerBranding({ studentUserId: STUDENT_ID });

      expect(result.gymName).toBeNull();
    });

    it('handles trainer with only firstName (no lastName)', async () => {
      const trainerFirstNameOnly = {
        ...trainerWithoutBranding,
        user: { firstName: 'Jane', lastName: null, avatarUrl: null },
      };
      prisma.trainingProtocol.findFirst.mockResolvedValue({
        trainer: trainerFirstNameOnly,
      });

      const result = await getStudentTrainerBranding({ studentUserId: STUDENT_ID });

      expect(result.trainerName).toBe('Jane');
    });

    it('resolves trainerAvatarUrl via S3', async () => {
      const trainerWithAvatar = {
        ...trainerWithBranding,
        user: { ...trainerWithBranding.user, avatarUrl: 'avatars/trainer-uuid-1.jpg' },
      };
      prisma.trainingProtocol.findFirst.mockResolvedValue({ trainer: trainerWithAvatar });
      s3BucketHandler.resolveUrl.mockImplementation((key) =>
        key ? Promise.resolve(`https://cdn.example.com/${key}`) : Promise.resolve(null),
      );

      const result = await getStudentTrainerBranding({ studentUserId: STUDENT_ID });

      expect(result.trainerAvatarUrl).toBe('https://cdn.example.com/avatars/trainer-uuid-1.jpg');
    });

    it('does not call trainerStudent fallback when active protocol found', async () => {
      prisma.trainingProtocol.findFirst.mockResolvedValue({ trainer: trainerWithBranding });

      await getStudentTrainerBranding({ studentUserId: STUDENT_ID });

      expect(prisma.trainerStudent.findFirst).not.toHaveBeenCalled();
    });
  });
});
