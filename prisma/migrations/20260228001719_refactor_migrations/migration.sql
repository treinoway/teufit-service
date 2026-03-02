-- DropIndex
DROP INDEX "trainer_students_trainer_id_idx";

-- AlterTable
ALTER TABLE "protocol_template_trainings" RENAME CONSTRAINT "training_schedule_templates_pkey" TO "protocol_template_trainings_pkey";

-- RenameForeignKey
ALTER TABLE "protocol_template_trainings" RENAME CONSTRAINT "training_schedule_templates_protocol_template_id_fkey" TO "protocol_template_trainings_protocol_template_id_fkey";

-- RenameForeignKey
ALTER TABLE "protocol_template_trainings" RENAME CONSTRAINT "training_schedule_templates_training_template_id_fkey" TO "protocol_template_trainings_training_template_id_fkey";
