import { env } from './env';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/worker/index';
import { outbox } from '../src/worker/email/mail';
import { runScheduler } from '../src/worker/email/scheduler';
import { checkMailing, markdownToHtml, renderEmail } from '../src/shared/email';

// Email lists and mass mailings. Synthetic addresses only (example.test never receives mail).
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
const post = (u: string, p: string, b: unknown = {}) => call(u, 'POST', p, b);
const put = (u: string, p: string, b: unknown) => call(u, 'PUT', p, b);

let seq = 0;
async function addMember(prefix: string, role: 'Member' | 'Administrator', divisions: string[]) {
  const email = `em-${prefix}-${++seq}@example.test`;
  const r = await post(OWNER, '/api/members', { name: `${prefix} ${seq}`, email, role, divisions });
  expect(r.status).toBe(201);
  return { id: r.data.id as string, email };
}
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const sender = (extra: Json = {}) => ({ fromName: 'Sample Brand', fromEmail: 'news@sample-brand.example', replyTo: '', postalAddress: '100 Sample Street, Toronto ON M5V 0A1', dailyLimit: 1000, ...extra });
async function setSender(brand: string, extra: Json = {}) {
  const cur = (await get(OWNER, '/api/email/overview')).data.brands.find((b: Json) => b.id === brand).sender;
  const r = await put(OWNER, `/api/email/senders/${brand}`, { ...sender(extra), rev: cur?.rev });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
}
async function importRows(user: string, brand: string, rows: Json[], basis = 'express', consentDate = today()) {
  const imp = await post(user, '/api/email/imports', { brand, filename: 'synthetic.csv', totalRows: rows.length, basis, consentDate, consentSource: 'Synthetic test sign-up form', attest: true });
  if (imp.status !== 201) return { status: imp.status, imp };
  const ch = await post(user, `/api/email/imports/${imp.data.id}/chunks`, { index: 0, rows });
  return { status: ch.status, id: imp.data.id as string, chunk: ch.data };
}
const goodMailing = (brand: string, extra: Json = {}) => ({
  brand, name: 'Synthetic newsletter', subject: 'Your October update from us', preheader: 'Three things worth knowing this month',
  format: 'markdown', body: '# Hello {{first_name|there}}\n\nHere is our monthly note with a few updates about what we have been working on, what is coming next, and how to reach us if you have any questions at all.\n\n[[Read more|https://sample-brand.example/news]]', ...extra,
});

beforeEach(async () => { await get(OWNER, '/api/me'); });

describe('email list access', () => {
  it('needs Marketing plus the entity’s own division, on every route', async () => {
    const lawgirl = await addMember('lg', 'Member', ['marketing', 'lawgirl']);
    const noMkt = await addMember('nomkt', 'Member', ['lawgirl']);
    expect((await get(lawgirl.email, '/api/email/lists/lawgirl/subscribers')).status).toBe(200);
    for (const p of ['/api/email/lists/cbpla/subscribers', '/api/email/lists/jdco/subscribers'])
      expect((await get(lawgirl.email, p)).status, p).toBe(403);
    expect((await post(lawgirl.email, '/api/email/mailings', goodMailing('cbpla'))).status).toBe(403);
    expect((await post(lawgirl.email, '/api/email/lists/cbpla/subscribers', { email: 'x@example.test', basis: 'express', consentDate: today(), consentSource: 'Form' })).status).toBe(403);
    const ov = await get(lawgirl.email, '/api/email/overview');
    expect(ov.data.brands.map((b: Json) => b.id)).toEqual(['lawgirl']);
    for (const p of ['/api/email/overview', '/api/email/mailings', '/api/email/lists/lawgirl/subscribers'])
      expect((await get(noMkt.email, p)).status, p).toBe(403);
    // Another entity's mailing is invisible.
    const m = await post(OWNER, '/api/email/mailings', goodMailing('cbpla'));
    expect((await get(lawgirl.email, `/api/email/mailings/${m.data.id}`)).status).toBe(404);
    expect(((await get(lawgirl.email, '/api/email/mailings')).data.mailings as Json[]).some(x => x.id === m.data.id)).toBe(false);
  });
  it('keeps sender settings and imports for administrators, and refuses free-mailbox senders', async () => {
    const staff = await addMember('staff', 'Member', ['marketing', 'cbpla']);
    expect((await put(staff.email, '/api/email/senders/cbpla', sender())).status).toBe(403);
    expect((await importRows(staff.email, 'cbpla', [{ email: 'a@example.test' }])).status).toBe(403);
    expect((await put(OWNER, '/api/email/senders/cbpla', sender({ fromEmail: 'cbpla.news@gmail.com' }))).status).toBe(400);
    expect((await put(OWNER, '/api/email/senders/cbpla', sender({ postalAddress: '' }))).status).toBe(400);
    await setSender('cbpla');
  });
});

