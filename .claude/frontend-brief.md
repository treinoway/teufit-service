# Frontend Brief — Reopen a finalized anamnesis to edit it + default anamnesis cleanup

**Backend branch**: feat/anamnesis-edit-reopen-and-default-cleanup · **Generated**: 2026-09-30

## Elevator pitch
A trainer can now go back into an anamnesis they already filled in with the student, correct it, and finalize it again (the student confirms again). The default "Anamnese Completa" is also shorter (10 sections) and its menstrual-cycle section only asks follow-ups when the student says she menstruates. The "matrix" question type can no longer be created.

## User story
As a trainer, I want to correct an anamnesis I already finalized for my student so that the record is accurate, and as a student I want a shorter default anamnesis that only asks menstrual-cycle questions when they apply to me.

## User flows
1. **Entry point**: the same "Preencher com o aluno" action in the trainer's student-anamnesis list (and the existing fill wizard). Nothing new to navigate to.
2. **Happy path (edit a finalized anamnesis)**:
   1. Trainer opens the fill wizard (attestation gate as today) on a row whose status is "Aguardando confirmação" or "Respondida" and `canFill = true`.
   2. Trainer changes answers and the wizard autosaves with the existing draft call (`PATCH .../response/draft`).
   3. The first successful save **reopens** the response: its status becomes `draft` ("Em preenchimento"), the student's confirmation and the trainer's attestation are cleared.
   4. Trainer finalizes with the existing finalize call (`POST .../response`, attestation required). Status returns to "Aguardando confirmação"; the student must confirm again.
3. **Branches**:
   - While reopened (status `draft`): the trainer cannot open "Ver respostas" (404, as for any draft); the list row shows "Em preenchimento" with `canFill = true` and no "Ver respostas". The student's confirm action fails with 409 `anamnesis.response.notAwaitingConfirmation` (hide/disable it when `status != awaiting_confirmation`). The student may still save a draft on the same response.
   - Student already submitted the anamnesis themselves, or another trainer filled it in: the draft save answers 409 (`anamnesis.response.submittedByStudent` / `anamnesis.response.filledByAnotherTrainer`) and nothing is changed. This is already reflected by `canFill = false` / `canFinalize = false`; do not offer editing there.
   - Warn before the first edit of a finalized anamnesis: saving will clear the student's confirmation and hide the answers from "Ver respostas" until the trainer finalizes again.
4. **Default anamnesis changes** (no new screen): sections are renumbered 01–10; removed sections ("Hábitos de Vida", "Avaliação Clínica", "Hábitos Alimentares e Suplementação", "Relação com Alimentação") no longer appear. In "10 — Ciclo Menstrual" the first question is "Você menstrua?"; the other 5 questions are conditional children (shown only when the answer is `yes`), using the same conditional-question rendering already used elsewhere.

## UI states to cover
- Loading / Empty / Error / Success: unchanged from the fill wizard and the list.
- Null/absent data: after a reopen `submittedAt`, `studentConfirmedAt` and `trainerAttestedAt` are `null`; `filledBy` keeps its previous value but is meaningless for a draft (do not show an author for a draft).
- Permissions: trainer-only routes (403 otherwise); 404 `anamnesis.notLinkedToStudent` when this trainer did not link the anamnesis.
- Historical responses to the default anamnesis: answers to removed questions are kept but no longer shown. Answers to the 5 old menstrual questions have no answer to "Você menstrua?", so with the conditional rule they stay hidden in read-only views of old responses.
- Stale clients: a student with the old default anamnesis cached (or an in-progress draft containing answers to removed questions) gets 404 `anamnesis.question.notFound` on draft/submit until the anamnesis is refetched. Refetch the anamnesis and retry on that error.

## API contract
### PATCH /trainer/students/:studentId/anamneses/:anamnesisId/response/draft
- **Auth**: Bearer token, role TRAINER; student linked and active on the plan; this trainer linked this anamnesis to the student.
- **Request**:
  ```json
  { "answers": [ { "questionId": "uuid", "value": "any JSON" } ] }
  ```
