-- CreateTable
CREATE TABLE "trainer_students" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trainer_students_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trainer_students_trainer_id_student_id_key" ON "trainer_students"("trainer_id", "student_id");

-- AddForeignKey
ALTER TABLE "trainer_students" ADD CONSTRAINT "trainer_students_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trainer_students" ADD CONSTRAINT "trainer_students_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
