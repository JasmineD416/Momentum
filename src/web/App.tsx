import { useEffect, useState, type ReactNode } from 'react';
import { DIVISIONS, FOLDERS } from '../shared/constants';
import { api, ApiError, devUser } from './api';
import { href, useRoute } from './router';
import { hasDiv, isAdmin, SessionCtx, type Me, type MemberLite } from './session';
import { FormModal, PageHead, ToastProvider, useLoad, useToast } from './ui';
import { Overview } from './pages/Overview';
import { Clients, ClientDetail } from './pages/Clients';
import { Checklist } from './pages/Checklist';
import { Pncs, PncDetail } from './pages/Pncs';
import { Counsel } from './pages/Counsel';
import { ClientExpenses } from './pages/Expenses';
import { DivisionContacts } from './pages/Contacts';
import { Folder } from './pages/Folder';
import { Imports } from './pages/Imports';
import { People } from './pages/People';
import { Announcements } from './pages/Announcements';
import { AttentionCentre } from './pages/Attention';
import { ExpenseClaims } from './pages/Claims';
import { TeamCalendar } from './pages/Calendar';
import { CampaignDetail, Campaigns } from './pages/Campaigns';
import { Companies, FollowUps, MarketingContactDetail, MarketingContacts } from './pages/Marketing';
import { MarketingExpenses } from './pages/MarketingExpenses';
import { EmailHome, EmailImport, EmailList } from './pages/Email';
import { MailingDetail, Mailings } from './pages/Mailings';
import { Opportunities } from './pages/Opportunities';
import { Programs } from './pages/Programs';
import { Properties, PropertyDetail } from './pages/Properties';
import { TeamWorkspace } from './pages/Team';
import { StaffUpdates } from './pages/Updates';

type NavItem = { path: string; label: string } | { heading: string };
type NavGroup = { title: string; division?: string; admin?: boolean; items: NavItem[] };

const NAV: NavGroup[] = [
  { title: 'Team', items: [{ path: 'overview', label: 'Overview' }, { path: 'announcements', label: 'Announcements' }, { path: 'attention', label: 'Attention centre' }, { path: 'team', label: 'Team workspace' }, { path: 'calendar', label: 'Team calendar' }, { path: 'updates', label: 'Staff updates' }, { path: 'claims', label: 'Expense claims' }] },
  { title: 'JD&Co Law Firm', division: 'jdco', items: [{ path: 'contacts/jdco', label: 'Contacts' }, { path: 'clients', label: 'Client directory' }, { path: 'pncs', label: 'PNC tracker' }, { path: 'counsel', label: 'Lawyer directory' }, { path: 'expenses', label: 'Client expenses' }] },
  { title: 'Marketing', division: 'marketing', items: [
    { heading: 'Relationships' }, { path: 'mk-contacts', label: 'Marketing contacts' }, { path: 'companies', label: 'Company directory' }, { path: 'opportunities', label: 'Opportunities' }, { path: 'follow-ups', label: 'Follow-ups' },
    { heading: 'Planning and spend' }, { path: 'campaigns', label: 'Campaigns and results' }, { path: 'programs', label: 'Marketing programs' }, { path: 'mk-expenses', label: 'Marketing expenses' },
    { heading: 'Email' }, { path: 'email', label: 'Email lists' }, { path: 'mailings', label: 'Mailings' },
  ] },
  ...DIVISIONS.filter(d => d.id !== 'jdco' && d.id !== 'marketing' && d.id !== 'properties').map(d => ({
    title: d.name, division: d.id,
    items: [{ path: `contacts/${d.id}`, label: 'Contacts' }, ...FOLDERS.filter(f => f.division === d.id).map(f => ({ path: `folder/${f.id}`, label: f.name }))],
  })),
  { title: 'Properties', division: 'properties', items: [{ path: 'properties', label: 'Properties' }, { path: 'contacts/properties', label: 'Contacts' }] },
  { title: 'Administration', admin: true, items: [{ path: 'imports', label: 'Import records' }, { path: 'people', label: 'People and access' }] },
];

// Brand imagery shown as a banner across matching pages.
const HERO: Record<string, string> = { calendar: 'calendar', 'mk-expenses': 'marketing-expenses', campaigns: 'loops', overview: 'city', clients: 'client-archive', client: 'client-archive', expenses: 'client-expenses', contacts: 'loops', folder: 'office', people: 'office' };

const Denied = ({ admin }: { admin?: boolean }) => (
  <><PageHead title="Access denied" /><section className="card"><p style={{ margin: 0 }}>{admin ? 'This area is for administrators.' : 'This area needs access to a division you don’t have. Jasmine grants division access in People and access.'}</p></section></>
);

