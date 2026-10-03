---
name: prisma-insensitive-equals-is-ilike
description: Prisma `{ equals, mode: 'insensitive' }` on Postgres compiles to unescaped `ILIKE` — `_`/`%` in emails act as wildcards and it seq-scans users; flag every new use on email lookups
metadata:
  type: feedback
---

Prisma 7 (adapter-pg) compiles `email: { equals: x, mode: 'insensitive' }` to `"email" ILIKE $1` with NO wildcard escaping (confirmed 2026-09-28 via query log + EXPLAIN on dev DB: Seq Scan on users). Consequences:
- `_` in a local part (e.g. `john_doe@x.com`) matches any single char → false-positive matches against other users' emails. `%` matches anything.
- The only email index besides the `@unique` btree is `users_email_trgm_idx` on `lower(COALESCE(email,''))` partial `WHERE deleted_at IS NULL` — neither is usable by bare `email ILIKE $1`. Result: seq scan per call.

Known call sites (pattern keeps spreading): `findUserByEmailInsensitive` (src/helpers/auth.js), `account-deletion-service` trainerInvite.deleteMany (can delete OTHER users' invites), `trainer-invite-service.listInvites`, `getInvitePreview` accountExists.

**Why:** reviewers (and the backend-engineer) read `mode: 'insensitive'` as exact case-folded equality; it is pattern matching.

**How to apply:** on any new insensitive-equals email lookup, flag correctness (wildcards) + perf (seq scan). Recommended fix: `lower(email) = lower($1)` via $queryRaw with a `lower(email)` btree expression index, or escape `\ _ %` before passing. Related: [[mocked-prisma-hides-bugs]] (unit tests mock findFirst, so this never surfaces).
