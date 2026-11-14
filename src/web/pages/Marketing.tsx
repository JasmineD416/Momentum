import { useRef, useState } from 'react';
import { ACTIVITY_DIRECTIONS, ACTIVITY_METHODS, ACTIVITY_OUTCOMES, BRANDS, CONTACT_SOURCES, EMAIL_PERMISSIONS } from '../../shared/constants';
import { api, ApiError } from '../api';
import { businessToday, fmtDate, fmtDateTime, money } from '../format';
import { href } from '../router';
import { memberOptions, useSession } from '../session';
import { DataTable, DefList, Empty, Ext, FormModal, Loaded, PageHead, Pill, Status, useLoad, useToast, type Field } from '../ui';

export type MkContact = {
  id: string; name: string; email: string; phone: string; companyId: string | null; companyName: string | null; role: string; source: string; brands: string[];
  ownerId: string | null; ownerName: string | null; emailPermission: string; permissionDate: string; permissionEvidence: string; nextAction: string; followUp: string;
  campaignId: string | null; campaignName: string | null; status: string; notes: string; lastActivity: string | null; rev: number;
};
type Company = { id: string; name: string; website: string; industry: string; brands: string[]; ownerId: string | null; ownerName: string | null; status: string; notes: string; contactCount: number; openOpportunities: number; rev: number };
type Activity = { id: string; kind: string; at: string; method: string; direction: string; outcome: string; notes: string; fromStage: string; toStage: string; actorName: string; opportunityTitle?: string | null };

/** Choices shared by the marketing screens. */
export function useMarketingChoices() {
  const companies = useLoad(() => api.get<{ companies: Company[] }>('/api/marketing/companies'), []);
  const campaigns = useLoad(() => api.get<{ campaigns: { id: string; name: string; status: string }[] }>('/api/marketing/campaigns'), []);
  return {
    companyOpts: (companies.data?.companies ?? []).filter(c => c.status === 'Active').map(c => [c.id, c.name] as [string, string]),
    campaignOpts: (campaigns.data?.campaigns ?? []).map(c => [c.id, `${c.name}${['Completed', 'Cancelled'].includes(c.status) ? ` (${c.status.toLowerCase()})` : ''}`] as [string, string]),
  };
}

export const Brands = ({ brands }: { brands: string[] }) => (brands.length ? <div className="tags">{brands.map(b => <Pill key={b}>{b}</Pill>)}</div> : <span className="muted">—</span>);
const overdue = (d: string, today: string) => (d && d < today ? { color: 'var(--bad)' } : undefined);

/* ---------------- Contact form (with duplicate-email confirmation) ---------------- */
function ContactForm({ contact, onClose, onSaved }: { contact?: MkContact; onClose: () => void; onSaved: () => void }) {
  const { me, members } = useSession();
  const toast = useToast();
  const { companyOpts, campaignOpts } = useMarketingChoices();
  const confirmed = useRef(false);
  const fields: Field[] = [
    { k: 'name', l: 'Name', req: true }, { k: 'email', l: 'Email', t: 'email' }, { k: 'phone', l: 'Phone', t: 'tel' },
    { k: 'companyId', l: 'Company', t: 'select', o: companyOpts }, { k: 'role', l: 'Role or title' }, { k: 'source', l: 'Source', t: 'select', o: CONTACT_SOURCES },
    { k: 'brands', l: 'Brands', t: 'multi', o: BRANDS },
    { k: 'ownerId', l: 'Staff owner', t: 'select', o: memberOptions(members, 'marketing') }, { k: 'campaignId', l: 'Primary campaign', t: 'select', o: campaignOpts },
    { k: 'h1', l: 'Email preference', t: 'h' },
    { k: 'emailPermission', l: 'Email permission', t: 'select', blank: false, o: EMAIL_PERMISSIONS, help: 'Momentum records the preference only. It never sends email.' },
    { k: 'permissionDate', l: 'Date given', t: 'date', help: 'Needed for any preference other than Unknown.' },
    { k: 'permissionEvidence', l: 'Evidence', full: true, help: 'For example: “Signed up on the website form” or a link to the email.' },
    { k: 'h2', l: 'Follow-up', t: 'h' },
    { k: 'nextAction', l: 'Next action' }, { k: 'followUp', l: 'Follow-up date', t: 'date' },
    { k: 'status', l: 'Status', t: 'select', blank: false, o: ['Active', 'Archived'] }, { k: 'notes', l: 'Notes', t: 'textarea' },
  ];
  return (
    <FormModal title={contact ? 'Edit marketing contact' : 'Add marketing contact'} fields={fields} onClose={onClose}
      initial={contact ?? { ownerId: me.id, status: 'Active', emailPermission: 'Unknown', brands: [] }}
      note="Marketing contacts are separate from JD&Co client records. Don’t add client details here."
      onSubmit={async v => {
        const payload = {
          name: v.name, email: v.email ?? '', phone: v.phone ?? '', companyId: v.companyId || null, role: v.role ?? '', source: v.source ?? '', brands: v.brands ?? [],
          ownerId: v.ownerId || null, emailPermission: v.emailPermission, permissionDate: v.permissionDate ?? '', permissionEvidence: v.permissionEvidence ?? '',
          nextAction: v.nextAction ?? '', followUp: v.followUp ?? '', campaignId: v.campaignId || null, status: v.status, notes: v.notes ?? '', confirmDuplicate: confirmed.current,
        };
        try {
          if (contact) await api.patch(`/api/marketing/contacts/${contact.id}`, { ...payload, rev: contact.rev }); else await api.post('/api/marketing/contacts', payload);
        } catch (e) {
          if (e instanceof ApiError && e.status === 409 && !confirmed.current && /already uses/.test(e.message)) { confirmed.current = true; throw new Error(`${e.message} Select Save again to confirm.`); }
          throw e;
        }
        toast('Contact saved.'); onSaved();
      }} />
  );
}

