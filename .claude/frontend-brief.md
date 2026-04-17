# Frontend Brief — Block Deletion of Active Training Protocols

**Backend branch**: staging · **Generated**: 2026-04-17

## Elevator pitch
Trainers can no longer accidentally delete an active training protocol. When they attempt to, the API now returns a clear 409 error prompting them to archive the protocol first.

## User story
As a trainer, I want to be prevented from deleting an active protocol so that I don't accidentally lose ongoing training data for my students.

## User flows

1. **Entry point**: Trainer navigates to the protocol list or protocol detail page and taps/clicks the "Delete" action.
2. **Happy path (deletable protocol)**:
   1. Trainer selects a protocol with status `completed` or `archived`.
   2. Confirms the delete action.
   3. Protocol is soft-deleted and removed from the list.
3. **Blocked path (active protocol)**:
   1. Trainer selects a protocol with status `active`.
   2. Triggers the delete action (button click / confirmation modal).
   3. API returns `409`. UI shows an error message: the protocol must be archived before it can be deleted.
   4. The protocol remains visible and unchanged in the list.
   5. Optionally, the UI surfaces a shortcut: "Archive protocol" CTA leading to the edit/archive flow.

## UI states to cover
- **Success**: Protocol disappears from the list after deletion.
- **409 Error**: Inline error or toast explaining the protocol is active and must be archived first.
- **Permissions**: The delete action is only available to the owning trainer (403 cases are unchanged).
- **Null/absent data**: Protocol not found (404) remains handled as before.

## API contract

### DELETE /trainer/protocols/:id

- **Auth**: Bearer token required · Role: `TRAINER`
- **Request**: No body. Path param `id` (UUID).
- **Success** (200):
  ```json
  {
    "id": "uuid",
    "deletedAt": "2026-04-17T12:00:00.000Z"
  }
  ```
- **Errors** (status · error · messageCode · when):
  - `401` · `UNAUTHORIZED` · `auth.unauthorized` · Missing or invalid token
  - `403` · `FORBIDDEN` · `auth.forbidden` · Trainer does not own the protocol
  - `404` · `NOT_FOUND` · `trainer.notFound` or `protocol.notFound` · Trainer profile or protocol missing
  - `409` · `PROTOCOL_STATUS_NOT_DELETABLE` · `legacy.PROTOCOL_STATUS_NOT_DELETABLE` · Protocol status is `active`
  - `429` · `RATE_LIMIT_EXCEEDED` · `rateLimit.exceeded` · Too many requests
  - `500` · `INTERNAL_ERROR` · `internal.error` · Unexpected server error

## i18n keys required
- `legacy.PROTOCOL_STATUS_NOT_DELETABLE` → suggested copy: "Esta rotina está ativa e não pode ser excluída. Arquive-a primeiro."

## Acceptance criteria
- [ ] Delete button/action for `active` protocols results in a visible 409 error message in the UI.
- [ ] The error message communicates that the protocol must be archived before deletion.
- [ ] Optionally, a shortcut to the archive flow is shown alongside the error.
- [ ] Delete button/action for `completed` or `archived` protocols continues to work as before.
- [ ] No change to the behavior for 401, 403, 404, or 500 error cases.

## Out of scope
- Implementing the archive flow itself (already exists via the edit form).
- Changing the delete confirmation modal design beyond adding the 409 error state.

## Open design questions
- Should the delete button be visually disabled (greyed out) for `active` protocols, or should it remain enabled and fail gracefully with the 409 error?
- If the button is disabled, what tooltip or hint copy should appear on hover?
- Should a direct "Archive first" CTA appear inline in the error toast/message, or is the existing edit flow sufficient?
