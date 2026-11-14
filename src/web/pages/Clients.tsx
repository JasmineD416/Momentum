import { useRef, useState } from 'react';
import { CASE_TYPES, MATTER_STATUSES } from '../../shared/constants';
import { api, ApiError } from '../api';
import { clientName, fmtDate, money } from '../format';
import { go, href } from '../router';
import { memberOptions, useSession } from '../session';
import { DataTable, DefList, Empty, Ext, FormModal, Loaded, PageHead, Status, useLoad, useToast, type Field, type Values } from '../ui';

type ClientRow = { id: string; lastName: string; firstName: string; dob: string; email: string; phone: string; address: string; instructions: string; rev: number; files: { id: string; fileNumber: string; status: string }[] };
type Matter = { id: string; clientId: string; fileNumber: string; caseType: string; lossDate: string; lawyerId: string | null; staffId: string | null; status: string; opened: string; closed: string; closingReason: string; boxLink: string; notes: string; rev: number; lawyerName?: string; staffName?: string; checklistTotal: number; checklistDone: number };

const CLIENT_FIELDS: Field[] = [
  { k: 'lastName', l: 'Last name', req: true }, { k: 'firstName', l: 'First name' },
  { k: 'dob', l: 'Date of birth', t: 'date' }, { k: 'email', l: 'Email', t: 'email' },
  { k: 'phone', l: 'Phone', t: 'tel' }, { k: 'address', l: 'Address', t: 'textarea' },
  { k: 'instructions', l: 'Contact instructions, guardians and family contacts', t: 'textarea' },
];

/** Save, and on a likely-duplicate warning ask once before saving anyway. */
function useDuplicateConfirm() {
  const confirmed = useRef(false);
  return async (send: (confirm: boolean) => Promise<unknown>) => {
    try { await send(confirmed.current); }
    catch (e) {
      if (e instanceof ApiError && e.status === 409 && /duplicate/i.test(e.message) && !confirmed.current) { confirmed.current = true; throw new Error(`${e.message} Select Save again to add anyway.`); }
      throw e;
    }
  };
}

export function ClientForm({ client, onClose, onSaved }: { client?: ClientRow; onClose: () => void; onSaved: (id: string) => void }) {
  const save = useDuplicateConfirm();
  const toast = useToast();
  return (
    <FormModal title={client ? 'Edit client' : 'Add client'} fields={CLIENT_FIELDS} initial={client ?? {}} onClose={onClose}
      onSubmit={v => save(async confirmDuplicate => {
        const payload = { lastName: v.lastName, firstName: v.firstName ?? '', dob: v.dob ?? '', email: v.email ?? '', phone: v.phone ?? '', address: v.address ?? '', instructions: v.instructions ?? '', confirmDuplicate };
        if (client) { await api.patch(`/api/clients/${client.id}`, { ...payload, rev: client.rev }); toast('Client saved.'); onSaved(client.id); }
        else { const r = await api.post<{ id: string }>('/api/clients', payload); toast('Client added.'); onSaved(r.id); }
      })} />
  );
}

export function Clients() {
  const list = useLoad(() => api.get<{ clients: ClientRow[] }>('/api/clients'), []);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHead title="Client directory" sub="Search by name, contact details, birth date or file number. A client can have open and closed files at the same time."
        actions={<button className="btn primary" onClick={() => setAdding(true)}>Add client</button>} />
      <Loaded state={list}>{d => (
        <DataTable rows={d.clients} rowKey={c => c.id} empty="No clients yet. Add one, or import them in Import records."
          search={{ placeholder: 'Search clients and file numbers', text: c => [c.lastName, c.firstName, c.email, c.phone, c.dob, c.address, ...c.files.map(f => f.fileNumber)].join(' ') }}
          columns={[
            { label: 'Client', render: c => <><a className="name" href={href(`client/${c.id}`)}>{clientName(c)}</a><div className="muted">{c.email}</div></> },
            { label: 'Phone', render: c => c.phone || '—' },
            { label: 'Date of birth', render: c => fmtDate(c.dob) },
            { label: 'Files', render: c => c.files.length ? <div className="stack">{c.files.map(f => <span key={f.id}>{f.fileNumber} <Status s={f.status} /></span>)}</div> : <span className="muted">No files</span> },
          ]} />
      )}</Loaded>
      {adding && <ClientForm onClose={() => setAdding(false)} onSaved={id => go(`client/${id}`)} />}
    </>
  );
}

