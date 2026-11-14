import { useState } from 'react';
import { BILLING_CYCLES, BRANDS, CURRENCIES, PROGRAM_STATUSES, PROGRAM_VISIBILITY } from '../../shared/constants';
import { api } from '../api';
import { businessToday, fmtDate, money } from '../format';
import { hasDiv, isAdmin, memberOptions, useSession } from '../session';
import { DataTable, Ext, FormModal, Loaded, PageHead, Pill, Status, useLoad, useToast } from '../ui';

type Program = {
  id: string; provider: string; purpose: string; website: string; signInUrl: string; brand: string; accountOwnerId: string | null; accountOwnerName: string | null; accountLogin: string;
  usersRoles: string; vaultLink: string; accessNotes: string; support: string; billingCycle: string; currency: string; amountCents: number; renewalDate: string; status: string;
  visibility: string; notes: string; createdBy: string; rev: number;
};

export function Programs() {
  const { me, members } = useSession();
  const toast = useToast();
  const list = useLoad(() => api.get<{ programs: Program[] }>('/api/marketing/programs'), []);
  const [editing, setEditing] = useState<Program | 'new' | null>(null);
  const today = businessToday(), soon = new Date(Date.parse(today) + 30 * 86400000).toISOString().slice(0, 10);
  const visOpts = PROGRAM_VISIBILITY.filter(([v]) => v === 'general' || (v === 'firm' && hasDiv(me, 'jdco')) || (v === 'admin' && isAdmin(me))).map(x => [...x] as [string, string]);
  return (
    <>
      <PageHead title="Marketing programs" sub="The software and services each brand uses, who owns the account, and when it renews."
        actions={<button className="btn primary" onClick={() => setEditing('new')}>Add program</button>} />
      <p className="warnbox">Never store passwords, MFA or recovery codes, or API keys here. Keep them in the password manager and add its link.</p>
      <Loaded state={list}>{d => (
        <DataTable rows={d.programs} rowKey={p => p.id} empty="No programs yet."
          search={{ placeholder: 'Search programs', text: p => [p.provider, p.purpose, p.brand, p.accountOwnerName, p.usersRoles, p.notes].join(' ') }}
          columns={[
            { label: 'Program', render: p => <><strong>{p.provider}</strong><div className="muted">{p.purpose}</div></> },
            { label: 'Brand', render: p => p.brand || '—' }, { label: 'Account owner', render: p => <>{p.accountOwnerName ?? '—'}{p.accountLogin && <div className="muted">{p.accountLogin}</div>}</> },
            { label: 'Billing', render: p => p.billingCycle ? <>{p.billingCycle}{p.amountCents > 0 && <div className="muted">{money(p.amountCents, p.currency)} (reference)</div>}</> : '—' },
            { label: 'Renews', render: p => p.renewalDate ? <span style={p.renewalDate <= soon && ['Active', 'Trial'].includes(p.status) ? { color: p.renewalDate < today ? 'var(--bad)' : 'var(--warn)', fontWeight: 600 } : undefined}>{fmtDate(p.renewalDate)}</span> : '—' },
            { label: 'Status', render: p => <><Status s={p.status} />{p.visibility !== 'general' && <div><Pill cls="pink">{p.visibility === 'firm' ? 'JD&Co only' : 'Admins only'}</Pill></div>}</> },
            { label: '', render: p => <div className="acts-cell">{p.signInUrl && <Ext href={p.signInUrl}>Sign in</Ext>}{p.vaultLink && <Ext href={p.vaultLink}>Vault</Ext>}{(p.createdBy === me.id || isAdmin(me)) && <button className="btn sm" onClick={() => setEditing(p)}>Edit</button>}</div> },
          ]} />
      )}</Loaded>
      {editing && <FormModal title={editing === 'new' ? 'Add marketing program' : 'Edit program'} onClose={() => setEditing(null)}
        initial={editing === 'new' ? { status: 'Active', visibility: 'general', currency: 'CAD', accountOwnerId: me.id } : editing}
        fields={[
          { k: 'provider', l: 'Program or provider', req: true }, { k: 'brand', l: 'Business using it', t: 'select', o: BRANDS }, { k: 'purpose', l: 'Purpose', full: true },
          { k: 'website', l: 'Website', t: 'url' }, { k: 'signInUrl', l: 'Sign-in page', t: 'url' },
          { k: 'h1', l: 'Account and access', t: 'h' },
          { k: 'accountOwnerId', l: 'Account owner', t: 'select', o: memberOptions(members) }, { k: 'accountLogin', l: 'Account email or username', help: 'Never the password.' },
          { k: 'usersRoles', l: 'Users and roles', t: 'textarea' }, { k: 'vaultLink', l: 'Password manager link', t: 'url' },
          { k: 'accessNotes', l: 'Access instructions', t: 'textarea' }, { k: 'support', l: 'Support contacts', t: 'textarea' },
          { k: 'h2', l: 'Billing', t: 'h' },
          { k: 'billingCycle', l: 'Billing cycle', t: 'select', o: BILLING_CYCLES }, { k: 'currency', l: 'Currency', t: 'select', blank: false, o: CURRENCIES },
          { k: 'amountCents', l: 'Subscription amount (reference)', t: 'money', help: 'Not posted as an expense. Record actual charges in Marketing expenses.' }, { k: 'renewalDate', l: 'Renewal date', t: 'date' },
          { k: 'status', l: 'Status', t: 'select', blank: false, o: PROGRAM_STATUSES }, { k: 'visibility', l: 'Who can see it', t: 'select', blank: false, o: visOpts },
          { k: 'notes', l: 'Notes', t: 'textarea' },
        ]}
        onSubmit={async v => {
          const payload = {
            provider: v.provider, purpose: v.purpose ?? '', website: v.website ?? '', signInUrl: v.signInUrl ?? '', brand: v.brand ?? '', accountOwnerId: v.accountOwnerId || null,
            accountLogin: v.accountLogin ?? '', usersRoles: v.usersRoles ?? '', vaultLink: v.vaultLink ?? '', accessNotes: v.accessNotes ?? '', support: v.support ?? '',
            billingCycle: v.billingCycle ?? '', currency: v.currency, amountCents: v.amountCents ?? 0, renewalDate: v.renewalDate ?? '', status: v.status, visibility: v.visibility, notes: v.notes ?? '',
          };
          if (editing === 'new') await api.post('/api/marketing/programs', payload); else await api.patch(`/api/marketing/programs/${editing.id}`, { ...payload, rev: editing.rev });
          toast('Program saved.'); list.reload();
        }} />}
    </>
  );
}
