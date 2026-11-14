// Email: entities that send, consent rules, message rendering and deliverability checks.
// Shared by the server (what is sent) and the screens (the preview), so they always match.

/** Each entity keeps its own list. Access to a list needs Marketing plus that entity's division. */
export const EMAIL_BRANDS = [
  { id: 'jdco', name: 'JD&Co Law Firm' },
  { id: 'lawgirl', name: 'Law Girl' },
  { id: 'plstack', name: 'The Private Lenders Stack' },
  { id: 'cbpla', name: 'CBPLA' },
  { id: 'publishing', name: 'JD Publishing' },
  { id: 'kitchen', name: 'JD in the Kitchen' },
] as const;
export type EmailBrand = (typeof EMAIL_BRANDS)[number]['id'];
export const EMAIL_BRAND_IDS = EMAIL_BRANDS.map(b => b.id) as [EmailBrand, ...EmailBrand[]];
export const emailBrandName = (id: string) => EMAIL_BRANDS.find(b => b.id === id)?.name ?? id;

/**
 * Consent bases (modelled on Canada's anti-spam law). Express consent doesn't expire until the person unsubscribes.
 * Implied consent from a purchase or contract lasts 2 years; from an inquiry, 6 months.
 */
export const CONSENT_BASES = [
  { id: 'express', label: 'Express consent (they signed up or said yes)', type: 'Express', months: 0 },
  { id: 'purchase', label: 'Implied: bought from us or had a contract (2 years)', type: 'Implied', months: 24 },
  { id: 'inquiry', label: 'Implied: asked us about our services (6 months)', type: 'Implied', months: 6 },
] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number]['id'];

export function impliedUntil(basis: ConsentBasis, consentDate: string) {
  const b = CONSENT_BASES.find(x => x.id === basis)!;
  if (!b.months) return '';
  const d = new Date(consentDate + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + b.months);
  return d.toISOString().slice(0, 10);
}

export const IMPORT_CHUNK = 500;
export const IMPORT_COLUMNS = ['email', 'firstName', 'lastName', 'company', 'phone', 'consentDate', 'consentSource'] as const;
/** Header names people commonly use in exports from Sender, HubSpot and spreadsheets. */
export const IMPORT_ALIASES: Record<string, (typeof IMPORT_COLUMNS)[number]> = {
  email: 'email', 'email address': 'email', 'e-mail': 'email', emailaddress: 'email',
  'first name': 'firstName', firstname: 'firstName', first: 'firstName', 'given name': 'firstName',
  'last name': 'lastName', lastname: 'lastName', last: 'lastName', surname: 'lastName', 'family name': 'lastName',
  company: 'company', 'company name': 'company', organization: 'company', organisation: 'company',
  phone: 'phone', 'phone number': 'phone', mobile: 'phone',
  'consent date': 'consentDate', consentdate: 'consentDate', 'opt-in date': 'consentDate', 'subscribed at': 'consentDate', 'created at': 'consentDate', 'create date': 'consentDate',
  'consent source': 'consentSource', consentsource: 'consentSource', source: 'consentSource',
};
export const isEmailAddress = (s: string) => /^[^@\s"<>,;]+@[^@\s"<>,;]+\.[a-z]{2,}$/i.test(s) && s.length <= 254;

/* ---------------- Rendering ---------------- */
export type Sender = { brand: string; fromName: string; fromEmail: string; replyTo: string; postalAddress: string; logoUrl: string; accent: string; footerNote: string };
export type MailContent = { subject: string; preheader: string; format: 'markdown' | 'html'; body: string };
export type Person = { email: string; firstName: string; lastName: string; company: string };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safeUrl = (u: string) => (/^(https:\/\/|mailto:)/i.test(u) ? u : '#');