describe('bulk import', () => {
  it('requires a consent declaration and skips invalid, repeated, blocked and unsubscribed addresses', async () => {
    expect((await post(OWNER, '/api/email/imports', { brand: 'plstack', totalRows: 1, basis: 'express', consentDate: today(), consentSource: 'Webinar form' })).status).toBe(400);
    await post(OWNER, '/api/email/suppressions', { email: 'blocked.imp@example.test', detail: 'test' });
    const first = await importRows(OWNER, 'plstack', [{ email: 'gone.imp@example.test', firstName: 'Gone' }]);
    const gone = (await get(OWNER, '/api/email/lists/plstack/subscribers?q=gone.imp')).data.subscribers[0];
    await post(OWNER, `/api/email/lists/plstack/subscribers/${gone.id}/unsubscribe`);
    void first;
    const r = await importRows(OWNER, 'plstack', [
      { email: 'Ann.Imp@Example.test', firstName: 'Ann' }, { email: 'ann.imp@example.test' }, { email: 'not-an-email' },
      { email: 'blocked.imp@example.test' }, { email: 'gone.imp@example.test' }, { email: 'ben.imp@example.test', lastName: 'Imp', consentDate: '2026-01-15' },
    ]);
    expect(r.chunk!).toMatchObject({ added: 2, existing: 0, skipped: 4 });
    expect(r.chunk!.errors.map((e: Json) => e.message)).toEqual(expect.arrayContaining(['Repeated in this file', 'Not a valid email address', 'Unsubscribed earlier; not re-added']));
    // Retrying the same chunk changes nothing.
    const again = await post(OWNER, `/api/email/imports/${r.id}/chunks`, { index: 0, rows: [{ email: 'carl.imp@example.test' }] });
    expect(again.data.duplicate).toBe(true);
    const done = await post(OWNER, `/api/email/imports/${r.id}/complete`);
    expect(done.data.import).toMatchObject({ status: 'Complete', added: 2, skipped: 4 });
    const list = (await get(OWNER, '/api/email/lists/plstack/subscribers?q=.imp@')).data.subscribers as Json[];
    expect(list.find(s => s.email === 'ann.imp@example.test')).toMatchObject({ status: 'Subscribed', consentType: 'Express' });
    expect(list.find(s => s.email === 'ben.imp@example.test')!.consentDate).toBe('2026-01-15');
    expect(list.find(s => s.email === 'gone.imp@example.test')!.status).toBe('Unsubscribed');
    expect(list.some(s => s.email === 'carl.imp@example.test')).toBe(false);
  });
  it('sets implied consent to expire and refuses already-expired implied consent', async () => {
    const r = await importRows(OWNER, 'publishing', [{ email: 'inq.ok@example.test', consentDate: '2026-09-01' }, { email: 'inq.old@example.test', consentDate: '2025-01-01' }], 'inquiry', '2026-09-01');
    expect(r.chunk!).toMatchObject({ added: 1, skipped: 1 });
    const s = (await get(OWNER, '/api/email/lists/publishing/subscribers?q=inq.ok')).data.subscribers[0];
    expect(s).toMatchObject({ consentType: 'Implied', impliedUntil: '2027-03-01' });
  });
  it('keeps each entity’s list separate for the same person', async () => {
    await importRows(OWNER, 'lawgirl', [{ email: 'shared.list@example.test' }]);
    await importRows(OWNER, 'kitchen', [{ email: 'shared.list@example.test' }]);
    const lg = (await get(OWNER, '/api/email/lists/lawgirl/subscribers?q=shared.list')).data.subscribers[0];
    await post(OWNER, `/api/email/lists/lawgirl/subscribers/${lg.id}/unsubscribe`);
    expect((await get(OWNER, '/api/email/lists/lawgirl/subscribers?q=shared.list')).data.subscribers[0].status).toBe('Unsubscribed');
    expect((await get(OWNER, '/api/email/lists/kitchen/subscribers?q=shared.list')).data.subscribers[0].status).toBe('Subscribed');
  });
});

