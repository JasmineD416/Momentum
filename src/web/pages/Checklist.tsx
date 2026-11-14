import { useState } from 'react';
import { CHECKLIST_ITEMS, CHECKLIST_STATUSES } from '../../shared/constants';
import { api } from '../api';
import { clientName, fmtDateTime } from '../format';
import { href } from '../router';
import { memberOptions, useSession } from '../session';
import { DataTable, Empty, Ext, FormModal, Loaded, PageHead, Status, useLoad, useToast } from '../ui';

type Item = { id: string; item: string; status: string; assigneeId: string | null; assigneeName: string | null; notes: string; evidence: string; completedByName: string | null; completedAt: string | null; updatedByName: string | null; updatedAt: string; rev: number };

export function Checklist({ matterId }: { matterId: string }) {
  const { members } = useSession();
  const toast = useToast();
  const d = useLoad(() => api.get<{ matter: { fileNumber: string; caseType: string; clientId: string; lastName: string; firstName: string }; items: Item[] }>(`/api/matters/${matterId}/checklist`), [matterId]);
  const [editing, setEditing] = useState<Item | null>(null);
  const start = async () => { const r = await api.post<{ added: number }>(`/api/matters/${matterId}/checklist/start`); toast(`${r.added} items added. Existing progress kept.`); d.reload(); };
  return (
    <Loaded state={d}>{({ matter, items }) => (
      <>
        <PageHead title="Opening checklist" sub={`${matter.fileNumber} · ${clientName(matter)} · ${matter.caseType}`} crumb={<a href={href(`client/${matter.clientId}`)}>← {clientName(matter)}</a>}
          actions={items.length < CHECKLIST_ITEMS.length ? <button className="btn primary" onClick={start}>{items.length ? 'Add missing items' : 'Start checklist'}</button> : undefined} />
        <div className="infobox">These prompts record staff review. They don’t decide whether legal obligations are met, calculate dates, or send records requests.</div>
        {items.length ? (
          <DataTable rows={items} rowKey={x => x.id} empty=""
            columns={[
              { label: 'Item', render: x => <><strong>{x.item}</strong><div className="muted">{CHECKLIST_ITEMS.find(c => c[0] === x.item)?.[1]}</div></> },
              { label: 'Status', render: x => <Status s={x.status} /> }, { label: 'Assignee', render: x => x.assigneeName ?? '—' },
              { label: 'Notes and evidence', render: x => <>{x.notes && <div style={{ whiteSpace: 'pre-wrap' }}>{x.notes}</div>}{x.evidence && <Ext href={x.evidence}>Evidence</Ext>}{!x.notes && !x.evidence && <span className="muted">—</span>}</> },
              { label: 'Completed', render: x => x.completedByName ? <>{x.completedByName}<div className="muted">{fmtDateTime(x.completedAt)}</div></> : '—' },
              { label: 'Last update', render: x => x.updatedByName ? <>{x.updatedByName}<div className="muted">{fmtDateTime(x.updatedAt)}</div></> : '—' },
              { label: '', render: x => <div className="acts-cell"><button className="btn sm" onClick={() => setEditing(x)}>Update</button></div> },
            ]} />
        ) : <Empty>This checklist hasn’t been started. Select Start checklist to create the eight default items.</Empty>}
        {editing && <FormModal title={editing.item} size="narrow" onClose={() => setEditing(null)} initial={editing}
          fields={[
            { k: 'status', l: 'Status', t: 'select', blank: false, o: CHECKLIST_STATUSES },
            { k: 'assigneeId', l: 'Assignee', t: 'select', o: memberOptions(members, 'jdco') },
            { k: 'notes', l: 'Review notes', t: 'textarea', help: 'Required for Complete or Not applicable.' },
            { k: 'evidence', l: 'Evidence or Box link', t: 'url', full: true },
          ]}
          onSubmit={async v => { await api.patch(`/api/checklist/${editing.id}`, { status: v.status, assigneeId: v.assigneeId || null, notes: v.notes ?? '', evidence: v.evidence ?? '', rev: editing.rev }); toast('Checklist updated.'); d.reload(); }} />}
      </>
    )}</Loaded>
  );
}
