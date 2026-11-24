import { DIVISIONS } from '../../shared/constants';
import { quoteFor } from '../../shared/quotes';
import { api } from '../api';
import { businessToday, fmtDate, fmtDateTime } from '../format';
import { href } from '../router';
import { hasDiv, useSession } from '../session';
import { Empty, Loaded, PageHead, useLoad } from '../ui';

type Summary = { contacts: Record<string, number>; firm: { clients: number; openMatters: number; activePncs: number } | null };
type AuditRow = { id: string; at: string; actor: string | null; action: string; entity: string; scope: string };

export function Overview() {
  const { me } = useSession();
  const today = businessToday();
  const summary = useLoad(() => api.get<Summary>('/api/summary'), []);
  const audit = useLoad(() => api.get<{ audit: AuditRow[] }>('/api/audit?limit=10'), []);
  const h = new Date().getHours(), greet = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  return (
    <>
      <PageHead title="Overview" sub={`Good ${greet}, ${me.name.split(' ')[0]}. Here’s where things stand on ${fmtDate(today)}.`} />
      <Loaded state={summary}>{s => (
        <>
          {s.firm && (
            <div className="tiles">
              <a className="tile" href={href('clients')}><div className="k">JD&amp;Co clients</div><div className="v">{s.firm.clients}</div></a>
              <a className="tile" href={href('clients')}><div className="k">Open files</div><div className="v">{s.firm.openMatters}</div></a>
              <a className="tile" href={href('pncs')}><div className="k">Active PNCs</div><div className="v">{s.firm.activePncs}</div></a>
            </div>
          )}
          <section className="card"><h3>Your divisions</h3>
            {DIVISIONS.some(d => hasDiv(me, d.id)) ? (
              <div className="tiles" style={{ margin: 0 }}>
                {DIVISIONS.filter(d => hasDiv(me, d.id)).map(d => d.id === 'properties' ? (
                  <a key={d.id} className="tile" href={href('properties')}><div className="k">{d.name}</div><div className="v small">View properties</div></a>
                ) : (
                  <a key={d.id} className="tile" href={href(`contacts/${d.id}`)}><div className="k">{d.name}</div><div className="v small">{s.contacts[d.id] ?? 0} contact{(s.contacts[d.id] ?? 0) === 1 ? '' : 's'}</div></a>
                ))}
              </div>
            ) : <Empty>You don’t have access to any divisions yet. Ask Jasmine to add you.</Empty>}
          </section>
        </>
      )}</Loaded>
      <div className="cols2">
        <section className="card"><h3>Recent activity</h3>
          <Loaded state={audit}>{a => a.audit.length ? (
            <ul className="tl">{a.audit.map(x => <li key={x.id}><div>{x.action}: <strong>{x.entity}</strong></div><div className="m">{x.actor ?? '—'} · {fmtDateTime(x.at)}</div></li>)}</ul>
          ) : <Empty>No activity yet.</Empty>}</Loaded>
        </section>
        <section className="card quote-card"><h3>Today’s inspiration</h3><blockquote>{quoteFor(today)}</blockquote><div className="byline">Momentum</div></section>
      </div>
    </>
  );
}
