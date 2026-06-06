# Frontend Brief — Exercise Intensity Field

**Backend branch**: staging · **Generated**: 2026-06-05

## Elevator pitch
Trainers can now assign an ACSM cardio intensity level to any cardio exercise or exercise template, giving students clearer effort targets during cardio workouts.

## User story
As a trainer, I want to label cardio exercises with an intensity level so that my students know exactly how hard they should be working during cardio sessions.

## User flows
1. **Entry point**: Exercise editor panel — reached from a training day's exercise list, or from the Exercise Templates library.
2. **Happy path**:
   1. Trainer opens an exercise whose type is "cardio".
   2. An "Intensity" select/dropdown appears (hidden or disabled for non-cardio types).
   3. Trainer picks one of the five intensity levels.
   4. Trainer saves. The exercise card shows the intensity label (e.g., "Moderada" / "Moderate").
3. **Branches**:
   - If trainer clears the intensity (sets to none/null), the field is saved as null and the label disappears from the card.
   - If the type is not cardio, the intensity field must not be shown (or must be disabled and its value discarded). The backend will reject it with a 400.

## UI states to cover
- **Field visibility**: Show intensity select only when `type === 'cardio'`. Hide/disable otherwise.
- **Loading**: Standard save spinner on the exercise form.
- **Empty**: Intensity not set → no intensity badge on the exercise card.
- **Success**: Intensity badge rendered using `intensityLabel` (the translated string returned by the API).
- **Error (400)**: `exercise.intensityRequiresCardio` → show inline error "Intensity can only be set for cardio exercises."
- **Null label**: `intensityLabel` will be `null` when `intensity` is `null` — do not render the badge.

## API contract
### POST /trainer/trainings/:trainingId/exercises
- **Auth**: Bearer — TRAINER role
- **Request** (intensity is optional):
  ```json
  {
    "name": "Esteira",
    "type": "cardio",
    "intensity": "moderate"
  }
  ```
- **Success** (201):
  ```json
  {
    "id": "uuid",
    "type": "cardio",
    "typeLabel": "Cardio",
    "intensity": "moderate",
    "intensityLabel": "Moderada"
  }
  ```
- **Errors** (status · error · messageCode · when):
  - `400` · `VALIDATION_ERROR` · `exercise.intensityRequiresCardio` · intensity set on a non-cardio type

### PATCH /trainer/exercises/:id
- **Auth**: Bearer — TRAINER role
- **Request** (null clears the field):
  ```json
  { "intensity": null }
  ```
- **Success** (200): same shape as POST 201 response
- **Errors** (status · error · messageCode · when):
  - `400` · `VALIDATION_ERROR` · `exercise.intensityRequiresCardio` · type changed away from cardio while intensity is set, or intensity set while type is non-cardio

### POST /trainer/exercise-templates
### PATCH /trainer/exercise-templates/:id
Same intensity field and validation rules as exercises above. Response includes `intensity` + `intensityLabel`.

### POST /trainer/exercises/from-template
Intensity is inherited from the template when not explicitly overridden in the request body.

## i18n keys required
Stable messageCodes the frontend needs to translate for this feature:
- `exercise.intensityRequiresCardio` → suggested copy: "A intensidade só pode ser definida para exercícios do tipo cardio."

Categorical labels returned directly by the API (`intensityLabel`) — no client-side translation needed:
- `very_light` → "Muito leve" / "Very light"
- `light` → "Leve" / "Light"
- `moderate` → "Moderada" / "Moderate"
- `vigorous` → "Vigorosa" / "Vigorous"
- `near_maximal` → "Quase máxima" / "Near-maximal"

## Acceptance criteria
- [ ] Intensity select appears only when exercise type is "cardio"; hidden or disabled otherwise.
- [ ] All five intensity options are shown, using the `intensityLabel` value (not the raw key) for display.
- [ ] Saving a cardio exercise with an intensity level returns 201/200 with `intensityLabel` populated.
- [ ] Setting intensity to null/none clears the badge and sends `intensity: null` to the API.
- [ ] Attempting to set intensity on a strength/mobility/stretching exercise is blocked before the API call (or gracefully handles the 400 response).
- [ ] Exercise card/detail view renders an intensity badge when `intensityLabel` is not null.
- [ ] Intensity is visible in the student view as a read-only label on cardio exercises.

## Out of scope
- Filtering or searching exercises by intensity.
- Intensity on non-cardio exercise types (backend rejects this).
- AI-driven intensity suggestions.

## Open design questions
- Where exactly in the exercise card should the intensity badge appear — near the type label, or in the prescription details section?
- What visual style for the badge? Color-coded by intensity level (green to red gradient) or neutral?
- Should the intensity dropdown label read "Intensidade ACSM" or simply "Intensidade"?
- Student view: read-only text or a visual indicator (e.g., effort bar)?
