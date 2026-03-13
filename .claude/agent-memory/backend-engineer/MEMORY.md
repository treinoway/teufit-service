# Backend Engineer Agent Memory

## Key Patterns

### Enum-like constants (no Prisma enums)
All enum-like values are stored as `String` in Prisma schema and validated at runtime via frozen constant objects in `src/constants/training.js`. Always follow this pattern:
1. Add frozen object + values array to `src/constants/training.js`
2. Add `validateXxx()` to `src/helpers/training-validators.js` (same signature as `validateTrainingLevel`)
3. Import and call in service functions

### Migration drift resolution (dev environment)
When `prisma migrate dev` fails due to drift (missing local migration file or checksum mismatch):
1. Check which migrations are applied in DB: `docker exec treinoway_postgres psql -U treinoway_user -d treinoway_db -c "SELECT migration_name FROM _prisma_migrations ORDER BY started_at DESC"`
2. Create the missing migration SQL file locally
3. Update checksums in DB to match local files:
   - Get local checksum: `shasum -a 256 prisma/migrations/<name>/migration.sql`
   - Update DB: `UPDATE _prisma_migrations SET checksum = '<hash>' WHERE migration_name = '<name>'`
4. Then run `npm run db:migrate -- --name <name>` normally

### DB container
- Container name: `treinoway_postgres`
- Credentials: user=`treinoway_user`, password=`treinoway_password`, db=`treinoway_db`
- Port: 5433

### importFromTemplate — new field inheritance pattern
When adding a new optional field to `TrainingProtocol`, always add it to `importFromTemplate` using:
```js
fieldName: data.fieldName !== undefined ? data.fieldName : template.fieldName,
```
Not the `??` operator, because `??` does not distinguish between "not provided" and "explicitly set to null".

## File Map

- Constants: `src/constants/training.js`, `src/constants/anamnesis.js`
- Validators: `src/helpers/training-validators.js`
- Protocol service: `src/services/training-protocol-service.js`
- Template service: `src/services/training-protocol-template-service.js`
- Protocol schemas: `api/schemas/training-protocol-route.schema.js`
- Template schemas: `api/schemas/training-protocol-template-route.schema.js`
- Action log: `.claude/action-log.md`
- DB cleanup helper: `test/helpers/db-cleanup.js`

## AppError subclass behavior — CRITICAL for tests
`NotFoundAppError`, `ForbiddenAppError`, `ConflictAppError` **hardcode their `error` field** (`NOT_FOUND`, `FORBIDDEN`, `CONFLICT`) and do NOT expose an `error` override. Passing `error: 'CUSTOM_CODE'` to them is silently ignored.

Always assert on `messageCode` and `httpStatus` in tests, NOT on `error`:
```js
// CORRECT
await expect(fn()).rejects.toMatchObject({ httpStatus: 404, messageCode: 'anamnesis.notFound' });
// WRONG — fails even when the error is thrown correctly
await expect(fn()).rejects.toMatchObject({ error: 'ANAMNESIS_NOT_FOUND' });
```

## Fastify route registration order
Static segments must be registered **before** dynamic ones sharing the same prefix:
```js
// CORRECT ORDER:
fastify.patch('/anamneses/:id/sections/reorder', ...); // static "reorder" first
fastify.patch('/anamneses/:id/sections/:sectionId', ...); // then dynamic
```

## Prisma P2002 (unique constraint) handling
```js
catch (error) {
  if (error.code === 'P2002') throw new ConflictAppError({ messageCode: '...', message: '...' });
  throw error;
}
```

## Server route registration location
All protected routes are inside `buildServer()` in `api/server.js`, inside the block:
```js
await fastify.register(async (fastify) => {
  // ...existing routes...
  await fastify.register(newRoutes); // add here
});
```
