# Frontend Brief — Anamnesis Response Draft (autosave and resume)

**Backend branch**: feat/anamnesis-response-draft · **Generated**: 2026-09-28

## Elevator pitch
A student can answer an anamnesis in several sittings: answers are saved as they go (draft), can be resumed later, and only reach the trainer once the student explicitly finishes and sends the form. Until now the wizard was all-or-nothing, so closing the app lost everything.

## User story
As a student, I want my partial answers to be saved automatically so that I can leave the anamnesis and come back later without losing progress, and my trainer only sees it when I decide to send it.

## User flows
1. **Entry point**: "My anamneses" list (cards) and the existing wizard at `/my/anamneses/:anamnesisId/answer`.
2. **Happy path**:
   1. Student opens a pending anamnesis card. The card shows "Rascunho" (draft) with progress hint if a draft exists, or the usual "pending" state if nothing was saved (`response` is `null`).
   2. Wizard opens. If a draft exists, the app loads it (`GET .../response`) and pre-fills the answers, then resumes at the first step with unanswered questions.
   3. As the student changes step (and/or after a short debounce while typing), the app sends only the answers that changed (`PATCH .../response/draft`). A subtle "Saved at HH:mm" indicator uses `updatedAt` from the response.
   4. On the last step the student taps "Send". The app calls the existing `POST .../response` with ALL answers. Required-question validation happens only here.
   5. The card now shows "Enviada" (submitted); the trainer can now see the answers.
3. **Branches**:
   - Student clears an answer (empty text, empty selection): send the question with an empty value (`null`, `""` or `[]`) and the saved answer is removed.
   - Student changes a parent answer and children become hidden: draft keeps the hidden children's answers (student may flip back). The final POST discards the hidden ones, so always send the final payload from the wizard state.
   - Student closes the app mid-way: nothing is sent to the trainer; the draft stays.
   - A `409` on save (already submitted, for example from another device or tab): stop autosaving, reload the response and show the submitted state.
   - Resubmitting an already submitted anamnesis through POST keeps working as before (unchanged).

## UI states to cover
- Loading: fetching the draft when the wizard opens; saving indicator (non-blocking) during autosave.
- Empty: no draft (`GET .../response` returns 404 `anamnesis.response.notFound`, or `response: null` in the list) — start the wizard blank.
- Error: autosave failure (network / 5xx) must not block the student: keep answers in local state, show a discreet "Could not save, retrying" and retry on next change; the final Send is the source of truth.
- Success: "Saved at HH:mm" after a save; submitted confirmation after POST.
- Null/absent data: `response` on the list is `null` when nothing was saved; `updatedAt` inside `response` can be `null` only for legacy rows.
- Permissions: routes require login only. `404 anamnesis.notLinkedToStudent` when the anamnesis is not linked to the student.
- Trainer view: a student who only has a draft appears as "no response yet" to the trainer (404 `anamnesis.response.notFound`) — the trainer UI must not show anything about drafts.
- Progress hint: `answeredCount` counts stored answers, including answers of currently hidden conditional questions, and there is no total from the backend. Compute progress from the wizard's own visible-question list, do not rely on `answeredCount` for a percentage.

## API contract
### PATCH /my/anamneses/:anamnesisId/response/draft
- **Auth**: Bearer token (any authenticated user; the anamnesis must be linked to them)
- **Request** (1 to 300 answers; only the listed questions are changed, the rest is preserved; no duplicated `questionId`):
  ```json
  { "answers": [ { "questionId": "uuid", "value": "string | number | boolean | array | object | null" } ] }
  ```
  An empty value (`null`, blank string, empty array) clears that question's saved answer.
- **Success** (200):
  ```json
  {
    "id": "uuid", "anamnesisId": "uuid", "studentId": "uuid",
    "submittedAt": null,
    "createdAt": "2026-09-28T12:00:00.000Z", "updatedAt": "2026-09-28T12:05:00.000Z",
    "status": "draft", "statusLabel": "Rascunho",
    "answers": [ { "id": "uuid", "responseId": "uuid", "questionId": "uuid", "value": "yes", "createdAt": "...", "updatedAt": "..." } ]
  }
  ```
  `answers` contains all saved answers, not just the ones sent. Choice answers are stored as option text, exactly as before.
