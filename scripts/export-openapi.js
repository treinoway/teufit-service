import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const INERT_ENV = {
  DATABASE_URL: 'postgresql://openapi:openapi@127.0.0.1:1/openapi',
  SESSION_SECRET: 'openapi-export-session-secret-0123456789',
  JWT_SECRET: 'openapi-export-jwt-secret',
  GOOGLE_OAUTH_CLIENT_ID: 'openapi-export',
  GOOGLE_OAUTH_CLIENT_SECRET: 'openapi-export',
  GOOGLE_OAUTH_CALLBACK_URL: 'http://localhost:3000/auth/google/callback',
  DISABLE_S3_UPLOAD: 'true',
  DISABLE_EMAIL: 'true',
};

// Builds the server with inert settings (no real database, no external calls) and returns its OpenAPI document.
async function buildSpec() {
  Object.assign(process.env, INERT_ENV);
  const { buildServer } = await import('../api/server.js');
  const app = await buildServer({ logger: false });
  await app.ready();
  const spec = app.swagger();
  await app.close();
  return spec;
}

// Writes the OpenAPI document to the path in argv[2] (default openapi/openapi.json), pretty-printed for stable diffs.
async function main() {
  const out = resolve(process.argv[2] ?? 'openapi/openapi.json');
  const spec = await buildSpec();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`);
  process.exit(0);
}

main().catch((error) => {
  console.error('openapi export failed:', error);
  process.exit(1);
});
