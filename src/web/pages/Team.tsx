import { useState } from 'react';
import { ADMIN_TASK_STATUSES, BRANDS, DONE_TASK_STATUSES, PRIORITIES, TASK_STATUSES, WORK_TYPES } from '../../shared/constants';
import { api } from '../api';
import { businessToday, fmtDate, fmtDateTime } from '../format';
import { href } from '../router';
import { hasDiv, isAdmin, memberOptions, useSession } from '../session';
import { DataTable, Ext, FormModal, Loaded, PageHead, Pill, Status, useLoad, useToast } from '../ui';

type Task = {
  id: string; title: string; brand: string; workType: string; assignees: { id: string; name: string }[]; assigneeIds: string[]; dueDate: string; priority: string; brief: string;
  creativeLink: string; publishedLink: string; status: string; campaignId: string | null; campaignName: string | null; approvedBy: string | null; approvedByName: string | null;
  approvedAt: string | null; completedAt: string | null; rev: number;
};
const payloadOf = (t: Task) => ({ title: t.title, brand: t.brand, workType: t.workType, assigneeIds: t.assigneeIds, dueDate: t.dueDate, priority: t.priority, brief: t.brief, creativeLink: t.creativeLink, publishedLink: t.publishedLink, status: t.status, campaignId: t.campaignId });

const VIEWS = ['Active', 'Needs review', 'Mine', 'Done', 'All'] as const;

