// Business time for Momentum: every period and cutoff is in America/New_York, including daylight-saving changes.

const TZ = 'America/New_York';
const parts = (instant: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(instant).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second) };
};

/** YYYY-MM-DD in New York for an instant. */
export const nyDate = (instant: Date = new Date()) => parts(instant).date;

/** Minutes New York is offset from UTC at an instant (-300 in winter, -240 in summer). */
function nyOffset(ms: number) {
  const p = parts(new Date(ms));
  const asUtc = Date.UTC(Number(p.date.slice(0, 4)), Number(p.date.slice(5, 7)) - 1, Number(p.date.slice(8, 10)), p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** The UTC instant of a wall-clock time in New York on a date (handles the DST change days). */
export function nyInstant(date: string, hour = 0, minute = 0): Date {
  const wall = Date.parse(date + 'T00:00:00Z') + (hour * 60 + minute) * 60000;
  let t = wall - nyOffset(wall) * 60000;
  t = wall - nyOffset(t) * 60000;
  return new Date(t);
}

export const addDays = (date: string, n: number) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
/** 0 = Monday … 6 = Sunday, for a calendar date. */
export const weekdayIndex = (date: string) => (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7;
export const mondayOf = (date: string) => addDays(date, -weekdayIndex(date));

/** The report period containing a business date. Weekly periods run Monday through Sunday. */
export function reportPeriod(kind: 'daily' | 'weekly', date: string) {
  if (kind === 'daily') return { start: date, end: date };
  const start = mondayOf(date);
  return { start, end: addDays(start, 6) };
}

/** UTC ISO bounds [from, to) of a New York period, for comparing against stored timestamps. */
export const periodBounds = (start: string, end: string) => ({ from: nyInstant(start).toISOString(), to: nyInstant(addDays(end, 1)).toISOString() });

/**
 * Which staff report alerts are due at an instant.
 * Daily: weekdays from 5 p.m. New York. Weekly: from Friday 5 p.m. through Sunday.
 */
export function reportAlertsDue(now: Date = new Date()) {
  const p = parts(now);
  const wd = weekdayIndex(p.date);
  const afterFive = p.hour >= 17;
  return { today: p.date, daily: wd <= 4 && afterFive, weekly: (wd === 4 && afterFive) || wd >= 5, weekStart: mondayOf(p.date) };
}
