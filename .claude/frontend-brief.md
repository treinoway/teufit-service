# Frontend Brief — Estimated Workout Duration

**Backend branch**: staging · **Generated**: 2026-05-13

## Elevator pitch
Students and trainers can now see how long a prescribed workout is expected to take before starting it. The estimated duration appears on every training card and workout detail screen.

## User story
As a student, I want to see an estimated duration for my workout before I start it, so that I can plan my session around my available time.

## User flows

1. **Entry point**: Workout screen ("My Workouts Today") and any training detail view.
2. **Happy path**:
   1. Student opens the app and sees today's workout card.
   2. The card shows an estimated duration (e.g., "≈ 45 min") below or next to the training name.
   3. Student taps the training to view the full exercise list — the detail view also shows the estimated duration.
3. **Branches**:
   - If the training has no exercises, `estimatedDurationSeconds` is `0`. The UI should suppress the label (e.g., "–" or hide the field entirely) rather than showing "0 min".
   - If the trainer adds or modifies exercises, the estimate updates automatically in the backend. Students see the updated figure on the next fetch.

## UI states to cover

- **Loading**: shimmer placeholder where the duration badge will appear.
- **Empty / zero**: `estimatedDurationSeconds === 0` — no exercises yet. Do not display "0 min"; show a neutral placeholder or hide the field.
- **Non-zero**: display a human-friendly rounded value. Convert seconds to minutes: `Math.round(estimatedDurationSeconds / 60)` — e.g., "≈ 42 min". For durations over 60 minutes you may show "1 h 15 min" — design decision for the UX team.
- **Permissions**: the field appears for both trainers (viewing their protocol) and students (their assigned workout). No role restriction.

## API contract

### GET /my/workouts/today
- **Auth**: student JWT required
- **Success** (200):
  ```json
  {
    "workouts": [
      {
        "protocol": { "id": "...", "name": "...", "startDate": "YYYY-MM-DD" },
        "targetTraining": {
          "id": "...",
          "name": "Leg Day",
          "estimatedDurationSeconds": 2580,
          "category": "strength",
          "categoryLabel": "Strength"
        },
        "isRestDay": false
      }
    ]
  }
  ```
- The field is also present on all other training endpoints:
  - `GET /trainer/protocols/:id/trainings` (list)
  - `GET /trainer/trainings/:id` (detail)
  - `GET /my/protocols/:id/trainings`
  - `GET /my/trainings/:id`
  - `POST /trainer/protocols/:id/trainings/from-template` (201 response)

### Field semantics
- `estimatedDurationSeconds` is always a non-negative integer (never null, never negative).
- `0` means no exercises are prescribed yet — treat as "unknown".
- The formula: sum of (sets × reps × 3 s + rest intervals) per principal exercise, plus 40 s transition per exercise, plus 300 s warm-up overhead. Substitutes and soft-deleted exercises are excluded.
- The value is recomputed server-side whenever exercises are added, updated (sets/reps/duration/mode/rest), or deleted. Order changes, substitute management, and training metadata edits do not change it.

## i18n keys required

No new `messageCode` values are required for this feature — the field is a number and formatting is purely client-side. Suggested display copy (add to your own i18n):

- `training.estimatedDuration` → suggested copy: "≈ {{minutes}} min"
- `training.estimatedDurationUnknown` → suggested copy: "–" (shown when value is 0)

## Acceptance criteria

- [ ] `estimatedDurationSeconds` is visible on the workout card in the Today screen.
- [ ] Duration is displayed in minutes (rounded), not in raw seconds.
- [ ] When `estimatedDurationSeconds === 0`, the field shows a neutral placeholder rather than "0 min".
- [ ] Duration value updates when the trainer modifies exercises (after re-fetching).
- [ ] Duration appears in training detail view as well as the list/card view.

## Out of scope

- Per-student calibration from historical execution data.
- Special accounting for bi-sets/supersets (treated as straight sets in the estimate).
- Frontend-side recalculation — always read from the API response.

## Open design questions

- Where exactly on the card should the duration badge appear — below the title, as a chip next to the category label, or in a meta row?
- For durations over 60 minutes, display as "1 h 15 min" or just "75 min"?
- Should the estimate be surfaced in push notifications ("Your 45-min leg workout is ready")?
- Icon to use alongside the duration (clock, timer, stopwatch)?

## Backfill note (important for staging/prod)

Existing training records have `estimatedDurationSeconds = 0` (the column default). The script at `/scripts/backfill-training-duration.js` must be run once against staging and production after the backend deployment. Until then, all existing trainings will show `0` for this field. Trainings created or imported after the deployment will have correct values immediately.