export function TeamWorkspace() {
  const { me, members } = useSession();
  const toast = useToast();
  const list = useLoad(() => api.get<{ tasks: Task[] }>('/api/tasks'), []);
  const campaigns = useLoad(() => (hasDiv(me, 'marketing') ? api.get<{ campaigns: { id: string; name: string }[] }>('/api/marketing/campaigns') : Promise.resolve({ campaigns: [] })), []);
  const [view, setView] = useState<(typeof VIEWS)[number]>('Active');
  const [brand, setBrand] = useState('');
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  const admin = isAdmin(me), today = businessToday();
  const statusOpts = (cur?: string) => TASK_STATUSES.filter(s => admin || !ADMIN_TASK_STATUSES.includes(s) || s === cur);
  const quick = async (t: Task, status: string, msg: string) => {
    try { await api.patch(`/api/tasks/${t.id}`, { ...payloadOf(t), status, rev: t.rev }); toast(msg); list.reload(); } catch (e) { toast((e as Error).message); }
  };
  const locked = (t: Task) => !admin && ADMIN_TASK_STATUSES.includes(t.status);
  // Everyone active, plus anyone already on the item (so a person whose access was switched off can still be unticked).
  const assignable = (current: { id: string; name: string }[]): [string, string][] => {
    const opts = memberOptions(members);
    for (const a of current) if (!opts.some(([id]) => id === a.id)) opts.push([a.id, `${a.name} (access off)`]);
    return opts;
  };
  return (
    <>
      <PageHead title="Team workspace" sub="Team work and content across the brands. Administrators approve and publish. Keep client-specific notes in the JD&Co file, not here."
        actions={<button className="btn primary" onClick={() => setEditing('new')}>Add work</button>} />
      <div className="tabs">{VIEWS.map(v => <button key={v} className={v === view ? 'on' : ''} onClick={() => setView(v)}>{v}</button>)}</div>
      <div className="toolbar"><select aria-label="Brand" value={brand} onChange={e => setBrand(e.target.value)}><option value="">All brands</option>{BRANDS.map(b => <option key={b}>{b}</option>)}</select></div>
      <Loaded state={list}>{d => {
        const rows = d.tasks.filter(t => (!brand || t.brand === brand) && (
          view === 'All' ? true : view === 'Done' ? DONE_TASK_STATUSES.includes(t.status) : view === 'Needs review' ? t.status === 'Ready for review'
            : view === 'Mine' ? t.assigneeIds.includes(me.id) &&!DONE_TASK_STATUSES.includes(t.status) : !DONE_TASK_STATUSES.includes(t.status)));
        return (
          <DataTable rows={rows} rowKey={t => t.id} empty={view === 'Needs review' ? 'Nothing is waiting for review.' : 'No work here yet.'}
            search={{ placeholder: 'Search work', text: t => [t.title, t.brief, t.brand, t.workType, ...t.assignees.map(a => a.name)].join(' ') }}
            columns={[
              { label: 'Work', render: t => <><strong>{t.title}</strong><div className="muted">{[t.workType, t.brand].filter(Boolean).join(' · ')}{t.campaignId && <> · <a href={href(`campaign/${t.campaignId}`)}>{t.campaignName}</a></>}</div></> },
              { label: 'Assigned to', render: t => t.assignees.length
                ? <div className="tags">{t.assignees.map(a => <Pill key={a.id} cls={a.id === me.id ? 'info' : undefined}>{a.id === me.id ? `${a.name} (you)` : a.name}</Pill>)}</div>
                : <span className="muted">Not assigned</span> },
              { label: 'Due or publish', render: t => <span style={t.dueDate && t.dueDate < today && !DONE_TASK_STATUSES.includes(t.status) ? { color: 'var(--bad)' } : undefined}>{fmtDate(t.dueDate)}</span> },
              { label: 'Priority', render: t => <Status s={t.priority} /> },
              { label: 'Status', render: t => <><Status s={t.status} />{t.approvedByName && ADMIN_TASK_STATUSES.includes(t.status) && <div className="muted" title={fmtDateTime(t.approvedAt)}>by {t.approvedByName}</div>}</> },
              { label: 'Links', render: t => <div className="stack">{t.creativeLink && <Ext href={t.creativeLink}>Creative</Ext>}{t.publishedLink && <Ext href={t.publishedLink}>Published</Ext>}{!t.creativeLink && !t.publishedLink && <span className="muted">—</span>}</div> },
              { label: '', render: t => <div className="acts-cell">
                {['Planned', 'In progress'].includes(t.status) && <button className="btn sm" onClick={() => quick(t, 'Ready for review', 'Sent for review.')}>Send for review</button>}
                {admin && t.status === 'Ready for review' && <button className="btn sm primary" onClick={() => quick(t, 'Approved', 'Approved.')}>Approve</button>}
                {!locked(t) && <button className="btn sm" onClick={() => setEditing(t)}>Edit</button>}
              </div> },
            ]} />
        );
      }}</Loaded>
      {editing && <FormModal title={editing === 'new' ? 'Add team work' : 'Edit team work'} onClose={() => setEditing(null)}
        initial={editing === 'new' ? { status: 'Planned', priority: 'Normal', assigneeIds: [me.id] } : editing}
        note={admin ? undefined : 'Only an administrator can approve or publish work.'}
        fields={[
          { k: 'title', l: 'Title', req: true, full: true }, { k: 'brand', l: 'Brand', t: 'select', o: BRANDS }, { k: 'workType', l: 'Work type', t: 'select', o: WORK_TYPES },
          { k: 'dueDate', l: 'Due or publication date', t: 'date' },
          { k: 'priority', l: 'Priority', t: 'select', blank: false, o: PRIORITIES }, { k: 'status', l: 'Status', t: 'select', blank: false, o: statusOpts(editing === 'new' ? undefined : editing.status) },
          { k: 'assigneeIds', l: 'Assigned to', t: 'multi', o: assignable(editing === 'new' ? [] : editing.assignees),
            help: 'Tick everyone working on this. Each person sees it under Mine and gets the due-date alerts.' },
          ...(hasDiv(me, 'marketing') ? [{ k: 'campaignId', l: 'Campaign', t: 'select' as const, o: (campaigns.data?.campaigns ?? []).map(c => [c.id, c.name] as [string, string]) }] : []),
          { k: 'brief', l: 'Brief', t: 'textarea', rows: 4 }, { k: 'creativeLink', l: 'Creative link', t: 'url' }, { k: 'publishedLink', l: 'Published link', t: 'url', help: 'Required to mark work Published.' },
        ]}
        onSubmit={async v => {
          const payload = { title: v.title, brand: v.brand ?? '', workType: v.workType ?? '', assigneeIds: v.assigneeIds ?? [], dueDate: v.dueDate ?? '', priority: v.priority, brief: v.brief ?? '', creativeLink: v.creativeLink ?? '', publishedLink: v.publishedLink ?? '', status: v.status, campaignId: v.campaignId || null };
          if (editing === 'new') await api.post('/api/tasks', payload); else await api.patch(`/api/tasks/${editing.id}`, { ...payload, rev: editing.rev });
          toast('Work saved.'); list.reload();
        }} />}
    </>
  );
}
