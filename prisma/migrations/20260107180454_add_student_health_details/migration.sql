-- CreateTable
CREATE TABLE "student_health_details" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "weight" DOUBLE PRECISION,
    "height" DOUBLE PRECISION,
    "body_fat" DOUBLE PRECISION,
    "conditions" TEXT[],

    CONSTRAINT "student_health_details_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "student_health_details_student_id_idx" ON "student_health_details"("student_id");

-- AddForeignKey
ALTER TABLE "student_health_details" ADD CONSTRAINT "student_health_details_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
