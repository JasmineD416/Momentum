import { useEffect, useMemo, useState } from 'react';
import { EMAIL_BRANDS, checkMailing, emailBrandName, renderEmail, type Check, type MailContent, type Sender } from '../../shared/email';
import { api } from '../api';
import { fmtDateTime } from '../format';
import { go, href } from '../router';
import { hasDiv, isAdmin, useSession } from '../session';
import { Confirm, DataTable, FormModal, Loaded, PageHead, Pill, Status, useLoad, useToast } from '../ui';
import { SetupBanner } from './Email';

type Mailing = {
  id: string; brand: string; name: string; subject: string; preheader: string; format: 'markdown' | 'html'; body: string; campaignId: string | null; campaignName: string | null; status: string;
  scheduledAt: string | null; startedAt: string | null; finishedAt: string | null; pauseReason: string; recipientCount: number; sentCount: number; failedCount: number; bounceCount: number;
  complaintCount: number; unsubscribeCount: number; createdByName: string; sentByName: string | null; updatedAt: string; rev: number;
};
type Detail = { mailing: Mailing; sender: Sender | null; checks: Check[]; audience: number; remaining: number; problems: { email: string; status: string; error: string; bounced: number; complained: number }[]; providerReady: boolean };

const n = (x: number) => x.toLocaleString('en-CA');
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(a / b < 0.01 ? 2 : 1)}%` : '—');
const STATUS_PILL: Record<string, string> = { Draft: '', Scheduled: 'info', Sending: 'warn', Paused: 'bad', Sent: 'ok', Cancelled: '' };
const MStatus = ({ s }: { s: string }) => <Pill cls={STATUS_PILL[s] ?? ''}>{s}</Pill>;

export function Mailings() {
  const { me } = useSession();
  const toast = useToast();
  const list = useLoad(() => api.get<{ mailings: Mailing[] }>('/api/email/mailings'), []);
  const [creating, setCreating] = useState(false);
  const brands = EMAIL_BRANDS.filter(b => hasDiv(me, b.id));
  return (
    <>
      <PageHead title="Mailings" sub="Mass emails for each business. Staff write drafts and send tests to themselves; an administrator sends or schedules."
        actions={brands.length ? <button className="btn primary" onClick={() => setCreating(true)}>New mailing</button> : undefined} />
      <Loaded state={list}>{d => (
        <DataTable rows={d.mailings} rowKey={m => m.id} empty="No mailings yet."
          search={{ placeholder: 'Search mailings', text: m => [m.name, m.subject, emailBrandName(m.brand)].join(' ') }}
          columns={[
            { label: 'Mailing', render: m => <><a href={href(`mailing/${m.id}`)}><strong>{m.name}</strong></a><div className="muted">{m.subject || 'No subject yet'}</div></> },
            { label: 'Business', render: m => emailBrandName(m.brand) },
            { label: 'Status', render: m => <><MStatus s={m.status} />{m.status === 'Scheduled' && <div className="muted">{fmtDateTime(m.scheduledAt)}</div>}{m.pauseReason && m.status === 'Paused' && <div className="muted">{m.pauseReason}</div>}</> },
            { label: 'Sent', num: true, render: m => m.recipientCount ? `${n(m.sentCount)} / ${n(m.recipientCount)}` : '—' },
            { label: 'Unsubscribed', num: true, render: m => m.sentCount ? pct(m.unsubscribeCount, m.sentCount) : '—' },
            { label: 'Bounced', num: true, render: m => m.sentCount ? pct(m.bounceCount, m.sentCount) : '—' },
            { label: 'Spam reports', num: true, render: m => m.sentCount ? pct(m.complaintCount, m.sentCount) : '—' },
            { label: 'Updated', render: m => fmtDateTime(m.updatedAt) },
          ]} />
      )}</Loaded>
      {creating && <FormModal title="New mailing" size="narrow" onClose={() => setCreating(false)} initial={{ brand: brands[0]?.id }}
        fields={[{ k: 'brand', l: 'Business', t: 'select', req: true, blank: false, o: brands.map(b => [b.id, b.name] as [string, string]) }, { k: 'name', l: 'Internal name', req: true, help: 'Only staff see this, for example “November newsletter”.' }]}
        onSubmit={async v => { const r = await api.post<{ id: string }>('/api/email/mailings', { brand: v.brand, name: v.name, subject: '', preheader: '', format: 'markdown', body: STARTER }); toast('Draft created.'); go(`mailing/${r.id}`); }} />}
    </>
  );
}

const STARTER = `# Hello {{first_name|there}},

