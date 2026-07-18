---
name: handrolled-error-replies-lose-message
description: Custom `message` strings on hand-rolled `reply.status(4xx).send({...})` payloads are dead code — the preSerialization hook overwrites them from messageCode
metadata:
  type: feedback
---

Any route that hand-rolls an error reply via `reply.status(>=400).send({ error, messageCode, message })` will have its `message` **silently overwritten** by the error-normalizing `preSerialization` hook in `api/server.js` (`translateErrorPayloadMessage`), which re-derives `message` from `messageCode` against `src/i18n/locales/*`. `request.language` defaults to `pt-BR`, so the hook always fires.

**Why:** the hook exists to cover 4xx/5xx paths that bypass `setErrorHandler` (Fastify's built-in 404, raw strings). It runs on *every* reply with `statusCode >= 400`, including deliberate hand-rolled ones. `normalizeErrorResponsePayload` early-returns when `messageCode` is present, so the payload keeps its `error`/`messageCode` and never gains `details` — but `translateErrorPayloadMessage` runs unconditionally after it.

**How to apply:** when reviewing a route that sends a 4xx payload directly instead of throwing `AppError`, check two things:
1. The `message` literal in the source is dead — what ships is the locale entry for that `messageCode`. Flag when the author clearly intended the literal to be user-visible (a giveaway: a route-specific message paired with a generic reused `messageCode`).
2. Reusing an unrelated `messageCode` produces a nonsense message. Real example: `api/routes/asaas-webhook-route.js` sends `messageCode: 'auth.unauthorized'` with `message: 'Invalid webhook secret.'`; Asaas actually receives `"Sessão expirada. Faça login novamente."` The fix is a dedicated messageCode per CLAUDE.md's "Adding a new error messageCode" procedure, not a better literal.

Also worth checking on these routes: hand-rolled payloads omit `details` (the contract in CLAUDE.md lists it), and the status code is often missing from the route's `response` schema in `api/schemas/` — so Swagger never documents it. See [[feedback_shared_schema_leaks]] for the related schema-completeness pattern.
