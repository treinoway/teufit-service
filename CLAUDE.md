# Treinoway Service

## MUST FOLLOW RULES
- NEVER ignore CLAUDE.md. Always read and respect its content, this is not a suggestion.
- NEVER accept my plans or suggestions blindly. You MUST be skeptic and always try to find flaws or non-covered edge cases. Avoid Sycophancy.
- The `backend-engineer` agent MUST always invoke the `test-writer` agent to write/update tests for any code it changes. No exceptions — implementation is not complete until tests are written.


## Admin Role

Admin access is **purely role-based** (`roles` contains `admin`). There is no
self-grant endpoint and no email allowlist — never reintroduce hardcoded or
env-based admin emails.

**Bootstrapping the first admin** is a manual DB operation (no code path):

```sql
UPDATE "User" SET roles = array_append(roles, 'admin')
WHERE email = 'someone@example.com' AND NOT ('admin' = ANY(roles));
```

Or via Prisma Studio (`npm run db:studio`) → edit the user's `roles`. The user
must obtain a fresh token (re-login) for the new role to take effect, since
roles are carried in the JWT.

## Error Handling

All error responses follow this contract — never deviate:

```json
{
  "error": "SOME_ERROR_CODE",
  "messageCode": "some.semantic.code",
  "message": "Human-readable fallback message",
  "details": {}
}
```

- Throw `AppError` (`src/errors/app-error.js`) from services/middlewares — never return ad-hoc payloads.
- Keep `messageCode` stable (used for client i18n).
- 5xx errors: never expose internals.
- Validation errors: `error: "VALIDATION_ERROR"`, `messageCode: "validation.failed"`, `details` array.
- Do not introduce legacy `error.code` / `error.statusCode` patterns.
- Route schemas (`api/schemas/`) must include `error`, `messageCode`, `message`, `details` in error responses.

## Date Handling

- **Date-only fields** (`birthDate`, `startDate`, `endDate`, any `@db.Date`): always format with `formatDateOnly()` from `src/helpers/date-helpers.js`. Returns `"YYYY-MM-DD"` string — prevents timezone shift bugs (e.g., Dec 18 becoming Dec 17 in UTC-3).
- **DateTime fields** (`createdAt`, `updatedAt`, etc.): keep as-is (ISO timestamp).

## Code Rules

- **Constants over loose strings**: Use named constants in `src/constants/` for error codes, roles, status values, and repeated string literals.
- **Dependency injection**: Services receive Prisma client and external clients as arguments — never import singletons inside business logic.
- **DRY with judgement**: Extract shared logic only when there are 3+ real usages.

## When Adding a New Field to a Model

Check ALL places where that model is created or copied — not just direct CRUD endpoints:

- `createFromTemplate` / import-from-template flows copy fields explicitly. New fields must be mapped manually.
- Any service that duplicates records or inherits from a template uses an intermediate data object — that object must include the new field.

Pattern for optional fields with template fallback:
```js
newField: data.newField !== undefined ? data.newField : template.newField,
```

## Required for Every New Route

- Update `postman/Treinoway.postman_collection.json`
- Swagger docs auto-generated from route JSON schemas — keep schemas complete

## Required for Every New Feature

- Unit tests for services/business logic (`test/services/`)
- E2E tests for API endpoints (`test/e2e/`)

## Internationalization (i18n)

The backend is the source of truth for all user-facing text on the mobile app (which has no client-side i18n).

### `app-language` header
Mobile clients send `app-language: en-US` (or `pt-BR`). Fastify normalizes header names to lowercase — read it as `request.headers['app-language']`. Missing or unknown values silently default to `pt-BR`. Never return a 400 for an unrecognized language.

### Locale files
- `src/i18n/locales/pt-BR.js` — canonical (always complete)
- `src/i18n/locales/en-US.js` — falls back to pt-BR for missing keys

Three top-level namespaces: `categorical.*`, `errors.*`, `validation.*`.

### Adding a new categorical field to a response schema
Use the helper instead of a raw property declaration:

```js
import { i18nField, i18nArrayField } from '../../src/i18n/schema-helpers.js';

// Single categorical value
properties: {
  ...i18nField('category', 'trainingCategory'),           // → category + categoryLabel
  ...i18nField('bodySegment', 'bodySegment', { nullable: true }),
  ...i18nArrayField('roles', 'userRole'),                  // → roles + rolesLabel (array)
}
```

The `*Label` sibling is populated at response time by the `preSerialization` hook — you don't need to return it from the service. The label is always present (never stripped) even when the language is `pt-BR`.

**Dev-mode guardrail**: if you declare `x-i18n` on a field but forget the `*Label` sibling in the schema, the server throws on first request (not at startup). Use `i18nField()` / `i18nArrayField()` to prevent this.

### `messageCode` stability
Never change existing `messageCode` values. They are the stable contract for i18n clients. Only `message` is translated. `messageCode` is always returned as-is.

### Adding a new error messageCode
1. Add the new messageCode string to the appropriate `*MessageCode` constant in `src/constants/`.
2. Add a translation entry in BOTH `src/i18n/locales/pt-BR.js` and `src/i18n/locales/en-US.js` under `errors`.
3. Follow PT-BR accents rule: always use `ã`, `é`, `ç`, `õ`, etc.

### Known gap: legacy errors

- Legacy errors thrown as `new Error(...)` with a `.code` property (e.g., `EMAIL_ALREADY_ON_WAITLIST`, `REFRESH_TOKEN_REVOKED`) flow through `normalizeLegacyError` in `src/errors/normalize-error.js`.
- Those produce `messageCode: 'legacy.${code}'`.
- There are intentionally **no `legacy.*` entries in the locale files**. `translate()` falls back to `appError.message` — the original English string set in the constructor.
- pt-BR mobile users currently see English for these specific errors.
- To fix: migrate the legacy throw to `throw new AppError({ error, messageCode, message, ... })` with a stable `messageCode` (e.g., `waitlist.emailInUse`), then add translations under `errors.*` in both locale files.
- This migration is tracked for follow-up PRs, NOT PR1.

## AI Flow Engineer Agent (`ai-flow-engineer`)

Use the `ai-flow-engineer` agent for any task involving AI/LLM integrations. Activate it when:

- **Designing or implementing** AI-powered features (e.g., workout suggestions, exercise generation, meal plans)
- **Writing or reviewing prompts** — prompt engineering, injection defense, output format design
- **Optimizing token usage** or reducing AI-related costs
- **Implementing structured output parsing** with validation (Zod, JSON Schema)
- **Building agentic pipelines** or multi-step LLM workflows
- **Reviewing AI flow code** for security, reliability, or cost issues

Do **not** use it for general backend work that doesn't involve LLM calls or prompt logic — use `backend-engineer` for those.
