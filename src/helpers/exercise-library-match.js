import { exerciseDedupKey } from "./exercise-name-normalize.js";

const LIBRARY_EXERCISE_SELECT = {
  id: true,
  trainerId: true,
  name: true,
  type: true,
  videoUrl: true,
  gifUrl: true,
  advancedTechniqueLinks: { select: { advancedTechniqueId: true, order: true } },
};

// Scores a library template for a name match: lower is better (media beats ownership, own beats public).
function matchRank(template, trainerId) {
  const mediaPenalty = template.videoUrl || template.gifUrl ? 0 : 2;
  const ownershipPenalty = template.trainerId === trainerId ? 0 : 1;
  return mediaPenalty + ownershipPenalty;
}

// Adds a template to the index unless a better-ranked template already holds its name.
export function addToExerciseLibraryIndex(index, template) {
  const key = exerciseDedupKey(template.name);
  if (!key) return;
  const current = index.byName.get(key);
  if (!current || matchRank(template, index.trainerId) < matchRank(current, index.trainerId)) {
    index.byName.set(key, template);
  }
}

/**
 * Loads the trainer's own and the public exercise templates, indexed by dedup name key.
 * @param {object} prismaClient - Prisma client or transaction
 * @param {string} trainerId - Trainer whose own templates are included
 * @returns {Promise<{ trainerId: string, byName: Map<string, object> }>}
 */
export async function loadExerciseLibraryIndex(prismaClient, trainerId) {
  const templates = await prismaClient.exerciseTemplate.findMany({
    where: { deletedAt: null, OR: [{ trainerId }, { isPublic: true }] },
    select: LIBRARY_EXERCISE_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
  const index = { trainerId, byName: new Map() };
  for (const template of templates) addToExerciseLibraryIndex(index, template);
  return index;
}

// Returns the library template matching an exercise name, or null.
export function findLibraryExercise(index, name) {
  return index.byName.get(exerciseDedupKey(name)) ?? null;
}

// Library link and media for a student exercise created by name; empty when nothing matched.
export function libraryExerciseFields(match) {
  if (!match) return {};
  return { exerciseTemplateId: match.id, videoUrl: match.videoUrl ?? null, gifUrl: match.gifUrl ?? null };
}
