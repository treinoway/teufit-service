# Frontend Brief — Anamnesis: Conditional Questions

**Backend branch**: staging · **Generated**: 2026-04-23

## Elevator pitch
Trainers can now mark any question as "only show if [parent question] = [value]". Students filling in an anamnesis see those questions appear and disappear live as they answer earlier questions in the same section.

## User story
As a trainer, I want to link a question to a parent question's answer so that my students only see follow-up questions that are relevant to their situation.

## User flows

1. **Entry point**: Trainer → Anamnesis editor → Canvas view of a section's questions (CanvasQuestionCard).
2. **Happy path — linking a condition**:
   1. Trainer expands a question card and scrolls to the new "Condição de exibição" section.
   2. Trainer opens the "Mostrar somente se..." dropdown. It lists all eligible questions in the **same section** (dichotomous, single choice, or multiple choice) that do not already have a parent.
   3. Trainer selects a parent question. A trigger-value picker appears below:
      - **Dichotomous parent** → two radio options: "Sim" / "Não".
      - **Single choice parent** → radio list of the parent's options.
      - **Multiple choice parent** → checkbox list of the parent's options with hint "mostrar se qualquer uma estiver marcada".
   4. Trainer picks a trigger value and saves the question.
3. **Removing a condition**: Trainer clicks "Remover condição" in the same UI section → `parentQuestionId` and `condition` are sent as `null` on the next save.
4. **Outline panel nesting**: conditional children are visually indented under their parent with a small "↳ condicional" badge but keep their existing `order` number.
5. **Student form (MyAnamneses)**:
   1. Student opens an anamnesis and sees all top-level questions.
   2. As the student answers a parent question, child questions appear or disappear immediately.
   3. When a child is hidden (parent answer doesn't match), any value the student had previously entered in that child is cleared from form state.
   4. The required-field gate runs only on visible questions.
6. **Preview modal**: trainer sees the same show/hide behavior when previewing the anamnesis. A static hint label above each conditional question reads: "Condicional: mostrado se «[parent question text]» = «[value]»".

## UI states to cover

- **Dropdown empty state**: if there are no eligible parent questions in the section, show a disabled dropdown or a hint "Nenhuma pergunta elegível nesta seção."
- **Child hidden / shown**: smooth toggle (e.g., fade or slide) — avoid jarring jump.
- **Stale value cleared**: when a child becomes hidden because the user changed the parent answer, the child's input is reset to empty so the stale value isn't submitted.
- **Server-side errors**: if the API returns one of the error messageCodes listed below, surface it as a toast.
- **Type selector disabled hint**: if a question has conditional children, the type selector should show a tooltip: "Não é possível alterar o tipo enquanto houver perguntas condicionais vinculadas." The server enforces this; the UI is a courtesy hint only.
- **Parent deleted**: when a parent question is deleted server-side, its former children become unconditional (always visible) — no special UI handling needed beyond a normal reload.

## API contract

### POST /anamneses/:anamnesisId/sections/:sectionId/questions
- **Auth**: Bearer token, role TRAINER
- **Request** (new optional fields):
  ```json
  {
    "text": "Há quanto tempo você treina?",
    "type": "numeric",
    "required": true,
    "parentQuestionId": "<uuid of parent>",
    "condition": { "operator": "equals", "value": "yes" }
  }
  ```
- **Success** (201): returns full question object (see response shape below)
- **Errors**:
  - `400` · `PARENT_NOT_ELIGIBLE` · `anamnesis.parentNotEligible` · parent type is free_text / numeric / matrix
  - `400` · `PARENT_MUST_BE_SAME_SECTION` · `anamnesis.parentMustBeSameSection` · parent is in a different section
  - `400` · `INVALID_CONDITION` · `anamnesis.invalidCondition` · condition shape doesn't match parent type
  - `400` · `CONDITIONAL_DEPTH_EXCEEDED` · `anamnesis.conditionalDepthExceeded` · parent itself already has a parent

### PATCH /anamneses/:anamnesisId/sections/:sectionId/questions/:questionId
- **Auth**: Bearer token, role TRAINER
- **Request** (new optional fields — same as above, also nullable to clear):
  ```json
  {
    "parentQuestionId": null,
    "condition": null
  }
  ```
- **Success** (200): updated question
- **Errors** (in addition to standard 400/404):
  - `409` · `PARENT_TYPE_LOCKED` · `anamnesis.parentTypeLocked` · trainer tries to change a parent question's type while it has children
  - `409` · `CONDITION_REFERENCES_REMOVED_OPTION` · `anamnesis.conditionReferencesRemovedOption` · trainer removes an option that a child condition references

### Question response shape (both create and update)
```json
{
  "id": "<uuid>",
  "sectionId": "<uuid>",
  "text": "...",
  "type": "numeric",
  "required": true,
  "order": 2,
  "config": null,
  "parentQuestionId": "<uuid or null>",
  "condition": { "operator": "equals", "value": "yes" },
  "options": [],
  "createdAt": "...",
  "updatedAt": "..."
}
```

### Condition shapes by parent type
| Parent type | Condition object |
|---|---|
| `dichotomous` | `{ "operator": "equals", "value": "yes" \| "no" }` |
| `single_choice` | `{ "operator": "equals", "optionId": "<uuid>" }` |
| `multiple_choice` | `{ "operator": "includesAny", "optionIds": ["<uuid>", ...] }` |

### POST /my/anamneses/:anamnesisId/response (submit)
Unchanged in shape. The backend silently drops answers for hidden children; the frontend must also not submit them (for correctness and UX consistency, clear stale values in form state before submit).

## i18n keys required

- `anamnesis.invalidCondition` → suggested copy: "Condição inválida para o tipo da pergunta pai."
- `anamnesis.parentNotEligible` → suggested copy: "Apenas perguntas Sim/Não, Escolha Única ou Múltipla Escolha podem ser perguntas pai."
- `anamnesis.parentMustBeSameSection` → suggested copy: "A pergunta pai deve estar na mesma seção."
- `anamnesis.parentTypeLocked` → suggested copy: "O tipo da pergunta não pode ser alterado porque existem perguntas condicionais vinculadas."
- `anamnesis.conditionReferencesRemovedOption` → suggested copy: "Não é possível remover uma opção referenciada por uma pergunta condicional."
- `anamnesis.conditionalDepthExceeded` → suggested copy: "Perguntas condicionais não podem ser encadeadas (apenas um nível)."

## Acceptance criteria

- [ ] Trainer can open an eligible parent dropdown in the question card editor and select a parent question from the same section.
- [ ] Trigger-value picker renders the correct control for each parent type (radio for dichotomous/single, checkboxes for multiple).
- [ ] "Remover condição" clears parent + condition and saves cleanly.
- [ ] Outline panel renders conditional children indented under their parent with a "↳ condicional" badge.
- [ ] Type selector shows a disabled hint tooltip when the question has conditional children.
- [ ] Student form hides conditional children whose parent answer doesn't match.
- [ ] When a parent answer changes and a child becomes hidden, the child's form value is cleared.
- [ ] Client-side required validation skips hidden questions.
- [ ] Preview modal applies the same visibility logic and shows the condition hint label.
- [ ] Fork/copy: the forked anamnesis has the same conditional structure and conditions still fire correctly.
- [ ] Parent deletion: formerly conditional children become unconditional (always visible) after reload.
- [ ] All six new error messageCodes surface as user-facing toasts in the trainer editor.

## Open design questions

- What animation/transition style for show/hide? Fade, height slide, or instant?
- Where in the question card should "Condição de exibição" live — at the bottom of the card, inside a collapsible accordion, or in a side-panel/drawer?
- Should the "↳ condicional" badge in the outline panel be a full indent (nested list) or a flat list with a visual indicator?
- What copy should appear on the "Mostrar somente se…" dropdown label?
- Should the preview modal condition hint be inside the question card or above it?
