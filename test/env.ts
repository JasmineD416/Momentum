import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../src/worker/db';
import type { Env } from '../src/worker/env';
import { applyMigrations } from '../src/worker/migrate';

// Each test file gets its own empty database, built from the real migrations.
const db = new Database(':memory:');
applyMigrations(db, readdirSync('migrations').filter(f => f.endsWith('.sql')).map(name => ({ name, sql: readFileSync(join('migrations', name), 'utf8') })));

export const env: Env = {
  DB: db,
  ENVIRONMENT: 'development',
  DEV_USER_EMAIL: 'owner@example.test',
  OWNER_EMAIL: 'owner@example.test',
  EMAIL_PROVIDER: 'log',
  EMAIL_SIGNING_SECRET: 'test-signing-secret-0123456789',
  SES_WEBHOOK_TOKEN: 'test-hook-token',
  PUBLIC_BASE_URL: 'http://localhost',
  SEND_BATCH_SIZE: '40',
  DATA_ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
};