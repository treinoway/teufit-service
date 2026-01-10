-- Make students.name nullable

ALTER TABLE "students" ALTER COLUMN "name" DROP NOT NULL;
