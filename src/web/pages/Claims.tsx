import { useState } from 'react';
import { CARD_TYPES, CLAIM_PAY_METHODS, CLAIM_STATUSES, CURRENCIES, DIVISIONS, divisionName } from '../../shared/constants';
import { api } from '../api';
import { fmtDate, fmtDateTime, money } from '../format';
import { hasDiv, isAdmin, useSession } from '../session';
import { Confirm, DataTable, FormModal, Loaded, PageHead, Status, useLoad, useToast, type Field } from '../ui';

type File_ = { id: string; fileName: string; contentType: string; size: number; uploadedAt: string };
type Claim = {
  id: string; memberId: string; memberName: string; division: string; chargeDate: string; amountCents: number; currency: string; company: string;
  payMethod: string; cardType: string; cardLast4: string; description: string; notes: string; status: string; reviewNote: string;
  reviewedByName: string | null; reviewedAt: string | null; files: File_[]; canReview: boolean; rev: number;
};

const MAX_MB = 8;
const ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp,image/heic,.heic';
const paidBy = (c: Claim) => (c.payMethod === 'Credit card' ? `${c.cardType} •••• ${c.cardLast4}` : c.payMethod);
const fileUrl = (c: Claim, f: File_) => `/api/claims/${c.id}/invoices/${f.id}`;
const tooBig = (f?: File | null) => !!f && f.size > MAX_MB * 1024 * 1024;