const MARKETING_PAGES = ['mk-contacts', 'mk-contact', 'companies', 'opportunities', 'follow-ups', 'campaigns', 'campaign', 'programs', 'mk-expenses', 'email', 'email-list', 'email-import', 'mailings', 'mailing'];

/** Screens mirror the server's rules so people never see a page they can't use (the server still checks every request). */
function allowed(me: Me, p: string, id: string) {
  if (['clients', 'client', 'checklist', 'pncs', 'pnc', 'counsel', 'expenses'].includes(p)) return hasDiv(me, 'jdco');
  if (MARKETING_PAGES.includes(p)) return hasDiv(me, 'marketing');
  if (p === 'properties' || p === 'property') return hasDiv(me, 'properties');
  if (p === 'contacts') return hasDiv(me, id);
  if (p === 'folder') { const f = FOLDERS.find(x => x.id === id); return !f?.division || hasDiv(me, f.division); }
  if (p === 'imports' || p === 'people') return isAdmin(me);
  return true;
}

function route(me: Me, parts: string[]): { active: string; page: ReactNode } {
  const [p = 'overview', id = ''] = parts;
  if (!allowed(me, p, id)) return { active: '', page: <Denied admin={p === 'imports' || p === 'people'} /> };
  switch (p) {
    case 'clients': return { active: 'clients', page: <Clients /> };
    case 'client': return { active: 'clients', page: <ClientDetail id={id} /> };
    case 'checklist': return { active: 'clients', page: <Checklist matterId={id} /> };
    case 'pncs': return { active: 'pncs', page: <Pncs /> };
    case 'pnc': return { active: 'pncs', page: <PncDetail id={id} /> };
    case 'counsel': return { active: 'counsel', page: <Counsel /> };
    case 'expenses': return { active: 'expenses', page: <ClientExpenses /> };
    case 'contacts': return { active: `contacts/${id}`, page: <DivisionContacts key={id} division={id} /> };
    case 'folder': return { active: `folder/${id}`, page: <Folder key={id} folderId={id} /> };
    case 'attention': return { active: 'attention', page: <AttentionCentre /> };
    case 'announcements': return { active: 'announcements', page: <Announcements /> };
    case 'claims': return { active: 'claims', page: <ExpenseClaims /> };
    case 'team': return { active: 'team', page: <TeamWorkspace /> };
    case 'calendar': return { active: 'calendar', page: <TeamCalendar /> };
    case 'updates': return { active: 'updates', page: <StaffUpdates /> };
    case 'mk-contacts': return { active: 'mk-contacts', page: <MarketingContacts /> };
    case 'mk-contact': return { active: 'mk-contacts', page: <MarketingContactDetail key={id} id={id} /> };
    case 'companies': return { active: 'companies', page: <Companies /> };
    case 'opportunities': return { active: 'opportunities', page: <Opportunities /> };
    case 'follow-ups': return { active: 'follow-ups', page: <FollowUps /> };
    case 'campaigns': return { active: 'campaigns', page: <Campaigns /> };
    case 'campaign': return { active: 'campaigns', page: <CampaignDetail key={id} id={id} /> };
    case 'programs': return { active: 'programs', page: <Programs /> };
    case 'mk-expenses': return { active: 'mk-expenses', page: <MarketingExpenses /> };
    case 'email': return { active: 'email', page: <EmailHome /> };
    case 'email-list': return { active: 'email', page: <EmailList key={id} brand={id} /> };
    case 'email-import': return { active: 'email', page: <EmailImport key={id} brand={id || undefined} /> };
    case 'mailings': return { active: 'mailings', page: <Mailings /> };
    case 'mailing': return { active: 'mailings', page: <MailingDetail key={id} id={id} /> };
    case 'properties': return { active: 'properties', page: <Properties /> };
    case 'property': return { active: 'properties', page: <PropertyDetail key={id} id={id} /> };
    case 'imports': return { active: 'imports', page: <Imports /> };
    case 'people': return { active: 'people', page: <People /> };
    default: return { active: 'overview', page: <Overview /> };
  }
}

