import { prisma } from '../db.js';
import s3BucketHandler from '../config/s3-bucket-handler.js';
import { NotFoundAppError, ValidationAppError } from '../errors/app-error.js';
import {
  HEX_COLOR_REGEX,
  WELCOME_MESSAGE_MAX_LENGTH,
  BRANDING_S3_PREFIXES,
} from '../constants/branding.js';
import { TrainingStatus } from '../constants/training.js';

const MIME_TO_EXTENSION = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const ALLOWED_MIME_TYPES = Object.keys(MIME_TO_EXTENSION);
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

function validatePrimaryColor(primaryColor) {
  if (!HEX_COLOR_REGEX.test(primaryColor)) {
    throw new ValidationAppError({
      message: 'primaryColor must be a valid hex color (e.g. #FF5733)',
      details: [{ field: 'primaryColor', message: 'Must match pattern ^#[0-9A-Fa-f]{6}$' }],
    });
  }
}

function validateSecondaryColor(secondaryColor) {
  if (secondaryColor != null && !HEX_COLOR_REGEX.test(secondaryColor)) {
    throw new ValidationAppError({
      message: 'secondaryColor must be a valid hex color (e.g. #FF5733)',
      details: [{ field: 'secondaryColor', message: 'Must match pattern ^#[0-9A-Fa-f]{6}$' }],
    });
  }
}

function validateWelcomeMessage(welcomeMessage) {
  if (welcomeMessage != null && welcomeMessage.length > WELCOME_MESSAGE_MAX_LENGTH) {
    throw new ValidationAppError({
      message: `welcomeMessage must be at most ${WELCOME_MESSAGE_MAX_LENGTH} characters`,
      details: [{ field: 'welcomeMessage', message: `Must be at most ${WELCOME_MESSAGE_MAX_LENGTH} characters` }],
    });
  }
}

function buildS3KeyForImage(trainerId, imageType, mimeType) {
  const extension = MIME_TO_EXTENSION[mimeType];
  const prefix = imageType === 'logo' ? BRANDING_S3_PREFIXES.LOGO : BRANDING_S3_PREFIXES.COVER;
  return `${prefix}/${trainerId}.${extension}`;
}

async function resolveBrandingUrls(branding) {
  if (!branding) return null;

  const [logoUrl, coverImageUrl] = await Promise.all([
    s3BucketHandler.resolveUrl(branding.logoUrl),
    s3BucketHandler.resolveUrl(branding.coverImageUrl),
  ]);

  return {
    ...branding,
    logoUrl,
    coverImageUrl,
  };
}

/**
 * Upsert trainer branding configuration.
 *
 * Contract:
 * - trainerId: Trainer.id (not User.id)
 * - data: { primaryColor (required, hex), secondaryColor (optional, hex), welcomeMessage (optional, max 200 chars) }
 * - Throws ValidationAppError for invalid inputs
 * - Returns the branding record with resolved S3 URLs
 */
export async function upsertBranding({ trainerId, data }) {
  validatePrimaryColor(data.primaryColor);
  validateSecondaryColor(data.secondaryColor);
  validateWelcomeMessage(data.welcomeMessage);

  const upsertData = {
    primaryColor: data.primaryColor,
    secondaryColor: data.secondaryColor !== undefined ? data.secondaryColor : null,
    welcomeMessage: data.welcomeMessage !== undefined ? data.welcomeMessage : null,
  };

  const branding = await prisma.trainerBranding.upsert({
    where: { trainerId },
    create: { trainerId, ...upsertData },
    update: upsertData,
  });

  return resolveBrandingUrls(branding);
}

/**
 * Upload a logo or cover image for a trainer's branding.
 *
 * Contract:
 * - trainerId: Trainer.id
 * - imageType: 'logo' | 'cover'
 * - file: { mimetype, buffer }
 * - Throws NotFoundAppError if branding does not exist yet
 * - Throws ValidationAppError for invalid MIME type or file too large
 * - Returns updated branding with resolved S3 URLs
 */
