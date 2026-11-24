import { useEffect, useState } from 'react';
import { CURRENCIES } from '../../shared/constants';
import { api } from '../api';
import { fmtDate, money } from '../format';
import { go, href } from '../router';
import { copyText, DataTable, DefList, Ext, FormModal, Loaded, PageHead, Status, useLoad, useToast, type Field, type Values } from '../ui';

type Property = {
  id: string; name: string; address: string; ownership: string; currency: string;
  purchaseDate: string; purchasePriceCents: number | null; soldDate: string; soldPriceCents: number | null;
  pmName: string; pmAddress: string; pmEmail: string; pmPhone: string; craBusinessNumber: string;
  mortgageCompany: string; loanNumber: string; insurer: string; policyNumber: string;
  status: string; notes: string; rev: number; currentTenants?: number; activeProviders?: number;
};
type Tenant = {
  id: string; name: string; unit: string; email: string; phone: string; emergencyContact: string; leaseStart: string; leaseEnd: string;
  rentCents: number | null; rentFrequency: string; rentDueDay: string; depositCents: number | null; leaseLink: string; leaseNotes: string; status: string; rev: number;
};
type Provider = {
  id: string; name: string; company: string; services: string; address: string; phone: string; email: string; accountNumber: string; login: string;
  hasPassword: boolean; notes: string; status: string; rev: number;
};

const amount = (c: number | null, cur: string) => (c === null || c === undefined ? '' : money(c, cur));
const mail = (e: string) => (e ? <a href={`mailto:${e}`}>{e}</a> : '');
const tel = (p: string) => (p ? <a href={`tel:${p.replace(/[^\d+]/g, '')}`}>{p}</a> : '');

const PROPERTY_FIELDS: Field[] = [
  { k: 'h1', l: 'Property', t: 'h' },
  { k: 'name', l: 'Property name', req: true, help: 'A short name, e.g. "Queen St duplex".' }, { k: 'status', l: 'Status', t: 'select', blank: false, o: ['Active', 'Sold', 'Archived'] },
  { k: 'address', l: 'Address', req: true, full: true },
  { k: 'ownership', l: 'Ownership', full: true, help: 'Who holds title, e.g. "JD Holdings Inc. (100%)" or "Jasmine Daya and spouse, joint tenants".' },
  { k: 'h2', l: 'Purchase and sale', t: 'h' },
  { k: 'currency', l: 'Currency', t: 'select', blank: false, o: CURRENCIES },
  { k: 'purchaseDate', l: 'Purchase date', t: 'date' }, { k: 'purchasePriceCents', l: 'Purchase price', t: 'money', nullable: true },
  { k: 'soldDate', l: 'Sold date', t: 'date' }, { k: 'soldPriceCents', l: 'Sold price', t: 'money', nullable: true },
  { k: 'h3', l: 'Property manager', t: 'h' },
  { k: 'pmName', l: 'Name' }, { k: 'pmPhone', l: 'Phone', t: 'tel' }, { k: 'pmEmail', l: 'Email', t: 'email' }, { k: 'pmAddress', l: 'Address', full: true },
  { k: 'h4', l: 'Tax, mortgage and insurance', t: 'h' },
  { k: 'craBusinessNumber', l: 'CRA business number', help: '9 digits, optionally with the program account, e.g. 123456789 RT0001.' },
  { k: 'mortgageCompany', l: 'Mortgage company' }, { k: 'loanNumber', l: 'Loan number' },
  { k: 'insurer', l: 'Insurer' }, { k: 'policyNumber', l: 'Policy number' },
  { k: 'notes', l: 'Notes', t: 'textarea' },
];

/** Money boxes here are optional; an empty box is sent as null ("not recorded"), not $0.00. */
const moneyPayload = (fields: Field[], v: Values) => Object.fromEntries(fields.filter(f => f.t === 'money').map(f => [f.k, v[f.k] ?? null]));