function Shell({ me, members }: { me: Me; members: MemberLite[] }) {
  const parts = useRoute();
  const { active, page } = route(me, parts);
  const [menuOpen, setMenuOpen] = useState(false);
  const [profile, setProfile] = useState(false);
  const toast = useToast();
  useEffect(() => setMenuOpen(false), [parts.join('/')]);
  const heroKey = allowed(me, parts[0] || 'overview', parts[1] || '') ? HERO[parts[0] || 'overview'] : undefined;
  const unread = useUnreadAnnouncements(parts.join('/'));
  const groups = NAV.filter(g => (!g.division || hasDiv(me, g.division)) && (!g.admin || isAdmin(me)));
  return (
    <>
      <div className="mbar"><button type="button" className="icon-btn" aria-label="Open menu" onClick={() => setMenuOpen(o => !o)}>☰</button><span className="wordmark">MOMENTUM</span><span /></div>
      <div className="shell">
        <nav className={`side${menuOpen ? ' open' : ''}`} aria-label="Main">
          <div className="brand"><div className="wordmark">MOMENTUM</div><div className="byline">By Jasmine Daya, Law Girl</div></div>
          {groups.map(g => (
            <div className="navg" key={g.title}>
              <h4>{g.title}</h4>
              {g.items.map(i => 'heading' in i ? <div className="navsub" key={i.heading}>{i.heading}</div> : (
                <a key={i.path} href={href(i.path)} className={i.path === active ? 'on' : undefined} aria-current={i.path === active ? 'page' : undefined}><span>{i.label}</span>{i.path === 'announcements' && unread > 0 && <span className="nav-badge" aria-label={`${unread} unread`}>{unread}</span>}</a>
              ))}
            </div>
          ))}
          <div className="side-foot">
            <div className="me">{me.name}</div>
            <div className="muted" style={{ fontSize: 12 }}>{me.title || me.role}</div>
            <div className="row"><button type="button" className={`btn sm${me.title ? '' : ' accent'}`} onClick={() => setProfile(true)}>{me.title ? 'My profile' : 'Add my title'}</button>
              <button type="button" className="btn sm" onClick={signOut}>Sign out</button></div>
            {import.meta.env.DEV && <DevSwitcher members={members} />}
          </div>
        </nav>
        <div className={`scrim${menuOpen ? ' on' : ''}`} onClick={() => setMenuOpen(false)} />
        <main id="main">
          {heroKey && <img className="hero-img" src={`/brand/${heroKey}.jpg`} alt="" />}
          {page}
        </main>
      </div>
      {profile && <FormModal title="My profile" size="narrow" fields={[{ k: 'title', l: 'Your title', req: true, full: true, help: 'For example Law Clerk or Marketing Coordinator.' }]} initial={{ title: me.title }}
        onClose={() => setProfile(false)} onSubmit={async v => { await api.patch('/api/me', { title: v.title }); toast('Title saved.'); location.reload(); }} />}
    </>
  );
}

/** Unread announcements for the menu badge: checked on every page change, every minute, and when announcements change. */
function useUnreadAnnouncements(page: string) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    const check = () => api.get<{ unread: number }>('/api/announcements/unread').then(d => live && setN(d.unread), () => undefined);
    check();
    const t = setInterval(check, 60_000);
    window.addEventListener('momentum:announcements', check);
    return () => { live = false; clearInterval(t); window.removeEventListener('momentum:announcements', check); };
  }, [page]);
  return n;
}

async function signOut() {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => undefined);
  location.href = '/';
}

/** Local development only: act as another member to check what they can see. */
function DevSwitcher({ members }: { members: MemberLite[] }) {
  return (
    <label className="dev-switch">View as (local only)
      <select value={devUser.email} onChange={e => { sessionStorage.setItem('devUser', e.target.value); location.reload(); }}>
        <option value="">Default (.env)</option>
        {members.filter(m => m.email).map(m => <option key={m.id} value={m.email}>{m.name}</option>)}
      </select>
    </label>
  );
}

export function App() {
  if (import.meta.env.DEV) { try { devUser.email = sessionStorage.getItem('devUser') || ''; } catch { /* ignore */ } }
  const me = useLoad(() => api.get<{ member: Me }>('/api/me'), []);
  const members = useLoad(() => api.get<{ members: MemberLite[] }>('/api/members'), [me.data?.member.id]);
  if (me.error) {
    const e = me.error as ApiError;
    return (
      <div className="login"><main className="login-card">
        <img className="login-hero" src="/brand/staircase.jpg" alt="" />
        <h1 className="wordmark">MOMENTUM</h1><div className="byline">By Jasmine Daya, Law Girl</div>
        {e.status === 401 ? (
          <a className="btn accent" href={`/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`}>Sign in with Google</a>
        ) : (
          <>
            <div className="qcard"><div className="lbl">{e.status === 403 ? 'No access yet' : 'Can’t open Momentum'}</div><p style={{ margin: '8px 0 0' }}>{e.message}</p></div>
            {e.status === 403 && <p><button type="button" className="btn sm" onClick={signOut}>Sign in with a different account</button></p>}
          </>
        )}
      </main></div>
    );
  }
  if (!me.data || !members.data) return <p className="muted" style={{ padding: 24 }}>Loading Momentum…</p>;
  return (
    <ToastProvider>
      <SessionCtx.Provider value={{ me: me.data.member, members: members.data.members, reloadMembers: members.reload, reloadMe: me.reload }}>
        <Shell me={me.data.member} members={members.data.members} />
      </SessionCtx.Provider>
    </ToastProvider>
  );
}
