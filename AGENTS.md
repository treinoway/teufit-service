# Treinoway Service – Agent Context

Backend API for the **Treinoway** wellness and training platform. Connects **trainers** and **students** for creating and managing training protocols.

---

## What the Project Does

- **Authentication**: signup/login (email+password), Google OAuth, JWT for web and mobile
- **Profiles**: `User` with roles (currently `STUDENT`, `TRAINER`; STUDENT planned for removal)
- **Trainers**: profile, address, social networks, service mode (online/in_person/hybrid)
- **Students**: profile, health data (`StudentHealthDetail`)
- **Training protocols**: main system in development
  - **Protocol Template**: reusable template created by trainer
  - **Training Protocol**: protocol assigned to a student, with dates and status
  - **Training Template**: reusable training template (can be public)
  - **Training**: workout within a protocol
  - **Training Schedule**: maps trainings to weekdays
- **Other**: avatar (S3), address, waitlist, password reset, user preferences

---

## Cursor Rules (reference – saves tokens)

**Always read the rules before implementing.** Do not duplicate their content here.

| Rule | When to apply |
|------|---------------|
| `.cursor/rules/project-overview.mdc` | Commands, environment, CI/CD |
| `.cursor/rules/development-standards.mdc` | New routes, features (Postman + Swagger + tests) |
| `.cursor/rules/architecture.mdc` | Request flow, layers, auth |
| `.cursor/rules/api-conventions.mdc` | Routes, services, server |
| `.cursor/rules/testing.mdc` | Unit tests, E2E, Vitest |

---

## Quick Structure

```
api/
  routes/          # Fastify routes (auth, trainer, user, address, protocol*, training*)
  schemas/         # JSON schemas for validation
  middleware/      # authenticate, requireRole, requireActiveUser
  hooks/           # auth-hook (onRequest global for protected routes)
src/
  services/        # Business logic (auth, user, trainer, token, training*, avatar)
  constants/       # roles.js, training.js
  config/          # email-handler, s3-bucket-handler
  db.js            # Prisma client
prisma/
  schema.prisma    # Models (User, Trainer, Student, Training*, etc.)
postman/           # Postman collection
docs/api/          # API documentation (e.g. training-protocols-api.md)
test/
  services/        # Unit tests
  e2e/             # E2E tests
```

---

## Current State

- **Branch**: `feature/add-training-protocol-feature`
- **In progress**: training protocol feature
- **Planned**: Nutritionist routes (model exists in schema); removal of STUDENT role

---

## FAQ

1. **Auth?** JWT for web and mobile via `Authorization: Bearer <token>` header.
2. **`activeProfile` vs `roles`?** `roles` drives backend authorization; `activeProfile` is a frontend UI preference.
3. **New routes?** Update Postman + Swagger (via schemas in routes) + add tests (unit + E2E when API is involved).
