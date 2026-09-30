# Frontend Brief — Response status on the trainer's student-anamnesis list (web)

**Backend branch**: feat/anamnesis-trainer-list-status · **Generated**: 2026-09-30

## Elevator pitch
In the student's anamnesis list, the trainer now sees at a glance where each anamnesis stands (not started, in progress, waiting for the student to confirm, answered) and gets the right action per row: fill it in with the student, or read the answers.

## User story
As a trainer, I want to see the response status of every anamnesis linked to a student so that I know which ones still need filling, which are waiting for the student, and which I can already read.

## User flows
1. **Entry point**: the student's anamnesis list in the trainer area (and the anamnesis card on the student profile if it reuses the same list data).
2. **Happy path**:
   1. Trainer opens the student's anamnesis list.
   2. Each row shows a status badge and only the actions that apply to it (see the table below).
   3. Trainer clicks "Preencher com o aluno" (existing attestation gate + wizard flow) or "Ver respostas" (existing dossier).
3. **Row rules** (all derived from the list payload, no extra request per row):

   | `response` | Badge | "Preencher com o aluno" | "Ver respostas" |
   |---|---|---|---|
   | `null` | Pendente | when `canFill` | no |
   | `status = draft` | Em preenchimento | when `canFill` | no |
   | `status = awaiting_confirmation` | Aguardando confirmação | when `canFill` | yes (`submittedAt` is set) |
   | `status = submitted` | Respondida | when `canFill` | yes (`submittedAt` is set) |

   - "Preencher com o aluno" is shown **only when `canFill` is `true`**.
   - "Ver respostas" is shown **only when `response.submittedAt` is not null**. A draft has answers stored but the trainer can never read them (the dossier answers 404 for drafts), so never link to it for drafts.
4. **Branches**:
   - Student already submitted the anamnesis themselves (`filledBy = student`, `status = submitted`): `canFill = false`. Show "Respondida" plus "Ver respostas" only.
   - Another trainer filled it in (possible with a general anamnesis linked directly by two trainers): `canFill = false` for this trainer even though the status is `awaiting_confirmation` or `submitted`. Optionally add a hint "Preenchida por outro professor" (use `filledBy = trainer` together with `canFill = false`); the backend does not expose who the other trainer is.
   - Trainer filled it and the student has not confirmed yet: `awaiting_confirmation`, `canFill = true`; the trainer can still re-fill (this resets the confirmation).
   - A `draft` row can optionally show progress from `answeredCount` (e.g. "12 respostas salvas") and last activity from `updatedAt`. `answeredCount` counts stored answers, including answers to questions the student's later choices may have hidden, so do not present it as "x of y questions".

## UI states to cover
- Loading: list skeleton while fetching.
- Empty: the trainer has not linked any anamnesis to this student (empty array): keep the existing empty state.
- Error: keep the existing list error state (401/403/404/429/500).
- Success: the rows described above.
- Null/absent data: `response` is `null` when nothing was saved yet ("Pendente"); `submittedAt` and `updatedAt` can be `null`. `filledBy` is always present when `response` is present, but is only meaningful when `status` is not `draft` (a draft is always attributed to `student` by default, do not show "Aluno" as author of a draft).
- Permissions: the endpoint is trainer-only (403 otherwise). It also fails with 404 `student.notFound` when the student is not linked to the trainer.
- Staleness: `canFill` reflects the moment of the request. A fill attempt can still answer 409 (`anamnesis.response.submittedByStudent` / `anamnesis.response.filledByAnotherTrainer`), handled by the existing fill flow; refetch the list after that.

