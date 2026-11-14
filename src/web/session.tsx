import { createContext, useContext } from 'react';
import { RESTRICTED } from '../shared/constants';

export type Me = { id: string; email: string; name: string; title: string; role: 'Owner' | 'Administrator' | 'Member'; divisions: string[]; active: boolean };
export type MemberLite = { id: string; name: string; title: string; role: string; divisions: string[]; active: boolean; email?: string; rev?: number; firstSignIn?: string | null };

export type Session = { me: Me; members: MemberLite[]; reloadMembers: () => void; reloadMe: () => void };
export const SessionCtx = createContext<Session | null>(null);
export const useSession = () => useContext(SessionCtx)!;

export const hasDiv = (m: { role: string; divisions: string[] }, d: string) => m.role === 'Owner' || m.divisions.includes(d);
export const isAdmin = (m: { role: string }) => m.role === 'Owner' || m.role === 'Administrator';
export const isOwner = (m: { role: string }) => m.role === 'Owner';
export const isRestricted = (d: string) => (RESTRICTED as readonly string[]).includes(d);

/** Active members with access to a division (or everyone active when division is null), for assignment lists. */
export const memberOptions = (members: MemberLite[], division: string | null = null): [string, string][] =>
  members.filter(m => m.active && (!division || hasDiv(m, division))).map(m => [m.id, m.name]);
