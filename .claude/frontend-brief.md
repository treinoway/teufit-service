# Frontend Brief — Anamnesis catalog (category + question count) and copy with a new title

**Backend branch**: feat/anamnesis-template-catalog · **Generated**: 2026-10-14

## Elevator pitch
The trainer's anamnesis list now says what each anamnesis is for (category: Triagem, Geral, Emagrecimento, Hipertrofia, Públicos específicos) and how many questions it has, can be filtered by category, and the trainer can name the copy when copying a model ("Usar este modelo") instead of getting a duplicate with the same title.

## User story
As a trainer, I want to browse the anamnesis models by category, see how long each one is, and copy one under my own title so that I can pick the right questionnaire quickly and keep my list organized.

## User flows
1. **Entry point**: the trainer's anamnesis area (the list fed by `GET /trainer/anamneses`). The frontend PR is `feat/anamnesis-template-gallery` in treinoway-web.
2. **Happy path (pick and copy a model)**:
   1. Trainer opens the gallery/list; each card shows title, category label and "N perguntas".
   2. Trainer narrows the list with a category chip/tab (`?category=`), or keeps "Todas" (no query param).
   3. Trainer chooses "Usar este modelo" on a model; a dialog pre-fills the title with the model's title (and optionally the description).
   4. Trainer confirms; `POST /trainer/anamneses/:id/copy` with `{ title, description }` creates the private copy, which keeps the model's category, and the UI navigates to it/refreshes the list.
3. **Branches**:
   - **General vs own anamneses**: `GET /trainer/anamneses` returns BOTH the trainer's own anamneses AND every general (platform) anamnesis. Tell them apart by `isGeneral`: general ones have `isGeneral: true` and `trainerId: null` and come first (then own ones, newest first). General anamneses are read-only for trainers (edit/delete/fork answer 403 `anamnesis.forbidden.general`); they can only be copied or linked to a student. Use `isGeneral` to split "Modelos" from "Minhas anamneses".
   - **Uncategorized**: `category` and `categoryLabel` are `null` for anything created before this change, for every anamnesis the trainer creates from scratch, and for the current default "Anamnese Completa". Show these under "Todas" only (or a "Sem categoria" bucket); they never match a `?category=` filter.
   - **Copy without a dialog**: sending no body keeps the current behaviour (same title and description as the source).

## UI states to cover
- Loading / Empty / Error / Success for the list and for the copy dialog.
- Empty filtered list: a category with no models returns `[]` (200), not an error.
- Null/absent data: `category`/`categoryLabel` may be `null`; `description` may be `null`; `questionCount` may be `0` (an anamnesis with no questions yet).
- Copy dialog validation: title required, 1–200 characters, not only spaces (the backend trims it and answers 400 for blank).
- Permissions: trainer-only routes (403 when the role is not TRAINER); copying another trainer's private anamnesis → 403.

## API contract
### GET /trainer/anamneses
- **Auth**: Bearer token, role TRAINER.
- **Request**: optional query `category` = `screening` | `general` | `weight_loss` | `hypertrophy` | `special_population`. Header `app-language: en-US` translates `categoryLabel` (default pt-BR).
- **Success** (200): array, general ones first.
  ```json
  [
    {
      "id": "uuid",
      "trainerId": null,
      "title": "Triagem pré-participação",
      "description": "Questionário curto de triagem",
      "category": "screening",
      "categoryLabel": "Triagem",
      "isGeneral": true,
      "version": 1,
      "parentId": null,
      "questionCount": 12,
      "sections": [{ "id": "uuid", "title": "Histórico de saúde", "order": 0 }],
      "createdAt": "2026-10-14T12:00:00.000Z",
      "updatedAt": null
    }
  ]
  ```
  `questionCount` counts every non-deleted question of the non-deleted sections, conditional (follow-up) questions included.
- **Errors** (status · error · messageCode · when):
  - `400` · `VALIDATION_ERROR` · `validation.failed` · unknown `category` value (`details[0].field = "category"`)
  - `401` · missing/invalid token
  - `403` · authenticated user is not a trainer
  - `404` · `TRAINER_PROFILE_MISSING` · `trainer.notFound` · trainer profile missing

### POST /trainer/anamneses/:anamnesisId/copy
- **Auth**: Bearer token, role TRAINER. Source must be general or owned by the trainer.
- **Request** (body optional; every field optional; unknown fields are ignored):
  ```json
  { "title": "Triagem — Turma da manhã", "description": "Texto ou null" }
  ```
  `title`: 1–200 chars, trimmed. `description`: string, or `null` to leave the copy without description. Omitted fields keep the source values.
- **Success** (201): the full anamnesis (same shape as `GET /trainer/anamneses/:id`), now with `category` and `categoryLabel`.
  ```json
  {
    "id": "uuid",
    "trainerId": "uuid",
    "title": "Triagem — Turma da manhã",
    "description": "Texto ou null",
    "category": "screening",
    "categoryLabel": "Triagem",
    "isGeneral": false,
    "version": 1,
    "parentId": null,
    "sections": [ { "id": "uuid", "title": "...", "questions": [ "..." ] } ],
    "createdAt": "2026-10-14T12:30:00.000Z",
    "updatedAt": null
  }
  ```
- **Errors** (status · error · messageCode · when):
  - `400` · `VALIDATION_ERROR` · `validation.failed` · empty, blank (spaces only) or > 200 chars title (`details[0].field = "title"`)
  - `403` · `FORBIDDEN_NOT_ANAMNESIS_OWNER` · `anamnesis.forbidden.notOwner` · another trainer's private anamnesis
  - `404` · `ANAMNESIS_NOT_FOUND` · `anamnesis.notFound` · anamnesis missing or deleted

### GET /trainer/anamneses/:anamnesisId and fork
- Detail and `POST /trainer/anamneses/:id/fork` responses also carry `category` + `categoryLabel`. A fork keeps the category.

## i18n keys required
`categoryLabel` already comes translated from the backend (pt-BR: Triagem, Geral, Emagrecimento, Hipertrofia, Públicos específicos · en-US: Screening, General, Weight loss, Hypertrophy, Special populations). If the web app keeps its own labels for the filter chips, use these raw values: `screening`, `general`, `weight_loss`, `hypertrophy`, `special_population`.
- `validation.failed` → suggested copy: "Dê um nome para a sua cópia."

## Acceptance criteria
- [ ] Each anamnesis card shows its category label (when not null) and "N perguntas".
- [ ] The trainer can filter the list by category and go back to "Todas".
- [ ] Models (`isGeneral: true`) are visually distinct from the trainer's own anamneses and offer "Usar este modelo" instead of edit/delete.
- [ ] Copying a model opens a dialog pre-filled with the model title; the created copy has the typed title and appears under "Minhas anamneses" with the model's category.
- [ ] A blank title cannot be submitted; a 400 from the backend is shown as a field error.

## Out of scope
- Seeded catalog models per category (comes in the next backend PR); until then only anamneses an admin categorizes have a category.
- Choosing or changing the category of a trainer's own anamnesis (only admins set categories; copies/forks inherit it).

## Open design questions
- Where uncategorized items appear when a category filter is active (hidden vs a "Sem categoria" chip).
- Whether the copy dialog also lets the trainer edit the description or only the title.
