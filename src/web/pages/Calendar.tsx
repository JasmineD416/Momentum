import { useState } from 'react';
import { api } from '../api';
import { businessToday, fmtMonth } from '../format';
import { href } from '../router';
import { hasDiv, useSession } from '../session';
import { Loaded, PageHead, useLoad } from '../ui';

type Item = { date: string; kind: string; title: string; detail: string; link: string };
const chipClass = (kind: string) => (kind.startsWith('Campaign') ? 'campaign' : kind === 'Work' ? 'work' : kind === 'Follow-up' ? 'follow' : 'firm');
const shift = (ym: string, n: number) => { const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1)); return d.toISOString().slice(0, 7); };

export function TeamCalendar() {
  const { me } = useSession();
  const today = businessToday();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [firm, setFirm] = useState(false);
  const cal = useLoad(() => api.get<{ items: Item[] }>(`/api/calendar?month=${month}${firm ? '&includeFirm=1' : ''}`), [month, firm]);
  // Monday-first grid covering the whole month.
  const first = new Date(month + '-01T00:00:00Z');
  const lead = (first.getUTCDay() + 6) % 7;
  const start = new Date(first.getTime() - lead * 86400000);
  const days = Array.from({ length: 42 }, (_, i) => new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10));
  const weeks = days.slice(35).every(d => d.slice(0, 7) !== month) ? days.slice(0, 35) : days;
  return (
    <>
      <PageHead title="Team calendar" sub="Campaign dates, work deadlines and marketing follow-ups. Select an item to open it. Nothing here syncs with an outside calendar." />
      <div className="toolbar">
        <button className="btn sm" onClick={() => setMonth(shift(month, -1))} aria-label="Previous month">‹</button>
        <strong style={{ minWidth: 150, textAlign: 'center' }}>{fmtMonth(month)}</strong>
        <button className="btn sm" onClick={() => setMonth(shift(month, 1))} aria-label="Next month">›</button>
        <button className="btn sm ghost" onClick={() => setMonth(today.slice(0, 7))}>Today</button>
        {hasDiv(me, 'jdco') && <label className="chk"><input type="checkbox" checked={firm} onChange={e => setFirm(e.target.checked)} /> Include JD&amp;Co PNC dates</label>}
      </div>
      <Loaded state={cal}>{d => (
        <>
          <div className="cal"><div className="cal-grid">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(x => <div key={x} className="dow">{x}</div>)}
            {weeks.map(day => (
              <div key={day} className={`day${day.slice(0, 7) !== month ? ' out' : ''}${day === today ? ' today' : ''}`}>
                <span className="n">{Number(day.slice(8))}</span>
                {d.items.filter(i => i.date === day).map((i, n) => (
                  <a key={n} className={`chip ${chipClass(i.kind)}`} href={href(i.link)} title={`${i.kind}: ${i.title}${i.detail ? ` · ${i.detail}` : ''}`}>{i.kind === 'Work' ? '' : `${i.kind}: `}{i.title}</a>
                ))}
              </div>
            ))}
          </div></div>
          <div className="legend">
            <span style={{ '--c': '#111' } as never}>Work deadline</span><span style={{ '--c': 'var(--violet)' } as never}>Campaign</span>
            <span style={{ '--c': 'var(--pink)' } as never}>Marketing follow-up</span>{firm && <span style={{ '--c': 'var(--warn)' } as never}>JD&amp;Co date (verify before relying on it)</span>}
          </div>
        </>
      )}</Loaded>
    </>
  );
}