- **Errors** (status · error · messageCode · when):
  - `400` · `VALIDATION_ERROR` · `validation.failed` · malformed body, 0 or more than 300 answers, or duplicated `questionId` (`details: [{ questionId, message }]`)
  - `401` · `UNAUTHORIZED` · `auth.unauthorized` · no or invalid token
  - `404` · `ANAMNESIS_NOT_LINKED_TO_STUDENT` · `anamnesis.notLinkedToStudent` · anamnesis not linked to the student
  - `404` · `ANAMNESIS_QUESTION_NOT_FOUND` · `anamnesis.question.notFound` · a `questionId` does not belong to this anamnesis (or was deleted)
  - `409` · `ANAMNESIS_RESPONSE_ALREADY_SUBMITTED` · `anamnesis.response.alreadySubmitted` · the response was already sent; drafts can no longer be edited

### GET /my/anamneses/:anamnesisId/response (changed)
- Now also returns `status` (`"draft"` or `"submitted"`) and `statusLabel`. `submittedAt` is `null` while draft. 404 `anamnesis.response.notFound` when nothing has been saved.

### POST /my/anamneses/:anamnesisId/response (behavior unchanged, now the "Send" action)
- Same request and validation as today (required visible questions, hidden answers dropped). Response now also includes `status: "submitted"` and `statusLabel`.

### GET /my/anamneses (changed)
- Each item gains:
  ```json
  { "response": { "status": "draft", "statusLabel": "Rascunho", "answeredCount": 4, "updatedAt": "2026-09-28T12:05:00.000Z" } }
  ```
  `response` is `null` when the student has not saved anything. `statusLabel` follows the `app-language` header (`pt-BR` default, `en-US`).

### GET /trainer/students/:studentId/anamneses/:anamnesisId/response (changed)
- **Auth**: TRAINER
- Returns only submitted responses (now including `status: "submitted"`). Returns `404` · `ANAMNESIS_RESPONSE_NOT_FOUND` · `anamnesis.response.notFound` when the student only has a draft.

## i18n keys required
The backend already returns translated `statusLabel` and error `message`; add client copy only if the app maps messageCodes itself:
- `anamnesis.response.alreadySubmitted` → suggested copy: "Esta anamnese já foi enviada."
- `anamnesis.response.notFound` → existing key, now also returned to trainers for draft-only students: "Nenhuma resposta encontrada para esta anamnese."
- New UI-only copy the designer must define: "Salvo às HH:mm", "Não foi possível salvar. Tentaremos novamente.", "Continuar de onde parou".

## Acceptance criteria
- [ ] A student who leaves the wizard halfway and returns finds previous answers pre-filled and resumes at the first unanswered step.
- [ ] Changing steps or pausing typing saves the draft without blocking the UI, and shows when it was last saved.
- [ ] The My anamneses card shows Draft or Submitted from `response.status`, and the blank pending state when `response` is `null`.
- [ ] Required questions are only enforced when tapping Send, not while saving progress.
- [ ] Clearing an answer and returning later shows it still cleared.
- [ ] If saving returns 409, the app stops autosaving and shows the submitted state.
- [ ] The trainer never sees a draft-only response.
- [ ] Sending an anamnesis makes it visible to the trainer as before.

## Out of scope
- Discarding or deleting a draft ("start over") — no endpoint exists.
- Editing an anamnesis after it was submitted.
- Notifying the trainer about drafts.
- Server-side progress percentage or per-question totals.
- Offline queueing of draft saves beyond in-memory retry.

## Open design questions
- Where and how the "Saved at" indicator appears in the wizard, and how discreet the failed-save state is.
- Debounce interval and whether to also save on step change and on app backgrounding.
- Draft card design: badge only, or badge plus a local progress bar computed from visible questions.
- Copy for the resume affordance ("Continuar" versus "Responder").
- Whether re-answering an already submitted anamnesis (POST still allowed) should remain reachable from the UI at all.