function PropertyForm({ editing, onClose, onSaved }: { editing: Property | 'new'; onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useToast();
  const initial: Values = editing === 'new' ? { status: 'Active', currency: 'CAD' } : editing;
  return (
    <FormModal title={editing === 'new' ? 'Add property' : 'Edit property'} onClose={onClose} initial={initial} fields={PROPERTY_FIELDS}
      onSubmit={async v => {
        const payload = {
          name: v.name, address: v.address, ownership: v.ownership ?? '', currency: v.currency, status: v.status,
          purchaseDate: v.purchaseDate ?? '', soldDate: v.soldDate ?? '',
          ...moneyPayload(PROPERTY_FIELDS, v),
          pmName: v.pmName ?? '', pmAddress: v.pmAddress ?? '', pmEmail: v.pmEmail ?? '', pmPhone: v.pmPhone ?? '',
          craBusinessNumber: v.craBusinessNumber ?? '', mortgageCompany: v.mortgageCompany ?? '', loanNumber: v.loanNumber ?? '',
          insurer: v.insurer ?? '', policyNumber: v.policyNumber ?? '', notes: v.notes ?? '',
        };
        if (editing === 'new') { const r = await api.post<{ id: string }>('/api/properties', payload); toast('Property added.'); onSaved(r.id); }
        else { await api.patch(`/api/properties/${editing.id}`, { ...payload, rev: editing.rev }); toast('Property saved.'); onSaved(editing.id); }
      }} />
  );
}

export function Properties() {
  const list = useLoad(() => api.get<{ properties: Property[] }>('/api/properties'), []);
  const [adding, setAdding] = useState(false);
  const [showAll, setShowAll] = useState(false);
  return (
    <>
      <PageHead title="Properties" sub="Each property with its ownership, purchase and sale, manager, mortgage and insurance, plus its tenants and service providers. Only people Jasmine gives Properties access can see this."
        actions={<button className="btn primary" onClick={() => setAdding(true)}>Add property</button>} />
      <Loaded state={list}>{d => {
        const rows = d.properties.filter(p => showAll || p.status === 'Active');
        return (
          <>
            <label className="chk" style={{ marginBottom: 10 }}><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> Show sold and archived</label>
            <DataTable rows={rows} rowKey={p => p.id} empty="No properties yet. Select Add property to create the first one."
              search={{ placeholder: 'Search name, address, owner, manager', text: p => [p.name, p.address, p.ownership, p.pmName, p.mortgageCompany, p.insurer].join(' ') }}
              columns={[
                { label: 'Property', render: p => <><a href={href(`property/${p.id}`)}><strong>{p.name}</strong></a><div className="muted">{p.address}</div></> },
                { label: 'Ownership', render: p => p.ownership || '—' },
                { label: 'Purchased', render: p => p.purchaseDate ? <>{fmtDate(p.purchaseDate)}<div className="muted">{amount(p.purchasePriceCents, p.currency)}</div></> : '—' },
                { label: 'Manager', render: p => p.pmName || '—' },
                { label: 'Tenants', num: true, render: p => p.currentTenants ?? 0 },
                { label: 'Providers', num: true, render: p => p.activeProviders ?? 0 },
                { label: 'Status', render: p => <Status s={p.status} /> },
              ]} />
          </>
        );
      }}</Loaded>
      {adding && <PropertyForm editing="new" onClose={() => setAdding(false)} onSaved={id => go(`property/${id}`)} />}
    </>
  );
}

const TENANT_FIELDS: Field[] = [
  { k: 'h1', l: 'Tenant', t: 'h' },
  { k: 'name', l: 'Tenant name', req: true }, { k: 'unit', l: 'Unit' },
  { k: 'email', l: 'Email', t: 'email' }, { k: 'phone', l: 'Phone', t: 'tel' },
  { k: 'emergencyContact', l: 'Emergency contact', full: true, help: 'Name and phone number.' },
  { k: 'h2', l: 'Lease', t: 'h' },
  { k: 'leaseStart', l: 'Lease start', t: 'date' }, { k: 'leaseEnd', l: 'Lease end', t: 'date', help: 'Leave empty for month-to-month.' },
  { k: 'rentCents', l: 'Rent', t: 'money', nullable: true }, { k: 'rentFrequency', l: 'Rent is paid', t: 'select', blank: false, o: ['Monthly', 'Weekly', 'Bi-weekly', 'Yearly'] },
  { k: 'rentDueDay', l: 'Rent due', help: 'e.g. "1st of the month".' }, { k: 'depositCents', l: 'Deposit held', t: 'money', nullable: true },
  { k: 'leaseLink', l: 'Signed lease (Box link)', t: 'url', full: true, help: 'Paste the Box link to the signed lease, starting https://' },
  { k: 'leaseNotes', l: 'Lease details and notes', t: 'textarea' },
  { k: 'status', l: 'Status', t: 'select', blank: false, o: ['Current', 'Former'] },
];

const PROVIDER_FIELDS = (existing: boolean): Field[] => [
  { k: 'h1', l: 'Service provider', t: 'h' },
  { k: 'name', l: 'Contact name', req: true }, { k: 'company', l: 'Company' },
  { k: 'services', l: 'Services', full: true, help: 'e.g. "Snow removal and lawn care", "Hydro", "Property tax".' },
  { k: 'phone', l: 'Phone', t: 'tel' }, { k: 'email', l: 'Email', t: 'email' },
  { k: 'address', l: 'Address', full: true },
  { k: 'h2', l: 'Account', t: 'h' },
  { k: 'accountNumber', l: 'Account number' }, { k: 'login', l: 'Login (username or email)' },
  { k: 'password', l: existing ? 'New password' : 'Password', t: 'password', help: existing ? 'Leave empty to keep the stored password.' : 'Stored encrypted. Viewing it later is recorded in the activity log.' },
  ...(existing ? [{ k: 'clearPassword', l: 'Stored password', t: 'check', cl: 'Remove the stored password' } as Field] : []),
  { k: 'notes', l: 'Notes', t: 'textarea' },
  { k: 'status', l: 'Status', t: 'select', blank: false, o: ['Active', 'Former'] },
];

function PasswordCell({ propertyId, p }: { propertyId: string; p: Provider }) {
  const toast = useToast();
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => { if (shown === null) return; const t = setTimeout(() => setShown(null), 30_000); return () => clearTimeout(t); }, [shown]);
  if (!p.hasPassword) return <span className="muted">—</span>;
  const reveal = async () => {
    try { setShown((await api.post<{ password: string }>(`/api/properties/${propertyId}/providers/${p.id}/password`, {})).password); }
    catch (e) { toast((e as Error).message); }
  };
  return shown === null
    ? <button className="btn sm" onClick={reveal}>Show</button>
    : <span className="pw"><code>{shown}</code> <button className="btn sm" onClick={() => copyText(shown, toast)}>Copy</button> <button className="btn sm ghost" onClick={() => setShown(null)}>Hide</button></span>;
}

