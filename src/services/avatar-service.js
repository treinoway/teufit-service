'use strict'

import { runNonCritical } from '../helpers/non-critical.js';
import { prisma } from '../db.js';
import s3BucketHandler from '../config/s3-bucket-handler.js';
import { maybeMarkProfileComplete } from './trainer-onboarding-service.js';

/**
 * Map MIME types to file extensions
 */
const MIME_TO_EXTENSION = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const ALLOWED_MIME_TYPES = Object.keys(MIME_TO_EXTENSION);
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Check if a stored avatar value is an S3 key (not an external URL).
 * @param {string} storedValue - Value from database
 * @returns {boolean}
 */
export function isS3Key(storedValue) {
  if (!storedValue) return false;
  return storedValue.startsWith('avatars/');
}

/**
 * Upload avatar for a user.
 *
 * @param {string} userId - User ID
 * @param {Object} file - File object
 * @param {string} file.filename - Original filename
 * @param {string} file.mimetype - MIME type
 * @param {Buffer} file.buffer - File buffer
 * @returns {Promise<Object>} Object with the signed avatar URL
 */
export async function uploadAvatar(userId, file) {
  // Validate userId
  if (!userId) {
    const error = new Error('User ID is required');
    error.code = 'USER_ID_REQUIRED';
    error.statusCode = 400;
    throw error;
  }

  // Validate file presence
  if (!file || !file.buffer) {
    const error = new Error('Avatar file is required');
    error.code = 'FILE_REQUIRED';
    error.statusCode = 400;
    throw error;
  }

  // Validate file type
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    const error = new Error(
      `Invalid file type. Only JPEG, PNG, and WebP images are allowed. Received: ${file.mimetype}`
    );
    error.code = 'INVALID_FILE_TYPE';
    error.statusCode = 400;
    throw error;
  }

  // Validate file size
  if (file.buffer.length > MAX_FILE_SIZE) {
    const sizeMB = (file.buffer.length / (1024 * 1024)).toFixed(2);
    const error = new Error(
      `File too large. Maximum size is 5MB. Received: ${sizeMB}MB`
    );
    error.code = 'FILE_TOO_LARGE';
    error.statusCode = 400;
    throw error;
  }

  // Get user from database
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, avatarUrl: true },
  });

  if (!user) {
    const error = new Error('User not found');
    error.code = 'USER_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }

  // Extract file extension from MIME type
  const extension = MIME_TO_EXTENSION[file.mimetype];

  // Generate S3 key: avatars/{userId}.{ext}
  const s3Key = `avatars/${userId}.${extension}`;

  // Store old avatar value for cleanup
  const oldAvatarValue = user.avatarUrl;

  try {
    // Upload file to S3 (returns the S3 key)
    const newS3Key = await s3BucketHandler.uploadFile({
      key: s3Key,
      buffer: file.buffer,
      contentType: file.mimetype,
    });

    // Store the S3 key in database (not a full URL)
    await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: newS3Key },
    });

    // Delete old avatar from S3 if it was an S3 key and differs from new one
    if (oldAvatarValue && isS3Key(oldAvatarValue) && oldAvatarValue !== newS3Key) {
      // Fire and forget - don't wait for deletion to complete
      s3BucketHandler.deleteFile({ key: oldAvatarValue }).catch((error) => {
        console.error(`Failed to delete old avatar (non-critical): ${error.message}`);
      });
    }

    await runNonCritical('Profile-complete milestone', () => maybeMarkProfileComplete({ userId }));

    // Return signed URL for the new avatar
    const avatarUrl = await s3BucketHandler.resolveUrl(newS3Key);
    return { avatarUrl };
  } catch (error) {
    // If it's already a custom error (from S3 handler), rethrow
    if (error.code === 'S3_UPLOAD_FAILED') {
      throw error;
    }

    // Database update error
    const dbError = new Error(`Failed to update user avatar: ${error.message}`);
    dbError.code = 'AVATAR_UPDATE_FAILED';
    dbError.statusCode = 500;
    dbError.originalError = error;
    throw dbError;
  }
}
