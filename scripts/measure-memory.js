// Memory baseline for the API process.
//
// Boots the real server (buildServer + ready) without a database or network and
// reports heap/RSS at each stage, then fires requests to confirm memory stays flat.
// Use it to compare a change against master before deploying:
//
//   npm run measure:memory               # without Sentry
//   npm run measure:memory -- --sentry   # with Sentry loaded (tracesSampleRate 1.0)
//
// Numbers vary with the Node version and machine; compare runs on the same machine.
// Prisma is lazy and never connects here, so the query engine is not included.
import v8 from 'node:v8';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    sentry: { type: 'boolean', default: false },
    requests: { type: 'string', default: '3000' },
  },
});

const DUMMY_ENV = {
  NODE_ENV: 'production',
  SESSION_SECRET: 'measure-memory-session-secret-0123456789abcdef',
  JWT_SECRET: 'measure-memory-jwt-secret',
  DATABASE_URL: 'postgresql://measure:measure@127.0.0.1:1/measure',
  GOOGLE_OAUTH_CLIENT_ID: 'measure',
  GOOGLE_OAUTH_CLIENT_SECRET: 'measure',
  GOOGLE_OAUTH_CALLBACK_URL: 'http://localhost/auth/google/callback',
  ANTHROPIC_API_KEY: 'measure',
  ASAAS_WEBHOOK_TOKEN: 'measure',
  ASAAS_WEBHOOK_SECRET: 'measure',
  DISABLE_EMAIL: 'true',
  DISABLE_S3_UPLOAD: 'true',
  // Unroutable DSN: loads the SDK without ever sending events anywhere.
  SENTRY_DSN: args.sentry ? 'http://public@127.0.0.1:1/0' : '',
  SENTRY_TRACES_SAMPLE_RATE: '1.0',
};
// Force the dummy values: a developer .env must not point this script at a real DB.
Object.assign(process.env, DUMMY_ENV);

if (typeof globalThis.gc !== 'function') {
  console.error('Run with --expose-gc (use `npm run measure:memory`).');
  process.exit(1);
}

const toMb = (bytes) => (bytes / 1048576).toFixed(1);
const rows = [];

// Yield to the event loop before collecting: pending setImmediate callbacks
// otherwise keep finished requests reachable and look like a leak.
async function snapshot(stage) {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  globalThis.gc();
  globalThis.gc();
  const { rss, heapUsed } = process.memoryUsage();
  rows.push({ stage, rssMb: toMb(rss), heapUsedMb: toMb(heapUsed) });
}

await snapshot('node boot');
if (args.sentry) await import('../instrument.js');
await snapshot(args.sentry ? 'sentry loaded' : 'sentry skipped');

const startedAt = Date.now();
const { buildServer } = await import('../api/server.js');
await snapshot('routes imported');

const app = await buildServer({ logger: false });
await app.ready();
const bootMs = Date.now() - startedAt;
await snapshot('server ready');

const total = Number(args.requests);
for (let i = 0; i < total; i++) {
  // A public 200 and an unauthenticated 401 exercise both serializer paths.
  await app.inject({ method: 'GET', url: '/' });
  await app.inject({ method: 'GET', url: '/me' });
  if (i % 50 === 0) await new Promise((resolve) => setImmediate(resolve));
}
await snapshot(`after ${total * 2} requests`);

await app.close();

console.table(rows);
console.log(`boot (import + ready): ${bootMs} ms`);
console.log(`heap limit: ${toMb(v8.getHeapStatistics().heap_size_limit)} MB`);
process.exit(0);
