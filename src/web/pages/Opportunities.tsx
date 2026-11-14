import { useState } from 'react';
import { BRANDS, CURRENCIES, PIPELINE_NAMES, PIPELINES, isClosedStage, type Pipeline } from '../../shared/constants';
import { api } from '../api';
import { businessToday, fmtDate, money } from '../format';
import { href } from '../router';
import { memberOptions, useSession } from '../session';
import { DataTable, FormModal, Loaded, Modal, PageHead, Status, useLoad, useToast } from '../ui';
import { ActivityForm, Timeline, useMarketingChoices } from './Marketing';

type Opp = {
  id: string; title: string; pipeline: Pipeline; stage: string; contactId: string | null; contactName: string | null; companyId: string | null; companyName: string | null;
  ownerId: string | null; ownerName: string | null; brand: string; currency: string; valueCents: number; probability: number; expectedClose: string; nextAction: string; followUp: string;
  lostReason: string; campaignId: string | null; campaignName: string | null; notes: string; rev: number;
};
type Totals = Record<string, { count: number; expectedCents: number; weightedCents: number }>;

function OppForm({ opp, pipeline, onClose, onSaved }: { opp?: Opp; pipeline: Pipeline; onClose: () => void; onSaved: () => void }) {
  const { me, members } = useSession();
  const toast = useToast();
  const { companyOpts, campaignOpts } = useMarketingChoices();
  const contacts = useLoad(() => api.get<{ contacts: { id: string; name: string; companyName: string | null; status: string }[] }>('/api/marketing/contacts'), []);
  const contactOpts = (contacts.data?.contacts ?? []).filter(c => c.status === 'Active' || c.id === opp?.contactId).map(c => [c.id, c.companyName ? `${c.name} · ${c.companyName}` : c.name] as [string, string]);
  const p = opp?.pipeline ?? pipeline;
  return (
    <FormModal title={opp ? 'Edit opportunity' : `New ${p} opportunity`} onClose={onClose}
      initial={opp ?? { stage: PIPELINES[p].stages[0], ownerId: me.id, currency: 'CAD', probability: '10' }}
      note="Won sets probability to 100% and Lost to 0%. Values describe the pipeline; they don’t mean payment was received."
      fields={[
        { k: 'title', l: 'Opportunity', req: true, full: true },
        { k: 'stage', l: 'Stage', t: 'select', blank: false, o: PIPELINES[p].stages },
        { k: 'brand', l: 'Brand', t: 'select', o: BRANDS },
        { k: 'contactId', l: 'Contact', t: 'select', o: contactOpts, help: 'Open opportunities need a contact or a company.' }, { k: 'companyId', l: 'Company', t: 'select', o: companyOpts },
        { k: 'ownerId', l: 'Staff owner', t: 'select', o: memberOptions(members, 'marketing') }, { k: 'campaignId', l: 'Primary campaign', t: 'select', o: campaignOpts },
        { k: 'h1', l: 'Value', t: 'h' },
        { k: 'currency', l: 'Currency', t: 'select', blank: false, o: CURRENCIES }, { k: 'valueCents', l: 'Expected value', t: 'money' },
        { k: 'probability', l: 'Probability (%)', t: 'number' }, { k: 'expectedClose', l: 'Expected close', t: 'date' },
        { k: 'h2', l: 'Next step', t: 'h' },
        { k: 'nextAction', l: 'Next action', help: 'Required while open.' }, { k: 'followUp', l: 'Follow-up date', t: 'date', help: 'Required while open.' },
        { k: 'lostReason', l: 'Lost reason', full: true, help: 'Required when the stage is Lost.' }, { k: 'notes', l: 'Notes', t: 'textarea' },
      ]}
      onSubmit={async v => {
        const prob = Number(v.probability ?? 0);
        if (!Number.isInteger(prob) || prob < 0 || prob > 100) throw new Error('Probability must be a whole number from 0 to 100.');
        const payload = {
          title: v.title, pipeline: p, stage: v.stage, contactId: v.contactId || null, companyId: v.companyId || null, ownerId: v.ownerId || null, brand: v.brand ?? '',
          currency: v.currency, valueCents: v.valueCents ?? 0, probability: prob, expectedClose: v.expectedClose ?? '', nextAction: v.nextAction ?? '', followUp: v.followUp ?? '',
          lostReason: v.lostReason ?? '', campaignId: v.campaignId || null, notes: v.notes ?? '',
        };
        if (opp) await api.patch(`/api/marketing/opportunities/${opp.id}`, { ...payload, rev: opp.rev }); else await api.post('/api/marketing/opportunities', payload);
        toast('Opportunity saved.'); onSaved();
      }} />
  );
}

