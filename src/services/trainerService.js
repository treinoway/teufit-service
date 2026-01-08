import { prisma } from '../db.js';
import _ from 'lodash';

function buildTrainerUpdateData(trainer) {
  const trainerData = {};
  if (trainer.firstName != null) trainerData.firstName = trainer.firstName;
  if (trainer.lastName != null) trainerData.lastName = trainer.lastName;
  if (trainer.birthDate != null) trainerData.birthDate = new Date(trainer.birthDate);
  if (trainer.avatar != null) trainerData.avatar = trainer.avatar;
  if (trainer.professionalDocument != null) trainerData.professionalDocument = trainer.professionalDocument;
  if (trainer.gymName != null) trainerData.gymName = trainer.gymName;
  return trainerData;
}

function buildAddressUpsertData(address) {
  return {
    street: address.street,
    streetLine2: address.streetLine2 ?? null,
    houseNumber: address.houseNumber,
    neighoborhood: address.neighoborhood ?? null,
    city: address.city,
    state: address.state ?? null,
    country: address.country,
  };
}

function buildSocialsUpsertData(socials) {
  return {
    instagram: socials.instagram ?? null,
    whatsapp: socials.whatsapp ?? null,
    x: socials.x ?? null,
    threads: socials.threads ?? null,
    youtube: socials.youtube ?? null,
  };
}

/**
 * Save trainer onboarding/profile data.
 *
 * Contract:
 * - Expects caller already authenticated and authorized (trainer role)
 * - Updates Trainer + optional Address + optional SocialNetwork
 * - Sets User.status=active
 */
export async function patch({ userId, trainer, address, socials }) {
  if (trainer == null && address == null && socials == null) {
    const err = new Error('No updates provided');
    err.code = 'NO_UPDATES';
    err.statusCode = 400;
    throw err;
  }

  return prisma.$transaction(async (tx) => {
    const existingTrainer = await tx.trainer.findUnique({ where: { userId } });
    if (!existingTrainer) {
      const err = new Error('Trainer profile missing');
      err.code = 'TRAINER_PROFILE_MISSING';
      err.statusCode = 409;
      throw err;
    }

    let trainerRow = existingTrainer;
    if (trainer) {
      trainerRow = await tx.trainer.update({
        where: { id: existingTrainer.id },
        data: buildTrainerUpdateData(trainer),
      });
    }

    let addressRow = null;
    if (address) {
      const addrData = buildAddressUpsertData(address);
      addressRow = await tx.address.upsert({
        where: { userId },
        create: { userId, ...addrData },
        update: addrData,
      });
    }

    let socialsRow = null;
    if (socials) {
      const socialData = buildSocialsUpsertData(socials);
      socialsRow = await tx.socialNetwork.upsert({
        where: { userId },
        create: { userId, ...socialData },
        update: socialData,
      });
    }

    const userRow = await tx.user.update({
      where: { id: userId },
      data: { status: 'active' },
    });

    return { user: userRow, trainer: trainerRow, address: addressRow, socials: socialsRow };
  });
}

// Backwards-compatible alias used by older routes/tests.
export const updateMyTrainerProfile = patch;

/**
 * Get the trainer profile (and related 1:1 resources) for a given userId.
 *
 * Contract:
 * - Input: userId (uuid string)
 * - Output: trainer row including the linked user + address + socials (may be null)
 */
export async function getOneByUserId(userId) {
  if (!userId) {
    const err = new Error('userId is required');
    err.code = 'USER_ID_REQUIRED';
    err.statusCode = 400;
    throw err;
  }

  const trainer = await prisma.trainer.findUnique({
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

  if (!trainer) {
    const err = new Error('Trainer profile missing');
    err.code = 'TRAINER_PROFILE_MISSING';
    err.statusCode = 404;
    throw err;
  }

  const responseTrainer = _.omit(trainer, ['user', 'userId'])
  // Flatten to match the structure returned by patch()
  // (trainer model doesn't have address/socials relations; those live on user)
  // eslint-disable-next-line no-unused-vars
  return {
   ...responseTrainer,
   address: trainer.user.address,
   socialNetworks: trainer.user.socials
  };
}
