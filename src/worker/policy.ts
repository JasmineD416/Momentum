import type { Context } from 'hono';
import { FOLDERS, RESTRICTED } from '../shared/constants';
import type { AppEnv, Member } from './env';
import { fail } from './util';

export const isOwner = (m: Member) => m.role === 'Owner';
export const isAdmin = (m: Member) => m.role === 'Owner' || m.role === 'Administrator';
export const hasDivision = (m: Member, division: string) => m.role === 'Owner' || m.divisions.includes(division);
export const hasFirm = (m: Member) => hasDivision(m, 'jdco');

/** Every route checks its own access, whether or not the menu shows it. */
export function requireDivision(c: Context<AppEnv>, division: string) {
  const m = c.get('member');
  if (!hasDivision(m, division)) fail(403, 'You don’t have access to this division.');
  return m;
}
export const requireFirm = (c: Context<AppEnv>) => requireDivision(c, 'jdco');
export function requireAdmin(c: Context<AppEnv>) {
  const m = c.get('member');
  if (!isAdmin(m)) fail(403, 'This is for administrators.');
  return m;
}
export function requireFolder(c: Context<AppEnv>, folderId: string) {
  const f = FOLDERS.find(x => x.id === folderId);
  if (!f) fail(404, 'Folder not found.');
  if (f!.division) requireDivision(c, f!.division);
  return f!;
}

/** An assignee or owner must be an active member with access to the division (when one is given). */
export async function checkStaff(db: D1Database, memberId: string | null, division: string | null, what = 'owner') {
  if (!memberId) return null;
  const o = await db.prepare('SELECT id, role, divisions, active FROM members WHERE id = ?').bind(memberId).first<Record<string, unknown>>();
  if (!o || !o.active) fail(400, `Choose an active staff member as ${what}.`);
  if (division && o!.role !== 'Owner' && !JSON.parse(String(o!.divisions)).includes(division)) fail(400, `The ${what} must have access to ${division === 'jdco' ? 'JD&Co Law Firm' : 'this division'}.`);
  return o!;
}

/**
 * Who may change whom. Administrators manage ordinary Members only and cannot grant restricted divisions;
 * only the Owner manages administrators and restricted divisions. Nobody edits the Owner record here.
 */
export function canManageMember(actor: Member, target: { role: string } | null) {
  if (!isAdmin(actor)) return false;
  if (!target) return true;
  if (target.role === 'Owner') return false;
  if (isOwner(actor)) return true;
  return target.role === 'Member';
}
export const canGrant = (actor: Member, division: string) => isOwner(actor) || !RESTRICTED.includes(division as never);
