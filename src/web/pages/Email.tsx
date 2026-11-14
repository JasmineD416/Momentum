import { useState } from 'react';
import { parseCsv } from '../../shared/csv';
import { CONSENT_BASES, EMAIL_BRANDS, IMPORT_ALIASES, IMPORT_CHUNK, IMPORT_COLUMNS, emailBrandName, type Sender } from '../../shared/email';
import { api, ApiError } from '../api';
import { businessToday, fmtDate, fmtDateTime } from '../format';
import { go, href } from '../router';
import { hasDiv, isAdmin, useSession } from '../session';
import { Confirm, DataTable, Empty, FormModal, Loaded, Modal, PageHead, Pill, Status, useLoad, useToast } from '../ui';

type BrandRow = { id: string; name: string; sender: (Sender & { dailyLimit: number; rev: number }) | null; dailyLimit: number; sentToday: number; subscribed: number; unsubscribed: number; expired: number; expiring: number };
type Overview = { providerReady: boolean; suppressed: number; brands: BrandRow[] };
const n = (x: number) => x.toLocaleString('en-CA');

export const SetupBanner = () => <p className="warnbox">Email sending isn’t switched on yet. You can build lists and write mailings now; sending starts once Amazon SES is connected (GO-LIVE.md, “Email sending”).</p>;

