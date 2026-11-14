import { useRef, useState } from 'react';
import { divisionName } from '../../shared/constants';
import { api, ApiError } from '../api';
import { businessToday, fmtDate } from '../format';
import { memberOptions, useSession } from '../session';
import { DataTable, FormModal, Loaded, PageHead, Status, useLoad, useToast } from '../ui';

type Contact = { id: string; division: string; name: string; organization: string; role: string; email: string; phone: string; ownerId: string | null; ownerName: string | null; nextAction: string; followUp: string; status: string; notes: string; rev: number };

export function DivisionContacts({ division }: { division: string }) {
  const { me, members } = useSession();
  const toast = useToast();
  const list = useLoad(() => api.get<{ contacts: Contact[] }>(`/api/contacts?division=${encodeURIComponent(division)}`), [division]);
  const [editing, setEditing] = useState<Contact | 'new' | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const confirmed = useRef(false);
  const name = divisionName(division), today = businessToday();
  const sub = division === 'jdco' ? 'People the firm works with, such as doctors, adjusters and other lawyers. Clients have their own directory.' : `Contacts for ${name}. Only staff with access to this division can see them.`;
  return (
    <>
      <PageHead title={`${name} contacts`} sub={sub} actions={<button className="btn primary" onClick={() => { confirmed.current = false; setEditing('new'); }}>Add contact</button>} />
      <Loaded state={list}>{d => {
        const rows = d.contacts.filter(c => showArchived || c.status !== 'Archived');
        return (
          <>
            <label className="chk" style={{ marginBottom: 10 }}><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> Show archived</label>
            <DataTable rows={rows} rowKey={c => c.id} empty={`No ${name} contacts yet. Select Add contact to create the first one.`}
              search={{ placeholder: 'Search name, email, organization', text: c => [c.name, c.email, c.organization, c.role, c.phone, c.notes].join(' ') }}
              columns={[
                { label: 'Name', render: c => <><strong>{c.name}</strong><div className="muted">{c.email}</div></> },
                { label: 'Organization', render: c => <>{c.organization || '—'}{c.role && <div className="muted">{c.role}</div>}</> },
                { label: 'Phone', render: c => c.phone || '—' }, { label: 'Owner', render: c => c.ownerName ?? '—' },
                { label: 'Next action', render: c => c.nextAction ? <>{c.nextAction}<div className="muted" style={c.followUp && c.followUp < today ? { color: 'var(--bad)' } : undefined}>{fmtDate(c.followUp)}</div></> : '—' },
                { label: 'Status', render: c => <Status s={c.status} /> },
                { label: '', render: c => <div className="acts-cell"><button className="btn sm" onClick={() => { confirmed.current = false; setEditing(c); }}>Edit</button></div> },
              ]} />
          </>
        );
      }}</Loaded>
      {editing && <FormModal title={editing === 'new' ? `Add ${name} contact` : 'Edit contact'} onClose={() => setEditing(null)}
        initial={editing === 'new' ? { ownerId: me.id, status: 'Active' } : editing}
        fields={[
          { k: 'name', l: 'Name', req: true }, { k: 'organization', l: 'Organization' }, { k: 'role', l: 'Role or title' },
          { k: 'email', l: 'Email', t: 'email' }, { k: 'phone', l: 'Phone', t: 'tel' },
          { k: 'ownerId', l: 'Staff owner', t: 'select', o: memberOptions(members, division) },
          { k: 'nextAction', l: 'Next action' }, { k: 'followUp', l: 'Follow-up date', t: 'date' },
          { k: 'status', l: 'Status', t: 'select', blank: false, o: ['Active', 'Archived'] }, { k: 'notes', l: 'Notes', t: 'textarea' },
        ]}
        onSubmit={async v => {
          const payload = { division, name: v.name, organization: v.organization ?? '', role: v.role ?? '', email: v.email ?? '', phone: v.phone ?? '', ownerId: v.ownerId || null, nextAction: v.nextAction ?? '', followUp: v.followUp ?? '', status: v.status, notes: v.notes ?? '', confirmDuplicate: confirmed.current };
          try {
            if (editing === 'new') await api.post('/api/contacts', payload); else await api.patch(`/api/contacts/${editing.id}`, { ...payload, rev: editing.rev });
          } catch (e) {
            if (e instanceof ApiError && e.status === 409 && !confirmed.current && /already uses/.test(e.message)) { confirmed.current = true; throw new Error(`${e.message} Select Save again to confirm.`); }
            throw e;
          }
          toast('Contact saved.'); list.reload();
        }} />}
    </>
  );
}
