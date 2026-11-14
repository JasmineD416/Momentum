import { useEffect, useState } from 'react';
import { REPORT_FIELDS } from '../../shared/constants';
import { api } from '../api';
import { businessToday, fmtDate, fmtDateTime } from '../format';
import { hasDiv, isAdmin, useSession } from '../session';
import { Empty, FormModal, Loaded, PageHead, Status, useLoad, useToast } from '../ui';

type FieldKey = (typeof REPORT_FIELDS)[number][0];
type Report = Record<FieldKey, string> & {
  id: string; memberId: string; kind: string; scope: string; periodStart: string; periodEnd: string; status: string; counters: Record<string, number>;
  submittedAt: string | null; reviewedBy: string | null; reviewedByName: string | null; reviewedAt: string | null; reviewNote: string; updatedAt: string; rev: number;
};
type Period = { start: string; end: string };
const periodLabel = (kind: string, p: Period) => (kind === 'daily' ? fmtDate(p.start) : `${fmtDate(p.start)} to ${fmtDate(p.end)}`);
const counterLabel = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());

function Counters({ c }: { c: Record<string, number> }) {
  const e = Object.entries(c);
  return e.length ? <div className="muted" style={{ fontSize: 12 }}>Snapshot when saved: {e.map(([k, n]) => `${counterLabel(k).toLowerCase()} ${n}`).join(' · ')}</div> : null;
}

function Picker({ kind, setKind, scope, setScope, date, setDate }: { kind: string; setKind: (k: string) => void; scope: string; setScope: (s: string) => void; date: string; setDate: (d: string) => void }) {
  const { me } = useSession();
  return (
    <div className="toolbar">
      <div className="tabs" style={{ margin: 0 }}>{['daily', 'weekly'].map(k => <button key={k} className={k === kind ? 'on' : ''} onClick={() => setKind(k)}>{k === 'daily' ? 'Daily' : 'Weekly'}</button>)}</div>
      {hasDiv(me, 'jdco') && <select aria-label="Report scope" value={scope} onChange={e => setScope(e.target.value)}><option value="general">General</option><option value="firm">JD&amp;Co Law Firm</option></select>}
      <input type="date" aria-label="Date" value={date} max={businessToday()} onChange={e => e.target.value && setDate(e.target.value)} />
    </div>
  );
}

