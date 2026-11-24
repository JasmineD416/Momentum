import { serve } from '@hono/node-server';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Database } from '../worker/db';
import { runScheduler } from '../worker/email/scheduler';
import type { Env } from '../worker/env';
import { app } from '../worker/index';
import { applyMigrations } from '../worker/migrate';
import { staticAssets } from './static';

/**
 * Momentum's server: the API, the built web app, and the once-a-minute email sender, in one Node process.
 * Settings come from environment variables (in development, from .env).
 */

if (existsSync('.env')) process.loadEnvFile('.env');
const cfg = process.env;

const dbPath = resolve(cfg.DATABASE_PATH || './data/momentum.db');
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

const migrationsDir = resolve(cfg.MIGRATIONS_DIR || './migrations');
const applied = applyMigrations(db, readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).map(name => ({ name, sql: readFileSync(join(migrationsDir, name), 'utf8') })));
if (applied.length) console.log('Applied migrations:', applied.join(', '));

const env: Env = {
  DB: db,
  ASSETS: staticAssets(cfg.STATIC_DIR || './dist/client'),
  ENVIRONMENT: cfg.ENVIRONMENT || 'production',
  GOOGLE_CLIENT_ID: cfg.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: cfg.GOOGLE_CLIENT_SECRET,
  GOOGLE_HOSTED_DOMAIN: cfg.GOOGLE_HOSTED_DOMAIN,
  SESSION_SECRET: cfg.SESSION_SECRET,
  SESSION_HOURS: cfg.SESSION_HOURS,
  DATA_ENCRYPTION_KEY: cfg.DATA_ENCRYPTION_KEY,
  OWNER_EMAIL: cfg.OWNER_EMAIL || '',
  DEV_USER_EMAIL: cfg.DEV_USER_EMAIL,
  EMAIL_PROVIDER: cfg.EMAIL_PROVIDER,
  AWS_REGION: cfg.AWS_REGION,
  AWS_ACCESS_KEY_ID: cfg.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: cfg.AWS_SECRET_ACCESS_KEY,
  SES_CONFIGURATION_SET: cfg.SES_CONFIGURATION_SET,
  EMAIL_SIGNING_SECRET: cfg.EMAIL_SIGNING_SECRET,
  SES_WEBHOOK_TOKEN: cfg.SES_WEBHOOK_TOKEN,
  SES_TOPIC_ARN: cfg.SES_TOPIC_ARN,
  PUBLIC_BASE_URL: cfg.PUBLIC_BASE_URL,
  SEND_BATCH_SIZE: cfg.SEND_BATCH_SIZE,
};
if (env.ENVIRONMENT !== 'production' && env.ENVIRONMENT !== 'development') throw new Error('ENVIRONMENT must be "production" or "development".');

// Behind the HTTPS proxy (Caddy) the app sees plain HTTP; restore the public https:// address so same-origin checks work.
const trustProxy = cfg.TRUST_PROXY === '1';
const fetchHandler = (req: Request) => {
  if (trustProxy && req.headers.get('x-forwarded-proto') === 'https' && req.url.startsWith('http:')) {
    const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers: req.headers, body: req.body, signal: req.signal, duplex: 'half' };
    req = new Request('https:' + req.url.slice(5), init);
  }
  return app.fetch(req, env);
};

const port = Number(cfg.PORT || 8787);
const server = serve({ fetch: fetchHandler, port, hostname: cfg.HOST || '127.0.0.1' }, info => {
  console.log(`Momentum (${env.ENVIRONMENT}) listening on http://${info.address}:${info.port}`);
});

// Every minute: start scheduled mailings and send the next batch of queued messages.
let running = false;
const tick = async () => {
  if (running) return;
  running = true;
  try {
    const r = await runScheduler(env);
    if (r.sent || r.failed) console.log('Email queue', r);
  } catch (e) {
    console.error('Email queue failed', e);
  } finally {
    running = false;
  }
};
const timer = setInterval(tick, 60_000);

const stop = () => {
  clearInterval(timer);
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