export async function uploadBrandingImage({ trainerId, imageType, file }) {
  const branding = await prisma.trainerBranding.findUnique({
    where: { trainerId },
  });

  if (!branding) {
    throw new NotFoundAppError({
      message: 'Branding configuration not found. Create branding first via PUT /trainer/branding',
      messageCode: 'branding.notFound',
    });
  }

  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    throw new ValidationAppError({
      message: `Invalid file type. Only JPEG, PNG, and WebP are allowed. Received: ${file.mimetype}`,
      details: [{ field: 'file', message: 'Must be image/jpeg, image/png, or image/webp' }],
    });
  }

  if (file.buffer.length > MAX_FILE_SIZE_BYTES) {
    const sizeMB = (file.buffer.length / (1024 * 1024)).toFixed(2);
    throw new ValidationAppError({
      message: `File too large. Maximum size is 5MB. Received: ${sizeMB}MB`,
      details: [{ field: 'file', message: 'Must be smaller than 5MB' }],
    });
  }

  const s3Key = buildS3KeyForImage(trainerId, imageType, file.mimetype);
  const fieldName = imageType === 'logo' ? 'logoUrl' : 'coverImageUrl';
  const oldValue = branding[fieldName];

  const uploadedKey = await s3BucketHandler.uploadFile({
    key: s3Key,
    buffer: file.buffer,
    contentType: file.mimetype,
  });

  const updatedBranding = await prisma.trainerBranding.update({
    where: { trainerId },
    data: { [fieldName]: uploadedKey },
  });

  if (oldValue && oldValue !== uploadedKey) {
    s3BucketHandler.deleteFile({ key: oldValue }).catch((deleteError) => {
      console.error(`Failed to delete old branding image (non-critical): ${deleteError.message}`);
    });
  }

  return resolveBrandingUrls(updatedBranding);
}

/**
 * Get the branding for the authenticated trainer.
 *
 * Contract:
 * - trainerId: Trainer.id
 * - Returns branding with resolved S3 URLs, or null if not configured
 */
export async function getBrandingByTrainerId({ trainerId }) {
  const branding = await prisma.trainerBranding.findUnique({
    where: { trainerId },
  });

  return resolveBrandingUrls(branding);
}

/**
 * Resolve the active trainer for a student and return their branding.
 *
 * Resolution order:
 * 1. Trainer with the most recent active TrainingProtocol assigned to the student
 * 2. Fallback: trainer with the most recent TrainerStudent link
 * 3. If no trainer found, returns null
 *
 * Contract:
 * - studentUserId: User.id of the student
 * - Returns { gymName, trainerName, trainerAvatarUrl, branding } or null
 */
export async function getStudentTrainerBranding({ studentUserId }) {
  // findFirst is intentional: we pick the trainer from the most recent active protocol.
  // The assumption is that when a student has multiple active protocols, they all belong
  // to the same trainer (a trainer assigns both, e.g. strength + mobility). In the rare
  // case of two different trainers, we show the most-recently-created protocol's trainer,
  // which is the best approximation without a formal "primary trainer" concept.
  const activeProtocol = await prisma.trainingProtocol.findFirst({
    where: {
      assigneeId: studentUserId,
      status: TrainingStatus.ACTIVE,
      deletedAt: null,
    },
    include: {
      trainer: {
        include: {
          user: { select: { firstName: true, lastName: true, avatarUrl: true } },
          branding: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (activeProtocol) {
    return buildBrandingResponse(activeProtocol.trainer);
  }

  const trainerStudentLink = await prisma.trainerStudent.findFirst({
    where: { studentId: studentUserId },
    include: {
      trainer: {
        include: {
          user: { select: { firstName: true, lastName: true, avatarUrl: true } },
          branding: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!trainerStudentLink) {
    return null;
  }

  return buildBrandingResponse(trainerStudentLink.trainer);
}

async function buildBrandingResponse(trainer) {
  const trainerAvatarUrl = await s3BucketHandler.resolveUrl(trainer.user.avatarUrl);

  const brandingWithUrls = await resolveBrandingUrls(trainer.branding);

  return {
    gymName: trainer.gymName ?? null,
    trainerName: [trainer.user.firstName, trainer.user.lastName].filter(Boolean).join(' ') || null,
    trainerAvatarUrl,
    branding: brandingWithUrls
      ? {
          primaryColor: brandingWithUrls.primaryColor,
          secondaryColor: brandingWithUrls.secondaryColor ?? null,
          logoUrl: brandingWithUrls.logoUrl,
          coverImageUrl: brandingWithUrls.coverImageUrl,
          welcomeMessage: brandingWithUrls.welcomeMessage ?? null,
        }
      : null,
  };
}
