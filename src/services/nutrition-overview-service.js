import s3BucketHandler from '../config/s3-bucket-handler.js';
import { getPatientRow } from './nutritionist-patient-service.js';
import { emptyAdherence } from './nutrition-adherence-service.js';

// The patient's trainer (oldest active link) as { id, firstName, lastName, avatarUrl }; null without one.
async function findPatientTrainer(prisma, patientId) {
  const link = await prisma.trainerStudent.findFirst({
    where: { studentId: patientId, trainer: { deletedAt: null } },
    orderBy: [{ activeOnPlan: 'desc' }, { createdAt: 'asc' }],
    select: { trainer: { select: { user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } } } } },
  });
  const user = link?.trainer.user;
  if (!user) return null;
  return {
    id: user.id,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    avatarUrl: await s3BucketHandler.resolveUrl(user.avatarUrl),
  };
}

/**
 * Plan-summary header: patient row, the patient's trainer and 7-day adherence.
 */
export async function getOverview(prisma, { nutritionistId, patientId }) {
  const { row, adherence } = await getPatientRow(prisma, { nutritionistId, patientId });
  const trainer = await findPatientTrainer(prisma, patientId);
  return { patient: row, trainer, adherence7d: adherence ?? emptyAdherence() };
}
