import { renderEmail, type MailContent, type Sender } from '../../shared/email';
import { nyDate } from '../../shared/time';
import type { Env } from '../env';
import { newId, toApi } from '../util';
import { providerReady, sendRaw, unsubscribeUrl } from './mail';

/** Who a mailing may go to: subscribed to that entity, consent still valid, and not suppressed anywhere. */
export const AUDIENCE_WHERE = `sub.brand = ?1 AND sub.status = 'Subscribed' AND (sub.consent_type = 'Express' OR sub.implied_until >= ?2)
  AND NOT EXISTS (SELECT 1 FROM suppressions x WHERE x.email = s.email)`;
export const AUDIENCE_FROM = 'FROM subscriptions sub JOIN subscribers s ON s.id = sub.subscriber_id';

/** Pause a mailing when bounces or spam complaints pass the levels mailbox providers penalize. */
export const LIMITS = { minSample: 100, bounceRate: 0.05, complaintRate: 0.003 };
const STUCK_MINUTES = 15;

export const senderFromRow = (r: Record<string, unknown>) => toApi<Sender>(r);

async function startDue(env: Env, now: Date) {
  const db = env.DB, today = nyDate(now);
  const { results } = await db.prepare("SELECT id, brand FROM mailings WHERE status = 'Scheduled' AND scheduled_at <= ?").bind(now.toISOString()).all<{ id: string; brand: string }>();
  for (const m of results) {
    // Only one run can move a mailing from Scheduled to Sending.
    const claimed = await db.prepare("UPDATE mailings SET status = 'Sending', started_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND status = 'Scheduled'").bind(now.toISOString(), now.toISOString(), m.id).run();
    if (!claimed.meta.changes) continue;
    // The audience is fixed when sending starts, and each address is re-checked again just before its message goes out.
    await db.prepare(`INSERT OR IGNORE INTO mailing_recipients (id, mailing_id, subscriber_id, email, status)
      SELECT lower(hex(randomblob(16))), ?3, s.id, lower(s.email), 'Queued' ${AUDIENCE_FROM} WHERE ${AUDIENCE_WHERE}`).bind(m.brand, today, m.id).run();
    await db.prepare('UPDATE mailings SET recipient_count = (SELECT COUNT(*) FROM mailing_recipients WHERE mailing_id = ?1) WHERE id = ?1').bind(m.id).run();
  }
}

async function safetyPause(env: Env) {
  await env.DB.prepare(`UPDATE mailings SET status = 'Paused', pause_reason = CASE
      WHEN complaint_count * 1.0 / sent_count > ?2 THEN 'Paused automatically: spam complaints are above 0.3%. Check the list before resuming.'
      ELSE 'Paused automatically: bounces are above 5%. Clean the list before resuming.' END, rev = rev + 1
    WHERE status = 'Sending' AND sent_count >= ?1 AND (complaint_count * 1.0 / sent_count > ?2 OR bounce_count * 1.0 / sent_count > ?3)`)
    .bind(LIMITS.minSample, LIMITS.complaintRate, LIMITS.bounceRate).run();
}

type Claimed = { id: string; email: string; subscriber_id: string; first_name: string; last_name: string; company: string; sub_status: string | null; consent_type: string; implied_until: string; suppressed: string | null };

