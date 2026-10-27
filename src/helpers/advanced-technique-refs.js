const TECHNIQUE_REF_SELECT = Object.freeze({
  id: true,
  key: true,
  name: true,
  description: true,
  videoUrl: true,
  gifUrl: true,
  deletedAt: true,
  trainerId: true,
});

// Prisma include for a link relation: ordered links carrying the technique fields exposed to clients.
export const ADVANCED_TECHNIQUE_LINKS_INCLUDE = Object.freeze({
  orderBy: { order: 'asc' },
  include: { advancedTechnique: { select: TECHNIQUE_REF_SELECT } },
});

// Include fragment to spread into any parent query (exercise, exercise template, training template junction).
export const advancedTechniqueLinksInclude = Object.freeze({
  advancedTechniqueLinks: ADVANCED_TECHNIQUE_LINKS_INCLUDE,
});

// Keeps only links a viewer may see (system or own techniques), re-indexed; no viewer means no filtering.
function filterLinksForViewer(links, viewerTrainerId) {
  if (viewerTrainerId === undefined) return links ?? [];
  return (links ?? [])
    .filter(({ advancedTechnique }) => advancedTechnique.trainerId === null || advancedTechnique.trainerId === viewerTrainerId)
    .map((link, index) => ({ ...link, order: index }));
}

// Maps link rows to the public `advancedTechniques` ref array, ordered by `order` (hides other trainers' private techniques when a viewer is given).
export function toAdvancedTechniqueRefs(links, viewerTrainerId) {
  return filterLinksForViewer(links, viewerTrainerId).map((link) => ({
    id: link.advancedTechnique.id,
    key: link.advancedTechnique.key,
    name: link.advancedTechnique.name,
    description: link.advancedTechnique.description,
    videoUrl: link.advancedTechnique.videoUrl,
    gifUrl: link.advancedTechnique.gifUrl,
    isDeleted: Boolean(link.advancedTechnique.deletedAt),
    order: link.order,
  }));
}

// Replaces the internal link relation of an entity with the public `advancedTechniques` array (no-op when not loaded).
export function withAdvancedTechniqueRefs(entity, viewerTrainerId) {
  if (!entity || !('advancedTechniqueLinks' in entity)) return entity;
  const { advancedTechniqueLinks, ...rest } = entity;
  return { ...rest, advancedTechniques: toAdvancedTechniqueRefs(advancedTechniqueLinks, viewerTrainerId) };
}

// Applies withAdvancedTechniqueRefs to every junction row of a training template.
export function withJunctionTechniqueRefs(trainingTemplate, viewerTrainerId) {
  if (!trainingTemplate?.trainingTemplateExerciseTemplates) return trainingTemplate;
  return {
    ...trainingTemplate,
    trainingTemplateExerciseTemplates: trainingTemplate.trainingTemplateExerciseTemplates.map((junction) =>
      withAdvancedTechniqueRefs(junction, viewerTrainerId)),
  };
}

// Converts existing link rows into a fresh ordered selection ({ advancedTechniqueId, order }) for copying.
export function selectionFromLinks(links) {
  return (links ?? [])
    .slice()
    .sort((left, right) => left.order - right.order)
    .map((link, index) => ({ advancedTechniqueId: link.advancedTechniqueId, order: index }));
}

// Builds the `advancedTechniqueLinks` nested-create entry of a parent create, or {} when there is nothing to link.
export function toLinkCreateInput(selection) {
  return selection?.length ? { advancedTechniqueLinks: { create: selection } } : {};
}

// Replaces all links of one parent row with the given selection (delete + createMany).
export async function replaceAdvancedTechniqueLinks(linkDelegate, parentField, parentId, selection) {
  await linkDelegate.deleteMany({ where: { [parentField]: parentId } });
  if (selection.length === 0) return;
  await linkDelegate.createMany({
    data: selection.map((item) => ({ ...item, [parentField]: parentId })),
  });
}

// Applies withAdvancedTechniqueRefs to every exercise of a training.
export function withTrainingExerciseTechniqueRefs(training) {
  if (!training?.exercises) return training;
  return { ...training, exercises: training.exercises.map((exercise) => withAdvancedTechniqueRefs(exercise)) };
}

// Applies withAdvancedTechniqueRefs to the exercise of every exercise log of a workout session.
export function withSessionTechniqueRefs(session) {
  if (!session?.exerciseLogs) return session;
  return {
    ...session,
    exerciseLogs: session.exerciseLogs.map((exerciseLog) => ({
      ...exerciseLog,
      exercise: withAdvancedTechniqueRefs(exerciseLog.exercise),
    })),
  };
}
