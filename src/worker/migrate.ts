import type { Database } from './db';

export interface Migration { name: string; sql: string }

/**
 * Apply any migrations not yet recorded, in name order, each in its own transaction.
 * Uses the same bookkeeping table as Cloudflare's D1 tooling, so an exported D1 database carries on where it left off.
 */
export function applyMigrations(db: Database, migrations: Migration[]): string[] {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const done = new Set((db.raw.prepare('SELECT name FROM d1_migrations').all() as { name: string }[]).map(r => r.name));
  const applied: string[] = [];
  for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (done.has(m.name)) continue;
    db.raw.exec('BEGIN IMMEDIATE');
    try {
      db.raw.exec(m.sql);
      db.raw.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(m.name);
      db.raw.exec('COMMIT');
    } catch (e) {
      db.raw.exec('ROLLBACK');
      throw new Error(`Migration ${m.name} failed: ${(e as Error).message}`);
    }
    applied.push(m.name);
  }
  return applied;
}