Write your message here. Keep it personal and useful: a few short paragraphs read better than one long one.

**Bold**, *italic* and [links](https://example.com) work like this. Start a line with "- " for a list:

- First point
- Second point

[[Button text|https://example.com]]

Warmly,
The team`;

const SAMPLE = { email: 'pat.sample@example.com', firstName: 'Pat', lastName: 'Sample', company: 'Sample Co' };
const PLACEHOLDER_SENDER = (brand: string): Sender => ({ brand, fromName: emailBrandName(brand), fromEmail: '', replyTo: '', postalAddress: '(Postal address from the sender settings)', logoUrl: '', accent: '#C14B8A', footerNote: '' });

export function MailingDetail({ id }: { id: string }) {
  const { me } = useSession();
  const toast = useToast();
  const d = useLoad(() => api.get<Detail>(`/api/email/mailings/${id}`), [id]);
  const campaigns = useLoad(() => api.get<{ campaigns: { id: string; name: string }[] }>('/api/marketing/campaigns').catch(() => ({ campaigns: [] })), []);
  const [form, setForm] = useState<MailContent & { name: string; campaignId: string }>({ name: '', subject: '', preheader: '', format: 'markdown', body: '', campaignId: '' });
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const [confirm, setConfirm] = useState<'' | 'send' | 'schedule' | 'pause' | 'resume' | 'cancel'>('');
  const [when, setWhen] = useState('');
  const m = d.data?.mailing;
  useEffect(() => { if (m) { setForm({ name: m.name, subject: m.subject, preheader: m.preheader, format: m.format, body: m.body, campaignId: m.campaignId ?? '' }); setDirty(false); } }, [m?.rev, m?.id]);
  // Watch progress while it sends.
  useEffect(() => { if (m && ['Sending', 'Scheduled'].includes(m.status)) { const t = setInterval(d.reload, 15_000); return () => clearInterval(t); } }, [m?.status, d.reload]);
  const draft = m?.status === 'Draft';
  const sender = d.data?.sender ?? (m ? PLACEHOLDER_SENDER(m.brand) : null);
  const checks = useMemo(() => (m ? checkMailing(form, d.data?.sender ?? null) : []), [form, d.data?.sender, m]);
  const preview = useMemo(() => (sender ? renderEmail(sender, form, SAMPLE, '#unsubscribe') : null), [sender, form]);
  const set = (k: keyof typeof form, v: string) => { setForm(f => ({ ...f, [k]: v })); setDirty(true); };
  const save = async () => {
    setBusy(true); setErr('');
    try { await api.patch(`/api/email/mailings/${id}`, { brand: m!.brand, name: form.name, subject: form.subject, preheader: form.preheader, format: form.format, body: form.body, campaignId: form.campaignId || null, rev: m!.rev }); toast('Saved.'); d.reload(); return true; }
    catch (e) { setErr((e as Error).message); return false; } finally { setBusy(false); }
  };
  const test = async () => {
    if (dirty && !(await save())) return;
    try { const r = await api.post<{ to: string }>(`/api/email/mailings/${id}/test`); toast(`Test sent to ${r.to}. Check your inbox and spam folder.`); } catch (e) { setErr((e as Error).message); }
  };
  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    await api.post(`/api/email/mailings/${id}/${action}`, { rev: m!.rev, ...extra });
    toast(action === 'send' ? (extra.scheduledAt ? 'Scheduled.' : 'Sending has started. Messages go out every minute.') : 'Done.'); d.reload();
  };
  const blocks = checks.filter(c => c.level === 'block'), warns = checks.filter(c => c.level === 'warn');
  return (
    <Loaded state={d}>{x => (
      <>
        <PageHead title={x.mailing.name} crumb={<a href={href('mailings')}>Mailings</a>} sub={<>{emailBrandName(x.mailing.brand)} · <MStatus s={x.mailing.status} />{x.mailing.status === 'Scheduled' && ` for ${fmtDateTime(x.mailing.scheduledAt)}`}</>}
          actions={<>
            <button className="btn ghost" onClick={async () => { const r = await api.post<{ id: string }>(`/api/email/mailings/${id}/duplicate`); go(`mailing/${r.id}`); }}>Duplicate</button>
            {draft && <><button className="btn" disabled={busy} onClick={test}>Send me a test</button><button className="btn" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}
            {draft && isAdmin(me) && <><button className="btn" disabled={dirty || blocks.length > 0} onClick={() => setConfirm('schedule')}>Schedule</button><button className="btn primary" disabled={dirty || blocks.length > 0} onClick={() => setConfirm('send')}>Send now</button></>}
            {isAdmin(me) && x.mailing.status === 'Sending' && <button className="btn" onClick={() => setConfirm('pause')}>Pause</button>}
            {isAdmin(me) && x.mailing.status === 'Paused' && <button className="btn primary" onClick={() => setConfirm('resume')}>Resume</button>}
            {isAdmin(me) && ['Scheduled', 'Sending', 'Paused'].includes(x.mailing.status) && <button className="btn danger" onClick={() => setConfirm('cancel')}>{x.mailing.status === 'Scheduled' ? 'Unschedule' : 'Cancel the rest'}</button>}
          </>} />
        {!x.providerReady && <SetupBanner />}
        {x.mailing.status === 'Paused' && x.mailing.pauseReason && <p className="warnbox">{x.mailing.pauseReason}</p>}
        {err && <p className="err" role="alert" style={{ marginBottom: 12 }}>{err}</p>}
        {!draft && x.mailing.status !== 'Scheduled' && (
          <div className="tiles">
            <div className="tile"><div className="k">Sent</div><div className="v small">{n(x.mailing.sentCount)} of {n(x.mailing.recipientCount)}</div>{x.remaining > 0 && <div className="muted" style={{ fontSize: 12 }}>{n(x.remaining)} waiting (daily limit or queue)</div>}</div>
            <div className="tile"><div className="k">Unsubscribed</div><div className="v small">{n(x.mailing.unsubscribeCount)} · {pct(x.mailing.unsubscribeCount, x.mailing.sentCount)}</div></div>
            <div className="tile"><div className="k">Bounced</div><div className="v small">{n(x.mailing.bounceCount)} · {pct(x.mailing.bounceCount, x.mailing.sentCount)}</div><div className="muted" style={{ fontSize: 12 }}>Keep under 2%</div></div>
            <div className="tile"><div className="k">Spam reports</div><div className="v small">{n(x.mailing.complaintCount)} · {pct(x.mailing.complaintCount, x.mailing.sentCount)}</div><div className="muted" style={{ fontSize: 12 }}>Keep under 0.1%</div></div>
          </div>
        )}
        <div className="cols2">
          <section className="card">
            <h3>Message</h3>
            <div className="fgrid">
              <div className="field"><label htmlFor="ml-name">Internal name</label><input id="ml-name" value={form.name} disabled={!draft} onChange={e => set('name', e.target.value)} /></div>
              <div className="field"><label htmlFor="ml-camp">Campaign</label><select id="ml-camp" value={form.campaignId} disabled={!draft} onChange={e => set('campaignId', e.target.value)}><option value="">None</option>{(campaigns.data?.campaigns ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
              <div className="field full"><label htmlFor="ml-subj">Subject</label><input id="ml-subj" value={form.subject} disabled={!draft} maxLength={200} onChange={e => set('subject', e.target.value)} /><small>{form.subject.length} characters. Use {'{{first_name}}'} to personalise.</small></div>
              <div className="field full"><label htmlFor="ml-pre">Preview text</label><input id="ml-pre" value={form.preheader} disabled={!draft} maxLength={200} onChange={e => set('preheader', e.target.value)} /><small>Shown after the subject in the inbox.</small></div>
              <div className="field full"><label htmlFor="ml-fmt">Format</label>
                <select id="ml-fmt" value={form.format} disabled={!draft} onChange={e => set('format', e.target.value)}><option value="markdown">Simple (headings, bold, links, buttons)</option><option value="html">HTML (paste a design from another tool)</option></select></div>
              <div className="field full"><label htmlFor="ml-body">Body</label><textarea id="ml-body" rows={18} value={form.body} disabled={!draft} onChange={e => set('body', e.target.value)} style={{ fontFamily: form.format === 'html' ? 'ui-monospace, Consolas, monospace' : undefined, fontSize: form.format === 'html' ? 12.5 : undefined }} />
                <small>{form.format === 'markdown' ? '# Heading · **bold** · *italic* · [link](https://…) · ![image](https://…) · - list item · [[Button|https://…]] · {{first_name|there}}' : 'The footer with your postal address and unsubscribe link is added automatically.'}</small></div>
            </div>
          </section>
          <div>
            <section className="card"><h3>Before sending</h3>
              {draft && <p style={{ marginTop: 0 }}>Goes to <strong>{n(x.audience)}</strong> {x.audience === 1 ? 'person' : 'people'} on the {emailBrandName(x.mailing.brand)} list who can be emailed today{x.sender ? `, up to ${n((x.sender as Sender & { dailyLimit?: number }).dailyLimit ?? 0)} a day` : ''}.</p>}
              {!checks.length ? <p className="muted" style={{ margin: 0 }}>No problems found.</p> : (
                <ul className="alist">{[...blocks, ...warns].map((c, i) => <li key={i}><span className="dot" style={{ background: c.level === 'block' ? 'var(--bad)' : 'var(--warn)' }} /><div className="grow"><div className="d" style={{ color: 'inherit' }}>{c.level === 'block' && <strong>Must fix: </strong>}{c.text}</div></div></li>)}</ul>
              )}
              <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Every email gets a plain-text version, your postal address, a visible unsubscribe link and one-click unsubscribe headers. Send yourself a test and check it in Gmail and Outlook before sending.</p>
            </section>
            <section className="card"><h3>Preview <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>as {SAMPLE.firstName} {SAMPLE.lastName}</span></h3>
              {preview && <><div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}><strong>{preview.subject || '(no subject)'}</strong> — {form.preheader}</div>
                <iframe title="Email preview" sandbox="" srcDoc={preview.html} style={{ width: '100%', height: 560, border: '1px solid var(--line)', borderRadius: 8, background: '#fff' }} /></>}
            </section>
          </div>
        </div>
        {x.problems.length > 0 && <section className="card"><h3>Not delivered or skipped</h3>
          <DataTable rows={x.problems} rowKey={p => p.email} empty="" columns={[{ label: 'Email', render: p => p.email }, { label: 'What happened', render: p => p.bounced ? <Pill cls="bad">Bounced</Pill> : p.complained ? <Pill cls="bad">Spam report</Pill> : <Status s={p.status === 'Failed' ? 'Error' : 'Skipped'} /> }, { label: 'Detail', render: p => p.error || '—' }]} />
        </section>}
        {confirm === 'send' && <Confirm title="Send now" label={`Send to ${n(x.audience)}`} onClose={() => setConfirm('')} onConfirm={() => act('send')}
          text={`This emails ${n(x.audience)} people on the ${emailBrandName(x.mailing.brand)} list, starting within a minute. It can be paused, but sent messages can’t be recalled.`} />}
        {confirm === 'schedule' && <FormModal title="Schedule" size="narrow" submitLabel="Schedule" onClose={() => setConfirm('')} initial={{ when }} fields={[{ k: 'when', l: 'Send at (your time)', t: 'datetime', req: true }]}
          intro={<p style={{ marginTop: 0 }}>Tuesday to Thursday mornings usually get the best response.</p>}
          onSubmit={async v => { setWhen(v.when); await act('send', { scheduledAt: new Date(v.when).toISOString() }); }} />}
        {confirm === 'pause' && <Confirm title="Pause sending" label="Pause" text="Nothing more goes out until you resume." onClose={() => setConfirm('')} onConfirm={() => act('pause')} />}
        {confirm === 'resume' && <Confirm title="Resume sending" label="Resume" text={x.mailing.pauseReason.startsWith('Paused automatically') ? 'This mailing was paused because of bounces or spam reports. Resume only after checking the list.' : 'Sending continues within a minute.'} onClose={() => setConfirm('')} onConfirm={() => act('resume')} />}
        {confirm === 'cancel' && <Confirm title={x.mailing.status === 'Scheduled' ? 'Unschedule' : 'Cancel the rest'} label={x.mailing.status === 'Scheduled' ? 'Unschedule' : 'Cancel'} onClose={() => setConfirm('')} onConfirm={() => act('cancel')}
          text={x.mailing.status === 'Scheduled' ? 'It goes back to a draft you can edit.' : 'Messages not sent yet are dropped. This can’t be undone.'} />}
      </>
    )}</Loaded>
  );
}
