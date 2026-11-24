import { useEffect, useState } from 'react';
import { DIVISIONS, divisionName } from '../../shared/constants';
import { api } from '../api';
import { fmtDateTime } from '../format';
import { isAdmin, isOwner, isRestricted, useSession, type MemberLite } from '../session';
import { DataTable, FormModal, Loaded, PageHead, Pill, Status, useLoad, useToast } from '../ui';

type AuditRow = { id: string; at: string; actor: string | null; action: string; entity: string; scope: string };

export function People() {
  const { me, members, reloadMembers } = useSession();
  const toast = useToast();
  const audit = useLoad(() => api.get<{ audit: AuditRow[] }>('/api/audit?limit=30'), []);
  const [editing, setEditing] = useState<MemberLite | 'new' | null>(null);
  useEffect(() => { reloadMembers(); }, [reloadMembers]);
  const owner = isOwner(me);
  const canManage = (m: MemberLite) => m.role !== 'Owner' && (owner || (isAdmin(me) && m.role === 'Member'));
  return (
    <>
      <PageHead title="People and access" sub="Who can use Momentum and which divisions each person sees." actions={<button className="btn primary" onClick={() => setEditing('new')}>Add staff member</button>} />
      <div className="infobox">Add each person with the Google account they sign in with. They sign in with Google; only people on this list (and switched on) can get in. Only Jasmine can give anyone access to a division (including Office) or manage administrators. Administrators can add people, but Jasmine decides what they see.</div>
      <DataTable rows={members} rowKey={m => m.id} empty="No members."
        columns={[
          { label: 'Name', render: m => <><strong>{m.name}</strong>{m.id === me.id && <span className="muted"> (you)</span>}<div className="muted">{m.email}</div></> },
          { label: 'Title', render: m => m.title || <span className="muted">Not added yet</span> },
          { label: 'Role', render: m => <Status s={m.role} /> },
          { label: 'Divisions', render: m => m.role === 'Owner' ? <Pill cls="info">All divisions</Pill> : m.divisions.length ? <div className="tags">{DIVISIONS.filter(d => m.divisions.includes(d.id)).map(d => <Pill key={d.id}>{d.name}</Pill>)}</div> : <span className="muted">None yet</span> },
          { label: 'Signed in', render: m => m.firstSignIn ? <Pill cls="ok">Yes</Pill> : <Pill cls="warn">Not yet</Pill> },
          { label: 'Status', render: m => m.active ? <Status s="Active" /> : <Pill cls="bad">Access off</Pill> },
          { label: '', render: m => canManage(m) ? <div className="acts-cell"><button className="btn sm" onClick={() => setEditing(m)}>Edit</button></div> : null },
        ]} />
      <section className="card" style={{ marginTop: 16 }}><h3>Audit log</h3>
        <Loaded state={audit}>{a => <ul className="tl">{a.audit.map(x => <li key={x.id}><div>{x.action}: <strong>{x.entity}</strong></div><div className="m">{x.actor ?? '—'} · {fmtDateTime(x.at)}{x.scope === 'firm' ? ' · firm' : ''}</div></li>)}</ul>}</Loaded>
      </section>
      {editing && <FormModal title={editing === 'new' ? 'Add staff member' : `Edit ${editing.name}`} size="narrow" onClose={() => setEditing(null)}
        initial={editing === 'new' ? { role: 'Member', active: true, divisions: [] } : editing}
        fields={[
          { k: 'name', l: 'Name', req: true }, { k: 'title', l: 'Title' },
          { k: 'email', l: 'Google sign-in email', t: 'email', req: true, full: true, help: 'Must match the Google account exactly.' },
          { k: 'role', l: 'Role', t: 'select', blank: false, o: owner ? ['Member', 'Administrator'] : ['Member'] },
          { k: 'divisions', l: 'Division access', t: 'multi', o: DIVISIONS.filter(d => owner || !isRestricted(d.id)).map(d => [d.id, divisionName(d.id)] as [string, string]),
            help: owner ? 'Tick only what this person needs. Only you can grant division access.' : 'Only Jasmine can grant division access. She’ll add it after you save; their current access stays as it is.' },
          { k: 'active', l: 'Access', t: 'check', cl: 'Can use Momentum' },
        ]}
        onSubmit={async v => {
          const payload = { name: v.name, title: v.title ?? '', email: v.email, role: v.role, divisions: v.divisions ?? [], active: !!v.active };
          if (editing === 'new') await api.post('/api/members', payload); else await api.patch(`/api/members/${editing.id}`, { ...payload, rev: editing.rev });
          toast('Saved.'); reloadMembers();
        }} />}
    </>
  );
}
