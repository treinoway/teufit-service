---
name: migration-drift-ai-logs
description: Prisma migrations auto-include unrelated drift fixes (esp. ai_interaction_logs id DROP DEFAULT) — flag stray ALTERs in feature migrations
metadata:
  type: project
---

Feature migrations in this repo tend to pick up unrelated drift ALTERs because the Prisma schema and prior raw-SQL migrations disagree.

Concrete case: `ai_interaction_logs.id` was created (migration `20260614120000_add_ai_interaction_logs`) with `DEFAULT gen_random_uuid()` at the DB level, but the schema declares `@default(uuid())` (Prisma generates app-side, emits NO db default). `prisma migrate dev` detects this as drift and injects `ALTER TABLE "ai_interaction_logs" ALTER COLUMN "id" DROP DEFAULT;` into whatever unrelated migration is being generated next.

**Why:** schema/DB mismatch on uuid default strategy left uncorrected.

**How to apply:** When reviewing a migration, scan for ALTER/DDL lines that have nothing to do with the stated feature. Flag them as migration pollution — they should be a separate migration or the underlying schema drift should be fixed. The DROP DEFAULT itself is functionally safe (Prisma supplies the uuid), but riding along in unrelated migrations is a smell and makes rollbacks ambiguous.
