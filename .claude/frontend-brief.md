# Frontend Brief — Trainer fills the anamnesis with the student (web)

**Backend branch**: feat/anamnesis-trainer-fill · **Generated**: 2026-09-29

## Elevator pitch
A trainer can fill in a student's anamnesis on the student's behalf (for example in person, at the gym), after attesting the student is present and authorized. The result is stored as "awaiting confirmation" until the student confirms it in the mobile app, and the dossier always shows who filled it and whether the student confirmed.

## User story
As a trainer, I want to fill the anamnesis together with a student who is next to me so that the student's record is complete without them having to do it alone on their phone, while the student still gets to confirm what was written in their name.

## User flows
1. **Entry points** (web, trainer area):
   - The anamnesis card on the student profile.
   - The student's anamnesis list (each linked anamnesis row).
   Both show a "Preencher com o aluno" action, available only when the anamnesis is linked to that student by this trainer and the student is active on the plan.
2. **Happy path**:
   1. Trainer clicks "Preencher com o aluno".
   2. **Presence attestation gate** (modal/step, before anything is loaded): "Confirmo que o aluno está presente e autorizou o preenchimento." with a required checkbox and a "Continuar" button. Nothing is requested from the backend until the box is checked; the request then carries `studentPresent=true`.
   3. The app loads the anamnesis and the current response (`GET .../fill?studentPresent=true`). If a response exists (for example the student's own draft, or a previous trainer draft), the wizard pre-fills its answers and resumes at the first step with unanswered questions.
   4. The trainer goes through the existing wizard (reuse the components of `src/pages/my/AnamnesisWizard.jsx`: step navigation, question renderers, conditional visibility, required-question validation). While going through the steps the app autosaves only the changed answers (`PATCH .../response/draft`, same behavior as the student draft, "Saved at HH:mm" from `updatedAt`).
   5. On the last step the trainer taps "Finalizar" and the app sends ALL answers plus `attestation: { studentPresent: true }` (`POST .../response`).
   6. Success screen: "Anamnese preenchida. O aluno precisa confirmar no aplicativo." The dossier now shows the response with the badge "Preenchida pelo professor · Aguardando confirmação".
3. **Dossier badges** (trainer view of a submitted response, from `status`, `filledBy`, `studentConfirmedAt`):
   - `status = awaiting_confirmation` (`filledBy = trainer`): "Preenchida pelo professor · Aguardando confirmação".
   - `status = submitted` and `filledBy = trainer`: "Confirmada pelo aluno em <studentConfirmedAt>" (keep a hint that the professor filled it).
   - `status = submitted` and `filledBy = student`: current behavior, "Enviada pelo aluno".
4. **Branches**:
   - Trainer leaves mid-way: the draft stays saved and is resumed next time (the attestation gate is shown again every time the flow is opened).
   - Trainer re-opens a response they finalized while it is still awaiting confirmation: the wizard is pre-filled and they can finalize again. This resets the confirmation (the student has to confirm again).
   - The student already submitted the anamnesis by themselves (before or while the trainer was filling): the trainer can never overwrite it. The app receives a 409 `anamnesis.response.submittedByStudent`; stop editing, reload the response and show the student's submission read-only.
   - A 409 `anamnesis.response.alreadySubmitted` on autosave (someone finalized in the meantime): stop autosaving, reload and show the current state.
   - Student later submits the form in the mobile app on top of a trainer-filled one: the response becomes student-authored and confirmed ("Enviada pelo aluno"). The dossier reflects that on next load.

## Mobile confirmation contract (for the mobile team, same backend)
- `GET /my/anamneses` returns `response.status = "awaiting_confirmation"` (label "Aguardando confirmação") for the card. The card should offer "Revisar e confirmar".
- The student opens the response (`GET /my/anamneses/:anamnesisId/response`, contains `filledBy = "trainer"` and `trainerAttestedAt`), reviews the answers, then taps "Confirmar" (`POST /my/anamneses/:anamnesisId/response/confirm`, no body). The status becomes `submitted`.
- The student can also correct the answers and send the form again (`POST .../response`), which becomes a student-authored, confirmed submission.
- Known limitation to design around: the confirm call has no version check. If the trainer re-finalizes right after the student opened the review screen, the student's confirmation applies to the new content. The mobile screen should reload the response right before showing the "Confirmar" button.

## UI states to cover
- Loading: gate accepted, fetching anamnesis + response; non-blocking indicator during autosave; disabled "Finalizar" while sending.
- Empty: `response` is `null` in the fill payload: start the wizard blank.
- Error: autosave failure (network / 5xx) must not block the trainer: keep answers in local state, show a discreet "Não foi possível salvar, tentando novamente"; the final "Finalizar" is the source of truth. Required questions unanswered on finalize: `400 validation.failed` with `details: [{ questionId, message }]`, highlight those questions.
- Success: "Saved at HH:mm" after autosave; success screen after finalize.
- Null/absent data: `trainerAttestedAt` and `studentConfirmedAt` can be `null`; `filledBy` is always present but is only meaningful when `status` is not `draft`.
- Permissions: the action must be hidden for students; a student calling these routes gets 403. The student must be active on the plan, otherwise the backend answers 403 (show the existing "student blocked on plan" message). 404 `student.notFound` when the student is not linked to the trainer; 404 `anamnesis.notLinkedToStudent` when this trainer did not link this anamnesis to the student (link it first).

## API contract
### GET /trainer/students/:studentId/anamneses/:anamnesisId/fill?studentPresent=true
- **Auth**: Bearer token, role TRAINER
- **Request**: query `studentPresent=true` is required. Missing or `false` returns 400. Send it only after the trainer ticks the attestation checkbox.
- **Success** (200):
  ```json
  {
    "anamnesis": { "id": "uuid", "title": "Anamnese geral", "sections": [ { "id": "uuid", "title": "Saúde", "questions": [ { "id": "uuid", "text": "...", "type": "single_choice", "typeLabel": "Escolha única", "required": true, "options": [], "parentQuestionId": null, "condition": null } ] } ] },
    "response": {
      "id": "uuid", "status": "draft", "statusLabel": "Rascunho",
      "filledBy": "student", "filledByLabel": "Aluno",
      "submittedAt": null, "updatedAt": "2026-09-29T12:05:00.000Z",
      "trainerAttestedAt": null, "studentConfirmedAt": null,
      "answers": [ { "questionId": "uuid", "value": "yes" } ]
    }
  }
  ```
  `response` is `null` when nothing was saved yet. The anamnesis has the same shape as `GET /trainer/anamneses/:anamnesisId`. Choice answers are stored and returned as the option text.
- **Errors** (status · error · messageCode · when):
  - `400` · `VALIDATION_ERROR` · `validation.failed` · `studentPresent` missing or not `true`
  - `403` · role is not TRAINER, or the student is blocked on the plan
  - `404` · `STUDENT_NOT_FOUND` · `student.notFound` · student not linked to this trainer
  - `404` · `ANAMNESIS_NOT_LINKED_TO_STUDENT` · `anamnesis.notLinkedToStudent` · this trainer did not link this anamnesis to this student

### PATCH /trainer/students/:studentId/anamneses/:anamnesisId/response/draft
- **Auth**: Bearer token, role TRAINER
- **Request** (1 to 300 answers; only the listed questions change; no duplicated `questionId`; an empty value `null`, `""` or `[]` clears that answer):
  ```json
  { "answers": [ { "questionId": "uuid", "value": "string | number | boolean | array | object | null" } ] }
  ```
- **Success** (200): the full response object (same shape as above, all saved answers, `status: "draft"`).
- **Errors**:
  - `400` · `VALIDATION_ERROR` · `validation.failed` · malformed body or duplicated `questionId`
  - `403` · role / plan blocked · `404` · `STUDENT_NOT_FOUND` / `ANAMNESIS_NOT_LINKED_TO_STUDENT` (as above) · `404` · `ANAMNESIS_QUESTION_NOT_FOUND` · `anamnesis.question.notFound`
  - `409` · `ANAMNESIS_RESPONSE_ALREADY_SUBMITTED` · `anamnesis.response.alreadySubmitted` · the response was already finalized by either party

### POST /trainer/students/:studentId/anamneses/:anamnesisId/response
- **Auth**: Bearer token, role TRAINER
- **Request** (all answers; `attestation` is required and `studentPresent` must be `true`):
  ```json
  { "answers": [ { "questionId": "uuid", "value": "..." } ], "attestation": { "studentPresent": true } }
  ```
- **Success** (200):
  ```json
  {
    "id": "uuid", "status": "awaiting_confirmation", "statusLabel": "Aguardando confirmação",
    "filledBy": "trainer", "filledByLabel": "Professor",
    "submittedAt": "2026-09-29T12:10:00.000Z", "trainerAttestedAt": "2026-09-29T12:10:00.000Z", "studentConfirmedAt": null,
    "answers": [ { "questionId": "uuid", "value": "..." } ]
  }
  ```
  Answers of questions hidden by conditional logic are dropped by the backend; always send the final wizard state.
- **Errors**:
  - `400` · `VALIDATION_ERROR` · `validation.failed` · attestation missing or false, required visible question unanswered (`details: [{ questionId, message }]`), duplicated `questionId`
  - `403` · role / plan blocked · `404` · `STUDENT_NOT_FOUND` / `ANAMNESIS_NOT_LINKED_TO_STUDENT` / `ANAMNESIS_QUESTION_NOT_FOUND`
  - `409` · `ANAMNESIS_RESPONSE_SUBMITTED_BY_STUDENT` · `anamnesis.response.submittedByStudent` · the student already submitted this anamnesis themselves

### GET /trainer/students/:studentId/anamneses/:anamnesisId/response (existing, extended)
- Now also returns responses that are `awaiting_confirmation`, and every response carries `status`, `statusLabel`, `filledBy`, `filledByLabel`, `trainerAttestedAt`, `studentConfirmedAt`. Drafts are still never returned here (404 `anamnesis.response.notFound`).

### POST /my/anamneses/:anamnesisId/response/confirm (mobile student)
- **Auth**: Bearer token (student). No body.
- **Success** (200): the full response with `status: "submitted"`, `filledBy: "trainer"`, `studentConfirmedAt` set.
- **Errors**:
  - `404` · `ANAMNESIS_NOT_LINKED_TO_STUDENT` · `anamnesis.notLinkedToStudent`; `404` · `ANAMNESIS_RESPONSE_NOT_FOUND` · `anamnesis.response.notFound`
  - `409` · `ANAMNESIS_RESPONSE_NOT_AWAITING_CONFIRMATION` · `anamnesis.response.notAwaitingConfirmation` · status is not `awaiting_confirmation` (draft, student-submitted, or already confirmed)

## i18n keys required
Backend returns translated `message`, `statusLabel` and `filledByLabel` (honors the `app-language` header, default pt-BR). The web app still needs its own copy for the attestation gate, buttons and badges. Stable messageCodes to handle in the UI:
- `anamnesis.response.submittedByStudent` → suggested copy: "O aluno já enviou esta anamnese."
- `anamnesis.response.notAwaitingConfirmation` → suggested copy: "Esta anamnese não está aguardando confirmação."
- `anamnesis.response.alreadySubmitted` → suggested copy: "Esta anamnese já foi enviada."
- `anamnesis.notLinkedToStudent` → suggested copy: "Esta anamnese não está vinculada a este aluno."
- `student.notFound` → suggested copy: "Aluno não encontrado ou não vinculado a você."
- `validation.failed` → suggested copy: "Responda as perguntas obrigatórias para finalizar."
- Categorical values: status `draft` "Rascunho", `awaiting_confirmation` "Aguardando confirmação", `submitted` "Enviada"; `filledBy` `student` "Aluno", `trainer` "Professor".

## Acceptance criteria
- [ ] "Preencher com o aluno" appears on the student profile anamnesis card and on the student's anamnesis list, only for anamneses this trainer linked and only for students active on the plan.
- [ ] Nothing about the response is loaded before the trainer ticks the presence attestation; unticking or cancelling never calls the backend.
- [ ] The wizard is the same one students use (same question types, conditional visibility, required validation), pre-filled with any existing draft.
- [ ] Answers are autosaved while going through steps and survive closing the page.
- [ ] Finalizing sends the attestation and shows a success state saying the student must confirm in the app.
- [ ] The dossier shows "Preenchida pelo professor · Aguardando confirmação" until the student confirms, then "Confirmada pelo aluno em <date>".
- [ ] When the student already submitted, the trainer sees a clear message and the student's answers read-only; there is no way to overwrite them.
- [ ] Re-finalizing a trainer-filled response that is still awaiting confirmation is possible and the badge stays "Aguardando confirmação".

## Out of scope
- Changing the anamnesis list endpoint or its badges (`GET /trainer/students/:studentId/anamneses`); a later change will add the response status there.
- Any trainer-side "confirm on behalf of the student"; only the student confirms.
- Notifications/push to the student about a pending confirmation.
- Editing a response the student submitted themselves.

## Open design questions
- Where exactly the "Preencher com o aluno" action sits on the profile card and the list row (primary button vs overflow menu), and its icon.
- Attestation gate as a modal or as a dedicated first wizard step; final wording of the attestation text (legal/product should approve it).
- Should the dossier keep showing the previous student draft/answers in some form after the trainer finalizes? (Today the trainer's finalize replaces all answers.)
- How prominent the "Aguardando confirmação" badge should be in the student list and whether trainers need a filter for pending confirmations.
