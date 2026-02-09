import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => {
  return {
    prisma: {
      user: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
    },
  };
});

vi.mock('../../src/config/s3-bucket-handler.js', () => {
  return {
    default: {
      uploadFile: vi.fn(),
      deleteFile: vi.fn(),
      resolveUrl: vi.fn(),
    },
  };
});

import { prisma } from '../../src/db.js';
import s3BucketHandler from '../../src/config/s3-bucket-handler.js';
import { uploadAvatar } from '../../src/services/avatar-service.js';

describe('avatar-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('uploadAvatar', () => {
    const validFile = {
      filename: 'avatar.jpg',
      mimetype: 'image/jpeg',
      buffer: Buffer.from('fake-image-data'),
    };

    const mockUser = {
      id: 'user-123',
      avatarUrl: null,
    };

    it('throws USER_ID_REQUIRED when userId is missing', async () => {
      await expect(uploadAvatar(undefined, validFile)).rejects.toMatchObject({
        code: 'USER_ID_REQUIRED',
        statusCode: 400,
        message: 'User ID is required',
      });

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(s3BucketHandler.uploadFile).not.toHaveBeenCalled();
    });

    it('throws USER_ID_REQUIRED when userId is null', async () => {
      await expect(uploadAvatar(null, validFile)).rejects.toMatchObject({
        code: 'USER_ID_REQUIRED',
        statusCode: 400,
      });
    });

    it('throws FILE_REQUIRED when file is missing', async () => {
      await expect(uploadAvatar('user-123', undefined)).rejects.toMatchObject({
        code: 'FILE_REQUIRED',
        statusCode: 400,
        message: 'Avatar file is required',
      });

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(s3BucketHandler.uploadFile).not.toHaveBeenCalled();
    });

    it('throws FILE_REQUIRED when file buffer is missing', async () => {
      const fileWithoutBuffer = {
        filename: 'avatar.jpg',
        mimetype: 'image/jpeg',
      };

      await expect(uploadAvatar('user-123', fileWithoutBuffer)).rejects.toMatchObject({
        code: 'FILE_REQUIRED',
        statusCode: 400,
      });
    });

    it('throws INVALID_FILE_TYPE for non-image files', async () => {
      const pdfFile = {
        filename: 'document.pdf',
        mimetype: 'application/pdf',
        buffer: Buffer.from('fake-pdf-data'),
      };

      await expect(uploadAvatar('user-123', pdfFile)).rejects.toMatchObject({
        code: 'INVALID_FILE_TYPE',
        statusCode: 400,
        message: expect.stringContaining('Invalid file type'),
      });

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(s3BucketHandler.uploadFile).not.toHaveBeenCalled();
    });

    it('throws INVALID_FILE_TYPE for unsupported image formats', async () => {
      const gifFile = {
        filename: 'animated.gif',
        mimetype: 'image/gif',
        buffer: Buffer.from('fake-gif-data'),
      };

      await expect(uploadAvatar('user-123', gifFile)).rejects.toMatchObject({
        code: 'INVALID_FILE_TYPE',
        statusCode: 400,
      });
    });

    it('throws FILE_TOO_LARGE when file exceeds 5MB', async () => {
      const largeBuffer = Buffer.alloc(6 * 1024 * 1024); // 6MB
      const largeFile = {
        filename: 'large-avatar.jpg',
        mimetype: 'image/jpeg',
        buffer: largeBuffer,
      };

      await expect(uploadAvatar('user-123', largeFile)).rejects.toMatchObject({
        code: 'FILE_TOO_LARGE',
        statusCode: 400,
        message: expect.stringContaining('File too large'),
      });

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(s3BucketHandler.uploadFile).not.toHaveBeenCalled();
    });

    it('throws USER_NOT_FOUND when user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(uploadAvatar('user-123', validFile)).rejects.toMatchObject({
        code: 'USER_NOT_FOUND',
        statusCode: 404,
        message: 'User not found',
      });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-123' },
        select: { id: true, avatarUrl: true },
      });
      expect(s3BucketHandler.uploadFile).not.toHaveBeenCalled();
    });

    it('successfully uploads avatar for user without existing avatar', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser);
      s3BucketHandler.uploadFile.mockResolvedValue('avatars/user-123.jpg');
      prisma.user.update.mockResolvedValue({ ...mockUser, avatarUrl: 'avatars/user-123.jpg' });
      s3BucketHandler.resolveUrl.mockResolvedValue('https://signed-url.example.com/avatars/user-123.jpg');

      const result = await uploadAvatar('user-123', validFile);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-123' },
        select: { id: true, avatarUrl: true },
      });

      expect(s3BucketHandler.uploadFile).toHaveBeenCalledWith({
        key: 'avatars/user-123.jpg',
        buffer: validFile.buffer,
        contentType: 'image/jpeg',
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-123' },
        data: { avatarUrl: 'avatars/user-123.jpg' },
      });

      expect(s3BucketHandler.resolveUrl).toHaveBeenCalledWith('avatars/user-123.jpg');
      expect(result).toEqual({ avatarUrl: 'https://signed-url.example.com/avatars/user-123.jpg' });
      expect(s3BucketHandler.deleteFile).not.toHaveBeenCalled();
    });

    it('successfully uploads PNG avatar', async () => {
      const pngFile = {
        filename: 'avatar.png',
        mimetype: 'image/png',
        buffer: Buffer.from('fake-png-data'),
      };

      prisma.user.findUnique.mockResolvedValue(mockUser);
      s3BucketHandler.uploadFile.mockResolvedValue('avatars/user-123.png');
      prisma.user.update.mockResolvedValue({ ...mockUser, avatarUrl: 'avatars/user-123.png' });
      s3BucketHandler.resolveUrl.mockResolvedValue('https://signed-url.example.com/avatars/user-123.png');

      await uploadAvatar('user-123', pngFile);

      expect(s3BucketHandler.uploadFile).toHaveBeenCalledWith({
        key: 'avatars/user-123.png',
        buffer: pngFile.buffer,
        contentType: 'image/png',
      });
    });

    it('successfully uploads WebP avatar', async () => {
      const webpFile = {
        filename: 'avatar.webp',
        mimetype: 'image/webp',
        buffer: Buffer.from('fake-webp-data'),
      };

      prisma.user.findUnique.mockResolvedValue(mockUser);
      s3BucketHandler.uploadFile.mockResolvedValue('avatars/user-123.webp');
      prisma.user.update.mockResolvedValue({ ...mockUser, avatarUrl: 'avatars/user-123.webp' });
      s3BucketHandler.resolveUrl.mockResolvedValue('https://signed-url.example.com/avatars/user-123.webp');

      await uploadAvatar('user-123', webpFile);

      expect(s3BucketHandler.uploadFile).toHaveBeenCalledWith({
        key: 'avatars/user-123.webp',
        buffer: webpFile.buffer,
        contentType: 'image/webp',
      });
    });

    it('uploads new avatar when replacing existing one', async () => {
      const userWithAvatar = {
        id: 'user-123',
        avatarUrl: 'avatars/user-123.jpg',
      };

      const newPngFile = {
        filename: 'new-avatar.png',
        mimetype: 'image/png',
        buffer: Buffer.from('fake-new-image'),
      };

      prisma.user.findUnique.mockResolvedValue(userWithAvatar);
      s3BucketHandler.uploadFile.mockResolvedValue('avatars/user-123.png');
      s3BucketHandler.deleteFile.mockResolvedValue(undefined);
      prisma.user.update.mockResolvedValue({ ...userWithAvatar, avatarUrl: 'avatars/user-123.png' });
      s3BucketHandler.resolveUrl.mockResolvedValue('https://signed-url.example.com/avatars/user-123.png');

      const result = await uploadAvatar('user-123', newPngFile);

      // Should upload new file
      expect(s3BucketHandler.uploadFile).toHaveBeenCalledWith({
        key: 'avatars/user-123.png',
        buffer: newPngFile.buffer,
        contentType: 'image/png',
      });

      // Should update database with S3 key
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-123' },
        data: { avatarUrl: 'avatars/user-123.png' },
      });

      // Should delete old avatar since it differs from new one
      expect(s3BucketHandler.deleteFile).toHaveBeenCalledWith({
        key: 'avatars/user-123.jpg',
      });

      expect(result).toEqual({ avatarUrl: 'https://signed-url.example.com/avatars/user-123.png' });
    });

    it('does not delete old avatar if it is not an S3 key', async () => {
      const userWithExternalAvatar = {
        id: 'user-123',
        avatarUrl: 'https://external-service.com/avatar.jpg',
      };

      prisma.user.findUnique.mockResolvedValue(userWithExternalAvatar);
      s3BucketHandler.uploadFile.mockResolvedValue('avatars/user-123.jpg');
      prisma.user.update.mockResolvedValue({ ...userWithExternalAvatar, avatarUrl: 'avatars/user-123.jpg' });
      s3BucketHandler.resolveUrl.mockResolvedValue('https://signed-url.example.com/avatars/user-123.jpg');

      await uploadAvatar('user-123', validFile);

      // Should not attempt to delete external URL
      expect(s3BucketHandler.deleteFile).not.toHaveBeenCalled();
    });

    it('does not delete old avatar if new avatar has same key', async () => {
      const userWithAvatar = {
        id: 'user-123',
        avatarUrl: 'avatars/user-123.jpg',
      };

      prisma.user.findUnique.mockResolvedValue(userWithAvatar);
      // uploadFile returns the same key as the old avatar
      s3BucketHandler.uploadFile.mockResolvedValue('avatars/user-123.jpg');
      prisma.user.update.mockResolvedValue(userWithAvatar);
      s3BucketHandler.resolveUrl.mockResolvedValue('https://signed-url.example.com/avatars/user-123.jpg');

      await uploadAvatar('user-123', validFile);

      // Should not delete since newS3Key equals oldAvatarValue
      expect(s3BucketHandler.deleteFile).not.toHaveBeenCalled();
    });

    it('compares against returned S3 key, not requested key, when deciding to delete old avatar', async () => {
      const userWithAvatar = {
        id: 'user-123',
        avatarUrl: 'avatars/user-123-old.jpg',
      };

      prisma.user.findUnique.mockResolvedValue(userWithAvatar);
      // uploadFile returns a different key than requested (e.g., with versioning or modified naming)
      // Requested: 'avatars/user-123.jpg', but returns: 'avatars/user-123-v2.jpg'
      s3BucketHandler.uploadFile.mockResolvedValue('avatars/user-123-v2.jpg');
      s3BucketHandler.deleteFile.mockResolvedValue(undefined);
      prisma.user.update.mockResolvedValue({ ...userWithAvatar, avatarUrl: 'avatars/user-123-v2.jpg' });
      s3BucketHandler.resolveUrl.mockResolvedValue('https://signed-url.example.com/avatars/user-123-v2.jpg');

      await uploadAvatar('user-123', validFile);

      // Should delete old avatar comparing against the RETURNED key (newS3Key)
      // not the REQUESTED key (s3Key = 'avatars/user-123.jpg')
      // Old avatar is 'avatars/user-123-old.jpg' which differs from newS3Key 'avatars/user-123-v2.jpg'
      expect(s3BucketHandler.deleteFile).toHaveBeenCalledWith({
        key: 'avatars/user-123-old.jpg',
      });
    });

    it('throws S3_UPLOAD_FAILED when S3 upload fails', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser);

      const s3Error = new Error('Network timeout');
      s3Error.code = 'S3_UPLOAD_FAILED';
      s3Error.statusCode = 502;
      s3BucketHandler.uploadFile.mockRejectedValue(s3Error);

      await expect(uploadAvatar('user-123', validFile)).rejects.toMatchObject({
        code: 'S3_UPLOAD_FAILED',
        statusCode: 502,
      });

      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('throws AVATAR_UPDATE_FAILED when database update fails', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser);
      s3BucketHandler.uploadFile.mockResolvedValue('avatars/user-123.jpg');

      const dbError = new Error('Database connection failed');
      prisma.user.update.mockRejectedValue(dbError);

      await expect(uploadAvatar('user-123', validFile)).rejects.toMatchObject({
        code: 'AVATAR_UPDATE_FAILED',
        statusCode: 500,
        message: expect.stringContaining('Failed to update user avatar'),
      });
    });

    it('continues successfully even if old avatar deletion fails', async () => {
      const userWithAvatar = {
        id: 'user-123',
        avatarUrl: 'avatars/user-123.jpg',
      };

      const newPngFile = {
        filename: 'new-avatar.png',
        mimetype: 'image/png',
        buffer: Buffer.from('fake-new-image'),
      };

      prisma.user.findUnique.mockResolvedValue(userWithAvatar);
      s3BucketHandler.uploadFile.mockResolvedValue('avatars/user-123.png');
      s3BucketHandler.deleteFile.mockRejectedValue(new Error('S3 delete failed'));
      prisma.user.update.mockResolvedValue({ ...userWithAvatar, avatarUrl: 'avatars/user-123.png' });
      s3BucketHandler.resolveUrl.mockResolvedValue('https://signed-url.example.com/avatars/user-123.png');

      // Should not throw even though deletion failed (fire and forget)
      const result = await uploadAvatar('user-123', newPngFile);

      expect(result).toEqual({ avatarUrl: 'https://signed-url.example.com/avatars/user-123.png' });
    });
  });
});