/* ---------------- Activity ---------------- */
export function ActivityForm({ contactId, opportunityId, onClose, onSaved }: { contactId?: string | null; opportunityId?: string | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  return (
    <FormModal title="Record activity" size="narrow" onClose={onClose} initial={{ direction: 'Outbound' }}
      note="Activity is permanent once saved. Record it after it happens."
      fields={[
        { k: 'at', l: 'Date and time', t: 'datetime', req: true }, { k: 'method', l: 'Method', t: 'select', req: true, o: ACTIVITY_METHODS },
        { k: 'direction', l: 'Direction', t: 'select', blank: false, o: ACTIVITY_DIRECTIONS }, { k: 'outcome', l: 'Outcome', t: 'select', req: true, o: ACTIVITY_OUTCOMES },
        { k: 'notes', l: 'Notes', t: 'textarea' },
      ]}
      onSubmit={async v => {
        await api.post('/api/marketing/activities', { contactId: contactId ?? null, opportunityId: opportunityId ?? null, at: new Date(v.at).toISOString(), method: v.method, direction: v.direction, outcome: v.outcome, notes: v.notes ?? '' });
        toast('Activity recorded.'); onSaved();
      }} />
  );
}

export function Timeline({ items }: { items: Activity[] }) {
  if (!items.length) return <Empty>No activity yet.</Empty>;
  return (
    <ul className="tl">{items.map(a => (
      <li key={a.id}>
        {a.kind === 'Stage change'
          ? <div>Stage: {a.fromStage ? <>{a.fromStage} → </> : 'Started at '}<strong>{a.toStage}</strong></div>
          : <div><strong>{a.method}</strong> · {a.direction} · {a.outcome}{a.opportunityTitle && <span className="muted"> · {a.opportunityTitle}</span>}{a.notes && <div>{a.notes}</div>}</div>}
        <div className="m">{a.actorName} · {fmtDateTime(a.at)}</div>
      </li>
    ))}</ul>
  );
}

/* ---------------- Contacts ---------------- */
export function MarketingContacts() {
  const list = useLoad(() => api.get<{ contacts: MkContact[] }>('/api/marketing/contacts'), []);
  const [editing, setEditing] = useState<MkContact | 'new' | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [brand, setBrand] = useState('');
  const today = businessToday();
  return (
    <>
      <PageHead title="Marketing contacts" sub="Relationships across the brands. Email preferences are recorded here; Momentum doesn’t send campaigns."
        actions={<button className="btn primary" onClick={() => setEditing('new')}>Add contact</button>} />
      <div className="toolbar">
        <select aria-label="Brand" value={brand} onChange={e => setBrand(e.target.value)}><option value="">All brands</option>{BRANDS.map(b => <option key={b}>{b}</option>)}</select>
        <label className="chk"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> Show archived</label>
      </div>
      <Loaded state={list}>{d => (
        <DataTable rows={d.contacts.filter(c => (showArchived || c.status !== 'Archived') && (!brand || c.brands.includes(brand)))} rowKey={c => c.id}
          empty="No marketing contacts yet. Select Add contact to create the first one."
          search={{ placeholder: 'Search name, email, company', text: c => [c.name, c.email, c.companyName, c.role, c.phone, c.notes, c.source].join(' ') }}
          columns={[
            { label: 'Name', render: c => <><a href={href(`mk-contact/${c.id}`)}><strong>{c.name}</strong></a><div className="muted">{c.email}</div></> },
            { label: 'Company', render: c => <>{c.companyName ?? '—'}{c.role && <div className="muted">{c.role}</div>}</> },
            { label: 'Brands', render: c => <Brands brands={c.brands} /> },
            { label: 'Email permission', render: c => <><Status s={c.emailPermission} />{c.permissionDate && <div className="muted">{fmtDate(c.permissionDate)}</div>}</> },
            { label: 'Owner', render: c => c.ownerName ?? '—' },
            { label: 'Next action', render: c => c.nextAction || c.followUp ? <>{c.nextAction || '—'}<div className="muted" style={overdue(c.followUp, today)}>{fmtDate(c.followUp)}</div></> : '—' },
            { label: 'Status', render: c => <Status s={c.status} /> },
            { label: '', render: c => <div className="acts-cell"><button className="btn sm" onClick={() => setEditing(c)}>Edit</button></div> },
          ]} />
      )}</Loaded>
      {editing && <ContactForm contact={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={list.reload} />}
    </>
  );
}

export function MarketingContactDetail({ id }: { id: string }) {
  const d = useLoad(() => api.get<{ contact: MkContact; activities: Activity[]; opportunities: { id: string; title: string; pipeline: string; stage: string; currency: string; valueCents: number; probability: number }[] }>(`/api/marketing/contacts/${id}`), [id]);
  const [modal, setModal] = useState<'' | 'edit' | 'activity'>('');
  return (
    <Loaded state={d}>{({ contact: c, activities, opportunities }) => (
      <>
        <PageHead title={c.name} crumb={<a href={href('mk-contacts')}>Marketing contacts</a>} sub={[c.role, c.companyName].filter(Boolean).join(' · ') || undefined}
          actions={<><button className="btn" onClick={() => setModal('activity')}>Record activity</button><button className="btn primary" onClick={() => setModal('edit')}>Edit</button></>} />
        <div className="cols2">
          <section className="card"><h3>Profile</h3>
            <DefList items={[
              ['Email', c.email], ['Phone', c.phone], ['Company', c.companyName], ['Source', c.source], ['Brands', <Brands brands={c.brands} />], ['Staff owner', c.ownerName],
              ['Email permission', <><Status s={c.emailPermission} /> {c.permissionDate && fmtDate(c.permissionDate)}</>], ['Permission evidence', c.permissionEvidence],
              ['Primary campaign', c.campaignId ? <a href={href(`campaign/${c.campaignId}`)}>{c.campaignName}</a> : ''],
              ['Next action', c.nextAction], ['Follow-up', c.followUp ? fmtDate(c.followUp) : ''], ['Status', <Status s={c.status} />], ['Notes', c.notes],
            ]} />
          </section>
          <section className="card"><h3>Opportunities</h3>
            {opportunities.length ? <ul className="tl">{opportunities.map(o => <li key={o.id}><div><a href={href('opportunities')}>{o.title}</a> · <Status s={o.stage} /></div><div className="m">{o.pipeline} · {money(o.valueCents, o.currency)} · {o.probability}%</div></li>)}</ul> : <Empty>No opportunities linked.</Empty>}
          </section>
        </div>
        <section className="card"><h3>Activity and stage history</h3><Timeline items={activities} /></section>
        {modal === 'edit' && <ContactForm contact={c} onClose={() => setModal('')} onSaved={d.reload} />}
        {modal === 'activity' && <ActivityForm contactId={c.id} onClose={() => setModal('')} onSaved={d.reload} />}
      </>
    )}</Loaded>
  );
}

/* ---------------- Companies ---------------- */
export function Companies() {
  const { me, members } = useSession();
  const toast = useToast();
  const list = useLoad(() => api.get<{ companies: Company[] }>('/api/marketing/companies'), []);
  const [editing, setEditing] = useState<Company | 'new' | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  return (
    <>
      <PageHead title="Company directory" sub="Organizations the brands work with: sponsors, partners, media and customers."
        actions={<button className="btn primary" onClick={() => setEditing('new')}>Add company</button>} />
      <label className="chk" style={{ marginBottom: 10 }}><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> Show archived</label>
      <Loaded state={list}>{d => (
        <DataTable rows={d.companies.filter(c => showArchived || c.status !== 'Archived')} rowKey={c => c.id} empty="No companies yet."
          search={{ placeholder: 'Search companies', text: c => [c.name, c.industry, c.notes, c.brands.join(' ')].join(' ') }}
          columns={[
            { label: 'Company', render: c => <><strong>{c.name}</strong>{c.website && <div><Ext href={c.website}>Website</Ext></div>}</> },
            { label: 'Industry', render: c => c.industry || '—' }, { label: 'Brands', render: c => <Brands brands={c.brands} /> },
            { label: 'Owner', render: c => c.ownerName ?? '—' }, { label: 'Contacts', num: true, render: c => c.contactCount }, { label: 'Open opportunities', num: true, render: c => c.openOpportunities },
            { label: 'Status', render: c => <Status s={c.status} /> },
            { label: '', render: c => <div className="acts-cell"><button className="btn sm" onClick={() => setEditing(c)}>Edit</button></div> },
          ]} />
      )}</Loaded>
      {editing && <FormModal title={editing === 'new' ? 'Add company' : 'Edit company'} onClose={() => setEditing(null)}
        initial={editing === 'new' ? { ownerId: me.id, status: 'Active', brands: [] } : editing}
        fields={[
          { k: 'name', l: 'Name', req: true }, { k: 'website', l: 'Website', t: 'url' }, { k: 'industry', l: 'Industry' },
          { k: 'ownerId', l: 'Staff owner', t: 'select', o: memberOptions(members, 'marketing') }, { k: 'brands', l: 'Brands', t: 'multi', o: BRANDS },
          { k: 'status', l: 'Status', t: 'select', blank: false, o: ['Active', 'Archived'] }, { k: 'notes', l: 'Notes', t: 'textarea' },
        ]}
        onSubmit={async v => {
          const payload = { name: v.name, website: v.website ?? '', industry: v.industry ?? '', brands: v.brands ?? [], ownerId: v.ownerId || null, status: v.status, notes: v.notes ?? '' };
          if (editing === 'new') await api.post('/api/marketing/companies', payload); else await api.patch(`/api/marketing/companies/${editing.id}`, { ...payload, rev: editing.rev });
          toast('Company saved.'); list.reload();
        }} />}
    </>
  );
}

/* ---------------- Follow-up queue ---------------- */
type FollowUp = { kind: 'contact' | 'opportunity'; id: string; title: string; nextAction: string; followUp: string; ownerName: string | null; detail: string | null };
export function FollowUps() {
  const [mine, setMine] = useState(true);
  const list = useLoad(() => api.get<{ followUps: FollowUp[] }>(`/api/marketing/follow-ups${mine ? '?mine=1' : ''}`), [mine]);
  const [logging, setLogging] = useState<FollowUp | null>(null);
  const today = businessToday();
  return (
    <>
      <PageHead title="Follow-ups" sub="Next actions for active contacts and open opportunities, soonest first. Archived contacts and closed opportunities drop off." />
      <div className="tabs"><button className={mine ? 'on' : ''} onClick={() => setMine(true)}>Mine</button><button className={!mine ? 'on' : ''} onClick={() => setMine(false)}>Everyone</button></div>
      <Loaded state={list}>{d => {
        const late = d.followUps.filter(f => f.followUp < today).length, due = d.followUps.filter(f => f.followUp === today).length;
        return (
          <>
            <div className="tiles">
              <div className="tile"><div className="k">Overdue</div><div className="v" style={late ? { color: 'var(--bad)' } : undefined}>{late}</div></div>
              <div className="tile"><div className="k">Due today</div><div className="v">{due}</div></div>
              <div className="tile"><div className="k">Upcoming</div><div className="v">{d.followUps.length - late - due}</div></div>
            </div>
            <DataTable rows={d.followUps} rowKey={f => f.kind + f.id} empty="Nothing to follow up. Add a next action and date to a contact or opportunity."
              columns={[
                { label: 'Due', render: f => <span style={overdue(f.followUp, today)}>{fmtDate(f.followUp)}</span> },
                { label: 'For', render: f => <><a href={href(f.kind === 'contact' ? `mk-contact/${f.id}` : 'opportunities')}><strong>{f.title}</strong></a><div className="muted">{f.kind === 'contact' ? 'Contact' : 'Opportunity'}{f.detail ? ` · ${f.detail}` : ''}</div></> },
                { label: 'Next action', render: f => f.nextAction || '—' }, { label: 'Owner', render: f => f.ownerName ?? '—' },
                { label: '', render: f => <div className="acts-cell"><button className="btn sm" onClick={() => setLogging(f)}>Record activity</button></div> },
              ]} />
          </>
        );
      }}</Loaded>
      {logging && <ActivityForm contactId={logging.kind === 'contact' ? logging.id : null} opportunityId={logging.kind === 'opportunity' ? logging.id : null} onClose={() => setLogging(null)} onSaved={list.reload} />}
    </>
  );
}
