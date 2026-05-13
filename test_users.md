# Test Users (Local Dev Seed)

Created by `npm run db:seed:dev` (or `npm run db:reset-and-populate`). Only runs against local DB.

## Trainer

| Field | Value |
|---|---|
| Email | `trainer@treinoway.local` |
| Password | `trainer123` |
| Name | José Demo |
| Gender | male |
| Birth Date | 1985-03-15 |
| Professional Document | CREF-DEMO-001 |
| Gym | Academia Demo |
| Service Mode | hybrid |

## Students

All share password `aluno123`. Emails pattern: `aluno{N}@treinoway.local`.

| # | Email | Name | Gender | Birth Date |
|---|---|---|---|---|
| 1 | aluno1@treinoway.local | Ana Souza | female | 1992-04-22 |
| 2 | aluno2@treinoway.local | Bruno Oliveira | male | 1988-09-10 |
| 3 | aluno3@treinoway.local | Carla Santos | female | 1995-12-03 |
| 4 | aluno4@treinoway.local | Diego Pereira | male | 2000-07-18 |
| 5 | aluno5@treinoway.local | Elisa Lima | female | 1990-02-25 |
| 6 | aluno6@treinoway.local | Felipe Costa | male | 1986-06-14 |
| 7 | aluno7@treinoway.local | Gabriela Almeida | female | 1998-11-30 |
| 8 | aluno8@treinoway.local | Hugo Ribeiro | male | 1993-08-05 |
| 9 | aluno9@treinoway.local | Isabela Carvalho | female | 2001-03-12 |
| 10 | aluno10@treinoway.local | João Fernandes | male | 1989-10-27 |

## Adherence Buckets (student order matters)

| Bucket | Students | Sessions | Abandoned | In Progress |
|---|---|---|---|---|
| high | 1–2 | 22 | 1 | 0 |
| medium | 3–5 | 14 | 2 | 0 |
| low | 6–8 | 7 | 1 | 1 |
| inactive | 9–10 | 0 | 0 | 0 |

## Source

- `prisma/seeds/dev-seed-data.js` — static catalog
- `prisma/seeds/dev-seed.js` — execution (refuses non-local DATABASE_URL)
