-- AlterTable
ALTER TABLE "exercise_templates" ADD COLUMN     "prescription_mode" TEXT;

-- AlterTable
ALTER TABLE "exercises" ADD COLUMN     "prescription_mode" TEXT;

-- AlterTable
ALTER TABLE "training_template_exercise_templates" ADD COLUMN     "prescription_mode" TEXT;

-- Backfill: infer prescription_mode from existing data
UPDATE exercises SET prescription_mode = CASE
  WHEN duration IS NOT NULL AND repetitions IS NULL THEN 'duration'
  ELSE 'reps'
END
WHERE prescription_mode IS NULL;

UPDATE exercise_templates SET prescription_mode = CASE
  WHEN duration IS NOT NULL AND repetitions IS NULL THEN 'duration'
  ELSE 'reps'
END
WHERE prescription_mode IS NULL;

UPDATE training_template_exercise_templates SET prescription_mode = CASE
  WHEN duration IS NOT NULL AND repetitions IS NULL THEN 'duration'
  ELSE 'reps'
END
WHERE prescription_mode IS NULL;