export function PropertyDetail({ id }: { id: string }) {
  const toast = useToast();
  const data = useLoad(() => api.get<{ property: Property; tenants: Tenant[]; providers: Provider[] }>(`/api/properties/${id}`), [id]);
  const [editing, setEditing] = useState(false);
  const [tenant, setTenant] = useState<Tenant | 'new' | null>(null);
  const [provider, setProvider] = useState<Provider | 'new' | null>(null);
  const [showFormer, setShowFormer] = useState(false);
  return (
    <Loaded state={data}>{({ property: p, tenants, providers }) => (
      <>
        <PageHead title={p.name} sub={p.address} crumb={<a href={href('properties')}>← Properties</a>}
          actions={<button className="btn" onClick={() => setEditing(true)}>Edit property</button>} />

        <section className="card">
          <h3>Details <Status s={p.status} /></h3>
          <DefList items={[
            ['Ownership', p.ownership],
            ['Purchased', p.purchaseDate ? `${fmtDate(p.purchaseDate)}${p.purchasePriceCents !== null ? ' for ' + amount(p.purchasePriceCents, p.currency) : ''}` : amount(p.purchasePriceCents, p.currency)],
            ['Sold', p.soldDate ? `${fmtDate(p.soldDate)}${p.soldPriceCents !== null ? ' for ' + amount(p.soldPriceCents, p.currency) : ''}` : amount(p.soldPriceCents, p.currency)],
            ['CRA business number', p.craBusinessNumber],
            ['Mortgage company', p.mortgageCompany], ['Loan number', p.loanNumber],
            ['Insurer', p.insurer], ['Policy number', p.policyNumber],
          ]} />
          <h4 style={{ margin: '16px 0 6px' }}>Property manager</h4>
          <DefList items={[['Name', p.pmName], ['Phone', tel(p.pmPhone)], ['Email', mail(p.pmEmail)], ['Address', p.pmAddress]]} />
          {p.notes && <><h4 style={{ margin: '16px 0 6px' }}>Notes</h4><p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{p.notes}</p></>}
        </section>

        <label className="chk" style={{ margin: '4px 0 10px' }}><input type="checkbox" checked={showFormer} onChange={e => setShowFormer(e.target.checked)} /> Show former tenants and providers</label>

        <section className="card">
          <h3>Tenants <button className="btn sm primary" onClick={() => setTenant('new')}>Add tenant</button></h3>
          <DataTable rows={tenants.filter(t => showFormer || t.status === 'Current')} rowKey={t => t.id} empty="No tenants recorded for this property."
            columns={[
              { label: 'Tenant', render: t => <><strong>{t.name}</strong>{t.unit && <div className="muted">Unit {t.unit}</div>}</> },
              { label: 'Contact', render: t => <>{mail(t.email) || '—'}<div className="muted">{tel(t.phone)}</div></> },
              { label: 'Lease', render: t => t.leaseStart || t.leaseEnd ? <>{fmtDate(t.leaseStart)} – {t.leaseEnd ? fmtDate(t.leaseEnd) : 'month-to-month'}</> : '—' },
              { label: 'Rent', render: t => t.rentCents !== null ? <>{amount(t.rentCents, p.currency)}<div className="muted">{t.rentFrequency}{t.rentDueDay ? `, due ${t.rentDueDay}` : ''}</div></> : '—' },
              { label: 'Deposit', render: t => amount(t.depositCents, p.currency) || '—' },
              { label: 'Lease file', render: t => <Ext href={t.leaseLink} /> },
              { label: 'Status', render: t => <Status s={t.status} /> },
              { label: '', render: t => <div className="acts-cell"><button className="btn sm" onClick={() => setTenant(t)}>Edit</button></div> },
            ]} />
        </section>

        <section className="card">
          <h3>Service providers <button className="btn sm primary" onClick={() => setProvider('new')}>Add provider</button></h3>
          <DataTable rows={providers.filter(s => showFormer || s.status === 'Active')} rowKey={s => s.id} empty="No service providers recorded for this property."
            columns={[
              { label: 'Provider', render: s => <><strong>{s.company || s.name}</strong>{s.company && <div className="muted">{s.name}</div>}</> },
              { label: 'Services', render: s => s.services || '—' },
              { label: 'Contact', render: s => <>{tel(s.phone) || '—'}<div className="muted">{mail(s.email)}</div></> },
              { label: 'Account', render: s => s.accountNumber || '—' },
              { label: 'Login', render: s => s.login || '—' },
              { label: 'Password', render: s => <PasswordCell propertyId={p.id} p={s} /> },
              { label: '', render: s => <div className="acts-cell"><button className="btn sm" onClick={() => setProvider(s)}>Edit</button></div> },
            ]} />
        </section>

        {editing && <PropertyForm editing={p} onClose={() => setEditing(false)} onSaved={() => data.reload()} />}

        {tenant && <FormModal title={tenant === 'new' ? 'Add tenant' : 'Edit tenant'} onClose={() => setTenant(null)}
          initial={tenant === 'new' ? { status: 'Current', rentFrequency: 'Monthly' } : tenant} fields={TENANT_FIELDS}
          onSubmit={async v => {
            const payload = {
              name: v.name, unit: v.unit ?? '', email: v.email ?? '', phone: v.phone ?? '', emergencyContact: v.emergencyContact ?? '',
              leaseStart: v.leaseStart ?? '', leaseEnd: v.leaseEnd ?? '', ...moneyPayload(TENANT_FIELDS, v),
              rentFrequency: v.rentFrequency, rentDueDay: v.rentDueDay ?? '', leaseLink: v.leaseLink ?? '', leaseNotes: v.leaseNotes ?? '', status: v.status,
            };
            if (tenant === 'new') await api.post(`/api/properties/${p.id}/tenants`, payload);
            else await api.patch(`/api/properties/${p.id}/tenants/${tenant.id}`, { ...payload, rev: tenant.rev });
            toast('Tenant saved.'); data.reload();
          }} />}

        {provider && <FormModal title={provider === 'new' ? 'Add service provider' : 'Edit service provider'} onClose={() => setProvider(null)}
          initial={provider === 'new' ? { status: 'Active' } : { ...provider, password: '' }} fields={PROVIDER_FIELDS(provider !== 'new' && provider.hasPassword)}
          onSubmit={async v => {
            const payload: Values = {
              name: v.name, company: v.company ?? '', services: v.services ?? '', address: v.address ?? '', phone: v.phone ?? '', email: v.email ?? '',
              accountNumber: v.accountNumber ?? '', login: v.login ?? '', notes: v.notes ?? '', status: v.status,
            };
            if (v.clearPassword) payload.clearPassword = true; else if (v.password) payload.password = v.password;
            if (provider === 'new') await api.post(`/api/properties/${p.id}/providers`, payload);
            else await api.patch(`/api/properties/${p.id}/providers/${provider.id}`, { ...payload, rev: provider.rev });
            toast('Service provider saved.'); data.reload();
          }} />}
      </>
    )}</Loaded>
  );
}