function History({ opp, onClose }: { opp: Opp; onClose: () => void }) {
  const d = useLoad(() => api.get(`/api/marketing/opportunities/${opp.id}`), [opp.id]);
  const [logging, setLogging] = useState(false);
  return (
    <Modal title={opp.title} onClose={onClose} footer={<><button className="btn" onClick={() => setLogging(true)}>Record activity</button><button className="btn ghost" onClick={onClose}>Close</button></>}>
      <Loaded state={d}>{x => <Timeline items={x.history} />}</Loaded>
      {logging && <ActivityForm opportunityId={opp.id} onClose={() => setLogging(false)} onSaved={d.reload} />}
    </Modal>
  );
}

export function Opportunities() {
  const [pipeline, setPipeline] = useState<Pipeline>(PIPELINE_NAMES[0]);
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open');
  const list = useLoad(() => api.get<{ opportunities: Opp[]; totals: Totals }>(`/api/marketing/opportunities?pipeline=${encodeURIComponent(pipeline)}&state=${state}`), [pipeline, state]);
  const [editing, setEditing] = useState<Opp | 'new' | null>(null);
  const [history, setHistory] = useState<Opp | null>(null);
  const today = businessToday();
  return (
    <>
      <PageHead title="Opportunities" sub={PIPELINES[pipeline].about} actions={<button className="btn primary" onClick={() => setEditing('new')}>Add opportunity</button>} />
      <div className="tabs">{PIPELINE_NAMES.map(p => <button key={p} className={p === pipeline ? 'on' : ''} onClick={() => setPipeline(p)}>{p}</button>)}</div>
      <div className="toolbar">
        <select aria-label="Show" value={state} onChange={e => setState(e.target.value as never)}><option value="open">Open</option><option value="closed">Won and lost</option><option value="all">All</option></select>
      </div>
      <Loaded state={list}>{d => (
        <>
          <div className="tiles">
            {(Object.keys(d.totals).length ? Object.keys(d.totals) : ['CAD']).map(cur => (
              <div className="tile" key={cur}><div className="k">Open pipeline · {cur}</div><div className="v small">{money(d.totals[cur]?.expectedCents, cur)}</div>
                <div className="muted" style={{ fontSize: 12 }}>Weighted {money(d.totals[cur]?.weightedCents, cur)} · {d.totals[cur]?.count ?? 0} open</div></div>
            ))}
          </div>
          <DataTable rows={d.opportunities} rowKey={o => o.id} empty="No opportunities here yet."
            search={{ placeholder: 'Search opportunities', text: o => [o.title, o.contactName, o.companyName, o.ownerName, o.notes, o.brand].join(' ') }}
            columns={[
              { label: 'Opportunity', render: o => <><strong>{o.title}</strong><div className="muted">{o.contactId ? <a href={href(`mk-contact/${o.contactId}`)}>{o.contactName}</a> : null}{o.contactName && o.companyName ? ' · ' : ''}{o.companyName}</div></> },
              { label: 'Stage', render: o => <><Status s={o.stage} />{o.stage === 'Lost' && <div className="muted">{o.lostReason}</div>}</> },
              { label: 'Value', num: true, render: o => money(o.valueCents, o.currency) }, { label: 'Prob.', num: true, render: o => `${o.probability}%` },
              { label: 'Weighted', num: true, render: o => money(Math.round((o.valueCents * o.probability) / 100), o.currency) },
              { label: 'Owner', render: o => o.ownerName ?? '—' },
              { label: 'Next action', render: o => isClosedStage(o.stage) ? <span className="muted">Closed</span> : <>{o.nextAction}<div className="muted" style={o.followUp < today ? { color: 'var(--bad)' } : undefined}>{fmtDate(o.followUp)}</div></> },
              { label: '', render: o => <div className="acts-cell"><button className="btn sm ghost" onClick={() => setHistory(o)}>History</button><button className="btn sm" onClick={() => setEditing(o)}>Edit</button></div> },
            ]} />
        </>
      )}</Loaded>
      {editing && <OppForm opp={editing === 'new' ? undefined : editing} pipeline={pipeline} onClose={() => setEditing(null)} onSaved={list.reload} />}
      {history && <History opp={history} onClose={() => setHistory(null)} />}
    </>
  );
}
