export const fmtDate = (d?: string | null) =>
  d ? new Date(d.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—';
export const fmtDateTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const fmtMonth = (ym: string) => new Date(ym + '-15T12:00:00Z').toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
export const money = (cents?: number | null, cur = 'CAD') => ((cents || 0) / 100).toLocaleString('en-CA', { style: 'currency', currency: cur });
export const businessToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const clientName = (x: { lastName?: string; firstName?: string }) => [x.lastName, x.firstName].filter(Boolean).join(', ');
/** "125.50" → 12550; NaN if not an amount. */
export const parseCents = (s: string) => {
  const t = s.trim().replace(/[$,\s]/g, '');
  return /^-?\d+(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : NaN;
};
