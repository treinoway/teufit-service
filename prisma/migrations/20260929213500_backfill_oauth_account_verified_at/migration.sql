-- Google/Apple accounts are only created from ID tokens the provider attested;
-- mark existing ones verified so `emailVerified` on GET /me is accurate for legacy users.
UPDATE "accounts"
SET "verified_at" = "created_at"
WHERE "provider" IN ('google', 'apple') AND "verified_at" IS NULL;
