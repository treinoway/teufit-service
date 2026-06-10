# Frontend Brief — Bulk Protocol Creation (Nova Rotina in One Request)

**Backend branch**: staging · **Generated**: 2026-06-10

## Elevator pitch
A trainer can now create an entire routine — protocol header, all training days, and all exercises — with a single HTTP call instead of ~50 sequential ones. The "Nova rotina → Concluir" flow that currently takes ~1 second of waterfall loading will feel instant.

## User story
As a trainer, I want to save a new routine and all its training days and exercises in one action so that the app responds immediately when I tap "Concluir" instead of showing a slow progress spinner for several seconds.

## User flows
1. **Entry point**: Trainer app → "Rotinas" tab → "Nova rotina" button → fills out protocol metadata (name, dates, level, etc.) → adds training days → adds exercises per day → taps "Concluir".
2. **Happy path**:
   1. Trainer fills protocol header fields (name, startDate, optional: description, status, expirationDate, genderOrdination, trainingLevel, type).
   2. Trainer adds one or more training days, each with name, category, weekDay, and a list of exercises.
   3. Trainer taps "Concluir".
   4. Frontend sends ONE `POST /trainer/protocols/with-trainings` with the full nested payload.
   5. Server responds 201 with the created protocol, including the `trainings` array with `estimatedDurationSeconds` already computed.
   6. Frontend navigates to the protocol detail screen.
3. **Branches**:
   - Empty routine (no training days): still valid — `trainings: []` is accepted.
   - Training day with no exercises: valid — `estimatedDurationSeconds` will be 0.
   - Trainer references an `exerciseTemplateId` or `trainingTemplateId` they do not own → 403 with specific error code.
   - Student is not linked / blocked by plan → 4xx with `platformPlan.*` messageCode.

## UI states to cover
- Loading: show spinner/skeleton while the single request is in-flight.
- Success: navigate to protocol detail. No intermediate "saving trainings…" progress steps needed anymore.
- Error — validation (400): highlight the offending field(s); the response includes a `details` array with `field` and `messageCode` per error.
- Error — assignee not found (404 · `ASSIGNEE_NOT_FOUND`): show toast "Aluno não encontrado".
- Error — template not owned (403 · `TRAINING_TEMPLATE_NOT_OWNED` / `EXERCISE_TEMPLATE_NOT_OWNED`): show toast with translated message.
- Error — student blocked on plan (from `platformPlan.studentBlockedOnPlan`): direct trainer to upgrade screen.
- Error — 5xx: generic "Algo deu errado. Tente novamente."

## API contract
### POST /trainer/protocols/with-trainings
- **Auth**: Bearer token, TRAINER role required
- **Rate limit**: 10 requests/minute
- **Request**:
  ```json
  {
    "assigneeId": "uuid",
    "name": "string (required)",
    "startDate": "YYYY-MM-DD (required)",
    "description": "string?",
    "status": "active | completed | archived (default: active)",
    "expirationDate": "YYYY-MM-DD?",
    "protocolTemplateId": "uuid?",
    "genderOrdination": "male | female | other?",
    "trainingLevel": "beginner | intermediate | advanced | athlete?",
    "type": "strength | cardio | stretching | mobility | activation?",
    "trainings": [
      {
        "name": "string (required)",
        "category": "strength | cardio | flexibility | rest | functional | mobility (required)",
        "order": 0,
        "trainingTemplateId": "uuid?",
        "description": "string?",
        "bodySegment": "upper | lower | core | full_body?",
        "weekDay": "monday | tuesday | wednesday | thursday | friday | saturday | sunday?",
        "exercises": [
          {
            "name": "string (required)",
            "type": "strength | cardio | mobility | stretching (required)",
            "order": 0,
            "exerciseTemplateId": "uuid?",
            "sets": 4,
            "prescriptionMode": "reps | duration",
            "repetitions": { "min": 8, "max": 12 },
            "duration": 60,
            "hasLoad": true,
            "suggestedLoad": 60.0,
            "restInterval": 90,
            "notes": "string?",
            "intensity": "very_light | light | moderate | vigorous | near_maximal? (cardio only)",
            "videoUrl": "string?"
          }
        ]
      }
    ]
  }
  ```