/** Replace {{first_name}}, {{last_name}}, {{name}}, {{company}} and {{email}}, with optional fallbacks: {{first_name|there}}. */
export function merge(text: string, p: Person, escapeValues = false) {
  return text.replace(/\{\{\s*(first_name|last_name|name|company|email)\s*(?:\|([^}]*))?\}\}/g, (_, k: string, fallback = '') => {
    const v = k === 'first_name' ? p.firstName : k === 'last_name' ? p.lastName : k === 'company' ? p.company : k === 'email' ? p.email : [p.firstName, p.lastName].filter(Boolean).join(' ');
    const out = v.trim() || fallback.trim();
    return escapeValues ? esc(out) : out;
  });
}

function inline(s: string, accent: string) {
  return esc(s)
    .replace(/\[\[([^\]|]+)\|([^\]\s]+)\]\]/g, (_, t, u) => `<a href="${safeUrl(u)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:6px">${t}</a>`)
    .replace(/!\[([^\]]*)\]\((\S+?)\)/g, (_, a, u) => `<img src="${safeUrl(u)}" alt="${a}" style="max-width:100%;height:auto;border:0;display:block;margin:8px 0">`)
    .replace(/\[([^\]]+)\]\((\S+?)\)/g, (_, t, u) => `<a href="${safeUrl(u)}" style="color:${accent}">${t}</a>`)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>');
}

/**
 * A small, predictable Markdown: # headings, **bold**, *italic*, [links](https://…), ![images](https://…),
 * - bullet lists, [[Button text|https://…]] buttons, and blank lines between paragraphs.
 */
