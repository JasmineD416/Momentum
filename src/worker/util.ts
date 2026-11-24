import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv, Member } from './env';

export class HttpError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 500, message: string) { super(message); }
}
export const fail = (status: HttpError['status'], message: string): never => { throw new HttpError(status, message); };

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

/** Today's business date in New York, as YYYY-MM-DD. */
export const businessDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
/** Convert a D1 row (snake_case) into an API object (camelCase). */
export function toApi<T = Record<string, unknown>>(row: Record<string, unknown> | null): T {
  if (!row) return row as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[camel(k)] = v;
  return out as T;
}
export const rowsToApi = <T = Record<string, unknown>>(rows: Record<string, unknown>[]) => rows.map(r => toApi<T>(r));

/** Parse and validate the JSON body with a zod schema; 400 with a readable message on failure. */
export async function body<S extends z.ZodTypeAny>(c: Context<AppEnv>, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { fail(400, 'The request body must be valid JSON.'); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(400, `${issue.path.join('.') || 'Request'}: ${issue.message}`);
  }
  return parsed.data;
}

// Reusable field validators.
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)').refine(s => !Number.isNaN(Date.parse(s + 'T00:00:00Z')), 'must be a real date');
export const optDate = z.union([dateStr, z.literal('')]).default('');
export const httpsUrl = z.union([z.string().trim().regex(/^https:\/\/\S+$/i, 'must be an HTTPS link'), z.literal('')]).default('');
export const optEmail = z.union([z.string().trim().email('must be a valid email address'), z.literal('')]).default('');
export const text = (max = 2000) => z.string().trim().max(max).default('');
export const reqText = (max = 300) => z.string().trim().min(1, 'is required').max(max);
export const rev = z.number().int().positive();

export async function audit(c: Context<AppEnv>, action: string, entity: string, scope: 'general' | 'firm' | 'properties' = 'general') {
  const m = c.get('member');
  await c.env.DB.prepare('INSERT INTO audit (id, at, actor_id, action, entity, scope) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(newId(), nowIso(), m?.id ?? null, action, entity.slice(0, 300), scope).run();
}

export function memberFromRow(r: Record<string, unknown>): Member {
  return {
    id: String(r.id), email: String(r.email), name: String(r.name), title: String(r.title ?? ''),
    role: r.role as Member['role'], divisions: JSON.parse(String(r.divisions || '[]')), active: !!r.active,
  };
}

/** Throw 409 unless an optimistic-concurrency update changed exactly one row. */
export function assertUpdated(result: D1Result, what = 'This record') {
  if (!result.meta.changes) fail(409, `${what} was changed by someone else since you opened it. Refresh and try again.`);
}

/** Make a value safe for a CSV cell, including neutralizing spreadsheet formulas. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Parse "1,234.56" or "-12" into integer cents; NaN when not a number. */
export function toCents(v: unknown): number {
  const s = String(v ?? '').trim().replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100);
}
