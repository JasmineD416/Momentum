import { DatabaseSync, type StatementSync } from 'node:sqlite';

/**
 * SQLite database with the same small interface the routes were written against (prepare/bind/first/all/run/batch).
 * One file on the server's disk; Node's built-in SQLite, so there's nothing native to compile.
 */

type Value = null | number | bigint | string | Uint8Array;

export interface DbResult<T = Record<string, unknown>> {
  results: T[];
  success: true;
  meta: { changes: number; last_row_id: number };
}

const clean = (v: unknown): Value => {
  if (v === undefined) throw new TypeError('A query parameter was undefined. Use null for an empty value.');
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v as Value;
};
const plain = <T>(row: unknown) => (row ? ({ ...(row as object) } as T) : null);

export class Statement {
  constructor(private readonly db: Database, readonly sql: string, private readonly params: Value[] = []) {}

  bind(...params: unknown[]) { return new Statement(this.db, this.sql, params.map(clean)); }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> { return this.firstSync<T>(column); }
  async all<T = Record<string, unknown>>(): Promise<DbResult<T>> { return this.exec<T>(); }
  async run<T = Record<string, unknown>>(): Promise<DbResult<T>> { return this.exec<T>(); }

  firstSync<T>(column?: string): T | null {
    const row = this.db.statement(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return column ? ((row[column] ?? null) as T) : plain<T>(row);
  }

  /** Runs the statement; rows come back for SELECT and RETURNING, change counts for writes. */
  exec<T>(): DbResult<T> {
    const st = this.db.statement(this.sql);
    if (st.columns().length) {
      const results = st.all(...this.params).map(r => plain<T>(r)!);
      return { results, success: true, meta: { changes: 0, last_row_id: 0 } };
    }
    const r = st.run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export class Database {
  readonly raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  }

  /** Compiled statements are reused; SQLite statements are cheap to keep. */
  statement(sql: string) {
    let st = this.cache.get(sql);
    if (!st) { st = this.raw.prepare(sql); this.cache.set(sql, st); }
    return st;
  }

  prepare(sql: string) { return new Statement(this, sql); }

  /** All statements succeed together or none do (one transaction). */
  async batch<T = Record<string, unknown>>(statements: Statement[]): Promise<DbResult<T>[]> {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = statements.map(s => s.exec<T>());
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }

  async exec(sql: string) { this.raw.exec(sql); }

  close() { this.cache.clear(); this.raw.close(); }
}

// The routes name these types as the Cloudflare D1 types they were written for.
declare global {
  type D1Database = Database;
  type D1PreparedStatement = Statement;
  type D1Result<T = Record<string, unknown>> = DbResult<T>;
}
