---
name: i18n legacy-error translation gap
description: Legacy errors thrown with .code bypass i18n and fall back to English even when the client requests pt-BR
type: project
---

Legacy errors created via `new Error(...)` with a `.code` property (e.g. `EMAIL_ALREADY_ON_WAITLIST`, `REFRESH_TOKEN_REVOKED`, `INVALID_RELATIONS`) flow through `normalizeLegacyError` in `src/errors/normalize-error.js` and get `messageCode: 'legacy.${code}'`. The i18n locale files do NOT include `legacy.*` entries, so `translate()` falls back to the thrown English `message` string — meaning pt-BR clients see English text for these errors.

**Why:** PR1 of the i18n rollout deliberately scoped locale files to stable `messageCode` values only. Migrating legacy errors to stable codes is deferred to follow-up PRs.

**How to apply:** When reviewing code that throws legacy `Error` with `.code`, either (a) convert it to an `AppError` with a stable `messageCode` and add pt-BR/en-US translations, or (b) accept that pt-BR users will see English until migration. Do NOT weaken e2e tests asserting on the English `message` text — as long as the error remains a legacy code, the fallback keeps the English string, and the assertion is still valid.
