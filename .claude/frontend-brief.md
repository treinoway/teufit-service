# Frontend Brief — Exercise Snapshot in Training Templates

**Backend branch**: staging · **Generated**: 2026-04-15

## Elevator pitch
Trainers can now edit the details of an exercise that lives inside a specific training template without changing that exercise globally across all other templates.

## User story
As a trainer, I want to edit an exercise's sets, reps, rest interval, load, and other parameters directly inside a training template so that each template can have its own independent configuration for the same exercise.

## User flows
1. **Entry point**: Training Templates section → open a template detail → exercise list within that template.
2. **Happy path**:
   1. Trainer taps or clicks on an exercise inside the template detail screen.
   2. An edit form opens pre-filled with the exercise's current snapshot values (name, type, sets, reps, duration, hasLoad, suggestedLoad, restInterval, notes, order).
   3. Trainer changes one or more fields and submits.
   4. The exercise row updates in place; no other template is affected.
3. **Branches**:
   - Trainer opens the same exercise template in a different training template — its values remain unchanged.
   - Creating a new training template and attaching exercises: optionally override any field at attach time (same form, different context).
   - Creating/updating a training template via the existing exercise list: snapshot overrides can be passed per exercise item in `exerciseTemplates[]`.

## UI states to cover
- Loading: skeleton or spinner while the PATCH request is in flight.
- Success: inline update with no full-page reload; show a brief confirmation toast.
- Error: display the error message from `error.userMessage` (e.g., exercise not found, not the template owner, validation error).
- Empty body: the PATCH requires at least one field; disable the submit button if nothing has changed.
- Permissions: the edit UI is only visible when the trainer owns the template (403 otherwise).

## API contract

### GET /trainer/training-templates/:id
- **Auth**: Bearer token, TRAINER role.
- **Success** (200): Each item in `trainingTemplateExerciseTemplates` now includes snapshot fields alongside `exerciseTemplate`:
  ```json
  {
    "id": "<junction-row-uuid>",
    "trainingTemplateId": "...",
    "exerciseTemplateId": "...",
    "order": 0,
    "name": "Supino reto",
    "type": "strength",
    "videoUrl": null,
    "sets": 4,
    "repetitions": { "min": 8, "max": 12 },
    "duration": null,
    "hasLoad": true,
    "suggestedLoad": 60.0,
    "restInterval": 90,
    "notes": null,
    "exerciseTemplate": { "id": "...", "name": "Supino reto", "type": "strength" }
  }
  ```

### PATCH /trainer/training-templates/:templateId/exercises/:exerciseId
- **Auth**: Bearer token, TRAINER role.
- **URL params**: `templateId` = training template UUID, `exerciseId` = junction row UUID (the `id` from `trainingTemplateExerciseTemplates[]`).
- **Request** (at least one field required):
  ```json
  {
    "name": "Supino inclinado",
    "sets": 5,
    "repetitions": { "min": 6, "max": 10 },
    "restInterval": 120,
    "hasLoad": true,
    "suggestedLoad": 70.0
  }
  ```
- **Success** (200): Updated junction row (same shape as above).
- **Errors**:
  - `400` · `VALIDATION_ERROR` · `validation.failed` · no fields sent or field format invalid
  - `401` · `auth.unauthorized` · session expired
  - `403` · `FORBIDDEN_NOT_TEMPLATE_OWNER` · trainer does not own the template
  - `404` · `TRAINER_PROFILE_MISSING` · trainer profile not found
  - `404` · `TEMPLATE_NOT_FOUND` · training template not found or deleted
  - `404` · `TRAINING_TEMPLATE_EXERCISE_NOT_FOUND` · junction row not found in this template

### POST /trainer/training-templates and PATCH /trainer/training-templates/:id (updated)
- `exerciseTemplates[]` items now accept snapshot override fields alongside `exerciseTemplateId`:
  ```json
  {
    "exerciseTemplateId": "<uuid>",
    "order": 0,
    "sets": 5,
    "repetitions": { "min": 6, "max": 10 },
    "restInterval": 120
  }
  ```
  Unspecified snapshot fields are copied from the source `ExerciseTemplate`.

## i18n keys required
- `trainingTemplateExercise.notFound` → suggested copy: "Exercise not found in this training template."

## Acceptance criteria
- [ ] Each exercise row inside a training template detail screen shows its own snapshot values (sets, reps, rest, load), not the global exercise template values.
- [ ] Tapping an exercise inside a template opens an edit form pre-filled with snapshot values.
- [ ] Submitting the form sends PATCH to the correct junction row URL and updates the row in the UI without affecting other templates.
- [ ] The exercise's source template (`exerciseTemplate.name`) is visible for reference but is read-only in this context.
- [ ] Error messages (not-found, forbidden, validation) are surfaced to the user.
- [ ] Creating a training template with snapshot overrides in `exerciseTemplates[]` stores the overridden values.

## Out of scope
- Editing the global `ExerciseTemplate` (separate flow in the exercise library).
- Reordering all exercises within a training template in bulk (drag-and-drop).

## Open design questions
- Should the exercise edit form be a bottom sheet, a modal, or an inline expand?
- Should snapshot values visually differ from global template values (e.g., a "customized" badge) to indicate the exercise was locally overridden?
- Where to surface the "Reset to global defaults" affordance (restore snapshot from ExerciseTemplate)?
- What is the copy for the edit screen title — "Edit exercise in template" vs "Customize exercise"?
