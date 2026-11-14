import { useState } from 'react';
import { api } from '../api';
import { DataTable, FormModal, Loaded, PageHead, useLoad, useToast } from '../ui';

type Lawyer = { id: string; name: string; firm: string; email: string; phone: string; practice: string; jurisdictions: string; notes: string; openFiles: number; rev: number };

export function Counsel() {
  const list = useLoad(() => api.get<{ counsel: Lawyer[] }>('/api/counsel'), []);
  const [editing, setEditing] = useState<Lawyer | 'new' | null>(null);
  const toast = useToast();
  return (
    <>
      <PageHead title="Lawyer directory" sub="Responsible and receiving lawyers." actions={<button className="btn primary" onClick={() => setEditing('new')}>Add lawyer</button>} />
      <Loaded state={list}>{d => (
        <DataTable rows={d.counsel} rowKey={l => l.id} empty="No lawyers yet." search={{ placeholder: 'Search lawyers', text: l => [l.name, l.firm, l.practice, l.jurisdictions].join(' ') }}
          columns={[
            { label: 'Lawyer', render: l => <><strong>{l.name}</strong><div className="muted">{l.firm}</div></> },
            { label: 'Contact', render: l => <div className="stack"><span>{l.email}</span><span>{l.phone}</span></div> },
            { label: 'Practice areas', render: l => l.practice || '—' }, { label: 'Jurisdictions', render: l => l.jurisdictions || '—' },
            { label: 'Open files', num: true, render: l => l.openFiles },
            { label: '', render: l => <div className="acts-cell"><button className="btn sm" onClick={() => setEditing(l)}>Edit</button></div> },
          ]} />
      )}</Loaded>
      {editing && <FormModal title={editing === 'new' ? 'Add lawyer' : 'Edit lawyer'} initial={editing === 'new' ? {} : editing} onClose={() => setEditing(null)}
        fields={[{ k: 'name', l: 'Name', req: true }, { k: 'firm', l: 'Firm' }, { k: 'email', l: 'Email', t: 'email' }, { k: 'phone', l: 'Phone', t: 'tel' },
          { k: 'practice', l: 'Practice areas', full: true }, { k: 'jurisdictions', l: 'Jurisdictions', full: true }, { k: 'notes', l: 'Notes, including referral terms', t: 'textarea' }]}
        onSubmit={async v => {
          const payload = { name: v.name, firm: v.firm ?? '', email: v.email ?? '', phone: v.phone ?? '', practice: v.practice ?? '', jurisdictions: v.jurisdictions ?? '', notes: v.notes ?? '' };
          if (editing === 'new') await api.post('/api/counsel', payload); else await api.patch(`/api/counsel/${editing.id}`, { ...payload, rev: editing.rev });
          toast('Lawyer saved.'); list.reload();
        }} />}
    </>
  );
}
