-- AlterTable
ALTER TABLE "student_feedback_configs" ADD COLUMN     "d15_template_id" UUID,
ADD COLUMN     "d21_template_id" UUID,
ADD COLUMN     "d30_template_id" UUID,
ADD COLUMN     "d7_template_id" UUID,
ADD COLUMN     "recurring_template_id" UUID;

-- AddForeignKey
ALTER TABLE "student_feedback_configs" ADD CONSTRAINT "student_feedback_configs_d7_template_id_fkey" FOREIGN KEY ("d7_template_id") REFERENCES "student_feedback_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_feedback_configs" ADD CONSTRAINT "student_feedback_configs_d15_template_id_fkey" FOREIGN KEY ("d15_template_id") REFERENCES "student_feedback_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_feedback_configs" ADD CONSTRAINT "student_feedback_configs_d21_template_id_fkey" FOREIGN KEY ("d21_template_id") REFERENCES "student_feedback_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_feedback_configs" ADD CONSTRAINT "student_feedback_configs_d30_template_id_fkey" FOREIGN KEY ("d30_template_id") REFERENCES "student_feedback_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_feedback_configs" ADD CONSTRAINT "student_feedback_configs_recurring_template_id_fkey" FOREIGN KEY ("recurring_template_id") REFERENCES "student_feedback_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Only one non-deleted general template may exist (partial unique index, not expressible in the Prisma schema)
CREATE UNIQUE INDEX "student_feedback_templates_single_general_key" ON "student_feedback_templates"("is_general") WHERE "is_general" = true AND "deleted_at" IS NULL;
