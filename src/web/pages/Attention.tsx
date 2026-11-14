import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtDate } from '../format';
import { href } from '../router';
import { hasDiv, isAdmin, memberOptions, useSession } from '../session';
import { Empty, FormModal, Loaded, PageHead, Status, useLoad, useToast } from '../ui';

type Alert = { key: string; kind: string; title: string; detail: string; date: string; link: string; read?: boolean };
type Reminder = { id: string; title: string; notes: string; dueDate: string; assigneeId: string; assigneeName: string; creatorId: string; creatorName: string; scope: string; status: string; rev: number };
const plusDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

export function AttentionCentre() {
  const { me, members } = useSession();
  const toast = useToast();
  const alerts = useLoad(() => api.get<{ today: string; alerts: Alert[]; hidden: number }>('/api/attention'), []);
  const reminders = useLoad(() => api.get<{ reminders: Reminder[] }>('/api/reminders'), []);
  const [adding, setAdding] = useState(false);
  // Refresh every minute while the page is open.
  useEffect(() => { const t = setInterval(() => { alerts.reload(); reminders.reload(); }, 60_000); return () => clearInterval(t); }, [alerts.reload, reminders.reload]);
  const setState = async (a: Alert, state: string, snoozeUntil?: string) => {
    try { await api.post('/api/attention/state', { key: a.key, state, snoozeUntil }); alerts.reload(); } catch (e) { toast((e as Error).message); }
  };
  const complete = async (r: Reminder) => {
    try { await api.post(`/api/reminders/${r.id}/complete`, { rev: r.rev }); toast('Reminder completed.'); reminders.reload(); alerts.reload(); } catch (e) { toast((e as Error).message); }
  };
  return (
    <>
      <PageHead title="Attention centre" sub="What needs you today, from work you can see. Dismissing or snoozing only changes your own view; it doesn’t complete the work."
        actions={<button className="btn primary" onClick={() => setAdding(true)}>Add reminder</button>} />
      <div className="cols2">
        <section className="card"><h3>Alerts</h3>
          <Loaded state={alerts}>{d => d.alerts.length ? (
            <>
              <ul className="alist">{d.alerts.map(a => (
                <li key={a.key} className={a.read ? 'read' : ''}>
                  <span className="dot" />
                  <div className="grow">
                    <div className="t"><a href={href(a.link)}>{a.title}</a></div>
                    <div className="d">{a.kind} · <span style={a.date < d.today ? { color: 'var(--bad)' } : undefined}>{fmtDate(a.date)}</span>{a.detail ? ` · ${a.detail}` : ''}</div>
                  </div>
                  <div className="btns">
                    {!a.read && <button className="btn sm ghost" onClick={() => setState(a, 'read')}>Mark read</button>}
                    <button className="btn sm ghost" onClick={() => setState(a, 'snoozed', plusDays(d.today, 1))}>Tomorrow</button>
                    <button className="btn sm ghost" onClick={() => setState(a, 'snoozed', plusDays(d.today, 7))}>Next week</button>
                    <button className="btn sm ghost" onClick={() => setState(a, 'dismissed')}>Dismiss</button>
                  </div>
                </li>
              ))}</ul>
              {d.hidden > 0 && <p className="muted" style={{ fontSize: 12 }}>{d.hidden} snoozed or dismissed alert{d.hidden === 1 ? '' : 's'} hidden.</p>}
            </>
          ) : <Empty>You’re all caught up.{d.hidden > 0 && ` (${d.hidden} snoozed or dismissed.)`}</Empty>}</Loaded>
        </section>
        <section className="card"><h3>Reminders</h3>
          <Loaded state={reminders}>{d => d.reminders.length ? (
            <ul className="alist">{d.reminders.map(r => (
              <li key={r.id} className={r.status === 'Done' ? 'read' : ''}>
                <span className="dot" />
                <div className="grow">
                  <div className="t">{r.title} {r.scope === 'firm' && <Status s="JD&Co" />}</div>
                  <div className="d">{fmtDate(r.dueDate)}{r.assigneeId !== me.id ? ` · for ${r.assigneeName}` : r.creatorId !== me.id ? ` · from ${r.creatorName}` : ''}{r.notes ? ` · ${r.notes}` : ''}</div>
                </div>
                <div className="btns">{r.status === 'Open' ? <button className="btn sm" onClick={() => complete(r)}>Complete</button> : <Status s="Completed" />}</div>
              </li>
            ))}</ul>
          ) : <Empty>No reminders. Add one for anything you don’t want to forget.</Empty>}</Loaded>
        </section>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>Alerts show while this page is open and refresh every minute. Momentum doesn’t send email or push notifications yet.</p>
      {adding && <FormModal title="Add reminder" size="narrow" onClose={() => setAdding(false)} initial={{ assigneeId: me.id, scope: 'general' }}
        fields={[
          { k: 'title', l: 'Reminder', req: true, full: true }, { k: 'dueDate', l: 'Date', t: 'date', req: true },
          ...(isAdmin(me) ? [{ k: 'assigneeId', l: 'For', t: 'select' as const, blank: false as const, o: memberOptions(members) }] : []),
          ...(hasDiv(me, 'jdco') ? [{ k: 'scope', l: 'Kind', t: 'select' as const, blank: false as const, o: [['general', 'General'], ['firm', 'JD&Co Law Firm']] as [string, string][], help: 'Firm reminders go only to staff with JD&Co access.' }] : []),
          { k: 'notes', l: 'Notes', t: 'textarea' },
        ]}
        onSubmit={async v => { await api.post('/api/reminders', { title: v.title, dueDate: v.dueDate, notes: v.notes ?? '', assigneeId: v.assigneeId || me.id, scope: v.scope || 'general' }); toast('Reminder added.'); reminders.reload(); alerts.reload(); }} />}
    </>
  );
}
