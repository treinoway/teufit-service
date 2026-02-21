-- CreateTable
CREATE TABLE "training_schedule_templates" (
    "id" UUID NOT NULL,
    "protocol_template_id" UUID NOT NULL,
    "training_template_id" UUID NOT NULL,
    "week_day" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "training_schedule_templates_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "training_schedule_templates" ADD CONSTRAINT "training_schedule_templates_protocol_template_id_fkey" FOREIGN KEY ("protocol_template_id") REFERENCES "training_protocol_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_schedule_templates" ADD CONSTRAINT "training_schedule_templates_training_template_id_fkey" FOREIGN KEY ("training_template_id") REFERENCES "training_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
