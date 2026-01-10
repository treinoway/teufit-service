-- Make students.birthdate nullable

ALTER TABLE "students" ALTER COLUMN "birthdate" DROP NOT NULL;