- **Success** (200): the response with all answers; when it reopened a finalized response:
  ```json
  {
    "id": "uuid", "anamnesisId": "uuid", "studentId": "uuid",
    "status": "draft", "submittedAt": null, "studentConfirmedAt": null, "trainerAttestedAt": null,
    "filledBy": "trainer", "answers": [ { "questionId": "uuid", "value": "..." } ]
  }
  ```
- **Errors** (status · error · messageCode · when):
  - `400` · `VALIDATION_ERROR` · `validation.failed` · malformed body
  - `404` · `ANAMNESIS_NOT_LINKED_TO_STUDENT` · `anamnesis.notLinkedToStudent` · not linked by this trainer
  - `404` · `ANAMNESIS_QUESTION_NOT_FOUND` · `anamnesis.question.notFound` · unknown or removed question
  - `409` · `ANAMNESIS_RESPONSE_SUBMITTED_BY_STUDENT` · `anamnesis.response.submittedByStudent` · the student submitted it
  - `409` · `ANAMNESIS_RESPONSE_FILLED_BY_ANOTHER_TRAINER` · `anamnesis.response.filledByAnotherTrainer` · another trainer finalized it

### Unchanged but affected
- `PATCH /my/anamneses/:anamnesisId/response/draft` (student) still answers 409 `anamnesis.response.alreadySubmitted` once submitted.
- `POST /my/anamneses/:anamnesisId/response/confirm` answers 409 `anamnesis.response.notAwaitingConfirmation` while the response is reopened.
- `GET /trainer/students/:studentId/anamneses/:anamnesisId/response` answers 404 `anamnesis.response.notFound` while reopened.
- `GET .../fill` `canFinalize` keeps its meaning.

### Question type `matrix` retired (anamnesis builder, if the web has one)
- `POST/PATCH` question routes (trainer and admin) and nested `sections[].questions[]` payloads: `type: "matrix"` → `400` · `INVALID_QUESTION_TYPE` · `anamnesis.invalidQuestionType`. Offer only `free_text`, `dichotomous`, `multiple_choice`, `numeric`, `single_choice`. Existing matrix questions are still returned (`type: "matrix"`, with label) and must keep rendering read-only.

## i18n keys required
- `anamnesis.invalidQuestionType` → suggested copy: "Tipo de pergunta inválido ou não suportado." (backend already translates `message`; only needed if the client maps codes)
- `anamnesis.response.submittedByStudent` → "O aluno já enviou esta anamnese."
- `anamnesis.response.filledByAnotherTrainer` → "Esta anamnese foi preenchida por outro professor."
- `anamnesis.response.notAwaitingConfirmation` → "Esta anamnese não está aguardando confirmação."

## Acceptance criteria
- [ ] A trainer can edit a finalized anamnesis they filled in; after the first save the list shows "Em preenchimento" and "Ver respostas" disappears.
- [ ] Finalizing again returns the row to "Aguardando confirmação" and the student can confirm again.
- [ ] A trainer cannot edit an anamnesis the student submitted or another trainer filled in (clear message, no data change).
- [ ] The student cannot confirm while the anamnesis is reopened.
- [ ] The default anamnesis shows 10 sections; "Você menstrua?" reveals or hides the other 5 menstrual questions.
- [ ] No UI path creates a "matrix" question.

## Out of scope
- Showing who the other trainer is.
- Notifying the student that the anamnesis was reopened.
- Backfilling "Você menstrua?" for historical responses.

## Open design questions
- Wording and placement of the warning before editing a finalized anamnesis.
- Whether the student app should tell the student that a confirmation they gave was withdrawn because the trainer reopened it.
- How read-only views show answers of old menstrual questions that are hidden by the new conditional rule.