function MyUpdate() {
  const toast = useToast();
  const [kind, setKind] = useState('daily'), [scope, setScope] = useState('general'), [date, setDate] = useState(businessToday());
  const d = useLoad(() => api.get<{ period: Period; report: Report | null }>(`/api/reports/mine?kind=${kind}&scope=${scope}&date=${date}`), [kind, scope, date]);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  useEffect(() => { const r = d.data?.report; setVals(Object.fromEntries(REPORT_FIELDS.map(([k]) => [k, r?.[k] ?? '']))); setErr(''); }, [d.data]);
  const save = async (submit: boolean) => {
    setBusy(true); setErr('');
    try {
      await api.put('/api/reports/mine', { kind, scope, date, ...vals, submit, rev: d.data?.report?.rev });
      toast(submit ? 'Update submitted.' : 'Draft saved. Only you can read it.'); d.reload();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  return (
    <>
      <Picker {...{ kind, setKind, scope, setScope, date, setDate }} />
      <Loaded state={d}>{({ period, report: r }) => (
        <section className="card report-form">
          <h3>{kind === 'daily' ? 'Daily' : 'Weekly'} update · {periodLabel(kind, period)} {r ? <Status s={r.status} /> : <Status s="Not started" />}</h3>
          {r?.reviewedAt && <p className="infobox">Reviewed by {r.reviewedByName} on {fmtDateTime(r.reviewedAt)}{r.reviewNote ? `: “${r.reviewNote}”` : '.'} Editing clears the review.</p>}
          {r?.status === 'Draft' && <p className="muted" style={{ marginTop: 0 }}>Drafts are private. Administrators see only that you started one.</p>}
          {REPORT_FIELDS.map(([k, label]) => (
            <div className="field" key={k}><label htmlFor={`rf-${k}`}>{label}</label><textarea id={`rf-${k}`} value={vals[k] ?? ''} onChange={e => setVals(s => ({ ...s, [k]: e.target.value }))} /></div>
          ))}
          {r && <Counters c={r.counters} />}
          {err && <p className="err" role="alert">{err}</p>}
          <div className="form-actions">
            {r && <button className="btn ghost" onClick={() => api.download(`/api/reports/${r.id}/recap`, `momentum-${kind}-update-${period.start}.txt`).catch(e => toast(e.message))}>Download recap</button>}
            <button className="btn" disabled={busy} onClick={() => save(false)}>{r?.status === 'Submitted' ? 'Return to draft' : 'Save draft'}</button>
            <button className="btn primary" disabled={busy} onClick={() => save(true)}>{r?.status === 'Submitted' ? 'Resubmit' : 'Submit'}</button>
          </div>
        </section>
      )}</Loaded>
    </>
  );
}

type TeamRow = { memberId: string; name: string; title: string; status: string; report: Report | null };
function TeamReview() {
  const toast = useToast();
  const [kind, setKind] = useState('daily'), [scope, setScope] = useState('general'), [date, setDate] = useState(businessToday());
  const d = useLoad(() => api.get<{ period: Period; team: TeamRow[] }>(`/api/reports/team?kind=${kind}&scope=${scope}&date=${date}`), [kind, scope, date]);
  const [reviewing, setReviewing] = useState<TeamRow | null>(null);
  return (
    <>
      <Picker {...{ kind, setKind, scope, setScope, date, setDate }} />
      <Loaded state={d}>{({ period, team }) => (
        <>
          <p className="muted">{kind === 'daily' ? 'Daily' : 'Weekly'} updates for {periodLabel(kind, period)}. You see submitted updates only; drafts show their status.</p>
          {!team.length ? <Empty>No staff whose updates you review.</Empty> : team.map(t => (
            <section className="card" key={t.memberId}>
              <h3>{t.name}{t.title && <span className="muted" style={{ fontWeight: 400 }}> · {t.title}</span>} <Status s={t.status} />{t.report?.reviewedAt && <> <Status s="Reviewed" /></>}</h3>
              {t.report ? (
                <>
                  {REPORT_FIELDS.map(([k, label]) => t.report![k] ? <div key={k} style={{ marginBottom: 8 }}><div className="muted" style={{ fontSize: 12 }}>{label}</div><div style={{ whiteSpace: 'pre-wrap' }}>{t.report![k]}</div></div> : null)}
                  <Counters c={t.report.counters} />
                  {t.report.reviewedAt && <p className="muted" style={{ fontSize: 12 }}>Reviewed by {t.report.reviewedByName} on {fmtDateTime(t.report.reviewedAt)}{t.report.reviewNote ? `: “${t.report.reviewNote}”` : ''}</p>}
                  <div className="row" style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button className="btn sm primary" onClick={() => setReviewing(t)}>{t.report.reviewedAt ? 'Review again' : 'Mark reviewed'}</button>
                    <button className="btn sm ghost" onClick={() => api.download(`/api/reports/${t.report!.id}/recap`, `momentum-${kind}-update-${t.name}-${period.start}.txt`).catch(e => toast(e.message))}>Download recap</button>
                  </div>
                </>
              ) : <p className="muted" style={{ margin: 0 }}>{t.status === 'Draft' ? 'Started, not submitted yet.' : 'Nothing yet.'}</p>}
            </section>
          ))}
        </>
      )}</Loaded>
      {reviewing?.report && <FormModal title={`Review ${reviewing.name}’s update`} size="narrow" submitLabel="Mark reviewed" onClose={() => setReviewing(null)}
        fields={[{ k: 'note', l: 'Note for them (optional)', t: 'textarea' }]}
        onSubmit={async v => { await api.post(`/api/reports/${reviewing.report!.id}/review`, { note: v.note ?? '', rev: reviewing.report!.rev }); toast('Marked reviewed.'); d.reload(); }} />}
    </>
  );
}

export function StaffUpdates() {
  const { me } = useSession();
  const [tab, setTab] = useState<'mine' | 'team'>('mine');
  return (
    <>
      <PageHead title="Staff updates" sub="Daily and weekly updates: completed work, work in progress, blockers, decisions needed from Jasmine and next priorities. Days and weeks (Monday to Sunday) follow New York time." />
      {isAdmin(me) && <div className="tabs"><button className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>My update</button><button className={tab === 'team' ? 'on' : ''} onClick={() => setTab('team')}>Team review</button></div>}
      {tab === 'team' && isAdmin(me) ? <TeamReview /> : <MyUpdate />}
    </>
  );
}
