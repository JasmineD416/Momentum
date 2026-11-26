import { useState } from 'react';
import { api } from '../api';
import { fmtDateTime } from '../format';
import { isAdmin, useSession } from '../session';
import { Empty, FormModal, Loaded, Modal, PageHead, Pill, useLoad, useToast } from '../ui';

type Announcement = {
  id: string; title: string; body: string; pinned: number; status: string; postedBy: string | null; postedByName: string | null; postedAt: string; updatedAt: string;
  readAt: string | null; readCount?: number; rev: number;
};
type Reader = { id: string; name: string; readAt: string | null };

/** Tells the menu badge to refresh straight away. */
export const announcementsChanged = () => window.dispatchEvent(new Event('momentum:announcements'));

export function Announcements() {
  const { me } = useSession();
  const toast = useToast();
  const admin = isAdmin(me);
  const [archived, setArchived] = useState(false);
  const list = useLoad(() => api.get<{ announcements: Announcement[]; activeMembers?: number }>(`/api/announcements${archived ? '?archived=1' : ''}`), [archived]);
  const [editing, setEditing] = useState<Announcement | 'new' | null>(null);
  const [readers, setReaders] = useState<Announcement | null>(null);
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); toast(msg); list.reload(); announcementsChanged(); } catch (e) { toast((e as Error).message); }
  };
  const save = (a: Announcement, status: string) => api.patch(`/api/announcements/${a.id}`, { title: a.title, body: a.body, pinned: !!a.pinned, status, rev: a.rev });
  return (
    <>
      <PageHead title="Announcements" sub="News for the whole team. New announcements show a count in the menu and an alert in your attention centre until you mark them read."
        actions={<>
          {admin && <button className="btn" onClick={() => setArchived(a => !a)}>{archived ? 'Show current' : 'Show archived'}</button>}
          {!archived && <button className="btn" onClick={() => act(() => api.post('/api/announcements/read-all'), 'All marked as read.')}>Mark all read</button>}
          {admin && <button className="btn primary" onClick={() => setEditing('new')}>Post announcement</button>}
        </>} />
      <Loaded state={list}>{d => !d.announcements.length ? <Empty>{archived ? 'No archived announcements.' : 'No announcements yet.'}</Empty> : (
        <div className="stack" style={{ gap: 12 }}>
          {d.announcements.map(a => (
            <section key={a.id} className={`card announcement${a.readAt || archived ? '' : ' unread'}`}>
              <div className="ann-head">
                <h3 style={{ margin: 0 }}>{a.title}</h3>
                <div className="tags">
                  {!!a.pinned && <Pill cls="info">Pinned</Pill>}
                  {!a.readAt && !archived && <Pill cls="pink">New</Pill>}
                </div>
              </div>
              <div className="muted" style={{ margin: '4px 0 10px' }}>{a.postedByName ?? '—'} · {fmtDateTime(a.postedAt)}{a.updatedAt !== a.postedAt && ' · edited'}</div>
              {a.body && <div className="ann-body">{a.body}</div>}
              <div className="row" style={{ marginTop: 12 }}>
                {!a.readAt && !archived && <button className="btn sm primary" onClick={() => act(() => api.post(`/api/announcements/${a.id}/read`), 'Marked as read.')}>Mark as read</button>}
                {admin && a.readCount !== undefined && <button className="btn sm" onClick={() => setReaders(a)}>Read by {a.readCount} of {d.activeMembers}</button>}
                {admin && !archived && <button className="btn sm" onClick={() => setEditing(a)}>Edit</button>}
                {admin && <button className="btn sm" onClick={() => act(() => save(a, archived ? 'Published' : 'Archived'), archived ? 'Announcement restored.' : 'Announcement archived.')}>{archived ? 'Restore' : 'Archive'}</button>}
              </div>
            </section>
          ))}
        </div>
      )}</Loaded>
      {editing && <FormModal title={editing === 'new' ? 'Post announcement' : 'Edit announcement'} onClose={() => setEditing(null)} submitLabel={editing === 'new' ? 'Post' : 'Save'}
        initial={editing === 'new' ? { pinned: false } : { ...editing, pinned: !!editing.pinned }}
        note={editing === 'new' ? 'Everyone with Momentum access will see it, with an alert until they mark it read.' : 'Editing doesn’t alert people again.'}
        fields={[
          { k: 'title', l: 'Title', req: true, full: true },
          { k: 'body', l: 'Message', t: 'textarea', rows: 8 },
          { k: 'pinned', l: 'Pin', t: 'check', cl: 'Keep at the top' },
        ]}
        onSubmit={async v => {
          const payload = { title: v.title, body: v.body ?? '', pinned: !!v.pinned };
          if (editing === 'new') await api.post('/api/announcements', payload);
          else await api.patch(`/api/announcements/${editing.id}`, { ...payload, status: 'Published', rev: editing.rev });
          toast(editing === 'new' ? 'Announcement posted.' : 'Announcement saved.'); list.reload(); announcementsChanged();
        }} />}
      {readers && <ReadersModal a={readers} onClose={() => setReaders(null)} />}
    </>
  );
}

function ReadersModal({ a, onClose }: { a: Announcement; onClose: () => void }) {
  const people = useLoad(() => api.get<{ people: Reader[] }>(`/api/announcements/${a.id}/reads`), [a.id]);
  return (
    <Modal title={`Who has read “${a.title}”`} size="narrow" onClose={onClose}>
      <Loaded state={people}>{d => (
        <ul className="tl">{d.people.map(p => <li key={p.id}><div><strong>{p.name}</strong></div><div className="m">{p.readAt ? `Read ${fmtDateTime(p.readAt)}` : 'Not read yet'}</div></li>)}</ul>
      )}</Loaded>
    </Modal>
  );
}
