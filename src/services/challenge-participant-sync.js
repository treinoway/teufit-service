import { ChallengeFormat, ChallengeParticipantMode } from '../constants/challenge.js';

/**
 * Live "all" mode: adds a newly linked student to the trainer's open (scheduled or running) weekly championships in all mode, counting from now.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {string} studentId - User.id of the student
 * @param {Date} [now] - entry instant of the new participant
 * @returns {Promise<number>} championships the student joined
 */
export async function joinAllModeChallenges(prisma, trainerId, studentId, now = new Date()) {
  const challenges = await prisma.challenge.findMany({
    where: {
      trainerId,
      format: ChallengeFormat.WEEKS,
      participantMode: ChallengeParticipantMode.ALL,
      cancelledAt: null,
      closedAt: null,
    },
    select: { id: true },
  });
  if (challenges.length === 0) return 0;
  const { count } = await prisma.challengeParticipant.createMany({
    data: challenges.map((challenge) => ({ challengeId: challenge.id, studentId, createdAt: now })),
    skipDuplicates: true,
  });
  return count;
}
