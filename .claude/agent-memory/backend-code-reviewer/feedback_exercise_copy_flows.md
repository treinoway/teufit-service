---
name: Exercise field copy flow checklist
description: Sites where Exercise/ExerciseTemplate/junction-row fields are copied — backend-engineer keeps missing one of them
type: feedback
---

When a new field is added to `Exercise`, `ExerciseTemplate`, or `TrainingTemplateExerciseTemplate`, ALL of these copy/import sites must be updated. Backend-engineer has missed at least one site (e.g., `training-service.js:importFromTemplate`) on multiple PRs.

**Why:** Each site is an independent snapshot — the model relation does not carry the field implicitly. A miss means the field is silently dropped to null, falling back to a heuristic if any.

**How to apply:** When reviewing a PR that adds a field to any of these models, grep for ALL of the following and verify the new field appears in each:

- `src/services/exercise-service.js` — `createExercise`, `createFromTemplate`, `updateExercise`
- `src/services/exercise-template-service.js` — `createExerciseTemplate`, `updateExerciseTemplate`
- `src/services/training-template-service.js` — `buildJunctionCreateData`, `createTrainingTemplateExercise`, `createTrainingTemplateExerciseFromTemplate`, `updateTrainingTemplateExercise`
- `src/services/training-service.js` — `importFromTemplate` (junction → Exercise expansion, EASY TO MISS)
- `src/services/training-protocol-service.js` — `createFromTemplate` (template → protocol expansion, junction → Exercise)
- `src/services/ai-training-service.js` — multiple sites: `CREATE_TRAINING_TEMPLATE`, `CREATE_PROTOCOL_TEMPLATE`, `ADD_TRAINING_TO_PROTOCOL`, `ADD_EXERCISES_TO_TRAINING`, plus `UPDATE_EXERCISE` / `UPDATE_EXERCISE_TEMPLATE` field allowlists, plus tool input JSON Schemas

Check both the create-data block AND any junction-row → Exercise mapping. If the model has a snapshot relationship (junction row copying template fields), the snapshot must be updated at link time AND when expanded into a child model.
