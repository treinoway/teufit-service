# Frontend Brief — Library Pagination, Search/Filter & Batch Delete

**Backend branch**: staging · **Generated**: 2026-06-17

## Elevator pitch
Trainers can now search, filter, and paginate their exercise, training, and protocol template libraries — and bulk-remove items in a single action — instead of scrolling through unbounded flat lists.

## User story
As a trainer, I want to search my template library by name, filter by type/category, navigate paginated results, and bulk-delete items I no longer need, so that I can manage large libraries quickly without losing context.

## User flows

1. **Entry point**: Library screens accessed from the Trainer dashboard — "Exercise Templates", "Training Templates", and "Protocol Templates" list pages.

2. **Happy path — search and filter**:
   1. Trainer opens a library list page (e.g. Exercise Templates).
   2. A search input is visible at the top of the list.
   3. Trainer types a name query; the list updates (debounced) to show matching items.
   4. Trainer optionally selects a filter from a dropdown (e.g. "Type: Strength").
   5. Pagination controls appear at the bottom showing current page / total pages.
   6. Trainer navigates between pages.

3. **Happy path — batch delete**:
   1. Trainer taps a "Select" toggle to enter selection mode.
   2. Checkboxes appear on each list item.
   3. Trainer selects one or more items (up to 200).
   4. A "Delete selected (N)" action appears (floating bar or top toolbar).
   5. Confirmation dialog asks "Delete N items?".
   6. On confirm, a `POST .../batch-delete` request is sent with the selected IDs.
   7. Success: the list refreshes from page 1, a toast shows "N items deleted".

4. **Branches**:
   - Empty search result: show empty state "No templates found for this search".
   - All selected items are public (non-owned): `deletedCount: 0` returned — show a warning "Nothing was deleted — you can only delete your own templates".
   - Mix of owned and non-owned selected: `deletedCount` will be less than items selected — show "N items deleted (some non-owned items were skipped)".

## UI states to cover
- **Loading**: skeleton rows while the paginated list is fetching.
- **Empty** (no templates at all): "Create your first template" CTA.
- **Empty search/filter result**: "No results for '[query]'" with a "Clear filters" link.
- **Selection mode**: checkboxes visible on each item, floating "Delete selected (N)" bar. "Select" button disabled when count is 0.
- **Batch delete in progress**: spinner on the delete bar, list dimmed, button disabled.
- **Pagination**: previous/next buttons + "Page N of M" indicator. Disable prev on page 1, disable next on last page.
- **deletedCount: 0 response**: warning toast "Nothing was deleted".

## API contract

### GET /trainer/exercise-templates
- **Auth**: Bearer, TRAINER role
- **Request** (querystring):
  ```json
  { "page": 1, "limit": 20, "q": "bench press", "type": "strength" }
  ```
- **Success** (200):
  ```json
  { "data": [...], "total": 42, "page": 1, "limit": 20 }
  ```
- **Errors**:
  - `401` — auth failed

### POST /trainer/exercise-templates/batch-delete
- **Auth**: Bearer, TRAINER role
- **Request**:
  ```json
  { "ids": ["uuid1", "uuid2"] }
  ```
- **Success** (200):
  ```json
  { "deletedCount": 3 }
  ```
- **Errors**:
  - `400` · `VALIDATION_ERROR` · `validation.failed` · `ids` empty or invalid UUIDs
  - `401` — auth failed

### GET /trainer/training-templates
- **Auth**: Bearer, TRAINER role
- **Request** (querystring):
  ```json
  { "page": 1, "limit": 20, "q": "string", "category": "strength", "bodySegment": "upper" }
  ```
- **Success** (200):
  ```json
  { "data": [...], "total": 18, "page": 1, "limit": 20 }
  ```

### POST /trainer/training-templates/batch-delete
- **Auth**: Bearer, TRAINER role
- **Request** / **Success**: same shape as exercise-templates batch-delete.

### GET /trainer/protocol-templates
- **Auth**: Bearer, TRAINER role
- **Request** (querystring):
  ```json
  { "page": 1, "limit": 20, "q": "string", "type": "strength", "trainingLevel": "beginner" }
  ```
- **Success** (200):
  ```json
  { "data": [...], "total": 5, "page": 1, "limit": 20 }
  ```

### POST /trainer/protocol-templates/batch-delete
- **Auth**: Bearer, TRAINER role
- **Request** / **Success**: same shape as exercise-templates batch-delete.

## i18n keys required
No new `messageCode` values were introduced. Frontend should map:
- `validation.failed` → suggested copy: "Some fields are invalid."

## Acceptance criteria
- [ ] Search input is visible on all 3 library list pages; results update within 300 ms debounce after the user stops typing.
- [ ] Filter dropdowns show the correct enum options per entity (type, category, bodySegment, trainingLevel).
- [ ] Pagination controls appear and navigate correctly.
- [ ] "Select" toggle activates checkboxes on list items; a counter reflects the selection count.
- [ ] "Delete selected" is disabled when no items are selected.
- [ ] Confirmation dialog is shown before executing batch delete.
- [ ] After batch delete, list refetches from page 1 and a toast shows "N item(s) deleted".
- [ ] When `deletedCount: 0`, a warning toast "Nothing was deleted — you can only delete your own templates" is shown.
- [ ] Empty search/filter result shows a "No results" state with a clear-filters affordance.

## Out of scope
- Sorting options (order is fixed as `createdAt desc` in this cycle).
- Multi-select drag or range-select interactions.
- Undo / restore after batch delete.
- Public template filter toggle.

## Open design questions
- Should filter dropdowns be a separate filter panel (slide-in tray) or always-visible selects above the list?
- Should the search bar be inside a collapsible header or always visible?
- Should the user be able to change the page size (e.g. 10 / 20 / 50)?
- Should selection mode include a "Select all on this page" checkbox?
- Is the batch delete confirmation modal dismissible by tapping outside, or must the user explicitly cancel?
