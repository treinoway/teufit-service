import { prisma } from '../db.js';
import _ from 'lodash';
import s3BucketHandler from '../config/s3-bucket-handler.js';
import { formatDateOnly } from '../helpers/date-helpers.js';
import { NotFoundAppError, AppError } from '../errors/app-error.js';

const VALID_SERVICE_MODES = ['online', 'in_person', 'hybrid'];

function buildNutritionistUpdateData(nutritionist) {
  const nutritionistData = {};
  if (nutritionist.professionalDocument != null) nutritionistData.professionalDocument = nutritionist.professionalDocument;
  if (nutritionist.clinicName != null) nutritionistData.clinicName = nutritionist.clinicName;
  if (nutritionist.notes != null) nutritionistData.notes = nutritionist.notes;
  if (nutritionist.serviceMode != null) {
    if (!VALID_SERVICE_MODES.includes(nutritionist.serviceMode)) {
      throw new AppError({
        httpStatus: 400,
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
        message: `Invalid service mode: ${nutritionist.serviceMode}. Valid modes are: ${VALID_SERVICE_MODES.join(', ')}`,
      });
    }
    nutritionistData.serviceMode = nutritionist.serviceMode;
  }
  return nutritionistData;
}

function isProfileComplete({ user, address }) {
  const hasPersonalData =
    user.firstName != null &&
    user.lastName != null &&
    user.birthDate != null &&
    user.gender != null;

  const hasAddress =
    address != null &&
    address.line1 != null &&
    address.city != null &&
    address.state != null &&
    address.postalCode != null &&
    address.country != null;

  return hasPersonalData && hasAddress;
}

function buildNutritionistResponse({ nutritionistRow, userRow, addressRow, socialsRow, avatarUrl }) {
  const responseNutritionist = _.omit(nutritionistRow, ['userId']);
  return {
    ...responseNutritionist,
    firstName: userRow.firstName,
    lastName: userRow.lastName,
    birthDate: formatDateOnly(userRow.birthDate),
    avatarUrl,
    address: addressRow ?? null,
    socialNetworks: socialsRow ?? null,
  };
}

/**
 * Update nutritionist profile fields.
 *
 * Contract:
 * - Expects caller already authenticated and authorized (nutritionist role)
 * - Updates Nutritionist record fields
 * - Sets profileCompletedAt when all required fields are filled
 * - Returns merged profile (nutritionist + user data)
 */
export async function patch({ userId, nutritionist }) {
  if (nutritionist == null) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: 'validation.failed',
      message: 'No updates provided',
    });
  }

  const result = await prisma.$transaction(async (tx) => {
    const existingNutritionist = await tx.nutritionist.findUnique({ where: { userId } });
    if (!existingNutritionist) {
      throw new NotFoundAppError({
        message: 'Nutritionist profile not found',
        messageCode: 'nutritionist.notFound',
      });
    }

    const nutritionistData = buildNutritionistUpdateData(nutritionist);

    let nutritionistRow = existingNutritionist;
    if (Object.keys(nutritionistData).length > 0) {
      nutritionistRow = await tx.nutritionist.update({
        where: { id: existingNutritionist.id },
        data: nutritionistData,
      });
    }

    const userRow = await tx.user.findUnique({
      where: { id: userId },
      include: { address: true },
    });

    if (isProfileComplete({ user: userRow, address: userRow.address }) && nutritionistRow.profileCompletedAt == null) {
      nutritionistRow = await tx.nutritionist.update({
        where: { id: existingNutritionist.id },
        data: { profileCompletedAt: new Date() },
      });
    }

    return {
      nutritionistRow,
      userRow,
      addressRow: userRow.address,
    };
  });

  const avatarUrl = await s3BucketHandler.resolveUrl(result.userRow.avatarUrl);
  const socialsRow = await prisma.socialNetwork.findUnique({ where: { userId } });

  return buildNutritionistResponse({
    nutritionistRow: result.nutritionistRow,
    userRow: result.userRow,
    addressRow: result.addressRow,
    socialsRow,
    avatarUrl,
  });
}

/**
 * Get the nutritionist profile for a given userId.
 *
 * Contract:
 * - Input: userId (uuid string)
 * - Output: nutritionist profile including user + address + socials
 */
export async function getOneByUserId(userId) {
  if (!userId) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: 'validation.failed',
      message: 'userId is required',
    });
  }

  const nutritionist = await prisma.nutritionist.findUnique({
    where: { userId },
    include: {
      user: {
        include: {
          address: true,
          socials: true,
        },
      },
    },
  });

  if (!nutritionist) {
    throw new NotFoundAppError({
      message: 'Nutritionist profile not found',
      messageCode: 'nutritionist.notFound',
    });
  }

  const avatarUrl = await s3BucketHandler.resolveUrl(nutritionist.user.avatarUrl);

  return buildNutritionistResponse({
    nutritionistRow: _.omit(nutritionist, ['user', 'userId']),
    userRow: nutritionist.user,
    addressRow: nutritionist.user.address,
    socialsRow: nutritionist.user.socials,
    avatarUrl,
  });
}

/**
 * List all active nutritionists with a completed profile.
 *
 * Contract:
 * - No input required
 * - Filters out soft-deleted nutritionists and users with deleted accounts
 * - Only returns nutritionists with profileCompletedAt set
 * - Output: array of public nutritionist profiles
 */
export async function listNutritionists() {
  const nutritionists = await prisma.nutritionist.findMany({
    where: {
      deletedAt: null,
      profileCompletedAt: { not: null },
      user: { deletedAt: null },
    },
    include: {
      user: {
        select: {
          firstName: true,
          lastName: true,
          avatarUrl: true,
          address: { select: { city: true, state: true, country: true } },
          socials: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  return Promise.all(
    nutritionists.map(async (nutritionist) => ({
      id: nutritionist.id,
      firstName: nutritionist.user.firstName,
      lastName: nutritionist.user.lastName,
      avatarUrl: await s3BucketHandler.resolveUrl(nutritionist.user.avatarUrl),
      serviceMode: nutritionist.serviceMode,
      address: nutritionist.user.address ?? null,
      socialNetworks: nutritionist.user.socials ?? null,
    })),
  );
}