export function MatterForm({ matter, clientId, onClose, onSaved }: { matter?: Matter; clientId: string; onClose: () => void; onSaved: () => void }) {
  const { members } = useSession();
  const counsel = useLoad(() => api.get<{ counsel: { id: string; name: string; firm: string }[] }>('/api/counsel'), []);
  const toast = useToast();
  if (!counsel.data) return null;
  const fields: Field[] = [
    { k: 'fileNumber', l: 'File number', req: true }, { k: 'caseType', l: 'Case type', t: 'select', req: true, o: [...new Set([...CASE_TYPES, ...(matter ? [matter.caseType] : [])])] },
    { k: 'lossDate', l: 'Date of loss', t: 'date' }, { k: 'lawyerId', l: 'Responsible lawyer', t: 'select', o: counsel.data.counsel.map(l => [l.id, l.firm ? `${l.name} (${l.firm})` : l.name] as [string, string]) },
    { k: 'staffId', l: 'Assigned staff', t: 'select', o: memberOptions(members, 'jdco') },
    { k: 'status', l: 'Status', t: 'select', blank: false, o: MATTER_STATUSES, help: 'Transferred keeps the file listed, for example when fees are owed on settlement.' },
    { k: 'opened', l: 'Opened', t: 'date' }, { k: 'closed', l: 'Closed date', t: 'date', help: 'Required to close. Clear it to reopen.' },
    { k: 'closingReason', l: 'Closing reason', full: true }, { k: 'boxLink', l: 'Box folder link', t: 'url', full: true },
    { k: 'notes', l: 'Notes', t: 'textarea' },
  ];
  return (
    <FormModal title={matter ? `Edit ${matter.fileNumber}` : 'Add matter'} fields={fields} onClose={onClose}
      initial={matter ?? { status: 'Open', lawyerId: counsel.data.counsel.find(l => l.name === 'Jasmine Daya')?.id ?? '' }}
      onSubmit={async (v: Values) => {
        const payload = { clientId, fileNumber: v.fileNumber, caseType: v.caseType, lossDate: v.lossDate ?? '', lawyerId: v.lawyerId || null, staffId: v.staffId || null, status: v.status, opened: v.opened ?? '', closed: v.closed ?? '', closingReason: v.closingReason ?? '', boxLink: v.boxLink ?? '', notes: v.notes ?? '' };
        if (matter) await api.patch(`/api/matters/${matter.id}`, { ...payload, rev: matter.rev }); else await api.post('/api/matters', payload);
        toast(matter ? 'Matter saved.' : 'Matter added.'); onSaved();
      }} />
  );
}

export function ClientDetail({ id }: { id: string }) {
  const d = useLoad(() => api.get<{ client: ClientRow; matters: Matter[]; expenseTotals: { currency: string; total: number }[] }>(`/api/clients/${id}`), [id]);
  const [editing, setEditing] = useState(false);
  const [matterForm, setMatterForm] = useState<Matter | 'new' | null>(null);
  return (
    <Loaded state={d}>{({ client, matters, expenseTotals }) => (
      <>
        <PageHead title={clientName(client)} crumb={<a href={href('clients')}>← Client directory</a>} actions={<button className="btn" onClick={() => setEditing(true)}>Edit client</button>} />
        <section className="card">
          <DefList items={[['Email', client.email], ['Phone', client.phone], ['Date of birth', client.dob ? fmtDate(client.dob) : ''], ['Address', client.address],
            ['Contact instructions', <span style={{ whiteSpace: 'pre-wrap' }}>{client.instructions}</span>],
            ['Client disbursements (incl. HST)', expenseTotals.length ? expenseTotals.map(t => money(t.total, t.currency)).join(' · ') : money(0)]]} />
        </section>
        <section className="card"><h3>Matters <button className="btn sm primary" onClick={() => setMatterForm('new')}>Add matter</button></h3>
          {matters.length ? (
            <DataTable rows={matters} rowKey={m => m.id} empty=""
              columns={[
                { label: 'File', render: m => <><strong>{m.fileNumber}</strong><div className="muted">{m.caseType}</div></> },
                { label: 'Lawyer', render: m => m.lawyerName ?? '—' }, { label: 'Staff', render: m => m.staffName ?? '—' },
                { label: 'Status', render: m => <><Status s={m.status} />{m.closed ? <div className="muted">Closed {fmtDate(m.closed)}</div> : m.opened ? <div className="muted">Opened {fmtDate(m.opened)}</div> : null}{m.notes && <div className="muted" style={{ maxWidth: 280 }}>{m.notes}</div>}</> },
                { label: 'Opening checklist', render: m => m.checklistTotal ? `${m.checklistDone} of ${m.checklistTotal} resolved` : <span className="muted">Not started</span> },
                { label: '', render: m => <div className="acts-cell">{m.boxLink && <Ext href={m.boxLink}>Box</Ext>}<a className="btn sm" href={href(`checklist/${m.id}`)}>Checklist</a><button className="btn sm" onClick={() => setMatterForm(m)}>Edit</button></div> },
              ]} />
          ) : <Empty>No matters yet.</Empty>}
        </section>
        {editing && <ClientForm client={client} onClose={() => setEditing(false)} onSaved={() => d.reload()} />}
        {matterForm && <MatterForm clientId={client.id} matter={matterForm === 'new' ? undefined : matterForm} onClose={() => setMatterForm(null)} onSaved={d.reload} />}
      </>
    )}</Loaded>
  );
}