describe('adding one person', () => {
  it('needs consent evidence, and re-adding someone who unsubscribed needs new express consent', async () => {
    const staff = await addMember('one', 'Member', ['marketing', 'cbpla']);
    const base = { email: 'dee.one@example.test', firstName: 'Dee', basis: 'express', consentDate: today(), consentSource: 'Signed up at the booth' };
    expect((await post(staff.email, '/api/email/lists/cbpla/subscribers', { ...base, consentSource: '' })).status).toBe(400);
    const a = await post(staff.email, '/api/email/lists/cbpla/subscribers', base);
    expect(a.status).toBe(201);
    expect((await post(staff.email, '/api/email/lists/cbpla/subscribers', base)).status).toBe(409);
    await post(staff.email, `/api/email/lists/cbpla/subscribers/${a.data.id}/unsubscribe`);
    expect((await post(staff.email, '/api/email/lists/cbpla/subscribers', base)).status).toBe(409);
    expect((await post(staff.email, '/api/email/lists/cbpla/subscribers', { ...base, basis: 'inquiry', resubscribe: true })).status).toBe(409);
    expect((await post(staff.email, '/api/email/lists/cbpla/subscribers', { ...base, resubscribe: true })).status).toBe(201);
  });
});

describe('mailings', () => {
  it('lets staff draft and test to themselves, but only administrators send', async () => {
    await setSender('cbpla');
    const staff = await addMember('draft', 'Member', ['marketing', 'cbpla']);
    const m = await post(staff.email, '/api/email/mailings', goodMailing('cbpla'));
    expect(m.status).toBe(201);
    const before = outbox.length;
    const t = await post(staff.email, `/api/email/mailings/${m.data.id}/test`);
    expect(t.status, JSON.stringify(t.data)).toBe(200);
    const sent = outbox[before];
    expect(sent.to).toBe(staff.email);
    expect(sent.subject.startsWith('[Test]')).toBe(true);
    expect(sent.raw).toMatch(/^List-Unsubscribe: <http:\/\/localhost\/u\/[^>]+>$/m);
    expect(sent.raw).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
    expect(sent.raw).toContain('Content-Type: text/plain; charset=UTF-8');
    expect((await post(staff.email, `/api/email/mailings/${m.data.id}/send`, { rev: 1 })).status).toBe(403);
  });
  it('blocks sending without a postal address, subject or with link shorteners', async () => {
    const m = await post(OWNER, '/api/email/mailings', goodMailing('jdco', { subject: '' }));
    await importRows(OWNER, 'jdco', [{ email: 'jd.block@example.test' }]);
    expect((await post(OWNER, `/api/email/mailings/${m.data.id}/send`, { rev: 1 })).status).toBe(400); // no sender yet
    await setSender('jdco');
    expect((await post(OWNER, `/api/email/mailings/${m.data.id}/send`, { rev: 1 })).status).toBe(400); // no subject
    const d = (await get(OWNER, `/api/email/mailings/${m.data.id}`)).data;
    expect(d.checks.some((x: Json) => x.level === 'block' && /subject/.test(x.text))).toBe(true);
    expect(checkMailing({ subject: 'Hi', preheader: 'x', format: 'markdown', body: 'See https://bit.ly/abc' }, sender()).some(x => x.level === 'block')).toBe(true);
    expect(checkMailing({ subject: 'FREE MONEY NOW!!!', preheader: '', format: 'markdown', body: 'Act now' }, sender()).filter(x => x.level === 'warn').length).toBeGreaterThanOrEqual(3);
  });
  it('sends only to people who can still be emailed, within the daily limit, then finishes', async () => {
    await setSender('kitchen', { dailyLimit: 2 });
    await importRows(OWNER, 'kitchen', ['k1', 'k2', 'k3', 'k4', 'k5'].map(k => ({ email: `${k}.send@example.test`, firstName: k.toUpperCase() })));
    const m = await post(OWNER, '/api/email/mailings', goodMailing('kitchen'));
    const id = m.data.id;
    expect((await post(OWNER, `/api/email/mailings/${id}/send`, { rev: 1 })).status).toBe(200);
    // Changes after the send is queued are still respected.
    const k4 = (await get(OWNER, '/api/email/lists/kitchen/subscribers?q=k4.send')).data.subscribers[0];
    await post(OWNER, '/api/email/suppressions', { email: 'k5.send@example.test', detail: 'Asked by phone' });
    const before = outbox.length;
    await runScheduler(env);
    await post(OWNER, `/api/email/lists/kitchen/subscribers/${k4.id}/unsubscribe`);
    let d = (await get(OWNER, `/api/email/mailings/${id}`)).data;
    expect(d.mailing.status).toBe('Sending');
    const recips = (await env.DB.prepare('SELECT email FROM mailing_recipients WHERE mailing_id = ?').bind(id).all<{ email: string }>()).results.map(r => r.email);
    expect(recips).not.toContain('k5.send@example.test'); // blocked before the audience was fixed
    expect(recips).toEqual(expect.arrayContaining(['k1.send@example.test', 'k4.send@example.test']));
    expect(d.mailing.sentCount).toBe(2); // daily limit
    // Next New York day: the rest go out, except the person who unsubscribed in between.
    // (A skipped address uses a batch slot, so the queue may need more than one run.)
    for (let day = 1; day <= 4 && d.mailing.status === 'Sending'; day++) {
      await runScheduler(env, new Date(Date.now() + day * 86_400_000));
      d = (await get(OWNER, `/api/email/mailings/${id}`)).data;
    }
    expect(d.mailing.status).toBe('Sent');
    const tos = outbox.slice(before).map(o => o.to);
    expect(tos).not.toContain('k4.send@example.test');
    expect(tos).not.toContain('k5.send@example.test');
    expect(new Set(tos).size).toBe(tos.length); // nobody twice
    expect(d.problems.some((p: Json) => p.email === 'k4.send@example.test' && p.status === 'Skipped')).toBe(true);
    expect(tos).toEqual(expect.arrayContaining(['k1.send@example.test', 'k2.send@example.test', 'k3.send@example.test']));
    expect(tos).toHaveLength(recips.length - 1);
  });
  it('lets administrators schedule, cancel back to draft, and refuses stale saves', async () => {
    await setSender('lawgirl');
    await importRows(OWNER, 'lawgirl', [{ email: 'sched@example.test' }]);
    const m = await post(OWNER, '/api/email/mailings', goodMailing('lawgirl'));
    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    expect((await post(OWNER, `/api/email/mailings/${m.data.id}/send`, { rev: 1, scheduledAt: at })).status).toBe(200);
    expect((await call(OWNER, 'PATCH', `/api/email/mailings/${m.data.id}`, { ...goodMailing('lawgirl'), rev: 2 })).status).toBe(409);
    await runScheduler(env);
    expect((await get(OWNER, `/api/email/mailings/${m.data.id}`)).data.mailing.status).toBe('Scheduled');
    expect((await post(OWNER, `/api/email/mailings/${m.data.id}/cancel`, { rev: 1 })).status).toBe(409);
    expect((await post(OWNER, `/api/email/mailings/${m.data.id}/cancel`, { rev: 2 })).data.status).toBe('Draft');
  });
});