export function markdownToHtml(md: string, accent = '#C14B8A') {
  const out: string[] = [];
  for (const block of md.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    if (!lines.length) continue;
    const h = /^(#{1,3})\s+(.*)$/.exec(lines[0]);
    if (h && lines.length === 1) {
      const size = [0, 24, 20, 17][h[1].length];
      out.push(`<h${h[1].length} style="margin:0 0 14px;font-size:${size}px;line-height:1.3;color:#111111">${inline(h[2], accent)}</h${h[1].length}>`);
    } else if (lines.every(l => /^[-*]\s+/.test(l))) {
      out.push(`<ul style="margin:0 0 16px;padding-left:22px">${lines.map(l => `<li style="margin:0 0 6px">${inline(l.replace(/^[-*]\s+/, ''), accent)}</li>`).join('')}</ul>`);
    } else {
      out.push(`<p style="margin:0 0 16px">${lines.map(l => inline(l, accent)).join('<br>')}</p>`);
    }
  }
  return out.join('\n');
}

/** Plain-text version of an HTML body (every message is sent with both). */
export function htmlToText(html: string) {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, u, t) => { const tt = t.replace(/<[^>]+>/g, '').trim(); return tt && tt !== u ? `${tt} (${u})` : u; })
    .replace(/<li[^>]*>/gi, '\n- ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|h\d|div|tr|ul|ol|table)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Build the complete message for one person. The footer (sender, postal address, unsubscribe) is always added. */
export function renderEmail(s: Sender, m: MailContent, p: Person, unsubscribeUrl: string) {
  const accent = /^#[0-9a-f]{6}$/i.test(s.accent) ? s.accent : '#C14B8A';
  const body = m.format === 'html' ? merge(m.body, p, true) : markdownToHtml(merge(m.body, p), accent);
  const subject = merge(m.subject, p).replace(/[\r\n]+/g, ' ').trim();
  const pre = merge(m.preheader, p);
  const brandName = s.fromName || emailBrandName(s.brand);
  const footer = `${esc(brandName)}<br>${esc(s.postalAddress).replace(/\n/g, '<br>')}${s.footerNote ? `<br><br>${esc(s.footerNote)}` : ''}
    <br><br>You’re receiving this because you subscribed to or did business with ${esc(brandName)}.<br>
    <a href="${esc(unsubscribeUrl)}" style="color:#6b6470">Unsubscribe</a> from ${esc(brandName)} emails.`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f3f6">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(pre)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:10px;border-top:4px solid ${accent}">
${s.logoUrl ? `<tr><td style="padding:24px 32px 0"><img src="${esc(safeUrl(s.logoUrl))}" alt="${esc(brandName)}" style="max-height:56px;max-width:220px;border:0"></td></tr>` : ''}
<tr><td style="padding:24px 32px 8px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#222222">
${body}
</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px"><tr><td style="padding:18px 32px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#6b6470;text-align:center">
${footer}
</td></tr></table>
</td></tr></table></body></html>`;
  const text = `${htmlToText(body)}\n\n--\n${brandName}\n${s.postalAddress}${s.footerNote ? `\n\n${s.footerNote}` : ''}\n\nUnsubscribe: ${unsubscribeUrl}`;
  return { subject, html, text };
}

/* ---------------- Deliverability checks ---------------- */
const SPAMMY = ['act now', 'buy now', 'cash bonus', 'click here', 'free money', 'guarantee', 'limited time', 'no cost', 'risk-free', 'risk free', 'winner', 'you have been selected', '100% free', 'earn $', 'double your', 'urgent', 'congratulations', 'order now', 'call now', 'once in a lifetime'];
const SHORTENERS = /https?:\/\/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly)\//i;

export type Check = { level: 'block' | 'warn'; text: string };
/** Problems that stop a send (block) or commonly push mail toward spam folders (warn). */
export function checkMailing(m: MailContent, s: Partial<Sender> | null) {
  const out: Check[] = [];
  const block = (text: string) => out.push({ level: 'block', text }), warn = (text: string) => out.push({ level: 'warn', text });
  if (!s?.fromEmail || !s.fromName) block('Set up this entity’s sender (name and from address) first.');
  if (s && !s.postalAddress?.trim()) block('Add the entity’s postal address to its sender settings. Every commercial email must include one.');
  if (s?.fromEmail && /@(gmail|yahoo|hotmail|outlook|icloud|aol)\./i.test(s.fromEmail)) block('Send from your own domain, not a free mailbox. Gmail and Yahoo reject bulk mail that claims to be from their domains.');
  if (!m.subject.trim()) block('Add a subject line.');
  if (!m.body.trim()) block('Write the email.');
  const subj = m.subject.trim();
  if (subj.length > 70) warn('The subject is over 70 characters; it will be cut off on phones.');
  const caps = subj.replace(/[^A-Za-z]/g, ''), upper = caps.replace(/[^A-Z]/g, '');
  if (caps.length >= 8 && upper.length / caps.length > 0.6) warn('The subject is mostly capital letters, which spam filters penalize.');
  if (/[!?]{2,}/.test(subj) || (subj.match(/!/g) ?? []).length > 1) warn('Use at most one exclamation mark in the subject.');
  if (/^(re|fwd?):/i.test(subj)) warn('Don’t start a mass email with “Re:” or “Fwd:”; filters treat that as deceptive.');
  if (!m.preheader.trim()) warn('Add preview text. It shows next to the subject in most inboxes.');
  const lower = `${m.subject} ${m.body}`.toLowerCase();
  const hits = SPAMMY.filter(w => lower.includes(w));
  if (hits.length) warn(`Spam-trigger phrases: ${hits.map(h => `“${h}”`).join(', ')}. Reword them if you can.`);
  const html = m.format === 'html' ? m.body : markdownToHtml(m.body);
  const text = htmlToText(html);
  const links = (html.match(/href="https?:/g) ?? []).length, images = (html.match(/<img\b/gi) ?? []).length;
  if (m.body.trim() && text.replace(/\s+/g, ' ').length < 120) warn('There is very little text. Image-heavy or very short emails are more likely to be filtered.');
  if (images > 0 && text.length / images < 300) warn('Add more text relative to images (aim for at least a few sentences per image).');
  if (links > 15) warn(`There are ${links} links. Fewer links look less like spam.`);
  if (SHORTENERS.test(m.body)) block('Don’t use link shorteners such as bit.ly; spam filters block them. Use the full link.');
  if (/href="http:\/\//i.test(html)) warn('Use https:// links.');
  if (m.format === 'html' && /<(script|form|iframe|object|embed)\b/i.test(m.body)) block('Remove scripts, forms and embedded frames. Email programs block them.');
  return out;
}
