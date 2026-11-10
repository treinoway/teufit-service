---
name: postman-conventions
description: Structural and stylistic conventions confirmed in postman/Treinoway.postman_collection.json — folder naming, auth headers, variables, example responses
metadata:
  type: project
---

Confirmed by adding the 4 "Trainer Invite System (closed beta)" endpoints (2026-07-19).

## File format
- 2-space indent, `ensure_ascii=False` (raw UTF-8, e.g. "São Paulo" not escaped), trailing newline at EOF.
- Collection-level `auth` is `bearer` with value `{{accessToken}}` — every request inherits this automatically. Do **not** add an explicit `Authorization` header on regular (non-admin) requests; Postman applies the collection auth. Only `Become Trainer` / `Grant Admin Role`-style token-rotation endpoints omit headers entirely and rely on inherited auth.
- **Admin routes always set an explicit header** `Authorization: Bearer {{adminToken}}`, overriding the collection default. This is the single most important auth-header rule — missed it once as a first instinct, caught by checking `Create Video` before writing new admin items.

## Folder naming
- Pattern: `<Resource> - <Role>` for role-scoped groups, e.g. `Videos - Admin`, `Anamnesis - Admin`, `Anamnesis - My`, `Training Protocols - Trainer`. New admin-only endpoint groups should follow this (used `Trainer Invites - Admin` for the 3 admin invite endpoints).
- User-facing endpoints that mirror an existing `/me` or `/become-trainer`-style flow go in the `User` folder, not a new folder (placed `Redeem Trainer Invite` right after `Become Trainer` since it mirrors its token-reissue behavior).
- New admin folders get inserted immediately after `Videos - Admin` in the top-level item list (arbitrary but keeps admin folders clustered).

## Collection variables (top-level `variable` array)
- Only ~9 variables exist: `baseUrl`, `accessToken`, `refreshToken`, `adminToken`, `appLanguage`, `videoId`, `subscriptionPlanId`, `studentSubscriptionId`, `subscriptionPaymentId`.
- Pattern for a new resource ID used across multiple requests (create → use in path): add `<resource>Id` with empty `value`, `type: "string"`, and a `description` naming which endpoints use it (mirrors `videoId`). Added `inviteId` and `inviteCode` following this pattern.
- No automatic test scripts populate these ID variables (e.g. `Create Video` does NOT auto-save `videoId`) — the user is expected to set them manually after running create requests. Only auth-token-rotation endpoints (`Become Trainer`, `Grant Admin Role`, login) have `event.test` scripts that write to `pm.collectionVariables`.

## Example responses (`response` array on request items)
- Most items (202/220 at last count) have an empty `response: []` — examples are the exception, not the rule.
- When a route is a **new logical feature** (not just a CRUD add-on to an existing well-documented resource), add at least one success example plus one realistic error example, matching the exact shape Postman expects: `name`, `originalRequest` (full copy of the request), `status`, `code`, `_postman_previewlanguage: "json"`, `header: [{Content-Type: application/json}]`, `body` (JSON string, pretty-printed).
- Response bodies with i18n categorical fields must include the `*Label` sibling with a pt-BR example value (e.g. `status: "pending"` → `statusLabel: "Pendente"`), matching the `x-i18n` / `preSerialization` hook behavior described in the backend CLAUDE.md.

## Swagger side note
- Route schemas in `api/schemas/*.schema.js` are the sole source for Swagger — if they're already complete (tags, security, params/querystring/body, response codes with `errorResponseSchema`/`badRequestErrorResponseSchema`), no separate Swagger edit is needed. Always verify against `api/schemas/error-response.schema.js` for the unified error contract before assuming it's fine.