- **Success** (201):
  ```json
  {
    "id": "uuid",
    "assigneeId": "uuid",
    "trainerId": "uuid",
    "protocolTemplateId": "uuid | null",
    "name": "string",
    "description": "string | null",
    "status": "active",
    "statusLabel": "Ativo",
    "startDate": "YYYY-MM-DD",
    "expirationDate": "YYYY-MM-DD | null",
    "genderOrdination": "male | null",
    "genderOrdinationLabel": "Masculino | null",
    "trainingLevel": "intermediate | null",
    "trainingLevelLabel": "Intermediário | null",
    "type": "strength | null",
    "typeLabel": "Força | null",
    "createdAt": "ISO-datetime",
    "assignee": { "id": "uuid", "firstName": "Jane", "lastName": "Doe", "avatarUrl": "url | null" },
    "trainings": [
      {
        "id": "uuid",
        "name": "Treino A",
        "category": "strength",
        "categoryLabel": "Força",
        "order": 0,
        "estimatedDurationSeconds": 1420,
        "weekDay": "monday | null",
        "weekDayLabel": "Segunda-feira | null"
      }
    ]
  }
  ```
  Note: the response includes `trainings` metadata only — no exercises nested. To load exercises for a specific training, use the existing `GET /trainer/trainings/:id` endpoint.
- **Errors** (status · error · messageCode · when):
  - `400` · `VALIDATION_ERROR` · `validation.failed` · missing required fields, invalid enum values, unknown extra fields
  - `401` · `UNAUTHORIZED` · `auth.unauthorized` · missing/expired token
  - `403` · `FORBIDDEN` · `auth.forbidden` · authenticated user is not a TRAINER
  - `403` · `TRAINING_TEMPLATE_NOT_OWNED` · `protocol.trainingTemplateNotOwned` · a trainingTemplateId references a template not owned by this trainer
  - `403` · `EXERCISE_TEMPLATE_NOT_OWNED` · `protocol.exerciseTemplateNotOwned` · an exerciseTemplateId references a template not owned by this trainer
  - `404` · `TRAINER_PROFILE_MISSING` · `legacy.TRAINER_PROFILE_MISSING` · trainer profile not set up
  - `404` · `ASSIGNEE_NOT_FOUND` · `legacy.ASSIGNEE_NOT_FOUND` · assignee user does not exist or was deleted
  - `4xx` · various · `platformPlan.studentBlockedOnPlan` · student is blocked by trainer's plan limit
  - `429` · `TOO_MANY_REQUESTS` · `request.rateLimitExceeded` · more than 10 requests/minute

## i18n keys required
- `protocol.trainingTemplateNotOwned` → "Um ou mais modelos de treino não pertencem ao seu perfil."
- `protocol.exerciseTemplateNotOwned` → "Um ou mais modelos de exercício não pertencem ao seu perfil."

## Acceptance criteria
- [ ] "Nova rotina → Concluir" fires exactly one HTTP request (visible in network DevTools).
- [ ] The protocol detail screen loads immediately after "Concluir" without a second loading state.
- [ ] Empty routine (no training days) creates successfully.
- [ ] Validation errors on missing name or startDate show inline field errors.
- [ ] 403 for unowned template shows a user-visible error toast.
- [ ] The `estimatedDurationSeconds` value returned per training is displayed on the training card.
- [ ] `statusLabel`, `categoryLabel`, `weekDayLabel` and other `*Label` siblings are used for display — not manual enum-to-string translation on the frontend.

## Open design questions
- Should the loading state during the single bulk request use a different animation than the old waterfall (single spinner vs. step-by-step progress bar)?
- The response does NOT include exercises nested under each training — should the protocol detail screen fetch exercises lazily per training, or should a richer include be added in a follow-up?
- Should "Concluir" be disabled while the request is in-flight to prevent double-submission?
