import { useState } from 'react';
import { BRANDS, CAMPAIGN_STATUSES, CURRENCIES, utmUrl } from '../../shared/constants';
import { api } from '../api';
import { fmtDate, money } from '../format';
import { href } from '../router';
import { memberOptions, useSession } from '../session';
import { copyText, DataTable, DefList, Empty, Ext, FormModal, Loaded, PageHead, Status, useLoad, useToast, type Values } from '../ui';

type Results = {
  contacts: number; opportunities: { open: number; won: number; lost: number }; winRate: number | null; wonValue: Record<string, number>;
  pipeline: Record<string, { count: number; expectedCents: number; weightedCents: number }>; tasks: { total: number; done: number };
  spend: Record<string, number>; remainingCents: number; costPerContactCents: number | null;
};
type Campaign = {
  id: string; name: string; brand: string; ownerId: string; ownerName: string; objective: string; startDate: string; endDate: string; status: string; currency: string; budgetCents: number;
  landingUrl: string; utmSource: string; utmMedium: string; utmCampaign: string; utmContent: string; utmTerm: string; notes: string; trackedUrl: string; results: Results; rev: number;
};

const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`);
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-');
const tracked = (v: Values) => utmUrl(v.landingUrl ?? '', { source: v.utmSource, medium: v.utmMedium, campaign: v.utmCampaign || slug(v.name ?? ''), content: v.utmContent, term: v.utmTerm });

function CampaignForm({ campaign, onClose, onSaved }: { campaign?: Campaign; onClose: () => void; onSaved: () => void }) {
  const { me, members } = useSession();
  const toast = useToast();
  return (
    <FormModal title={campaign ? 'Edit campaign' : 'Add campaign'} onClose={onClose} initial={campaign ?? { ownerId: me.id, status: 'Planned', currency: 'CAD' }}
      fields={[
        { k: 'name', l: 'Campaign name', req: true }, { k: 'brand', l: 'Brand', t: 'select', req: true, o: BRANDS },
        { k: 'ownerId', l: 'Staff owner', t: 'select', req: true, o: memberOptions(members, 'marketing') }, { k: 'status', l: 'Status', t: 'select', blank: false, o: CAMPAIGN_STATUSES },
        { k: 'startDate', l: 'Start date', t: 'date' }, { k: 'endDate', l: 'End date', t: 'date' }, { k: 'objective', l: 'Objective', t: 'textarea' },
        { k: 'h1', l: 'Budget', t: 'h' },
        { k: 'currency', l: 'Currency', t: 'select', blank: false, o: CURRENCIES }, { k: 'budgetCents', l: 'Budget including tax', t: 'money' },
        { k: 'h2', l: 'Link builder', t: 'h' },
        { k: 'landingUrl', l: 'Landing page', t: 'url', full: true }, { k: 'utmSource', l: 'Source (utm_source)', help: 'For example instagram or newsletter.' },
        { k: 'utmMedium', l: 'Medium (utm_medium)', help: 'For example social, email or cpc.' }, { k: 'utmCampaign', l: 'Campaign (utm_campaign)', help: 'Leave blank to use the campaign name.' },
        { k: 'utmContent', l: 'Content (utm_content)' }, { k: 'utmTerm', l: 'Term (utm_term)' },
        { k: 'notes', l: 'Notes', t: 'textarea' },
      ]}
      live={v => v.landingUrl ? <div className="infobox" style={{ wordBreak: 'break-all' }}><strong>Tracked link:</strong> {tracked(v) || 'Enter a full https:// address.'}</div> : null}
      note="Momentum builds the link only. It doesn’t install tracking or collect analytics."
      onSubmit={async v => {
        const payload = {
          name: v.name, brand: v.brand, ownerId: v.ownerId, objective: v.objective ?? '', startDate: v.startDate ?? '', endDate: v.endDate ?? '', status: v.status, currency: v.currency,
          budgetCents: v.budgetCents ?? 0, landingUrl: v.landingUrl ?? '', utmSource: v.utmSource ?? '', utmMedium: v.utmMedium ?? '', utmCampaign: v.utmCampaign || (v.landingUrl ? slug(v.name) : ''),
          utmContent: v.utmContent ?? '', utmTerm: v.utmTerm ?? '', notes: v.notes ?? '',
        };
        if (campaign) await api.patch(`/api/marketing/campaigns/${campaign.id}`, { ...payload, rev: campaign.rev }); else await api.post('/api/marketing/campaigns', payload);
        toast('Campaign saved.'); onSaved();
      }} />
  );
}

const spendText = (r: Results) => (Object.keys(r.spend).length ? Object.entries(r.spend).map(([c, n]) => money(n, c)).join(' + ') : money(0));

export function Campaigns() {
  const list = useLoad(() => api.get<{ campaigns: Campaign[] }>('/api/marketing/campaigns'), []);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHead title="Campaigns and results" sub="Results come only from contacts, opportunities, team work and marketing expenses linked to each campaign."
        actions={<button className="btn primary" onClick={() => setAdding(true)}>Add campaign</button>} />
      <Loaded state={list}>{d => (
        <DataTable rows={d.campaigns} rowKey={c => c.id} empty="No campaigns yet."
          search={{ placeholder: 'Search campaigns', text: c => [c.name, c.brand, c.objective, c.ownerName].join(' ') }}
          columns={[
            { label: 'Campaign', render: c => <><a href={href(`campaign/${c.id}`)}><strong>{c.name}</strong></a><div className="muted">{c.brand}</div></> },
            { label: 'Dates', render: c => <>{fmtDate(c.startDate)}<div className="muted">to {fmtDate(c.endDate)}</div></> },
            { label: 'Status', render: c => <Status s={c.status} /> }, { label: 'Owner', render: c => c.ownerName },
            { label: 'Budget incl. tax', num: true, render: c => money(c.budgetCents, c.currency) },
            { label: 'Spent incl. HST', num: true, render: c => spendText(c.results) },
            { label: 'Contacts', num: true, render: c => c.results.contacts },
            { label: 'Won / lost', num: true, render: c => `${c.results.opportunities.won} / ${c.results.opportunities.lost}` },
            { label: 'Win rate', num: true, render: c => pct(c.results.winRate) },
          ]} />
      )}</Loaded>
      {adding && <CampaignForm onClose={() => setAdding(false)} onSaved={list.reload} />}
    </>
  );
}

type Linked = {
  contacts: { id: string; name: string; email: string; status: string }[]; opportunities: { id: string; title: string; pipeline: string; stage: string; currency: string; valueCents: number; probability: number }[];
  tasks: { id: string; title: string; status: string; dueDate: string }[]; expenses: { id: string; date: string; provider: string; currency: string; amountCents: number; hstCents: number; state: string }[];
};
export function CampaignDetail({ id }: { id: string }) {
  const toast = useToast();
  const d = useLoad(() => api.get<{ campaign: Campaign; linked: Linked }>(`/api/marketing/campaigns/${id}`), [id]);
  const [editing, setEditing] = useState(false);
  return (
    <Loaded state={d}>{({ campaign: c, linked }) => {
      const r = c.results, others = Object.keys(r.spend).filter(x => x !== c.currency);
      return (
        <>
          <PageHead title={c.name} crumb={<a href={href('campaigns')}>Campaigns and results</a>} sub={`${c.brand} · ${fmtDate(c.startDate)} to ${fmtDate(c.endDate)}`}
            actions={<button className="btn primary" onClick={() => setEditing(true)}>Edit</button>} />
          <div className="tiles">
            <div className="tile"><div className="k">Budget incl. tax</div><div className="v small">{money(c.budgetCents, c.currency)}</div></div>
            <div className="tile"><div className="k">Spent incl. HST ({c.currency})</div><div className="v small">{money(r.spend[c.currency] ?? 0, c.currency)}</div>{others.length > 0 && <div className="muted" style={{ fontSize: 12 }}>Also {others.map(x => money(r.spend[x], x)).join(', ')} (not counted against the budget)</div>}</div>
            <div className="tile"><div className="k">Remaining</div><div className="v small" style={r.remainingCents < 0 ? { color: 'var(--bad)' } : undefined}>{money(r.remainingCents, c.currency)}</div></div>
            <div className="tile"><div className="k">Cost per linked contact</div><div className="v small">{r.costPerContactCents === null ? '—' : money(r.costPerContactCents, c.currency)}</div></div>
            <div className="tile"><div className="k">Win rate</div><div className="v small">{pct(r.winRate)}</div><div className="muted" style={{ fontSize: 12 }}>{r.opportunities.won} won · {r.opportunities.lost} lost · {r.opportunities.open} open</div></div>
          </div>
          <div className="cols2">
            <section className="card"><h3>Plan</h3>
              <DefList items={[
                ['Status', <Status s={c.status} />], ['Owner', c.ownerName], ['Objective', c.objective], ['Landing page', c.landingUrl ? <Ext href={c.landingUrl}>{c.landingUrl}</Ext> : ''],
                ['Tracked link', c.trackedUrl ? <><code style={{ wordBreak: 'break-all' }}>{c.trackedUrl}</code> <button className="btn sm" onClick={() => copyText(c.trackedUrl, toast)}>Copy</button></> : ''],
                ['Won value', Object.entries(r.wonValue).map(([cur, n]) => money(n, cur)).join(', ')], ['Team work', `${r.tasks.done} of ${r.tasks.total} done`], ['Notes', c.notes],
              ]} />
            </section>
            <section className="card"><h3>Linked contacts ({linked.contacts.length})</h3>
              {linked.contacts.length ? <ul className="tl">{linked.contacts.map(x => <li key={x.id}><a href={href(`mk-contact/${x.id}`)}>{x.name}</a><div className="m">{x.email}</div></li>)}</ul> : <Empty>Choose this campaign as a contact’s primary campaign to link it.</Empty>}
            </section>
          </div>
          <section className="card"><h3>Linked opportunities</h3>
            <DataTable rows={linked.opportunities} rowKey={o => o.id} empty="No opportunities linked."
              columns={[{ label: 'Opportunity', render: o => <><strong>{o.title}</strong><div className="muted">{o.pipeline}</div></> }, { label: 'Stage', render: o => <Status s={o.stage} /> }, { label: 'Value', num: true, render: o => money(o.valueCents, o.currency) }, { label: 'Prob.', num: true, render: o => `${o.probability}%` }]} />
          </section>
          <div className="cols2">
            <section className="card"><h3>Marketing expenses</h3>
              <DataTable rows={linked.expenses} rowKey={e => e.id} rowClass={e => (e.state === 'Voided' ? 'voided' : '')} empty="No expenses linked."
                columns={[{ label: 'Date', render: e => fmtDate(e.date) }, { label: 'Provider', render: e => <>{e.provider}{e.state === 'Voided' && <> <Status s="Voided" /></>}</> }, { label: 'Total incl. HST', num: true, render: e => money(e.amountCents + e.hstCents, e.currency) }]} />
            </section>
            <section className="card"><h3>Team work</h3>
              <DataTable rows={linked.tasks} rowKey={t => t.id} empty="No team work linked."
                columns={[{ label: 'Work', render: t => <a href={href('team')}>{t.title}</a> }, { label: 'Due', render: t => fmtDate(t.dueDate) }, { label: 'Status', render: t => <Status s={t.status} /> }]} />
            </section>
          </div>
          {editing && <CampaignForm campaign={c} onClose={() => setEditing(false)} onSaved={d.reload} />}
        </>
      );
    }}</Loaded>
  );
}
