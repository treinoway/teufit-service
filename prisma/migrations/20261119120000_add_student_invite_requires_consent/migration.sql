-- AlterTable
ALTER TABLE "student_invites" ADD COLUMN IF NOT EXISTS "requires_consent" BOOLEAN NOT NULL DEFAULT false;

-- Backfill (re-runnable): a pending invite whose address already belongs to a user waits for that user's
-- answer in the app instead of being accepted automatically when the account verifies its e-mail.
-- student_invites.email is always stored trimmed and lowercased.
UPDATE student_invites si
SET requires_consent = true
WHERE si.status = 'pending'
  AND si.requires_consent = false
  AND EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = si.email);