/** One scheduler pass. Runs every minute from the cron trigger. */
export async function runScheduler(env: Env, now = new Date()) {
  const db = env.DB, today = nyDate(now), stamp = now.toISOString();
  if (!providerReady(env)) return { sent: 0, failed: 0, note: 'Email sending isn’t configured.' };
  // Messages claimed by a run that died are marked failed rather than retried, so nobody gets the same email twice.
  await db.prepare("UPDATE mailing_recipients SET status = 'Failed', error = 'Interrupted while sending; not retried to avoid a duplicate.' WHERE status = 'Sending' AND claimed_at < ?")
    .bind(new Date(now.getTime() - STUCK_MINUTES * 60000).toISOString()).run();
  await startDue(env, now);
  await safetyPause(env);

  let budget = Math.max(1, Math.min(1000, Number(env.SEND_BATCH_SIZE) || 100));
  let sent = 0, failed = 0, throttled = false;
  const { results: active } = await db.prepare("SELECT * FROM mailings WHERE status = 'Sending' ORDER BY started_at").all<Record<string, unknown>>();
  for (const m of active) {
    if (budget <= 0 || throttled) break;
    const brand = String(m.brand);
    const sRow = await db.prepare('SELECT * FROM email_senders WHERE brand = ?').bind(brand).first<Record<string, unknown>>();
    if (!sRow || !sRow.from_email || !sRow.postal_address) {
      await db.prepare("UPDATE mailings SET status = 'Paused', pause_reason = 'Paused: the sender settings are incomplete.', rev = rev + 1 WHERE id = ?").bind(m.id).run();
      continue;
    }
    const sender = senderFromRow(sRow);
    const used = Number((await db.prepare('SELECT n FROM send_counts WHERE brand = ? AND day = ?').bind(brand, today).first<{ n: number }>())?.n ?? 0);
    const n = Math.min(budget, Number(sRow.daily_limit) - used);
    if (n <= 0) continue; // daily limit reached; carries on tomorrow
    const claim = newId();
    await db.prepare(`UPDATE mailing_recipients SET status = 'Sending', claim = ?, claimed_at = ? WHERE id IN (SELECT id FROM mailing_recipients WHERE mailing_id = ? AND status = 'Queued' LIMIT ?)`)
      .bind(claim, stamp, m.id, n).run();
    const { results: batch } = await db.prepare(`SELECT r.id, r.email, r.subscriber_id, s.first_name, s.last_name, s.company, sub.status AS sub_status, sub.consent_type, sub.implied_until, x.email AS suppressed
      FROM mailing_recipients r JOIN subscribers s ON s.id = r.subscriber_id LEFT JOIN subscriptions sub ON sub.subscriber_id = r.subscriber_id AND sub.brand = ?
      LEFT JOIN suppressions x ON x.email = r.email WHERE r.claim = ?`).bind(brand, claim).all<Claimed>();
    if (!batch.length) continue;
    const content: MailContent = { subject: String(m.subject), preheader: String(m.preheader), format: m.format as MailContent['format'], body: String(m.body) };
    const updates: D1PreparedStatement[] = [];
    let ok = 0, bad = 0;
    const one = async (r: Claimed) => {
      const why = r.suppressed ? 'Suppressed (bounce or complaint)' : r.sub_status !== 'Subscribed' ? 'Unsubscribed before sending' : r.consent_type === 'Implied' && r.implied_until < today ? 'Implied consent expired' : '';
      if (why) { updates.push(db.prepare("UPDATE mailing_recipients SET status = 'Skipped', error = ?, claim = NULL WHERE id = ?").bind(why, r.id)); return; }
      if (throttled) { updates.push(db.prepare("UPDATE mailing_recipients SET status = 'Queued', claim = NULL WHERE id = ?").bind(r.id)); return; }
      const url = await unsubscribeUrl(env, { subscriberId: r.subscriber_id, brand, mailingId: String(m.id) });
      const msg = renderEmail(sender, content, { email: r.email, firstName: r.first_name, lastName: r.last_name, company: r.company }, url);
      let res;
      try {
        res = await sendRaw(env, { fromName: sender.fromName, fromEmail: sender.fromEmail, replyTo: sender.replyTo, to: r.email, subject: msg.subject, html: msg.html, text: msg.text, unsubscribeUrl: url, feedbackId: `${String(m.id).slice(0, 8)}:${brand}:momentum` });
      } catch (e) { res = { ok: false as const, error: String((e as Error).message || e), retry: true }; }
      if (res.ok) { ok++; updates.push(db.prepare("UPDATE mailing_recipients SET status = 'Sent', provider_id = ?, sent_at = ?, claim = NULL WHERE id = ?").bind(res.id, new Date().toISOString(), r.id)); }
      else if (res.retry) { throttled = true; updates.push(db.prepare("UPDATE mailing_recipients SET status = 'Queued', claim = NULL, error = ? WHERE id = ?").bind(res.error.slice(0, 300), r.id)); }
      else { bad++; updates.push(db.prepare("UPDATE mailing_recipients SET status = 'Failed', error = ?, claim = NULL WHERE id = ?").bind(res.error.slice(0, 300), r.id)); }
    };
    // A few at a time keeps well under Amazon SES's per-second sending rate.
    for (let i = 0; i < batch.length; i += 5) await Promise.all(batch.slice(i, i + 5).map(one));
    updates.push(
      db.prepare('UPDATE mailings SET sent_count = sent_count + ?, failed_count = failed_count + ?, updated_at = ? WHERE id = ?').bind(ok, bad, new Date().toISOString(), m.id),
      db.prepare('INSERT INTO send_counts (brand, day, n) VALUES (?, ?, ?) ON CONFLICT (brand, day) DO UPDATE SET n = n + excluded.n').bind(brand, today, ok + bad),
    );
    await db.batch(updates);
    sent += ok; failed += bad; budget -= batch.length;
  }
  await db.prepare(`UPDATE mailings SET status = 'Sent', finished_at = ?, rev = rev + 1 WHERE status = 'Sending'
    AND NOT EXISTS (SELECT 1 FROM mailing_recipients r WHERE r.mailing_id = mailings.id AND r.status IN ('Queued', 'Sending'))`).bind(new Date().toISOString()).run();
  return { sent, failed, throttled };
}