/* ---------------- Sender settings ---------------- */
function SenderForm({ brand, onClose, onSaved }: { brand: BrandRow; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  return (
    <FormModal title={`${brand.name} sender`} onClose={onClose}
      initial={brand.sender ?? { fromName: brand.name, dailyLimit: '200', accent: '#C14B8A' }}
      intro={<p className="infobox">Send from a domain this entity owns (for example news@lawgirl.ca), verified in Amazon SES with DKIM, SPF and DMARC records. New domains should start around 200 a day and roughly double each week.</p>}
      fields={[
        { k: 'fromName', l: 'From name', req: true }, { k: 'fromEmail', l: 'From address', t: 'email', req: true },
        { k: 'replyTo', l: 'Reply-to address', t: 'email', help: 'Where replies go. Use a mailbox someone reads.' }, { k: 'dailyLimit', l: 'Daily sending limit', t: 'number', req: true },
        { k: 'postalAddress', l: 'Postal address', t: 'textarea', req: true, help: 'Required by law in every commercial email. A P.O. box is fine.' },
        { k: 'logoUrl', l: 'Logo image link', t: 'url', help: 'An https:// link to a PNG or JPG, about 400 px wide.' }, { k: 'accent', l: 'Accent colour', help: 'For example #C14B8A.' },
        { k: 'footerNote', l: 'Footer note', t: 'textarea', help: 'Optional, for example a disclaimer. JD&Co: “This email is not legal advice.”' },
      ]}
      onSubmit={async v => {
        await api.put(`/api/email/senders/${brand.id}`, { fromName: v.fromName, fromEmail: v.fromEmail, replyTo: v.replyTo ?? '', postalAddress: v.postalAddress, dailyLimit: Number(v.dailyLimit), logoUrl: v.logoUrl ?? '', accent: v.accent || '#C14B8A', footerNote: v.footerNote ?? '', rev: brand.sender?.rev });
        toast('Sender saved.'); onSaved();
      }} />
  );
}

type DomainCheck = { domain: string; verified: boolean; dkim: string; records: { name: string; value: string }[] };
function DomainCheckModal({ brand, onClose }: { brand: BrandRow; onClose: () => void }) {
  const d = useLoad(() => api.post<DomainCheck>(`/api/email/senders/${brand.id}/check`), [brand.id]);
  return (
    <Modal title={`Domain check: ${brand.name}`} onClose={onClose}>
      <Loaded state={d}>{x => (
        <>
          <p>Domain <strong>{x.domain}</strong>: {x.verified ? <Status s="Active" /> : <Pill cls="bad">Not verified</Pill>} DKIM: <strong>{x.dkim}</strong></p>
          {!x.verified && <p className="warnbox">Until Amazon SES verifies this domain, mail can’t be sent from it. Add the domain in SES (Easy DKIM), then add these DNS records where the domain is hosted.</p>}
          {x.records.length > 0 && <div className="tblwrap"><table><thead><tr><th>CNAME name</th><th>Value</th></tr></thead><tbody>{x.records.map(r => <tr key={r.name}><td><code>{r.name}</code></td><td><code>{r.value}</code></td></tr>)}</tbody></table></div>}
          <p className="muted" style={{ fontSize: 12 }}>Also publish SPF (through a custom MAIL FROM domain in SES) and a DMARC record such as <code>_dmarc.{x.domain}</code> TXT <code>v=DMARC1; p=none; rua=mailto:dmarc@{x.domain}</code>. Gmail and Yahoo require all three for bulk mail.</p>
        </>
      )}</Loaded>
    </Modal>
  );
}

/* ---------------- Overview of every entity's list ---------------- */
export function EmailHome() {
  const { me } = useSession();
  const d = useLoad(() => api.get<Overview>('/api/email/overview'), []);
  const [editing, setEditing] = useState<BrandRow | null>(null);
  const [checking, setChecking] = useState<BrandRow | null>(null);
  const admin = isAdmin(me);
  return (
    <>
      <PageHead title="Email lists" sub="Each business keeps its own list. People join a list with recorded consent and leave it with one click; bounces and spam complaints are blocked everywhere."
        actions={admin ? <a className="btn primary" href={href('email-import')}>Import contacts</a> : undefined} />
      <Loaded state={d}>{x => (
        <>
          {!x.providerReady && <SetupBanner />}
          {!x.brands.length ? <Empty>You don’t have access to any business’s email list. Lists need Marketing plus that business’s division.</Empty> : (
            <div className="grid-cards">{x.brands.map(b => (
              <section className="card" key={b.id} style={{ margin: 0 }}>
                <h3 style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><a href={href(`email-list/${b.id}`)}>{b.name}</a>{b.sender ? <Status s="Active" /> : <Pill cls="warn">No sender</Pill>}</h3>
                <div className="tiles" style={{ margin: '0 0 10px' }}>
                  <div className="tile"><div className="k">Subscribed</div><div className="v small">{n(b.subscribed)}</div></div>
                  <div className="tile"><div className="k">Unsubscribed</div><div className="v small">{n(b.unsubscribed)}</div></div>
                </div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {b.sender ? <>From {b.sender.fromName} &lt;{b.sender.fromEmail}&gt;<br /></> : null}
                  Sent today: {n(b.sentToday)} of {n(b.dailyLimit)}
                  {b.expiring > 0 && <><br />{n(b.expiring)} implied consents end within 30 days</>}
                  {b.expired > 0 && <><br />{n(b.expired)} implied consents have ended (not emailed)</>}
                </div>
                <div className="row" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                  <a className="btn sm" href={href(`email-list/${b.id}`)}>Open list</a>
                  {admin && <button className="btn sm ghost" onClick={() => setEditing(b)}>Sender settings</button>}
                  {admin && b.sender && <button className="btn sm ghost" onClick={() => setChecking(b)}>Check domain</button>}
                </div>
              </section>
            ))}</div>
          )}
          <Suppressions count={x.suppressed} />
        </>
      )}</Loaded>
      {editing && <SenderForm brand={editing} onClose={() => setEditing(null)} onSaved={d.reload} />}
      {checking && <DomainCheckModal brand={checking} onClose={() => setChecking(null)} />}
    </>
  );
}

function Suppressions({ count }: { count: number }) {
  const { me } = useSession();
  const toast = useToast();
  const [q, setQ] = useState('');
  const list = useLoad(() => api.get<{ suppressions: { email: string; reason: string; detail: string; createdAt: string }[] }>(`/api/email/suppressions?q=${encodeURIComponent(q)}`), [q]);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState('');
  return (
    <section className="card"><h3>Blocked addresses ({n(count)}) <button className="btn sm" onClick={() => setAdding(true)}>Block an address</button></h3>
      <p className="muted" style={{ marginTop: 0 }}>Never emailed by any business: hard bounces and spam complaints reported by mail providers, plus addresses blocked by staff.</p>
      <div className="toolbar"><input type="search" placeholder="Search blocked addresses" aria-label="Search blocked addresses" value={q} onChange={e => setQ(e.target.value)} /></div>
      <Loaded state={list}>{d => (
        <DataTable rows={d.suppressions} rowKey={s => s.email} empty="No blocked addresses."
          columns={[
            { label: 'Email', render: s => s.email }, { label: 'Reason', render: s => <Pill cls={s.reason === 'Complaint' ? 'bad' : 'warn'}>{s.reason}</Pill> },
            { label: 'Detail', render: s => s.detail || '—' }, { label: 'Since', render: s => fmtDateTime(s.createdAt) },
            { label: '', render: s => isAdmin(me) && s.reason !== 'Complaint' ? <button className="btn sm ghost" onClick={() => setRemoving(s.email)}>Unblock</button> : null },
          ]} />
      )}</Loaded>
      {adding && <FormModal title="Block an address" size="narrow" onClose={() => setAdding(false)} fields={[{ k: 'email', l: 'Email', t: 'email', req: true }, { k: 'detail', l: 'Why', help: 'For example: asked by phone not to be contacted.' }]}
        onSubmit={async v => { await api.post('/api/email/suppressions', { email: v.email, detail: v.detail ?? '' }); toast('Address blocked.'); list.reload(); }} />}
      {removing && <Confirm title="Unblock address" label="Unblock" text={`${removing} can be added to lists again. Only do this if you know the address works and the person wants your email.`}
        onClose={() => setRemoving('')} onConfirm={async () => { await api.post('/api/email/suppressions/remove', { email: removing }); toast('Unblocked.'); list.reload(); }} />}
    </section>
  );
}

/* ---------------- One entity's list ---------------- */
type Sub = { id: string; email: string; firstName: string; lastName: string; company: string; phone: string; status: string; consentType: string; consentDate: string; consentSource: string; impliedUntil: string; unsubscribedAt: string | null; unsubscribeSource: string; suppressed: string | null; rev: number };
const consentFields = [
  { k: 'basis', l: 'Consent', t: 'select' as const, req: true, blank: false as const, o: CONSENT_BASES.map(b => [b.id, b.label] as [string, string]) },
  { k: 'consentDate', l: 'Date consent was given', t: 'date' as const, req: true },
  { k: 'consentSource', l: 'How they gave it (evidence)', req: true, full: true, help: 'For example: website sign-up form, business card at the CBPLA conference, bought the cookbook.' },
];

export function EmailList({ brand }: { brand: string }) {
  const { me } = useSession();
  const toast = useToast();
  const [q, setQ] = useState(''), [status, setStatus] = useState(''), [page, setPage] = useState(0);
  const list = useLoad(() => api.get<{ subscribers: Sub[]; total: number; page: number; pageSize: number }>(`/api/email/lists/${brand}/subscribers?q=${encodeURIComponent(q)}&status=${status}&page=${page}`), [brand, q, status, page]);
  const [adding, setAdding] = useState(false);
  const [resub, setResub] = useState(false);
  const [unsub, setUnsub] = useState<Sub | null>(null);
  const [editing, setEditing] = useState<Sub | null>(null);
  const [fromContacts, setFromContacts] = useState(false);
  const name = emailBrandName(brand), today = businessToday();
  return (
    <>
      <PageHead title={`${name} list`} crumb={<a href={href('email')}>Email lists</a>}
        actions={<>{isAdmin(me) && <a className="btn" href={href(`email-import/${brand}`)}>Import contacts</a>}<button className="btn" onClick={() => setFromContacts(true)}>Add marketing contacts</button><button className="btn primary" onClick={() => { setResub(false); setAdding(true); }}>Add person</button></>} />
      <div className="toolbar">
        <input type="search" placeholder="Search email, name or company" aria-label="Search" value={q} onChange={e => { setQ(e.target.value); setPage(0); }} />
        <select aria-label="Status" value={status} onChange={e => { setStatus(e.target.value); setPage(0); }}>
          <option value="">Everyone</option><option>Subscribed</option><option>Unsubscribed</option><option value="Expired">Implied consent ended</option><option>Suppressed</option>
        </select>
      </div>
      <Loaded state={list}>{d => (
        <>
          <p className="muted" style={{ margin: '0 0 8px' }}>{n(d.total)} {d.total === 1 ? 'person' : 'people'}{d.total > d.pageSize && ` · showing ${n(d.page * d.pageSize + 1)}–${n(Math.min(d.total, (d.page + 1) * d.pageSize))}`}</p>
          <DataTable rows={d.subscribers} rowKey={s => s.id} empty={q || status ? 'Nobody matches.' : 'Nobody on this list yet. Import contacts or add people one at a time.'}
            columns={[
              { label: 'Email', render: s => <><strong>{s.email}</strong><div className="muted">{[s.firstName, s.lastName].filter(Boolean).join(' ')}{s.company && ` · ${s.company}`}</div></> },
              { label: 'Status', render: s => s.suppressed ? <Pill cls="bad">Blocked: {s.suppressed}</Pill> : s.status === 'Unsubscribed' ? <><Status s="Unsubscribed" /><div className="muted">{fmtDate(s.unsubscribedAt)} · {s.unsubscribeSource}</div></>
                : s.consentType === 'Implied' && s.impliedUntil < today ? <Pill cls="warn">Consent ended</Pill> : <Status s="Subscribed" /> },
              { label: 'Consent', render: s => <>{s.consentType}{s.consentType === 'Implied' && <span className="muted"> until {fmtDate(s.impliedUntil)}</span>}<div className="muted">{fmtDate(s.consentDate)} · {s.consentSource}</div></> },
              { label: '', render: s => <div className="acts-cell"><button className="btn sm ghost" onClick={() => setEditing(s)}>Edit</button>{s.status === 'Subscribed' && <button className="btn sm ghost" onClick={() => setUnsub(s)}>Unsubscribe</button>}</div> },
            ]} />
          {d.total > d.pageSize && <div className="toolbar" style={{ justifyContent: 'flex-end' }}>
            <button className="btn sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</button>
            <button className="btn sm" disabled={(page + 1) * d.pageSize >= d.total} onClick={() => setPage(p => p + 1)}>Next</button>
          </div>}
        </>
      )}</Loaded>
      {adding && <FormModal title={resub ? 'Resubscribe with new consent' : `Add to ${name}`} onClose={() => setAdding(false)} initial={{ basis: 'express', consentDate: today }}
        note="Only add people who agreed to hear from this business, or who bought from or asked it something recently. Never add bought or rented lists."
        fields={[{ k: 'email', l: 'Email', t: 'email', req: true }, { k: 'firstName', l: 'First name' }, { k: 'lastName', l: 'Last name' }, { k: 'company', l: 'Company' }, ...consentFields,
          ...(resub ? [{ k: 'resubscribe', l: 'Resubscribe', t: 'check' as const, req: true, cl: 'They unsubscribed before and have now given express consent again', full: true }] : [])]}
        onSubmit={async v => {
          try {
            await api.post(`/api/email/lists/${brand}/subscribers`, { email: v.email, firstName: v.firstName ?? '', lastName: v.lastName ?? '', company: v.company ?? '', basis: v.basis, consentDate: v.consentDate, consentSource: v.consentSource, resubscribe: !!v.resubscribe });
          } catch (e) {
            if (e instanceof ApiError && /unsubscribed/.test(e.message) && !resub) { setResub(true); throw new Error(`${e.message} Tick the box below to confirm.`); }
            throw e;
          }
          toast('Added.'); list.reload();
        }} />}
      {editing && <FormModal title="Edit details" size="narrow" onClose={() => setEditing(null)} initial={editing}
        intro={<p style={{ marginTop: 0 }}>{editing.email}. To change an address, add the new one and unsubscribe the old one.</p>}
        fields={[{ k: 'firstName', l: 'First name' }, { k: 'lastName', l: 'Last name' }, { k: 'company', l: 'Company' }, { k: 'phone', l: 'Phone', t: 'tel' }]}
        onSubmit={async v => { await api.patch(`/api/email/subscribers/${editing.id}`, { firstName: v.firstName ?? '', lastName: v.lastName ?? '', company: v.company ?? '', phone: v.phone ?? '', rev: editing.rev }); toast('Saved.'); list.reload(); }} />}
      {unsub && <Confirm title="Unsubscribe" label="Unsubscribe" text={`${unsub.email} will stop receiving ${name} emails. Use this when someone asks by phone, email or in person.`}
        onClose={() => setUnsub(null)} onConfirm={async () => { await api.post(`/api/email/lists/${brand}/subscribers/${unsub.id}/unsubscribe`); toast('Unsubscribed.'); list.reload(); }} />}
      {fromContacts && <Confirm title="Add marketing contacts" label="Add them" text={`Adds marketing contacts tagged ${name} whose email permission is Granted, using the date and evidence recorded on the contact. Nobody who unsubscribed or is blocked is added.`}
        onClose={() => setFromContacts(false)} onConfirm={async () => { const r = await api.post<{ added: number; eligible: number }>(`/api/email/lists/${brand}/from-contacts`); toast(`${r.added} added (${r.eligible} eligible).`); list.reload(); }} />}
    </>
  );
}

/* ---------------- Bulk import ---------------- */
type Problem = { row: number; email: string; message: string };
type Mapped = Record<(typeof IMPORT_COLUMNS)[number], string>;
const COLUMN_LABELS: Record<(typeof IMPORT_COLUMNS)[number], string> = { email: 'Email (required)', firstName: 'First name', lastName: 'Last name', company: 'Company', phone: 'Phone', consentDate: 'Consent date (per person)', consentSource: 'Consent evidence (per person)' };
const MAX_BYTES = 40 * 1024 * 1024;

export function EmailImport({ brand: initialBrand }: { brand?: string }) {
  const { me } = useSession();
  const toast = useToast();
  const brands = EMAIL_BRANDS.filter(b => hasDiv(me, 'marketing') && hasDiv(me, b.id));
  const [brand, setBrand] = useState(initialBrand && brands.some(b => b.id === initialBrand) ? initialBrand : brands[0]?.id ?? '');
  const [file, setFile] = useState(''), [rows, setRows] = useState<string[][]>([]);
  const [map, setMap] = useState<Record<string, number>>({});
  const [basis, setBasis] = useState('express'), [consentDate, setConsentDate] = useState(businessToday()), [source, setSource] = useState(''), [attest, setAttest] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; added: number; existing: number; skipped: number } | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]), [finished, setFinished] = useState(false), [err, setErr] = useState('');
  if (!isAdmin(me)) return <><PageHead title="Import contacts" /><section className="card"><p style={{ margin: 0 }}>Imports are for administrators.</p></section></>;
  const header = rows[0] ?? [], body = rows.slice(1);
  const load = async (f: File) => {
    if (f.size > MAX_BYTES) return toast('This file is over 40 MB. Split it into smaller files.');
    const parsed = parseCsv(await f.text());
    if (parsed.length < 2) return toast('That file has no rows under the header.');
    const guess: Record<string, number> = {};
    parsed[0].forEach((h, i) => { const k = IMPORT_ALIASES[h.trim().toLowerCase()]; if (k && guess[k] === undefined) guess[k] = i; });
    setFile(f.name); setRows(parsed); setMap(guess); setProgress(null); setProblems([]); setFinished(false); setErr('');
  };
  const pick = (r: string[]): Mapped => Object.fromEntries(IMPORT_COLUMNS.map(k => [k, map[k] === undefined ? '' : (r[map[k]] ?? '').trim()])) as Mapped;
  const start = async () => {
    setErr('');
    if (map.email === undefined) return setErr('Choose which column holds the email address.');
    if (source.trim().length < 5) return setErr('Describe where these people gave consent.');
    if (!attest) return setErr('Confirm the consent statement.');
    try {
      const imp = await api.post<{ id: string }>('/api/email/imports', { brand, filename: file, totalRows: body.length, basis, consentDate, consentSource: source.trim(), attest: true });
      const total = Math.ceil(body.length / IMPORT_CHUNK);
      const sum = { done: 0, total, added: 0, existing: 0, skipped: 0 };
      const found: Problem[] = [];
      setProgress({ ...sum });
      for (let i = 0; i < total; i++) {
        const chunk = body.slice(i * IMPORT_CHUNK, (i + 1) * IMPORT_CHUNK).map(pick);
        let res: { added: number; existing: number; skipped: number; errors: Problem[] } | null = null;
        // Each chunk can be safely retried: the server ignores a chunk it has already applied.
        for (let attempt = 0; attempt < 4 && !res; attempt++) {
          try { res = await api.post(`/api/email/imports/${imp.id}/chunks`, { index: i, rows: chunk }); }
          catch (e) { if (attempt === 3 || (e instanceof ApiError && e.status < 500)) throw e; await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); }
        }
        sum.done++; sum.added += res!.added; sum.existing += res!.existing; sum.skipped += res!.skipped;
        if (found.length < 1000) found.push(...res!.errors);
        setProgress({ ...sum }); setProblems([...found]);
      }
      await api.post(`/api/email/imports/${imp.id}/complete`);
      setFinished(true); toast('Import finished.');
    } catch (e) { setErr((e as Error).message); }
  };
  const busy = !!progress && !finished && !err;
  return (
    <>
      <PageHead title="Import contacts" crumb={<a href={href('email')}>Email lists</a>} sub="Bring in contacts from Sender, HubSpot or a spreadsheet. Large files are sent in batches of 500; people already on the list are left as they are." />
      <section className="card"><h3>1. Choose the business and the file</h3>
        <div className="toolbar">
          <select aria-label="Business" value={brand} disabled={busy} onChange={e => setBrand(e.target.value)}>{brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          <label className="btn" style={{ cursor: 'pointer' }}>Choose CSV file<input type="file" accept=".csv,text/csv" className="sr" disabled={busy} onChange={async e => { const f = e.target.files?.[0]; if (f) await load(f); e.target.value = ''; }} /></label>
          {file && <span className="muted">{file} · {n(body.length)} rows</span>}
        </div>
        <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>In Sender: Subscribers › Export. In HubSpot: Contacts › Export, CSV. Export only people who are subscribed; leave out unsubscribed, bounced and spam-complaint contacts.</p>
      </section>
      {rows.length > 1 && (
        <section className="card"><h3>2. Match the columns</h3>
          <div className="fgrid">{IMPORT_COLUMNS.map(k => (
            <div className="field" key={k}><label htmlFor={`map-${k}`}>{COLUMN_LABELS[k]}</label>
              <select id={`map-${k}`} value={map[k] ?? ''} disabled={busy} onChange={e => setMap(m => { const x = { ...m }; if (e.target.value === '') delete x[k]; else x[k] = Number(e.target.value); return x; })}>
                <option value="">Not in this file</option>{header.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
              </select></div>
          ))}</div>
          <div className="tblwrap" style={{ marginTop: 10 }}><table><thead><tr>{IMPORT_COLUMNS.filter(k => map[k] !== undefined).map(k => <th key={k}>{COLUMN_LABELS[k].replace(/ \(.*\)/, '')}</th>)}</tr></thead>
            <tbody>{body.slice(0, 5).map((r, i) => { const p = pick(r); return <tr key={i}>{IMPORT_COLUMNS.filter(k => map[k] !== undefined).map(k => <td key={k}>{p[k]}</td>)}</tr>; })}</tbody></table></div>
          <p className="muted" style={{ fontSize: 12 }}>First 5 rows shown.</p>
        </section>
      )}
      {rows.length > 1 && (
        <section className="card"><h3>3. Record the consent</h3>
          <div className="fgrid">
            <div className="field full"><label htmlFor="basis">How these people agreed to hear from {emailBrandName(brand)}</label>
              <select id="basis" value={basis} disabled={busy} onChange={e => setBasis(e.target.value)}>{CONSENT_BASES.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}</select>
              <small>Implied consent stops allowing email after its period. Ask those people to opt in before it ends.</small></div>
            <div className="field"><label htmlFor="cdate">Consent date</label><input id="cdate" type="date" value={consentDate} max={businessToday()} disabled={busy} onChange={e => setConsentDate(e.target.value)} />
              <small>Used for rows without their own consent date.</small></div>
            <div className="field"><label htmlFor="csrc">Where they gave consent</label><input id="csrc" value={source} disabled={busy} placeholder="e.g. Sender list: Law Girl newsletter sign-ups" onChange={e => setSource(e.target.value)} /></div>
            <div className="field full"><label className="chk"><input type="checkbox" checked={attest} disabled={busy} onChange={e => setAttest(e.target.checked)} /> I confirm everyone in this file agreed to receive email from {emailBrandName(brand)} (or bought from or asked it something within the period above), and this isn’t a bought, rented or scraped list.</label></div>
          </div>
          {err && <p className="err" role="alert">{err}</p>}
          <div className="form-actions">
            {finished ? <button className="btn primary" onClick={() => go(`email-list/${brand}`)}>Open the list</button>
              : <button className="btn primary" disabled={busy} onClick={start}>{busy ? 'Importing…' : `Import ${n(body.length)} rows`}</button>}
          </div>
        </section>
      )}
      {progress && (
        <section className="card"><h3>{finished ? 'Import finished' : 'Importing…'}</h3>
          <div style={{ height: 10, background: 'var(--soft)', borderRadius: 99, overflow: 'hidden' }}><div style={{ width: `${(progress.done / progress.total) * 100}%`, height: '100%', background: 'var(--pink)', transition: 'width .3s' }} /></div>
          <div className="tiles" style={{ marginTop: 12 }}>
            <div className="tile"><div className="k">Added</div><div className="v small">{n(progress.added)}</div></div>
            <div className="tile"><div className="k">Already on the list</div><div className="v small">{n(progress.existing)}</div></div>
            <div className="tile"><div className="k">Skipped</div><div className="v small">{n(progress.skipped)}</div></div>
          </div>
          {problems.length > 0 && <DataTable rows={problems.slice(0, 200)} rowKey={p => `${p.row}-${p.email}`} empty="" columns={[{ label: 'Row', num: true, render: p => p.row }, { label: 'Email', render: p => p.email || '—' }, { label: 'Why it was skipped', render: p => p.message }]} />}
          {problems.length > 200 && <p className="muted">Showing the first 200 skipped rows.</p>}
        </section>
      )}
    </>
  );
}
