-- Data-only migration (no schema change): restructures the default public anamnesis
-- "Anamnese Completa" (is_general = true, trainer_id IS NULL) from the old 14-section layout
-- to the new 10-section one. Trainers' copies/forks (trainer_id IS NOT NULL) are never touched.
--
-- Safety rules:
--   * Every statement is guarded by the section's CURRENT exact title, so it is a no-op on a
--     fresh database (the anamnesis does not exist yet; the seed creates it already restructured)
--     and when re-run / when the titles were already changed.
--   * Nothing is hard-deleted: anamnesis_answers.question_id is ON DELETE RESTRICT, so removed
--     sections/questions are soft-deleted (deleted_at). Existing answers to them stay in the DB.
--   * Statement order matters: the menstrual section is located by its OLD title, so it must run
--     before the rename step.

-- 1. "Ciclo Menstrual": add the trigger question "Você menstrua?" (order 0, dichotomous, optional),
--    shift the existing questions to orders 1..N and make them conditional children of it
--    (visible only when the answer is "yes"). Skipped when the trigger already exists.
WITH menstrual_sections AS (
  SELECT section.id
  FROM anamnesis_sections section
  JOIN anamneses anamnesis ON anamnesis.id = section.anamnesis_id
  WHERE anamnesis.is_general = true
    AND anamnesis.trainer_id IS NULL
    AND anamnesis.title = 'Anamnese Completa'
    AND anamnesis.deleted_at IS NULL
    AND section.title = '14 — Ciclo Menstrual'
    AND section.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM anamnesis_questions existing
      WHERE existing.section_id = section.id
        AND existing.text = 'Você menstrua?'
        AND existing.deleted_at IS NULL
    )
),
trigger_questions AS (
  INSERT INTO anamnesis_questions (id, section_id, text, type, required, "order", created_at)
  SELECT gen_random_uuid(), menstrual_sections.id, 'Você menstrua?', 'dichotomous', false, 0, now()
  FROM menstrual_sections
  RETURNING id, section_id
)
UPDATE anamnesis_questions question
SET "order" = question."order" + 1,
    parent_question_id = trigger_questions.id,
    condition = '{"operator": "equals", "value": "yes"}'::jsonb,
    updated_at = now()
FROM trigger_questions
WHERE question.section_id = trigger_questions.section_id
  AND question.deleted_at IS NULL;

-- 2. Soft-delete the questions of the 4 removed sections ...
UPDATE anamnesis_questions question
SET deleted_at = now()
FROM anamnesis_sections section
JOIN anamneses anamnesis ON anamnesis.id = section.anamnesis_id
WHERE question.section_id = section.id
  AND question.deleted_at IS NULL
  AND section.deleted_at IS NULL
  AND section.title IN (
    '03 — Hábitos de Vida',
    '08 — Avaliação Clínica',
    '10 — Hábitos Alimentares e Suplementação',
    '11 — Relação com Alimentação'
  )
  AND anamnesis.is_general = true
  AND anamnesis.trainer_id IS NULL
  AND anamnesis.title = 'Anamnese Completa'
  AND anamnesis.deleted_at IS NULL;

-- ... and the sections themselves.
UPDATE anamnesis_sections section
SET deleted_at = now()
FROM anamneses anamnesis
WHERE anamnesis.id = section.anamnesis_id
  AND section.deleted_at IS NULL
  AND section.title IN (
    '03 — Hábitos de Vida',
    '08 — Avaliação Clínica',
    '10 — Hábitos Alimentares e Suplementação',
    '11 — Relação com Alimentação'
  )
  AND anamnesis.is_general = true
  AND anamnesis.trainer_id IS NULL
  AND anamnesis.title = 'Anamnese Completa'
  AND anamnesis.deleted_at IS NULL;

-- 3. Rename and re-order the remaining sections (single statement: all matches use the OLD title).
UPDATE anamnesis_sections section
SET title = renamed.new_title,
    "order" = renamed.new_order,
    updated_at = now()
FROM (
  VALUES
    ('04 — Hábitos de Sono', '03 — Hábitos de Sono', 2),
    ('05 — Estresse e Contexto de Vida', '04 — Estresse e Contexto de Vida', 3),
    ('06 — Histórico Médico', '05 — Histórico Médico', 4),
    ('07 — Histórico de Lesões e Limitações', '06 — Histórico de Lesões e Limitações', 5),
    ('09 — Postura e Mobilidade', '07 — Postura e Mobilidade', 6),
    ('12 — Treino de Musculação', '08 — Treino de Musculação', 7),
    ('13 — Exercício Aeróbico', '09 — Exercício Aeróbico', 8),
    ('14 — Ciclo Menstrual', '10 — Ciclo Menstrual', 9)
) AS renamed(old_title, new_title, new_order)
JOIN anamneses anamnesis
  ON anamnesis.is_general = true
 AND anamnesis.trainer_id IS NULL
 AND anamnesis.title = 'Anamnese Completa'
 AND anamnesis.deleted_at IS NULL
WHERE section.anamnesis_id = anamnesis.id
  AND section.title = renamed.old_title
  AND section.deleted_at IS NULL;