export function ExpenseClaims() {
  const { me } = useSession();
  const toast = useToast();
  const admin = isAdmin(me);
  const VIEWS = admin ? (['To review', 'Mine', 'All'] as const) : (['Mine'] as const);
  const [view, setView] = useState<string>(VIEWS[0]);
  const list = useLoad(() => api.get<{ claims: Claim[] }>('/api/claims'), []);
  const [editing, setEditing] = useState<Claim | 'new' | null>(null);
  const [adding, setAdding] = useState<Claim | null>(null);
  const [reviewing, setReviewing] = useState<Claim | null>(null);
  const [withdrawing, setWithdrawing] = useState<Claim | null>(null);
  const divisions: [string, string][] = DIVISIONS.filter(d => hasDiv(me, d.id)).map(d => [d.id, d.name]);
  const run = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); toast(msg); list.reload(); } catch (e) { toast((e as Error).message); } };

  const fields = (isNew: boolean): Field[] => [
    { k: 'chargeDate', l: 'Date of the charge', t: 'date', req: true },
    { k: 'division', l: 'For', t: 'select', o: divisions, blank: 'General / team', help: 'Which business the charge is for.' },
    { k: 'amountCents', l: 'Amount', t: 'money', req: true, help: 'The total charged, including tax.' },
    { k: 'currency', l: 'Currency', t: 'select', blank: false, o: CURRENCIES },
    { k: 'company', l: 'Company', req: true, full: true, help: 'Who charged it, e.g. "Canva" or "Staples".' },
    { k: 'payMethod', l: 'Method of payment', t: 'select', req: true, o: CLAIM_PAY_METHODS, blank: 'Choose…' },
    { k: 'cardType', l: 'Card type', t: 'select', o: CARD_TYPES, help: 'Credit card only.' },
    { k: 'cardLast4', l: 'Card’s last four digits', help: 'Credit card only. Never enter the full card number.' },
    { k: 'description', l: 'Description', req: true, full: true, help: 'What it was for.' },
    { k: 'notes', l: 'Notes', t: 'textarea' },
    ...(isNew ? [{ k: 'invoice', l: 'Invoice', t: 'file' as const, req: true, full: true, accept: ACCEPT, help: `PDF or a photo (JPG, PNG, WebP or HEIC), up to ${MAX_MB} MB. You can add more files after saving.` }] : []),
  ];

  return (
    <>
      <PageHead title="Expense claims" sub="Submit a charge you paid for the business, with its invoice. Administrators review claims; you can change or withdraw yours until it’s reviewed."
        actions={<button className="btn primary" onClick={() => setEditing('new')}>Submit an expense</button>} />
      {VIEWS.length > 1 && <div className="tabs">{VIEWS.map(v => <button key={v} className={v === view ? 'on' : ''} onClick={() => setView(v)}>{v}</button>)}</div>}
      <Loaded state={list}>{d => {
        const rows = d.claims.filter(c => view === 'All' ? true : view === 'To review' ? c.status === 'Submitted' && c.canReview : c.memberId === me.id);
        return (
          <DataTable rows={rows} rowKey={c => c.id} empty={view === 'To review' ? 'Nothing is waiting for review.' : 'No expense claims yet.'}
            search={{ placeholder: 'Search company, description, person', text: c => [c.company, c.description, c.notes, c.memberName, divisionName(c.division)].join(' ') }}
            columns={[
              { label: 'Date', render: c => fmtDate(c.chargeDate) },
              { label: 'Company', render: c => <><strong>{c.company}</strong><div className="muted">{c.description}</div>{c.notes && <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</div>}</> },
              { label: 'Amount', num: true, render: c => money(c.amountCents, c.currency) },
              { label: 'Paid by', render: c => <span style={{ whiteSpace: 'nowrap' }}>{paidBy(c)}</span> },
              ...(admin ? [{ label: 'Submitted by', render: (c: Claim) => c.memberId === me.id ? `${c.memberName} (you)` : c.memberName }] : []),
              { label: 'For', render: c => c.division ? divisionName(c.division) : <span className="muted">General</span> },
              { label: 'Invoice', render: c => c.files.length
                ? <div className="stack">{c.files.map(f => <a key={f.id} href={fileUrl(c, f)} target="_blank" rel="noopener noreferrer">{f.fileName} ↗</a>)}</div>
                : <span style={{ color: 'var(--bad)' }}>Missing</span> },
              { label: 'Status', render: c => <><Status s={c.status} />{c.reviewedByName && <div className="muted" title={fmtDateTime(c.reviewedAt)}>by {c.reviewedByName}</div>}{c.reviewNote && <div className="muted">{c.reviewNote}</div>}</> },
              { label: '', render: c => <div className="acts-cell">
                {c.canReview && <button className="btn sm primary" onClick={() => setReviewing(c)}>Review</button>}
                {c.memberId === me.id && c.status === 'Submitted' && <>
                  <button className="btn sm" onClick={() => setAdding(c)}>Add file</button>
                  <button className="btn sm" onClick={() => setEditing(c)}>Edit</button>
                  <button className="btn sm" onClick={() => setWithdrawing(c)}>Withdraw</button>
                </>}
              </div> },
            ]} />
        );
      }}</Loaded>

      {editing && <FormModal title={editing === 'new' ? 'Submit an expense' : 'Edit expense claim'} onClose={() => setEditing(null)} submitLabel={editing === 'new' ? 'Submit' : 'Save'}
        initial={editing === 'new' ? { currency: 'CAD', division: divisions.length === 1 ? divisions[0][0] : '' } : editing}
        fields={fields(editing === 'new')}
        live={v => v.payMethod === 'Credit card' && v.cardLast4 && !/^\d{4}$/.test(String(v.cardLast4).trim()) ? <p className="err">Enter only the last four digits of the card.</p> : null}
        onSubmit={async v => {
          if (v.payMethod === 'Credit card' && (!v.cardType || !/^\d{4}$/.test(String(v.cardLast4 ?? '').trim()))) throw new Error('For a credit card, choose the card type and enter its last four digits.');
          if (tooBig(v.invoice)) throw new Error(`The invoice is larger than ${MAX_MB} MB.`);
          const payload = { division: v.division ?? '', chargeDate: v.chargeDate, amountCents: v.amountCents, currency: v.currency, company: v.company, payMethod: v.payMethod,
            cardType: v.payMethod === 'Credit card' ? v.cardType : '', cardLast4: v.payMethod === 'Credit card' ? String(v.cardLast4).trim() : '', description: v.description, notes: v.notes ?? '' };
          if (editing !== 'new') { await api.patch(`/api/claims/${editing.id}`, { ...payload, rev: editing.rev }); toast('Claim saved.'); list.reload(); return; }
          const { id } = await api.post<{ id: string }>('/api/claims', payload);
          try { await api.upload(`/api/claims/${id}/invoices`, v.invoice); toast('Expense submitted.'); }
          catch (e) { toast(`Expense saved, but the invoice didn’t upload: ${(e as Error).message} Use Add file to try again.`); }
          list.reload();
        }} />}

      {adding && <FormModal title={`Add a file to ${adding.company}`} size="narrow" onClose={() => setAdding(null)} submitLabel="Upload"
        fields={[{ k: 'file', l: 'File', t: 'file', req: true, full: true, accept: ACCEPT, help: `PDF or a photo, up to ${MAX_MB} MB.` }]}
        note={adding.files.length ? <>Already attached: {adding.files.map(f => f.fileName).join(', ')}</> : undefined}
        onSubmit={async v => {
          if (tooBig(v.file)) throw new Error(`The file is larger than ${MAX_MB} MB.`);
          await api.upload(`/api/claims/${adding.id}/invoices`, v.file); toast('File added.'); list.reload();
        }} />}

      {reviewing && <FormModal title={`Review: ${reviewing.company}, ${money(reviewing.amountCents, reviewing.currency)}`} size="narrow" onClose={() => setReviewing(null)}
        initial={{ status: reviewing.status === 'Submitted' ? 'Approved' : reviewing.status, note: reviewing.reviewNote }}
        intro={<p className="muted" style={{ marginTop: 0 }}>Submitted by {reviewing.memberName} · {fmtDate(reviewing.chargeDate)} · {paidBy(reviewing)} · {reviewing.files.length ? `${reviewing.files.length} file(s)` : 'no invoice attached'}</p>}
        fields={[
          { k: 'status', l: 'Decision', t: 'select', blank: false, o: CLAIM_STATUSES, full: true, help: 'Choose Submitted to send it back to the submitter for changes.' },
          { k: 'note', l: 'Note', t: 'textarea', help: 'Required when declining.' },
        ]}
        onSubmit={async v => {
          await api.post(`/api/claims/${reviewing.id}/review`, { status: v.status, note: v.note ?? '', rev: reviewing.rev }); toast('Review saved.'); list.reload();
        }} />}

      {withdrawing && <Confirm title="Withdraw this claim?" label="Withdraw" onClose={() => setWithdrawing(null)}
        text={<>This removes the claim for <strong>{withdrawing.company}</strong> ({money(withdrawing.amountCents, withdrawing.currency)}) and its invoice files. It can’t be undone.</>}
        onConfirm={() => run(() => api.post(`/api/claims/${withdrawing.id}/withdraw`, { rev: withdrawing.rev }), 'Claim withdrawn.')} />}
    </>
  );
}
