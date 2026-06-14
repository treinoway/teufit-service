-- High-fidelity interaction log for closed-beta iArnold diagnostics.
-- Captures every turn (user message, tools used, response text, token usage, latency)
-- so the team can read conversations and debug bad prompts or broken tools.
-- PRIVACY: userMessage / responseText may contain student PII.
-- Enforce a retention policy (e.g. purge rows older than 90 days) before production rollout.

CREATE TABLE "ai_interaction_logs" (
    "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
    "trainer_id"      UUID         NOT NULL,
    "student_id"      UUID,
    "conversation_id" TEXT,
    "action"          TEXT         NOT NULL,
    "user_message"    TEXT,
    "tools_used"      JSONB,
    "response_text"   TEXT,
    "model"           TEXT,
    "input_tokens"    INTEGER,
    "output_tokens"   INTEGER,
    "latency_ms"      INTEGER,
    "status"          TEXT         NOT NULL,
    "error_code"      TEXT,
    "created_at"      TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT "ai_interaction_logs_pkey" PRIMARY KEY ("id")
);

-- Foreign key to trainers (cascade delete — removing a trainer removes their logs)
ALTER TABLE "ai_interaction_logs"
    ADD CONSTRAINT "ai_interaction_logs_trainer_id_fkey"
    FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Foreign key to users for student (set null on delete — student removal does not purge logs)
ALTER TABLE "ai_interaction_logs"
    ADD CONSTRAINT "ai_interaction_logs_student_id_fkey"
    FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Index for querying a trainer's logs ordered by time (primary access pattern)
CREATE INDEX "ai_interaction_logs_trainer_id_created_at_idx"
    ON "ai_interaction_logs"("trainer_id", "created_at");
