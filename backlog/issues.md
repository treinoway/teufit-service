# Refactoring Backlog

Issues identified during a codebase audit against the Development Standards (SOLID, Clean Architecture, constants over loose strings). Check off items as they are resolved.

---

## CRITICAL

> Violations that block testability or break DI everywhere — address these first.

- [ ] **C1** `src/helpers/auth.js` — Direct `prisma` singleton import throughout — tightly coupled, untestable
- [ ] **C2** `src/services/trainer-service.js` — Direct `s3BucketHandler` singleton import in business logic
- [ ] **C3** `src/services/user-service.js` — Direct `s3BucketHandler` + `getAddressByPostalCode` imports; DI completely bypassed
- [ ] **C4** `src/services/auth-service.js` — Direct `prisma` + `emailHandler` singleton imports in service layer

---

## HIGH

> Significant design problems affecting maintainability, consistency, or correctness.

- [ ] **H1** `src/services/user-service.js` — `updateUserProfile()` is 161 lines — does validation, address lookup, upserts, and error handling all in one function
- [ ] **H2** `src/helpers/training-validators.js` — Uses legacy `buildError()` — inconsistent with unified `AppError` contract
- [ ] **H3** `api/middleware/auth.js` — Returns error objects directly instead of throwing `AppError` subclasses
- [ ] **H4** `src/services/training-service.js` + `training-protocol-service.js` — Duplicated user context validation logic across multiple functions
- [ ] **H5** `src/services/trainer-service.js` — `validModes = ['online', 'in_person', 'hybrid']` — magic strings, should be constants
- [ ] **H6** `src/config/email-handler.js` + `s3-bucket-handler.js` — Exported as singletons — prevents DI, makes testing hard
- [ ] **H7** `src/services/firebase-id-token-service.js` + `google-id-token-service.js` — Duplicated token verification logic — should share a strategy

---

## MEDIUM

> Code quality issues that increase cognitive load or introduce subtle risk.

- [ ] **M1** `src/services/auth-service.js` — Magic numbers: scrypt params (`16384`, `8`, `1`, `64`), token TTL (`15 * 60 * 1000`) — no constants
- [ ] **M2** `src/services/avatar-service.js` + `api/server.js` — `5 * 1024 * 1024` (5 MB limit) duplicated in two places
- [ ] **M3** `src/services/auth-service.js` — `signupWithEmailPassword()` is 70 lines — mixes validation, logic, and persistence
- [ ] **M4** `src/services/trainer-service.js` — Uses `lodash` for `_.omit()` — simple destructuring would suffice
- [ ] **M5** `src/helpers/auth.js` — `toSafeExpiresDate()` is 47 lines handling 7 different formats — should be its own module
- [ ] **M6** `src/constants/training.js` — Inconsistent naming convention; `...Values` arrays exported separately — harder to discover
- [ ] **M7** `src/services/token-service.js` — `crypto.randomBytes(40)` — magic number with no explanation
- [ ] **M8** `src/services/auth-service.js` — 6-digit reset token (`randomInt(0, 1_000_000)`) — weak entropy for a security token

---

## LOW

> Minor inconsistencies or style issues with low impact.

- [ ] **L1** `src/services/trainer-service.js` — Method aliasing: `patch` vs `updateMyTrainerProfile` — confusing naming
- [ ] **L2** Various routes — Inconsistent response shapes (some return `{ user: { id } }`, others return full objects)
- [ ] **L3** `src/helpers/query-parser.js` — Empty string passes through `parseIncludeParameter` without early validation
- [ ] **L4** Multiple services — `prisma.$transaction()` calls lack application-level try-catch for clearer error messages
- [ ] **L5** `config/environments/*.js` — Rate limit configs lack comments explaining the rationale
