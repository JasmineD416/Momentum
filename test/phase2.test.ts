import { env } from './env';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/worker/index';
import { nyInstant, reportAlertsDue, reportPeriod } from '../src/shared/time';
import { utmUrl } from '../src/shared/constants';

// Phase 2: marketing workspace, team work, calendar, staff updates and the attention centre. Synthetic data only.
const OWNER = 'owner@example.test';
type Json = Record<string, any>;

async function call(user: string, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method, headers: { 'x-dev-user': user, 'content-type': 'application/json', origin: 'http://localhost' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? ((await res.json()) as Json) : ((await res.text()) as unknown as Json);
  return { status: res.status, data, res };
}
const get = (u: string, p: string) => call(u, 'GET', p);
const post = (u: string, p: string, b: unknown) => call(u, 'POST', p, b);
const patch = (u: string, p: string, b: unknown) => call(u, 'PATCH', p, b);
const put = (u: string, p: string, b: unknown) => call(u, 'PUT', p, b);

let seq = 0;
async function addMember(prefix: string, role: 'Member' | 'Administrator', divisions: string[]) {
  const email = `p2-${prefix}-${++seq}@example.test`;
  const r = await post(OWNER, '/api/members', { name: `${prefix} ${seq}`, email, role, divisions });
  expect(r.status).toBe(201);
  return { id: r.data.id as string, email };
}
const ownerId = async () => (await get(OWNER, '/api/me')).data.member.id as string;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

beforeEach(async () => { await get(OWNER, '/api/me'); });

describe('marketing workspace access', () => {
  it('is closed to staff without the Marketing division, on every route', async () => {
    const firmOnly = await addMember('firmonly', 'Member', ['jdco']);
    const admin = await addMember('admin-nomkt', 'Administrator', ['lawgirl']);
    for (const u of [firmOnly.email, admin.email]) {
      for (const p of ['/api/marketing/contacts', '/api/marketing/companies', '/api/marketing/opportunities', '/api/marketing/follow-ups', '/api/marketing/campaigns', '/api/marketing/programs', '/api/expenses?scope=marketing'])
        expect((await get(u, p)).status, `${u} ${p}`).toBe(403);
      expect((await post(u, '/api/marketing/contacts', { name: 'X' })).status).toBe(403);
      expect((await post(u, '/api/marketing/campaigns', { name: 'X' })).status).toBe(403);
    }
    const mkt = await addMember('mkt', 'Member', ['marketing']);
    expect((await get(mkt.email, '/api/marketing/contacts')).status).toBe(200);
  });
});

describe('marketing contacts and companies', () => {
  it('asks for confirmation before a duplicate email, on create and on email change only', async () => {
    const mkt = await addMember('dup', 'Member', ['marketing']);
    const a = await post(mkt.email, '/api/marketing/contacts', { name: 'Avery Sample', email: 'shared.p2@example.test', brands: ['Law Girl', 'CBPLA'] });
    expect(a.status).toBe(201);
    const b = await post(mkt.email, '/api/marketing/contacts', { name: 'Blake Sample', email: 'SHARED.p2@example.test' });
    expect(b.status).toBe(409);
    const b2 = await post(mkt.email, '/api/marketing/contacts', { name: 'Blake Sample', email: 'SHARED.p2@example.test', confirmDuplicate: true });
    expect(b2.status).toBe(201);
    // Saving the second contact again without changing its email doesn't re-ask.
    const detail = (await get(mkt.email, `/api/marketing/contacts/${b2.data.id}`)).data.contact;
    expect((await patch(mkt.email, `/api/marketing/contacts/${b2.data.id}`, { name: 'Blake Sample', email: detail.email, notes: 'x', rev: detail.rev })).status).toBe(200);
    const c = await post(mkt.email, '/api/marketing/contacts', { name: 'Casey Sample', email: 'casey.p2@example.test' });
    expect((await patch(mkt.email, `/api/marketing/contacts/${c.data.id}`, { name: 'Casey Sample', email: 'shared.p2@example.test', rev: 1 })).status).toBe(409);
    const list = (await get(mkt.email, '/api/marketing/contacts')).data.contacts as any[];
    expect(list.find(x => x.id === a.data.id).brands).toEqual(['Law Girl', 'CBPLA']);
  });
  it('records email permission with its date and evidence, and defaults to Unknown', async () => {
    const mkt = await addMember('perm', 'Member', ['marketing']);
    const plain = await post(mkt.email, '/api/marketing/contacts', { name: 'Dana Sample', email: 'dana.p2@example.test' });
    expect((await get(mkt.email, `/api/marketing/contacts/${plain.data.id}`)).data.contact.emailPermission).toBe('Unknown');
    expect((await post(mkt.email, '/api/marketing/contacts', { name: 'Eli Sample', email: 'eli.p2@example.test', emailPermission: 'Granted' })).status).toBe(400);
    expect((await post(mkt.email, '/api/marketing/contacts', { name: 'Eli Sample', email: 'eli.p2@example.test', emailPermission: 'Granted', permissionDate: '2026-10-01' })).status).toBe(400);
    expect((await post(mkt.email, '/api/marketing/contacts', { name: 'Eli Sample', email: 'eli.p2@example.test', emailPermission: 'Granted', permissionDate: '2026-10-01', permissionEvidence: 'Website sign-up form' })).status).toBe(201);
    expect((await post(mkt.email, '/api/marketing/contacts', { name: 'Fran Sample', emailPermission: 'Declined' })).status).toBe(400);
  });
  it('only accepts active Marketing staff as owners, and rejects stale edits', async () => {
    const mkt = await addMember('own', 'Member', ['marketing']);
    const other = await addMember('own-nomkt', 'Member', ['lawgirl']);
    expect((await post(mkt.email, '/api/marketing/companies', { name: 'Sample Co', ownerId: other.id })).status).toBe(400);
    const co = await post(mkt.email, '/api/marketing/companies', { name: 'Sample Co', ownerId: mkt.id, brands: ['CBPLA'] });
    expect(co.status).toBe(201);
    expect((await patch(mkt.email, `/api/marketing/companies/${co.data.id}`, { name: 'Sample Co 2', rev: 1 })).status).toBe(200);
    expect((await patch(mkt.email, `/api/marketing/companies/${co.data.id}`, { name: 'Sample Co 3', rev: 1 })).status).toBe(409);
  });
});

describe('opportunities', () => {
  async function setup() {
    const mkt = await addMember('opp', 'Member', ['marketing']);
    const ct = await post(mkt.email, '/api/marketing/contacts', { name: 'Gale Sample' });
    return { mkt, contactId: ct.data.id as string };
  }
  const open = (contactId: string, ownerId: string, extra: Json = {}) => ({ title: 'Sponsor the summit', pipeline: 'Sponsorships', stage: 'Prospect', contactId, ownerId, nextAction: 'Send deck', followUp: '2026-11-02', currency: 'CAD', valueCents: 500000, probability: 30, ...extra });

  it('requires a link, an active owner, a next action and a follow-up date while open', async () => {
    const { mkt, contactId } = await setup();
    expect((await post(mkt.email, '/api/marketing/opportunities', open(contactId, mkt.id, { contactId: null }))).status).toBe(400);
    expect((await post(mkt.email, '/api/marketing/opportunities', open(contactId, mkt.id, { ownerId: null }))).status).toBe(400);
    expect((await post(mkt.email, '/api/marketing/opportunities', open(contactId, mkt.id, { nextAction: '' }))).status).toBe(400);
    expect((await post(mkt.email, '/api/marketing/opportunities', open(contactId, mkt.id, { followUp: '' }))).status).toBe(400);
    expect((await post(mkt.email, '/api/marketing/opportunities', open(contactId, mkt.id, { stage: 'Demo' }))).status).toBe(400); // not a Sponsorships stage
    expect((await post(mkt.email, '/api/marketing/opportunities', open(contactId, mkt.id))).status).toBe(201);
  });
  it('records stage history, sets won to 100 and lost to 0, and needs a lost reason', async () => {
    const { mkt, contactId } = await setup();
    const o = await post(mkt.email, '/api/marketing/opportunities', open(contactId, mkt.id));
    const id = o.data.id;
    expect((await patch(mkt.email, `/api/marketing/opportunities/${id}`, open(contactId, mkt.id, { stage: 'Pitched', rev: 1 }))).status).toBe(200);
    expect((await patch(mkt.email, `/api/marketing/opportunities/${id}`, open(contactId, mkt.id, { stage: 'Lost', rev: 2 }))).status).toBe(400);
    expect((await patch(mkt.email, `/api/marketing/opportunities/${id}`, open(contactId, mkt.id, { stage: 'Lost', lostReason: 'Budget went elsewhere', probability: 80, rev: 2 }))).status).toBe(200);
    let d = (await get(mkt.email, `/api/marketing/opportunities/${id}`)).data;
    expect(d.opportunity.probability).toBe(0);
    expect(d.history.filter((h: Json) => h.kind === 'Stage change').map((h: Json) => h.toStage).sort()).toEqual(['Lost', 'Pitched', 'Prospect']);
    // A stale save changes nothing, including the history.
    expect((await patch(mkt.email, `/api/marketing/opportunities/${id}`, open(contactId, mkt.id, { stage: 'Won', rev: 2 }))).status).toBe(409);
    expect((await patch(mkt.email, `/api/marketing/opportunities/${id}`, open(contactId, mkt.id, { stage: 'Won', probability: 10, nextAction: '', followUp: '', rev: 3 }))).status).toBe(200);
    d = (await get(mkt.email, `/api/marketing/opportunities/${id}`)).data;
    expect(d.opportunity.probability).toBe(100);
    expect(d.opportunity.lostReason).toBe('');
    expect(d.history.filter((h: Json) => h.kind === 'Stage change')).toHaveLength(4);
  });
  it('keeps expected and weighted values separate by currency, rounding each to cents', async () => {
    const { mkt, contactId } = await setup();
    const pipeline = 'Speaking';
    for (const [cur, value, p] of [['CAD', 1001, 33], ['CAD', 1001, 33], ['USD', 250, 50]] as const)
      expect((await post(mkt.email, '/api/marketing/opportunities', open(contactId, mkt.id, { pipeline, stage: 'Lead', currency: cur, valueCents: value, probability: p }))).status).toBe(201);
    const r = await get(mkt.email, `/api/marketing/opportunities?pipeline=${encodeURIComponent(pipeline)}`);
    // 1001 × 33% = 330.33 → 330 each, so 660 (not round(660.66) = 661).
    expect(r.data.totals.CAD).toMatchObject({ expectedCents: 2002, weightedCents: 660 });
    expect(r.data.totals.USD).toMatchObject({ expectedCents: 250, weightedCents: 125 });
  });
  it('drops archived contacts and closed opportunities from the follow-up queue', async () => {
    const { mkt, contactId } = await setup();
    const p1 = await patch(mkt.email, `/api/marketing/contacts/${contactId}`, { name: 'Gale Sample', ownerId: mkt.id, nextAction: 'Call back', followUp: '2026-10-20', rev: 1 });
    expect(p1.status, JSON.stringify(p1.data)).toBe(200);
    const o = await post(mkt.email, '/api/marketing/opportunities', open(contactId, mkt.id, { title: 'Queue test opp' }));
    let q = (await get(mkt.email, '/api/marketing/follow-ups?mine=1')).data.followUps as any[];
    expect(q.map(x => x.id)).toEqual(expect.arrayContaining([contactId, o.data.id]));
    await patch(mkt.email, `/api/marketing/contacts/${contactId}`, { name: 'Gale Sample', ownerId: mkt.id, nextAction: 'Call back', followUp: '2026-10-20', status: 'Archived', rev: 2 });
    await patch(mkt.email, `/api/marketing/opportunities/${o.data.id}`, open(contactId, mkt.id, { title: 'Queue test opp', stage: 'Won', rev: 1 }));
    q = (await get(mkt.email, '/api/marketing/follow-ups?mine=1')).data.followUps as any[];
    expect(q.map(x => x.id)).not.toContain(contactId);
    expect(q.map(x => x.id)).not.toContain(o.data.id);
  });
  it('appends activity and rejects future times', async () => {
    const { mkt, contactId } = await setup();
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect((await post(mkt.email, '/api/marketing/activities', { contactId, at: future, method: 'Call', direction: 'Outbound', outcome: 'Reached' })).status).toBe(400);
    expect((await post(mkt.email, '/api/marketing/activities', { at: new Date().toISOString(), method: 'Call', direction: 'Outbound', outcome: 'Reached' })).status).toBe(400);
    expect((await post(mkt.email, '/api/marketing/activities', { contactId, at: new Date(Date.now() - 60_000).toISOString(), method: 'Email', direction: 'Inbound', outcome: 'Replied', notes: 'Asked for pricing' })).status).toBe(201);
    const d = (await get(mkt.email, `/api/marketing/contacts/${contactId}`)).data;
    expect(d.activities).toHaveLength(1);
    expect(d.contact.lastActivity).toBeTruthy();
  });
});

describe('campaigns', () => {
  it('derives results from linked records: spend incl. HST without voids, by currency, win rate and cost per contact', async () => {
    const mkt = await addMember('camp', 'Member', ['marketing']);
    const ca = await post(mkt.email, '/api/marketing/campaigns', {
      name: 'Fall webinar', brand: 'The Private Lenders Stack', ownerId: mkt.id, status: 'Active', currency: 'CAD', budgetCents: 100000,
      startDate: '2026-10-01', endDate: '2026-11-30', landingUrl: 'https://example.test/webinar', utmSource: 'newsletter', utmMedium: 'email', utmCampaign: 'fall-webinar',
    });
    expect(ca.status).toBe(201);
    const id = ca.data.id;
    let r = (await get(mkt.email, `/api/marketing/campaigns/${id}`)).data.campaign;
    expect(r.results.winRate).toBeNull();
    expect(r.results.costPerContactCents).toBeNull();
    expect(r.trackedUrl).toBe('https://example.test/webinar?utm_source=newsletter&utm_medium=email&utm_campaign=fall-webinar');
    for (const n of ['Hal', 'Ivy']) await post(mkt.email, '/api/marketing/contacts', { name: `${n} Sample`, campaignId: id });
    const ct = (await get(mkt.email, '/api/marketing/contacts')).data.contacts.find((x: Json) => x.name === 'Hal Sample');
    const opp = (stage: string, extra: Json = {}) => ({ title: `Webinar ${stage}`, pipeline: 'Software sales', stage, contactId: ct.id, ownerId: mkt.id, nextAction: 'n', followUp: '2026-11-01', currency: 'CAD', valueCents: 20000, campaignId: id, ...extra });
    await post(mkt.email, '/api/marketing/opportunities', opp('Won'));
    await post(mkt.email, '/api/marketing/opportunities', opp('Lost', { lostReason: 'Timing' }));
    await post(mkt.email, '/api/marketing/opportunities', opp('Lost', { lostReason: 'Price' }));
    await post(mkt.email, '/api/marketing/opportunities', opp('Demo'));
    const exp = (amount: number, hst: number, currency = 'CAD') => post(mkt.email, '/api/expenses', { scope: 'marketing', brand: 'The Private Lenders Stack', campaignId: id, date: '2026-10-05', provider: 'Ad network', currency, amountCents: amount, hstCents: hst, payStatus: 'Unpaid' });
    await exp(10000, 1300);
    const voided = await exp(5000, 650);
    await post(mkt.email, `/api/expenses/${voided.data.id}/void`, { reason: 'Duplicate', rev: 1 });
    await exp(2000, 0, 'USD');
    r = (await get(mkt.email, `/api/marketing/campaigns/${id}`)).data.campaign;
    expect(r.results.contacts).toBe(2);
    expect(r.results.opportunities).toEqual({ open: 1, won: 1, lost: 2 });
    expect(r.results.winRate).toBeCloseTo(1 / 3);
    expect(r.results.spend).toEqual({ CAD: 11300, USD: 2000 });
    expect(r.results.remainingCents).toBe(100000 - 11300);
    expect(r.results.costPerContactCents).toBe(5650);
    expect(r.results.wonValue).toEqual({ CAD: 20000 });
  });
  it('requires an active Marketing owner, valid dates and a clean UTM link', async () => {
    const mkt = await addMember('camp2', 'Member', ['marketing']);
    const base = { name: 'X', brand: 'CBPLA', ownerId: mkt.id, status: 'Planned', currency: 'CAD' };
    expect((await post(mkt.email, '/api/marketing/campaigns', { ...base, ownerId: (await addMember('camp-nomkt', 'Member', ['jdco'])).id })).status).toBe(400);
    expect((await post(mkt.email, '/api/marketing/campaigns', { ...base, startDate: '2026-10-10', endDate: '2026-10-01' })).status).toBe(400);
    expect((await post(mkt.email, '/api/marketing/campaigns', { ...base, landingUrl: 'http://example.test' })).status).toBe(400);
    expect((await post(mkt.email, '/api/marketing/campaigns', { ...base, utmSource: 'a&b' })).status).toBe(400);
    expect(utmUrl('https://example.test/p?x=1', { source: 'ig', campaign: 'spring sale' })).toBe('https://example.test/p?x=1&utm_source=ig&utm_campaign=spring+sale');
  });
  it('links client expenses to matters only, and marketing expenses to existing campaigns only', async () => {
    const mkt = await addMember('camp3', 'Member', ['marketing']);
    expect((await post(mkt.email, '/api/expenses', { scope: 'marketing', brand: 'CBPLA', campaignId: 'nope', date: '2026-10-05', provider: 'P', currency: 'CAD', amountCents: 100, payStatus: 'Unpaid' })).status).toBe(400);
    expect((await post(mkt.email, '/api/expenses', { scope: 'marketing', brand: 'CBPLA', date: '2026-10-05', provider: 'P', currency: 'CAD', amountCents: 100, payStatus: 'Unpaid' })).status).toBe(201);
  });
});

describe('marketing programs', () => {
  it('applies general, firm and administrator visibility, and keeps edits to the creator or an administrator', async () => {
    const mkt = await addMember('prog', 'Member', ['marketing']);
    const mkt2 = await addMember('prog2', 'Member', ['marketing']);
    const firmMkt = await addMember('prog-firm', 'Member', ['marketing', 'jdco']);
    const admin = await addMember('prog-admin', 'Administrator', ['marketing']);
    const g = await post(mkt.email, '/api/marketing/programs', { provider: 'Design tool', renewalDate: '2026-12-01' });
    expect(g.status).toBe(201);
    expect((await post(mkt.email, '/api/marketing/programs', { provider: 'Firm tool', visibility: 'firm' })).status).toBe(403);
    expect((await post(mkt.email, '/api/marketing/programs', { provider: 'Admin tool', visibility: 'admin' })).status).toBe(403);
    expect((await post(firmMkt.email, '/api/marketing/programs', { provider: 'Firm tool', visibility: 'firm' })).status).toBe(201);
    expect((await post(admin.email, '/api/marketing/programs', { provider: 'Admin tool', visibility: 'admin' })).status).toBe(201);
    const names = async (u: string) => ((await get(u, '/api/marketing/programs')).data.programs as any[]).map(p => p.provider);
    expect(await names(mkt.email)).not.toEqual(expect.arrayContaining(['Firm tool']));
    expect(await names(mkt.email)).not.toContain('Admin tool');
    expect(await names(firmMkt.email)).toContain('Firm tool');
    expect(await names(admin.email)).toContain('Admin tool');
    expect(await names(admin.email)).not.toContain('Firm tool');
    expect((await patch(mkt2.email, `/api/marketing/programs/${g.data.id}`, { provider: 'Design tool', rev: 1 })).status).toBe(403);
    expect((await patch(admin.email, `/api/marketing/programs/${g.data.id}`, { provider: 'Design tool', status: 'Trial', rev: 1 })).status).toBe(200);
    expect((await post(mkt.email, '/api/marketing/programs', { provider: 'Leaky', accessNotes: 'password: hunter2' })).status).toBe(400);
  });
});

describe('team workspace', () => {
  it('lets every staff member work, but only administrators approve or publish', async () => {
    const plain = await addMember('team', 'Member', ['lawgirl']);
    const admin = await addMember('team-admin', 'Administrator', []);
    const t = await post(plain.email, '/api/tasks', { title: 'Instagram carousel', brand: 'Law Girl', workType: 'Social post', status: 'Planned', assigneeId: plain.id });
    expect(t.status).toBe(201);
    expect((await post(plain.email, '/api/tasks', { title: 'Self-approved', status: 'Approved' })).status).toBe(403);
    expect((await patch(plain.email, `/api/tasks/${t.data.id}`, { title: 'Instagram carousel', status: 'Ready for review', rev: 1 })).status).toBe(200);
    expect((await patch(plain.email, `/api/tasks/${t.data.id}`, { title: 'Instagram carousel', status: 'Approved', rev: 2 })).status).toBe(403);
    expect((await patch(admin.email, `/api/tasks/${t.data.id}`, { title: 'Instagram carousel', status: 'Approved', rev: 2 })).status).toBe(200);
    // Staff can't edit their way back out of an approval, or publish.
    expect((await patch(plain.email, `/api/tasks/${t.data.id}`, { title: 'Instagram carousel', status: 'In progress', rev: 3 })).status).toBe(403);
    expect((await patch(plain.email, `/api/tasks/${t.data.id}`, { title: 'Instagram carousel', status: 'Published', publishedLink: 'https://example.test/p', rev: 3 })).status).toBe(403);
    expect((await patch(admin.email, `/api/tasks/${t.data.id}`, { title: 'Instagram carousel', status: 'Published', rev: 3 })).status).toBe(400);
    expect((await patch(admin.email, `/api/tasks/${t.data.id}`, { title: 'Instagram carousel', status: 'Published', publishedLink: 'https://example.test/p', rev: 3 })).status).toBe(200);
    const row = ((await get(plain.email, '/api/tasks')).data.tasks as any[]).find(x => x.id === t.data.id);
    expect(row.approvedBy).toBe(admin.id);
    expect(row.completedAt).toBeTruthy();
  });
  it('needs Marketing access to link work to a campaign, and hides campaign names from other staff', async () => {
    const mkt = await addMember('team-mkt', 'Member', ['marketing']);
    const plain = await addMember('team-plain', 'Member', ['kitchen']);
    const ca = await post(mkt.email, '/api/marketing/campaigns', { name: 'Secret launch', brand: 'JD in the Kitchen', ownerId: mkt.id, status: 'Planned', currency: 'CAD' });
    expect((await post(plain.email, '/api/tasks', { title: 'Shoot recipe video', status: 'Planned', campaignId: ca.data.id })).status).toBe(403);
    const t = await post(mkt.email, '/api/tasks', { title: 'Shoot recipe video', status: 'Planned', campaignId: ca.data.id });
    expect(t.status).toBe(201);
    const seen = ((await get(plain.email, '/api/tasks')).data.tasks as any[]).find(x => x.id === t.data.id);
    expect(seen.campaignName).toBeNull();
    // Their edit keeps the link they can't see.
    expect((await patch(plain.email, `/api/tasks/${t.data.id}`, { title: 'Shoot recipe video', status: 'In progress', rev: 1 })).status).toBe(200);
    const after = ((await get(mkt.email, '/api/tasks')).data.tasks as any[]).find(x => x.id === t.data.id);
    expect(after.campaignId).toBe(ca.data.id);
  });
});

describe('team calendar', () => {
  it('combines work, campaigns and follow-ups, and adds firm dates only on request with firm access', async () => {
    const mkt = await addMember('cal', 'Member', ['marketing']);
    const plain = await addMember('cal-plain', 'Member', ['cbpla']);
    await post(mkt.email, '/api/tasks', { title: 'Calendar work item', status: 'Planned', dueDate: '2027-01-15' });
    await post(mkt.email, '/api/marketing/campaigns', { name: 'January push', brand: 'CBPLA', ownerId: mkt.id, status: 'Planned', currency: 'CAD', startDate: '2027-01-05', endDate: '2027-02-05' });
    await post(mkt.email, '/api/marketing/contacts', { name: 'Jo Sample', nextAction: 'Check in', followUp: '2027-01-20' });
    await post(OWNER, '/api/pncs', { name: 'Calendar PNC', status: 'New', followUp: '2027-01-21', data: { limitationDate: '2027-01-30', verifiedBy: 'Test lawyer', verifiedBasis: 'Synthetic test record' } });
    const kinds = (r: Json) => (r.data.items as any[]).map(i => i.kind);
    const m = await get(mkt.email, '/api/calendar?month=2027-01');
    expect(kinds(m)).toEqual(expect.arrayContaining(['Work', 'Campaign starts', 'Follow-up']));
    expect(kinds(m)).not.toContain('PNC follow-up');
    expect((await get(mkt.email, '/api/calendar?month=2027-01&includeFirm=1')).status).toBe(403);
    const p = await get(plain.email, '/api/calendar?month=2027-01');
    expect(kinds(p)).toEqual(['Work']);
    const o = await get(OWNER, '/api/calendar?month=2027-01&includeFirm=1');
    expect(kinds(o)).toEqual(expect.arrayContaining(['PNC follow-up', 'Limitation date']));
    expect(kinds(await get(OWNER, '/api/calendar?month=2027-01'))).not.toContain('PNC follow-up');
  });
});

describe('staff updates', () => {
  const report = (extra: Json = {}) => ({ kind: 'daily', scope: 'general', date: today(), completed: 'Drafted newsletter', inProgress: 'Podcast notes', blockers: '', decisions: 'Approve the cover', nextPriorities: 'Publish', ...extra });

  it('keeps drafts private, shows submitted reports to reviewers, and clears the review on edit', async () => {
    const staff = await addMember('rep', 'Member', ['marketing']);
    const other = await addMember('rep-other', 'Member', ['marketing']);
    const admin = await addMember('rep-admin', 'Administrator', ['marketing']);
    const d = await put(staff.email, '/api/reports/mine', report());
    expect(d.status).toBe(201);
    const id = d.data.id;
    // Draft: the author sees it; an administrator sees the status but not the text; other staff see nothing.
    expect((await get(staff.email, `/api/reports/${id}`)).status).toBe(200);
    expect((await get(admin.email, `/api/reports/${id}`)).status).toBe(404);
    expect((await get(other.email, `/api/reports/${id}`)).status).toBe(404);
    let team = (await get(admin.email, `/api/reports/team?kind=daily&scope=general&date=${today()}`)).data.team as any[];
    let row = team.find(r => r.memberId === staff.id);
    expect(row.status).toBe('Draft');
    expect(row.report).toBeNull();
    expect(JSON.stringify(team)).not.toContain('Drafted newsletter');
    expect((await get(other.email, `/api/reports/team?kind=daily&scope=general&date=${today()}`)).status).toBe(403);
    expect((await post(admin.email, `/api/reports/${id}/review`, { note: 'x', rev: 1 })).status).toBe(404);
    // Submit; now the admin can read and review it.
    expect((await put(staff.email, '/api/reports/mine', report({ submit: true, rev: 1 }))).status).toBe(200);
    team = (await get(admin.email, `/api/reports/team?kind=daily&scope=general&date=${today()}`)).data.team as any[];
    row = team.find(r => r.memberId === staff.id);
    expect(row.report.completed).toBe('Drafted newsletter');
    expect((await post(staff.email, `/api/reports/${id}/review`, { note: 'self', rev: 2 })).status).toBe(403);
    expect((await post(admin.email, `/api/reports/${id}/review`, { note: 'Looks good', rev: 2 })).status).toBe(200);
    expect((await get(staff.email, `/api/reports/${id}`)).data.report.reviewedBy).toBe(admin.id);
    // A stale edit is rejected; a current one clears the review.
    expect((await put(staff.email, '/api/reports/mine', report({ submit: true, completed: 'Changed', rev: 2 }))).status).toBe(409);
    expect((await put(staff.email, '/api/reports/mine', report({ submit: true, completed: 'Changed', rev: 3 }))).status).toBe(200);
    const after = (await get(staff.email, `/api/reports/${id}`)).data.report;
    expect(after.reviewedBy).toBeNull();
    expect(after.reviewNote).toBe('');
    // Recap downloads as text for the author.
    const recap = await get(staff.email, `/api/reports/${id}/recap`);
    expect(recap.res.headers.get('content-type')).toContain('text/plain');
    expect(String(recap.data)).toContain('Changed');
  });
  it('keeps firm reports separate and limits review to permitted administrators', async () => {
    const firmStaff = await addMember('rep-firm', 'Member', ['jdco']);
    const plain = await addMember('rep-plain', 'Member', ['marketing']);
    const admin = await addMember('rep-admin2', 'Administrator', ['marketing']);
    const admin2 = await addMember('rep-admin3', 'Administrator', ['marketing']);
    expect((await put(plain.email, '/api/reports/mine', report({ scope: 'firm' }))).status).toBe(403);
    const f = await put(firmStaff.email, '/api/reports/mine', report({ scope: 'firm', submit: true }));
    expect(f.status).toBe(201);
    // A general report for the same day is a separate record.
    expect((await put(firmStaff.email, '/api/reports/mine', report({ submit: true }))).status).toBe(201);
    expect((await get(admin.email, `/api/reports/team?kind=daily&scope=firm&date=${today()}`)).status).toBe(403);
    expect((await get(admin.email, `/api/reports/${f.data.id}`)).status).toBe(404);
    expect((await get(OWNER, `/api/reports/${f.data.id}`)).status).toBe(200);
    // Administrators review ordinary members, not each other.
    const a = await put(admin2.email, '/api/reports/mine', report({ submit: true }));
    expect((await get(admin.email, `/api/reports/${a.data.id}`)).status).toBe(404);
    expect((await get(OWNER, `/api/reports/${a.data.id}`)).status).toBe(200);
  });
  it('uses Monday-to-Sunday weeks and New York dates across daylight-saving changes', async () => {
    expect(reportPeriod('weekly', '2026-11-01')).toEqual({ start: '2026-10-26', end: '2026-11-01' }); // Sunday, DST ends
    expect(reportPeriod('weekly', '2026-11-02')).toEqual({ start: '2026-11-02', end: '2026-11-08' });
    expect(nyInstant('2026-03-08').toISOString()).toBe('2026-03-08T05:00:00.000Z'); // midnight before spring-forward is EST
    expect(nyInstant('2026-03-09').toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(nyInstant('2026-11-01').toISOString()).toBe('2026-11-01T04:00:00.000Z'); // midnight before fall-back is EDT
    expect(nyInstant('2026-11-02').toISOString()).toBe('2026-11-02T05:00:00.000Z');
    const staff = await addMember('rep-week', 'Member', ['marketing']);
    // Week of the spring-forward change (Sunday 2026-03-08).
    const w = await put(staff.email, '/api/reports/mine', report({ kind: 'weekly', date: '2026-03-04' }));
    expect(w.status).toBe(201);
    const mine = (await get(staff.email, '/api/reports/mine?kind=weekly&scope=general&date=2026-03-08')).data;
    expect(mine.report.id).toBe(w.data.id);
    expect(mine.period).toEqual({ start: '2026-03-02', end: '2026-03-08' });
    expect((await get(staff.email, '/api/reports/mine?kind=weekly&scope=general&date=2026-03-09')).data.report).toBeNull();
    expect((await put(staff.email, '/api/reports/mine', report({ date: addDays(today(), 2) }))).status).toBe(400);
  });
  it('alerts for daily reports from 5 p.m. New York on weekdays and weekly from Friday 5 p.m.', () => {
    // Thursday 2026-10-29: 4:59 p.m. EDT = 20:59Z, 5 p.m. = 21:00Z.
    expect(reportAlertsDue(new Date('2026-10-29T20:59:00Z'))).toMatchObject({ daily: false, weekly: false });
    expect(reportAlertsDue(new Date('2026-10-29T21:00:00Z'))).toMatchObject({ daily: true, weekly: false, today: '2026-10-29' });
    // Friday 5 p.m. starts the weekly alert; Saturday has no daily alert.
    expect(reportAlertsDue(new Date('2026-10-30T21:00:00Z'))).toMatchObject({ daily: true, weekly: true, weekStart: '2026-10-26' });
    expect(reportAlertsDue(new Date('2026-10-31T15:00:00Z'))).toMatchObject({ daily: false, weekly: true });
    // After the clocks change (EST), 5 p.m. is 22:00Z.
    expect(reportAlertsDue(new Date('2026-11-02T21:30:00Z'))).toMatchObject({ daily: false });
    expect(reportAlertsDue(new Date('2026-11-02T22:00:00Z'))).toMatchObject({ daily: true, today: '2026-11-02' });
    // 11 p.m. Sunday in New York is already Monday in UTC, but still Sunday's week.
    expect(reportAlertsDue(new Date('2026-11-09T04:00:00Z'))).toMatchObject({ today: '2026-11-08', weekStart: '2026-11-02', weekly: true });
  });
});

describe('attention centre and reminders', () => {
  it('derives alerts from permitted work, with per-person read, dismiss and expiring snooze', async () => {
    const a = await addMember('att', 'Member', ['marketing']);
    const b = await addMember('att-b', 'Member', ['marketing']);
    const t = await post(a.email, '/api/tasks', { title: 'Overdue alert task', status: 'In progress', assigneeId: a.id, dueDate: addDays(today(), -1) });
    const ct = await post(a.email, '/api/marketing/contacts', { name: 'Kit Sample', ownerId: a.id, nextAction: 'Call', followUp: today() });
    await post(b.email, '/api/marketing/contacts', { name: 'Not mine', ownerId: b.id, nextAction: 'Call', followUp: today() });
    const alerts = async (u: string) => (await get(u, '/api/attention')).data.alerts as any[];
    let list = await alerts(a.email);
    const taskAlert = list.find(x => x.title === 'Overdue alert task');
    expect(taskAlert.kind).toBe('Overdue work');
    expect(list.some(x => x.title === 'Kit Sample')).toBe(true);
    expect(list.some(x => x.title === 'Not mine')).toBe(false);
    // Read is per person.
    await post(a.email, '/api/attention/state', { key: taskAlert.key, state: 'read' });
    expect((await alerts(a.email)).find(x => x.key === taskAlert.key).read).toBe(true);
    // Snooze must be to a later date, and hides until then.
    expect((await post(a.email, '/api/attention/state', { key: taskAlert.key, state: 'snoozed', snoozeUntil: today() })).status).toBe(400);
    await post(a.email, '/api/attention/state', { key: taskAlert.key, state: 'snoozed', snoozeUntil: addDays(today(), 1) });
    expect((await alerts(a.email)).some(x => x.key === taskAlert.key)).toBe(false);
    // Snoozes expire by business date (simulate the date arriving).
    await env.DB.prepare('UPDATE alert_states SET snooze_until = ? WHERE alert_key = ?').bind(today(), taskAlert.key).run();
    expect((await alerts(a.email)).some(x => x.key === taskAlert.key)).toBe(true);
    // Dismissing hides the alert without completing the source; completing the source removes it.
    const ctKey = (await alerts(a.email)).find(x => x.title === 'Kit Sample').key;
    await post(a.email, '/api/attention/state', { key: ctKey, state: 'dismissed' });
    expect((await alerts(a.email)).some(x => x.key === ctKey)).toBe(false);
    expect((await get(a.email, `/api/marketing/contacts/${ct.data.id}`)).data.contact.followUp).toBe(today());
    await patch(a.email, `/api/tasks/${t.data.id}`, { title: 'Overdue alert task', status: 'Completed', assigneeId: a.id, dueDate: addDays(today(), -1), rev: 1 });
    expect((await alerts(a.email)).some(x => x.title === 'Overdue alert task')).toBe(false);
  });
  it('keeps firm alerts and marketing alerts to people with access', async () => {
    const firm = await addMember('att-firm', 'Member', ['jdco']);
    const mkt = await addMember('att-mkt', 'Member', ['marketing']);
    await post(OWNER, '/api/pncs', { name: 'Alert PNC', status: 'New', assignedStaffId: firm.id, followUp: addDays(today(), -2) });
    expect(((await get(firm.email, '/api/attention')).data.alerts as any[]).some(x => x.kind === 'PNC follow-up' && x.title === 'Alert PNC')).toBe(true);
    expect(((await get(mkt.email, '/api/attention')).data.alerts as any[]).some(x => x.kind === 'PNC follow-up')).toBe(false);
  });
  it('limits who reminders can be created for, and completes them once', async () => {
    const plain = await addMember('rem', 'Member', ['marketing']);
    const other = await addMember('rem-other', 'Member', ['marketing']);
    const firm = await addMember('rem-firm', 'Member', ['jdco']);
    const admin = await addMember('rem-admin', 'Administrator', ['marketing']);
    expect((await post(plain.email, '/api/reminders', { title: 'For someone else', dueDate: today(), assigneeId: other.id })).status).toBe(403);
    expect((await post(plain.email, '/api/reminders', { title: 'Firm', dueDate: today(), scope: 'firm' })).status).toBe(403);
    expect((await post(admin.email, '/api/reminders', { title: 'Firm for firm staff', dueDate: today(), scope: 'firm', assigneeId: firm.id })).status).toBe(403); // creator lacks firm access
    expect((await post(OWNER, '/api/reminders', { title: 'Firm for marketing staff', dueDate: today(), scope: 'firm', assigneeId: other.id })).status).toBe(400); // assignee lacks firm access
    expect((await post(OWNER, '/api/reminders', { title: 'Firm reminder', dueDate: today(), scope: 'firm', assigneeId: firm.id })).status).toBe(201);
    const r = await post(admin.email, '/api/reminders', { title: 'Send the photos', dueDate: today(), assigneeId: other.id });
    expect(r.status).toBe(201);
    expect(((await get(other.email, '/api/attention')).data.alerts as any[]).some(x => x.title === 'Send the photos')).toBe(true);
    expect((await post(plain.email, `/api/reminders/${r.data.id}/complete`, { rev: 1 })).status).toBe(404);
    expect((await post(other.email, `/api/reminders/${r.data.id}/complete`, { rev: 1 })).status).toBe(200);
    expect((await post(other.email, `/api/reminders/${r.data.id}/complete`, { rev: 2 })).status).toBe(409);
    expect(((await get(other.email, '/api/attention')).data.alerts as any[]).some(x => x.title === 'Send the photos')).toBe(false);
    expect(((await get(firm.email, '/api/attention')).data.alerts as any[]).some(x => x.title === 'Firm reminder')).toBe(true);
  });
  it('flags upcoming program renewals to the account owner and administrators', async () => {
    const mkt = await addMember('ren', 'Member', ['marketing']);
    const other = await addMember('ren-other', 'Member', ['marketing']);
    await post(mkt.email, '/api/marketing/programs', { provider: 'Renewing tool', accountOwnerId: mkt.id, renewalDate: addDays(today(), 10) });
    expect(((await get(mkt.email, '/api/attention')).data.alerts as any[]).some(x => x.title === 'Renewing tool')).toBe(true);
    expect(((await get(other.email, '/api/attention')).data.alerts as any[]).some(x => x.title === 'Renewing tool')).toBe(false);
    expect(((await get(OWNER, '/api/attention')).data.alerts as any[]).some(x => x.title === 'Renewing tool')).toBe(true);
    void (await ownerId());
  });
});
