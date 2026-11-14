import { useState } from 'react';
import { BOOK_STATUSES, CURRENCIES, EXPENSE_CATEGORIES, PAY_STATUSES } from '../../shared/constants';
import { api, qs } from '../api';
import { businessToday, clientName, fmtDate, fmtMonth, money } from '../format';
import { href } from '../router';
import { isAdmin, useSession } from '../session';
import { DataTable, Ext, FormModal, Loaded, PageHead, Status, useLoad, useToast, type Field } from '../ui';

type Expense = { id: string; matterId: string; clientId: string; fileNumber: string; lastName: string; firstName: string; date: string; provider: string; description: string; category: string; reference: string; currency: string; amountCents: number; hstCents: number; payStatus: string; paidDate: string; payMethod: string; bookStatus: string; batchRef: string; receipt: string; notes: string; state: string; voidReason: string; createdBy: string; rev: number };
type Totals = Record<string, { amountCents: number; hstCents: number; totalCents: number }>;
type MatterLite = { id: string; fileNumber: string; lastName: string; firstName: string; status: string };

export function ClientExpenses() {
  const { me } = useSession();
  const toast = useToast();
  const [month, setMonth] = useState(businessToday().slice(0, 7));
  const [matterId, setMatterId] = useState('');
  const [q, setQ] = useState('');
  const query = qs({ scope: 'client', month, matterId: matterId || undefined, q: q || undefined });
  const list = useLoad(() => api.get<{ expenses: Expense[]; totals: Totals }>(`/api/expenses${query}`), [query]);
  const matters = useLoad(() => api.get<{ matters: MatterLite[] }>('/api/matters'), []);
  const [editing, setEditing] = useState<Expense | 'new' | null>(null);
  const [voiding, setVoiding] = useState<Expense | null>(null);
  const matterOpts = (matters.data?.matters ?? []).map(m => [m.id, `${m.fileNumber} · ${clientName(m)}`] as [string, string]);
  const fields: Field[] = [
    { k: 'matterId', l: 'Client matter', t: 'select', req: true, o: matterOpts, full: true },
    { k: 'date', l: 'Expense date', t: 'date', req: true }, { k: 'provider', l: 'Service provider', req: true },
    { k: 'description', l: 'Description', full: true }, { k: 'category', l: 'Category', t: 'select', o: EXPENSE_CATEGORIES }, { k: 'reference', l: 'Invoice or receipt number' },
    { k: 'h1', l: 'Amounts', t: 'h' },
    { k: 'currency', l: 'Currency', t: 'select', blank: false, o: CURRENCIES }, { k: 'amountCents', l: 'Amount before HST', t: 'money', req: true },
    { k: 'hstCents', l: 'HST shown on the invoice', t: 'money', help: 'Enter only what the invoice shows. No rate is assumed.' }, { k: 'receipt', l: 'Receipt or invoice link', t: 'url' },
    { k: 'h2', l: 'Payment and bookkeeping', t: 'h' },
    { k: 'payStatus', l: 'Payment', t: 'select', blank: false, o: PAY_STATUSES }, { k: 'paidDate', l: 'Paid date', t: 'date' }, { k: 'payMethod', l: 'Payment method' },
    { k: 'bookStatus', l: 'Bookkeeping', t: 'select', blank: false, o: BOOK_STATUSES }, { k: 'batchRef', l: 'Bookkeeping batch or reference' },
    { k: 'notes', l: 'Notes', t: 'textarea' },
  ];
  const label = month ? fmtMonth(month) : 'All months';
  return (
    <>
      <PageHead title="Client expenses" sub="Disbursements on client files. Totals use the HST shown on each invoice. CAD and USD stay separate, and voided rows stay visible but don’t count."
        actions={<><button className="btn" onClick={() => api.download(`/api/expenses/export${query}`, `momentum-client-expenses-${month || 'all'}.csv`).catch(e => toast(e.message))}>Export CSV</button>
          <button className="btn primary" onClick={() => setEditing('new')}>Add expense</button></>} />
      <div className="toolbar">
        <input type="month" aria-label="Month" value={month} onChange={e => setMonth(e.target.value)} />
        <button type="button" className="btn sm ghost" onClick={() => setMonth('')}>All months</button>
        <select aria-label="Matter" value={matterId} onChange={e => setMatterId(e.target.value)}><option value="">All clients and matters</option>{matterOpts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <input type="search" aria-label="Search supplier or text" placeholder="Supplier or text" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <Loaded state={list}>{d => {
        const curs = Object.keys(d.totals).length ? Object.keys(d.totals) : ['CAD'];
        return (
          <>
            <div className="tiles">
              {curs.map(c => <div className="tile" key={c}><div className="k">{label} · {c} incl. HST</div><div className="v small">{money(d.totals[c]?.totalCents, c)}</div></div>)}
              <div className="tile"><div className="k">Unpaid</div><div className="v">{d.expenses.filter(e => e.state === 'Recorded' && e.payStatus === 'Unpaid').length}</div></div>
              <div className="tile"><div className="k">Payment status unknown</div><div className="v">{d.expenses.filter(e => e.state === 'Recorded' && e.payStatus === 'Unknown').length}</div></div>
            </div>
            <DataTable rows={d.expenses} rowKey={e => e.id} empty="No expenses for these filters." rowClass={e => (e.state === 'Voided' ? 'voided' : '')}
              foot={d.expenses.length ? <tfoot>{curs.map(c => <tr key={c}><td colSpan={4}>Recorded total, {c}</td><td className="num">{money(d.totals[c]?.amountCents, c)}</td><td className="num">{money(d.totals[c]?.hstCents, c)}</td><td className="num">{money(d.totals[c]?.totalCents, c)}</td><td colSpan={3} /></tr>)}</tfoot> : undefined}
              columns={[
                { label: 'Date', render: e => fmtDate(e.date) },
                { label: 'Provider', render: e => <><strong>{e.provider}</strong><div className="muted">{[e.description, e.reference].filter(Boolean).join(' · ')}</div></> },
                { label: 'Category', render: e => e.category || '—' },
                { label: 'File', render: e => <a href={href(`client/${e.clientId}`)}>{e.fileNumber} · {clientName(e)}</a> },
                { label: 'Before HST', num: true, render: e => money(e.amountCents, e.currency) }, { label: 'HST', num: true, render: e => money(e.hstCents, e.currency) },
                { label: 'Total', num: true, render: e => <strong>{money(e.amountCents + e.hstCents, e.currency)}</strong> },
                { label: 'Payment', render: e => <><Status s={e.payStatus} />{e.paidDate && <div className="muted">{fmtDate(e.paidDate)}</div>}</> },
                { label: 'Bookkeeping', render: e => e.state === 'Voided' ? <><Status s="Voided" /><div className="muted">{e.voidReason}</div></> : <Status s={e.bookStatus} /> },
                { label: '', render: e => <div className="acts-cell">{e.receipt && <Ext href={e.receipt}>Receipt</Ext>}{e.state !== 'Voided' && (e.createdBy === me.id || isAdmin(me)) && <><button className="btn sm" onClick={() => setEditing(e)}>Edit</button><button className="btn sm danger" onClick={() => setVoiding(e)}>Void</button></>}</div> },
              ]} />
          </>
        );
      }}</Loaded>
      {editing && <FormModal title={editing === 'new' ? 'Add client expense' : 'Edit expense'} fields={fields} onClose={() => setEditing(null)}
        initial={editing === 'new' ? { date: businessToday(), currency: 'CAD', payStatus: 'Unpaid', bookStatus: 'Not submitted', matterId } : editing}
        onSubmit={async v => {
          const payload = { scope: 'client', matterId: v.matterId, date: v.date, provider: v.provider, description: v.description ?? '', category: v.category ?? '', reference: v.reference ?? '', currency: v.currency, amountCents: v.amountCents, hstCents: v.hstCents ?? 0, payStatus: v.payStatus, paidDate: v.paidDate ?? '', payMethod: v.payMethod ?? '', bookStatus: v.bookStatus, batchRef: v.batchRef ?? '', receipt: v.receipt ?? '', notes: v.notes ?? '' };
          if (editing === 'new') await api.post('/api/expenses', payload); else await api.patch(`/api/expenses/${editing.id}`, { ...payload, rev: editing.rev });
          toast('Expense saved.'); list.reload();
        }} />}
      {voiding && <FormModal title="Void expense" size="narrow" submitLabel="Void expense" onClose={() => setVoiding(null)} fields={[{ k: 'reason', l: 'Reason for voiding', t: 'textarea', req: true }]}
        intro={<p style={{ marginTop: 0 }}>{voiding.provider} · {money(voiding.amountCents + voiding.hstCents, voiding.currency)}. The row stays in the history and exports but stops counting toward totals.</p>}
        onSubmit={async v => { await api.post(`/api/expenses/${voiding.id}/void`, { reason: v.reason, rev: voiding.rev }); toast('Expense voided.'); list.reload(); }} />}
    </>
  );
}
