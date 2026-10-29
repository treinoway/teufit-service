-- Data-only migration (no schema change): creates a permanent test trainer with 10 linked test
-- students, mirroring the trainer + students part of prisma/seeds/dev-seed.js (no protocols,
-- sessions, anamneses or subscriptions — those are created through the app).
--
-- Accounts (passwords are NOT in the repo — only their scrypt hashes; keep them in the password manager):
--   trainer.teste@teufit.test          — TRAINER role, DIAMOND plan, active profile = trainer
--   aluno1..aluno10.teste@teufit.test  — students (no roles), all sharing one password
--
-- Safety rules:
--   * Runs on every environment (dev, CI, staging, prod). The @teufit.test emails never collide
--     with dev-seed.js (@treinoway.local) nor with real users, and .test is a reserved TLD, so no
--     transactional email can be delivered to them.
--   * Idempotent: the whole block is skipped when the test trainer email already exists.
--   * No accounts row is created (same as dev-seed): with no unverified email account, password
--     login is not neutralized by the email-verification check.

DO $seed$
DECLARE
  v_trainer_user_id UUID := gen_random_uuid();
  v_trainer_id      UUID := gen_random_uuid();
  v_student_user_id UUID;
  v_student         RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM "users" WHERE lower("email") = 'trainer.teste@teufit.test') THEN
    RAISE NOTICE 'Test trainer already exists, skipping';
    RETURN;
  END IF;

  INSERT INTO "users" ("id", "email", "password_hash", "roles", "status", "first_name", "last_name", "gender", "birth_date", "created_at", "updated_at")
  VALUES (
    v_trainer_user_id,
    'trainer.teste@teufit.test',
    'scrypt$N=16384,r=8,p=1$8m/vDNpCthQqtotGB+KUzA==$i1EU6ARk+ZLj6H6Bq9Aivyf/LyV62kBjWu/c/7CzIzOLETiegaaWHrr00+Jzsty15WatxrzSp2QkR6oqQ8cEKA==',
    ARRAY['trainer'],
    'active',
    'José',
    'Teste',
    'male',
    '1985-03-15',
    NOW(),
    NOW()
  );

  INSERT INTO "trainers" ("id", "user_id", "professional_document", "gym_name", "service_mode", "notes", "profile_completed_at", "first_student_linked_at", "created_at", "updated_at")
  VALUES (
    v_trainer_id,
    v_trainer_user_id,
    'CREF-TESTE-001',
    'Academia Teste',
    'hybrid',
    'Conta de teste em produção. Não usar com dados reais.',
    NOW(),
    NOW(),
    NOW(),
    NOW()
  );

  -- No current_period_end: nothing expires the plan, so the account keeps DIAMOND until edited.
  INSERT INTO "platform_subscriptions" ("id", "trainer_id", "tier", "status", "current_period_start", "created_at", "updated_at")
  VALUES (gen_random_uuid(), v_trainer_id, 'DIAMOND', 'ACTIVE', NOW(), NOW(), NOW());

  INSERT INTO "user_preferences" ("id", "user_id", "active_profile", "created_at", "updated_at")
  VALUES (gen_random_uuid(), v_trainer_user_id, 'trainer', NOW(), NOW());

  FOR v_student IN
    SELECT *
    FROM (
      VALUES
        (1,  'Ana',      'Souza',     'female', DATE '1992-04-22'),
        (2,  'Bruno',    'Oliveira',  'male',   DATE '1988-09-10'),
        (3,  'Carla',    'Santos',    'female', DATE '1995-12-03'),
        (4,  'Diego',    'Pereira',   'male',   DATE '2000-07-18'),
        (5,  'Elisa',    'Lima',      'female', DATE '1990-02-25'),
        (6,  'Felipe',   'Costa',     'male',   DATE '1986-06-14'),
        (7,  'Gabriela', 'Almeida',   'female', DATE '1998-11-30'),
        (8,  'Hugo',     'Ribeiro',   'male',   DATE '1993-08-05'),
        (9,  'Isabela',  'Carvalho',  'female', DATE '2001-03-12'),
        (10, 'João',     'Fernandes', 'male',   DATE '1989-10-27')
    ) AS s("n", "first_name", "last_name", "gender", "birth_date")
  LOOP
    -- A student email taken by someone else is left alone (never re-linked to the test trainer).
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM "users" WHERE lower("email") = 'aluno' || v_student."n" || '.teste@teufit.test'
    );

    v_student_user_id := gen_random_uuid();

    INSERT INTO "users" ("id", "email", "password_hash", "roles", "status", "first_name", "last_name", "gender", "birth_date", "created_at", "updated_at")
    VALUES (
      v_student_user_id,
      'aluno' || v_student."n" || '.teste@teufit.test',
      'scrypt$N=16384,r=8,p=1$gM6XYj4AJ8gvPvES/9UgIw==$oCiT6c16FHE1TkOb2ZcDQ/a0vfbFeS1wTIv40MMdSA7+cmDApESUJ3zmyQoJHaWu8UoASbU6jr0/ZM6gzH2cXg==',
      ARRAY[]::TEXT[],
      'active',
      v_student."first_name",
      v_student."last_name",
      v_student."gender",
      v_student."birth_date",
      NOW(),
      NOW()
    );

    INSERT INTO "trainer_students" ("id", "trainer_id", "student_id", "created_at")
    VALUES (gen_random_uuid(), v_trainer_id, v_student_user_id, NOW());
  END LOOP;
END $seed$;