describe('unsubscribe links and provider notifications', () => {
  it('shows a confirmation page, unsubscribes on one-click POST, and rejects tampered links', async () => {
    await setSender('publishing');
    await importRows(OWNER, 'publishing', [{ email: 'unsub.me@example.test', firstName: 'Una' }]);
    const m = await post(OWNER, '/api/email/mailings', goodMailing('publishing'));
    await post(OWNER, `/api/email/mailings/${m.data.id}/send`, { rev: 1 });
    const before = outbox.length;
    await runScheduler(env);
    const msg = outbox.slice(before).find(o => o.to === 'unsub.me@example.test')!;
    const url = /^List-Unsubscribe: <([^>]+)>$/m.exec(msg.raw)![1];
    const page = await app.request(url, {}, env);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Unsubscribe from JD Publishing');
    const status = async () => (await get(OWNER, '/api/email/lists/publishing/subscribers?q=unsub.me')).data.subscribers[0].status;
    expect(await status()).toBe('Subscribed'); // viewing the page doesn't unsubscribe
    const bad = await app.request(url.slice(0, -3) + 'abc', { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, env);
    expect(bad.status).toBe(400);
    const one = await app.request(url, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, env);
    expect(one.status).toBe(200);
    expect(await status()).toBe('Unsubscribed');
    expect((await get(OWNER, `/api/email/mailings/${m.data.id}`)).data.mailing.unsubscribeCount).toBe(1);
  });
  it('accepts SES notifications only with the secret, and blocks hard bounces and complaints everywhere', async () => {
    await setSender('plstack');
    await importRows(OWNER, 'plstack', [{ email: 'bounce.me@example.test' }, { email: 'complain.me@example.test' }]);
    const m = await post(OWNER, '/api/email/mailings', goodMailing('plstack'));
    await post(OWNER, `/api/email/mailings/${m.data.id}/send`, { rev: 1 });
    await runScheduler(env);
    const ids = await env.DB.prepare('SELECT email, provider_id FROM mailing_recipients WHERE mailing_id = ?').bind(m.data.id).all<{ email: string; provider_id: string }>();
    const pid = (e: string) => ids.results.find(r => r.email === e)!.provider_id;
    const hook = (token: string, message: Json) => app.request(`http://localhost/hooks/ses?token=${token}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ Type: 'Notification', Message: JSON.stringify(message) }) }, env);
    const bounce = { eventType: 'Bounce', mail: { messageId: pid('bounce.me@example.test') }, bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'bounce.me@example.test' }] } };
    expect((await hook('wrong', bounce)).status).toBe(403);
    expect((await hook('test-hook-token', bounce)).status).toBe(200);
    expect((await hook('test-hook-token', { notificationType: 'Complaint', mail: { messageId: pid('complain.me@example.test') }, complaint: { complainedRecipients: [{ emailAddress: 'complain.me@example.test' }] } })).status).toBe(200);
    const d = (await get(OWNER, `/api/email/mailings/${m.data.id}`)).data.mailing;
    expect(d).toMatchObject({ bounceCount: 1, complaintCount: 1 });
    const sup = (await get(OWNER, '/api/email/suppressions?q=.me@')).data.suppressions as Json[];
    expect(sup.map(s => s.reason).sort()).toEqual(['Complaint', 'Hard bounce']);
    // Blocked on every list, and a complaint can never be unblocked.
    expect((await post(OWNER, '/api/email/lists/cbpla/subscribers', { email: 'bounce.me@example.test', basis: 'express', consentDate: today(), consentSource: 'Form' })).status).toBe(409);
    expect((await post(OWNER, '/api/email/suppressions/remove', { email: 'complain.me@example.test' })).status).toBe(403);
    expect((await post(OWNER, '/api/email/suppressions/remove', { email: 'bounce.me@example.test' })).status).toBe(200);
  });
  it('pauses a mailing automatically when complaints pass 0.3%', async () => {
    await setSender('jdco');
    const m = await post(OWNER, '/api/email/mailings', goodMailing('jdco', { name: 'Pause test' }));
    await env.DB.prepare("UPDATE mailings SET status = 'Sending', started_at = ?, sent_count = 200, complaint_count = 1 WHERE id = ?").bind(new Date().toISOString(), m.data.id).run();
    await runScheduler(env);
    const d = (await get(OWNER, `/api/email/mailings/${m.data.id}`)).data.mailing;
    expect(d.status).toBe('Paused');
    expect(d.pauseReason).toMatch(/spam complaints/);
  });
});

describe('rendering', () => {
  it('escapes HTML in Markdown, always adds the postal address and unsubscribe link, and merges names', () => {
    expect(markdownToHtml('<script>alert(1)</script> [x](javascript:alert(1))')).not.toMatch(/<script|javascript:/);
    const r = renderEmail({ brand: 'lawgirl', ...sender(), logoUrl: '', accent: '#C14B8A', footerNote: '' }, { subject: 'Hi {{first_name|friend}}', preheader: '', format: 'markdown', body: 'Hello {{name}}' }, { email: 'p@example.test', firstName: '', lastName: '', company: '' }, 'https://x.example/u/t');
    expect(r.subject).toBe('Hi friend');
    expect(r.html).toContain('100 Sample Street');
    expect(r.html).toContain('https://x.example/u/t');
    expect(r.text).toContain('Unsubscribe: https://x.example/u/t');
  });
});
