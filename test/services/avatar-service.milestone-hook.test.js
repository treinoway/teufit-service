import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn() } },
}));

vi.mock('../../src/config/s3-bucket-handler.js', () => ({
  default: { uploadFile: vi.fn(), deleteFile: vi.fn(), resolveUrl: vi.fn() },
}));

vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkProfileComplete: vi.fn(),
}));

import { prisma } from '../../src/db.js';
import s3BucketHandler from '../../src/config/s3-bucket-handler.js';
import { maybeMarkProfileComplete } from '../../src/services/trainer-onboarding-service.js';
import { uploadAvatar } from '../../src/services/avatar-service.js';

const USER_ID = 'user-123';
const SIGNED_URL = 'https://signed-url.example.com/avatars/user-123.jpg';
const VALID_FILE = { filename: 'avatar.jpg', mimetype: 'image/jpeg', buffer: Buffer.from('img') };

describe('uploadAvatar profile-complete milestone hook', () => {
  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, avatarUrl: null });
    prisma.user.update.mockResolvedValue({});
    s3BucketHandler.uploadFile.mockResolvedValue(`avatars/${USER_ID}.jpg`);
    s3BucketHandler.resolveUrl.mockResolvedValue(SIGNED_URL);
    maybeMarkProfileComplete.mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('should call maybeMarkProfileComplete with the userId after the avatar is stored', async () => {
    await uploadAvatar(USER_ID, VALID_FILE);

    expect(maybeMarkProfileComplete).toHaveBeenCalledWith({ userId: USER_ID });
    expect(maybeMarkProfileComplete.mock.invocationCallOrder[0]).toBeGreaterThan(
      prisma.user.update.mock.invocationCallOrder[0],
    );
  });

  it('should still return the avatar url when the milestone hook rejects', async () => {
    maybeMarkProfileComplete.mockRejectedValue(new Error('milestone failed'));

    await expect(uploadAvatar(USER_ID, VALID_FILE)).resolves.toEqual({ avatarUrl: SIGNED_URL });
  });

  it('should log the milestone failure as non-critical', async () => {
    maybeMarkProfileComplete.mockRejectedValue(new Error('milestone failed'));

    await uploadAvatar(USER_ID, VALID_FILE);

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('milestone failed'));
  });
});
