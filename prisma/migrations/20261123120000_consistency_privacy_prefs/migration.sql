-- CreateTable
CREATE TABLE "consistency_privacy_prefs" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "appear_as" TEXT NOT NULL,
    "term_version" TEXT NOT NULL,
    "accepted_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "consistency_privacy_prefs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "consistency_privacy_prefs_student_id_key" ON "consistency_privacy_prefs"("student_id");

-- AddForeignKey
ALTER TABLE "consistency_privacy_prefs" ADD CONSTRAINT "consistency_privacy_prefs_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