## API contract
### GET /trainer/students/:studentId/anamneses
- **Auth**: Bearer token, role TRAINER (the student must be linked to the trainer)
- **Request**: header `app-language: pt-BR | en-US` (optional, default pt-BR)
- **Success** (200), one item per anamnesis linked by this trainer, newest first:
  ```json
  [
    {
      "id": "uuid",
      "anamnesisId": "uuid",
      "studentId": "uuid",
      "trainerId": "uuid",
      "createdAt": "2026-09-01T10:00:00.000Z",
      "anamnesis": {
        "id": "uuid", "title": "Anamnese geral", "description": null, "isGeneral": true,
        "createdAt": "2026-08-20T10:00:00.000Z",
        "sections": [ { "id": "uuid", "title": "Saúde", "order": 0 } ]
      },
      "response": {
        "status": "awaiting_confirmation",
        "statusLabel": "Aguardando confirmação",
        "filledBy": "trainer",
        "filledByLabel": "Professor",
        "submittedAt": "2026-09-29T12:10:00.000Z",
        "answeredCount": 14,
        "updatedAt": "2026-09-29T12:10:00.000Z"
      },
      "canFill": true
    },
    {
      "id": "uuid", "anamnesisId": "uuid", "studentId": "uuid", "trainerId": "uuid",
      "createdAt": "2026-09-02T10:00:00.000Z",
      "anamnesis": { "id": "uuid", "title": "Avaliação postural", "description": null, "isGeneral": false, "createdAt": "2026-08-22T10:00:00.000Z", "sections": [] },
      "response": null,
      "canFill": true
    }
  ]
  ```
  `response.status`: `draft` | `awaiting_confirmation` | `submitted`. `response.filledBy`: `student` | `trainer`. The `*Label` fields are translated by the backend, but the "Pendente / Em preenchimento / Aguardando confirmação / Respondida" badge copy above is web copy: note the backend label for `submitted` is "Enviada", so map badges from `status` rather than displaying `statusLabel` verbatim if the wording should be "Respondida". Answers are never part of this payload.
- **Errors** (status · error · messageCode · when):
  - `401` · not authenticated
  - `403` · role is not TRAINER
  - `404` · `STUDENT_NOT_FOUND` · `student.notFound` · student not linked to this trainer
  - `429` · rate limited

### GET /my/anamneses (student, mobile; additive change)
- `response` (still `null` when nothing was saved) now also carries `filledBy`, `filledByLabel` and `submittedAt`, so the trainer list and the student list share one summary shape. No new behavior is required on mobile.

## i18n keys required
Backend returns translated `statusLabel` / `filledByLabel` (honors `app-language`). Web copy needed for the list badges and actions (no new messageCodes):
- badge `null` → "Pendente"
- badge `draft` → "Em preenchimento"
- badge `awaiting_confirmation` → "Aguardando confirmação"
- badge `submitted` → "Respondida"
- action → "Preencher com o aluno"
- action → "Ver respostas"
- optional hint (`canFill = false` and `filledBy = trainer`) → "Preenchida por outro professor"

## Acceptance criteria
- [ ] Every row of the student's anamnesis list shows exactly one of the four badges, matching the table above.
- [ ] "Preencher com o aluno" is visible if and only if `canFill` is true.
- [ ] "Ver respostas" is visible if and only if `response.submittedAt` is set; draft rows never link to the dossier.
- [ ] When the student submitted the anamnesis, or another trainer filled it in, the trainer cannot start the fill flow from the list.
- [ ] Badges and action visibility update after returning from the fill flow (list refetched).
- [ ] Labels follow the app language; badge copy is consistent between pt-BR and en-US.

## Out of scope
- Any list-level filter or sort by status (for example "pending confirmation only").
- Showing draft answers to the trainer (the dossier rule stays: trainers never see drafts).
- Showing the name of the other trainer who filled the anamnesis.
- Changes to the attestation gate, the wizard or the confirmation flow on mobile.

## Open design questions
- Badge colors and icons per status (especially telling "Em preenchimento" apart from "Aguardando confirmação"), and whether "Pendente" should look neutral or call for action.
- Whether to show progress (`answeredCount`) and "last saved" (`updatedAt`) on draft rows, or keep the row minimal.
- How to present a row where `canFill = false` but the status is `awaiting_confirmation` (filled by another trainer): plain badge, or an explicit "Preenchida por outro professor" hint.
- Whether the same status badge should also appear on the anamnesis card of the student profile.
