// Local-dev nutritionist: a nutritionist-only account (beta access via an accepted
// TrainerInvite) linked to the first students, as if each had accepted the invite in the app.

import crypto from 'node:crypto';

import { NUTRITIONIST } from './dev-seed-data.js';
import { Roles } from '../../src/constants/roles.js';
import { InviteStatus } from '../../src/constants/trainer-invite.js';
import { PatientInviteStatus, PatientLinkStatus } from '../../src/constants/nutrition.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Creates the nutritionist user, profile, beta access and active profile; returns the Nutritionist row.
async function createNutritionist(prisma, { passwordHash, invitedByUserId, now }) {
  const user = await prisma.user.create({
    data: {
      email: NUTRITIONIST.email,
      passwordHash,
      roles: [Roles.NUTRITIONIST],
      status: 'active',
      firstName: NUTRITIONIST.firstName,
      lastName: NUTRITIONIST.lastName,
      gender: NUTRITIONIST.gender,
      birthDate: new Date(NUTRITIONIST.birthDate),
    },
  });
  await prisma.trainerInvite.create({
    data: {
      email: NUTRITIONIST.email,
      codeHash: crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
      status: InviteStatus.ACCEPTED,
      invitedByUserId,
      userId: user.id,
      expiresAt: new Date(now.getTime() + 30 * DAY_MS),
      acceptedAt: now,
    },
  });
  await prisma.userPreferences.create({ data: { userId: user.id, activeProfile: 'nutritionist' } });
  return prisma.nutritionist.create({
    data: {
      userId: user.id,
      professionalDocument: NUTRITIONIST.professionalDocument,
      clinicName: NUTRITIONIST.clinicName,
      serviceMode: NUTRITIONIST.serviceMode,
      profileCompletedAt: now,
    },
  });
}

// Records the accepted invite and the active link for one patient.
async function linkPatient(prisma, { nutritionistId, patient, now }) {
  await prisma.patientInvite.create({
    data: {
      nutritionistId,
      email: patient.email,
      status: PatientInviteStatus.ACCEPTED,
      patientId: patient.id,
      expiresAt: new Date(now.getTime() + 7 * DAY_MS),
      acceptedAt: now,
    },
  });
  await prisma.nutritionistPatient.create({
    data: { nutritionistId, patientId: patient.id, status: PatientLinkStatus.ACTIVE },
  });
}

/**
 * Seeds the dev nutritionist and links the first NUTRITIONIST.patientCount students as patients.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ passwordHash: string, invitedByUserId: string, students: Array<{ id: string, email: string }>, now?: Date }} args
 * @returns {Promise<{ nutritionistId: string, patientEmails: string[] }>}
 */
export async function seedNutritionist(prisma, { passwordHash, invitedByUserId, students, now = new Date() }) {
  const nutritionist = await createNutritionist(prisma, { passwordHash, invitedByUserId, now });
  const patients = students.slice(0, NUTRITIONIST.patientCount);
  for (const patient of patients) {
    await linkPatient(prisma, { nutritionistId: nutritionist.id, patient, now });
  }
  return { nutritionistId: nutritionist.id, patientEmails: patients.map((p) => p.email) };
}
