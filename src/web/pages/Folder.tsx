import { useState } from 'react';
import { FOLDER_KINDS, FOLDERS, ITEM_STATUSES } from '../../shared/constants';
import { api } from '../api';
import { fmtDateTime } from '../format';
import { memberOptions, useSession } from '../session';
import { DataTable, Ext, FormModal, Loaded, PageHead, Pill, Status, useLoad, useToast } from '../ui';

type Item = { id: string; title: string; kind: string; status: string; link: string; ownerId: string | null; ownerName: string | null; notes: string; updatedAt: string; rev: number };

export function Folder({ folderId }: { folderId: string }) {
  const f = FOLDERS.find(x => x.id === folderId);
  const { me, members } = useSession();
  const toast = useToast();
  const list = useLoad(() => api.get<{ items: Item[] }>(`/api/folders/${folderId}`), [folderId]);
  const [editing, setEditing] = useState<Item | 'new' | null>(null);
  if (!f) return <PageHead title="Folder not found" />;
  return (
    <>
      <PageHead title={f.name} sub={`${f.area} · ${f.about}`} actions={<button className="btn primary" onClick={() => setEditing('new')}>Add item</button>} />
      <div className="infobox">Files stay in Box. Add each item with its Box link so the team can open it from here.</div>
      <Loaded state={list}>{d => (
        <DataTable rows={d.items} rowKey={i => i.id} empty={`Nothing in ${f.name} yet. Select Add item to add the first one.`} search={{ placeholder: `Search ${f.name}`, text: i => [i.title, i.kind, i.notes].join(' ') }}
          columns={[
            { label: 'Item', render: i => <><strong>{i.title}</strong>{i.notes && <div className="muted">{i.notes}</div>}</> },
            { label: 'Type', render: i => <Pill>{i.kind}</Pill> }, { label: 'Status', render: i => <Status s={i.status} /> },
            { label: 'Owner', render: i => i.ownerName ?? '—' }, { label: 'Updated', render: i => fmtDateTime(i.updatedAt) },
            { label: 'Link', render: i => i.link ? <Ext href={i.link}>Open in Box</Ext> : <span className="muted">No link yet</span> },
            { label: '', render: i => <div className="acts-cell"><button className="btn sm" onClick={() => setEditing(i)}>Edit</button></div> },
          ]} />
      )}</Loaded>
      {editing && <FormModal title={editing === 'new' ? `Add to ${f.name}` : 'Edit item'} size="narrow" onClose={() => setEditing(null)}
        initial={editing === 'new' ? { kind: 'Document', status: 'Draft', ownerId: me.id } : editing}
        fields={[
          { k: 'title', l: 'Title', req: true, full: true }, { k: 'kind', l: 'Type', t: 'select', blank: false, o: FOLDER_KINDS },
          { k: 'status', l: 'Status', t: 'select', blank: false, o: ITEM_STATUSES }, { k: 'link', l: 'Box link', t: 'url', full: true, help: 'Paste the HTTPS link from Box.' },
          { k: 'ownerId', l: 'Owner', t: 'select', o: memberOptions(members, f.division) }, { k: 'notes', l: 'Notes', t: 'textarea' },
        ]}
        onSubmit={async v => {
          const payload = { folder: f.id, title: v.title, kind: v.kind, status: v.status, link: v.link ?? '', ownerId: v.ownerId || null, notes: v.notes ?? '' };
          if (editing === 'new') await api.post(`/api/folders/${f.id}/items`, payload); else await api.patch(`/api/folders/${f.id}/items/${editing.id}`, { ...payload, rev: editing.rev });
          toast('Item saved.'); list.reload();
        }} />}
    </>
  );
}
