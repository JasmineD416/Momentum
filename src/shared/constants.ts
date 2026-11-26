// Definitions shared by the server and the screens.

export const DIVISIONS = [
  { id: 'office', name: 'Office' },
  { id: 'jdco', name: 'JD&Co Law Firm' },
  { id: 'marketing', name: 'Marketing' },
  { id: 'lawgirl', name: 'Law Girl' },
  { id: 'plstack', name: 'The Private Lenders Stack' },
  { id: 'cbpla', name: 'CBPLA' },
  { id: 'publishing', name: 'JD Publishing' },
  { id: 'kitchen', name: 'JD in the Kitchen' },
  { id: 'accounting', name: 'Accounting' },
  { id: 'properties', name: 'Properties' },
] as const;
export type DivisionId = (typeof DIVISIONS)[number]['id'];
export const DIVISION_IDS = DIVISIONS.map(d => d.id) as readonly DivisionId[];
export const divisionName = (id: string) => DIVISIONS.find(d => d.id === id)?.name ?? id;

/** Divisions only the Owner can grant: all of them. Administrators manage people but never hand out access. */
export const RESTRICTED: readonly DivisionId[] = DIVISION_IDS;

export const ROLES = ['Owner', 'Administrator', 'Member'] as const;
export type Role = (typeof ROLES)[number];

/** Document folders, each inside a division (the Office folders need the Office division). */
export const FOLDERS = [
  { id: 'hr', name: 'Human Resources', area: 'Office', division: 'office', about: 'Policies, forms and staff documents.' },
  { id: 'sops', name: 'SOPs & Templates', area: 'Office', division: 'office', about: 'Standard operating procedures and reusable templates.' },
  { id: 'pl-series', name: 'The Private Lenders Series', area: 'JD Publishing', division: 'publishing', about: 'Manuscripts, drafts and production files for the series.' },
  { id: 'lg-series', name: 'Law Girl Series', area: 'JD Publishing', division: 'publishing', about: 'Manuscripts, drafts and production files for the series.' },
  { id: 'cookbooks', name: 'JD in the Kitchen Cookbooks', area: 'JD Publishing', division: 'publishing', about: 'Recipes, manuscripts and photography for the cookbooks.' },
] as const satisfies readonly { id: string; name: string; area: string; division: DivisionId | null; about: string }[];
export type FolderId = (typeof FOLDERS)[number]['id'];
export const FOLDER_KINDS = ['Document', 'Template', 'Policy', 'Form', 'Manuscript', 'Image', 'Link', 'Note'] as const;
export const ITEM_STATUSES = ['Draft', 'In review', 'Final'] as const;

export const CHECKLIST_ITEMS = [
  ['Conflicts', 'Conflict review recorded'],
  ['Retainer', 'Signed retainer and scope reviewed'],
  ['Client details', 'Client contact and identity details reviewed'],
  ['Responsibility', 'File number, lawyer and staff assigned'],
  ['Dates', 'Key dates reviewed by responsible lawyer'],
  ['Notices', 'Notice requirements reviewed by responsible lawyer'],
  ['Documents', 'File folder and document access prepared'],
  ['Next steps', 'Initial records requests and next steps planned'],
] as const;
export const CHECKLIST_STATUSES = ['Not started', 'In progress', 'Complete', 'Not applicable'] as const;

export const MATTER_STATUSES = ['Open', 'Transferred', 'Closed'] as const;
export const CASE_TYPES = ['Motor vehicle accident', 'Personal injury', 'Slip and fall', 'Long-term disability', 'Accident benefits', 'Medical malpractice', 'Elder abuse', 'Assault', 'Vaccine injury (VISP)', 'Mortgage or lending dispute', 'Real estate', 'Employment', 'Breach of contract', 'Other'] as const;

export const PNC_STATUSES = ['New', 'Contacting', 'Consult booked', 'Retained', 'Referred', 'Not retained', 'Closed'] as const;
/** Statuses staff can choose directly; Retained and Referred come from their own workflows. */
export const PNC_EDITABLE_STATUSES = ['New', 'Contacting', 'Consult booked', 'Not retained', 'Closed'] as const;
export const URGENCIES = ['Low', 'Normal', 'High', 'Urgent'] as const;
export const ATTEMPT_METHODS = ['Call', 'Email', 'Voicemail', 'Text', 'Meeting', 'Other'] as const;
export const ATTEMPT_OUTCOMES = ['Reached', 'No answer', 'Left message', 'Wrong number', 'Consult booked', 'Other'] as const;

/** Intake fields stored in pncs.data (allow-list). */
export const PNC_DATA_FIELDS = [
  'dob', 'address', 'preferredContact', 'source', 'referrer', 'lossDate', 'firstContact', 'intakeStaffId', 'summary', 'opposingParty',
  'jurisdiction', 'propertyAddress', 'lendingCompany', 'loanAmountCents', 'lenderOrBorrower', 'closingDate', 'licenceType',
  'limitationDate', 'noticeDate', 'verifiedBy', 'verifiedBasis', 'nonRetainerSent', 'letterLink', 'closingReason',
  'receivingLawyerId', 'consentDate', 'consentLawyerId', 'consentEvidence', 'referralOutcome', 'referralReason', 'feeNotes',
  'retainerDate', 'responsibleLawyerId',
] as const;

export const CURRENCIES = ['CAD', 'USD'] as const;
export const PAY_STATUSES = ['Unpaid', 'Paid', 'Reimbursed', 'Unknown'] as const;
export const BOOK_STATUSES = ['Not submitted', 'Submitted', 'Reconciled'] as const;
export const EXPENSE_CATEGORIES = ['Court and filing fees', 'Medical and other records', 'Process server', 'Expert report', 'Transcripts', 'Searches', 'Courier and postage', 'Mediation', 'Travel', 'Other'] as const;

export const IMPORT_TARGETS = {
  clients: { label: 'Clients', division: 'jdco', columns: ['lastName', 'firstName', 'dob', 'email', 'phone', 'address', 'instructions'] },
  matters: { label: 'Matters', division: 'jdco', columns: ['client', 'dob', 'fileNumber', 'caseType', 'lawyer', 'lossDate', 'status', 'opened', 'closed', 'notes'] },
  clientExpenses: { label: 'Client expenses', division: 'jdco', columns: ['fileNumber', 'date', 'provider', 'description', 'category', 'reference', 'currency', 'amount', 'hst', 'payStatus', 'paidDate', 'receipt', 'notes'] },
  pncs: { label: 'PNC intake', division: 'jdco', columns: ['name', 'phone', 'email', 'source', 'caseType', 'lossDate', 'nextAction', 'followUp'] },
  divisionContacts: { label: 'Division contacts', division: null, columns: ['name', 'organization', 'role', 'email', 'phone', 'notes'] },
} as const;
export type ImportTarget = keyof typeof IMPORT_TARGETS;
export const IMPORT_LIMITS = { rows: 100, columns: 60, bytes: 300 * 1024 } as const;

/* ---------------- Phase 2: marketing, team work, reports and reminders ---------------- */

/** Business brands that marketing records, team work and expenses belong to. */
export const BRANDS = ['JD&Co Law Firm', 'Law Girl', 'The Private Lenders Stack', 'CBPLA', 'JD Publishing', 'JD in the Kitchen'] as const;

export const CONTACT_SOURCES = ['Website', 'Referral', 'Event', 'Social', 'Podcast', 'Email', 'Import', 'Other'] as const;
/** Email permission is recorded, never acted on: Momentum doesn’t send campaigns. */
export const EMAIL_PERMISSIONS = ['Unknown', 'Granted', 'Declined', 'Unsubscribed'] as const;

/** Each pipeline defines its own stages; every pipeline ends in Won or Lost. */
export const PIPELINES = {
  'Software sales': { about: 'Product inquiries and sales opportunities', stages: ['Inquiry', 'Demo', 'Proposal', 'Negotiation', 'Won', 'Lost'] },
  'CBPLA memberships': { about: 'Membership interest and conversion', stages: ['Interested', 'Application', 'Payment pending', 'Won', 'Lost'] },
  Sponsorships: { about: 'Prospective sponsor relationships', stages: ['Prospect', 'Pitched', 'Proposal', 'Negotiation', 'Won', 'Lost'] },
  Partnerships: { about: 'Commercial and professional partnerships', stages: ['Exploring', 'In discussion', 'Agreement drafting', 'Won', 'Lost'] },
  'Podcast and media': { about: 'Guests, coverage and media opportunities', stages: ['Idea', 'Pitched', 'Scheduled', 'Recorded', 'Won', 'Lost'] },
  Speaking: { about: 'Speaking and teaching opportunities', stages: ['Lead', 'Submitted', 'Confirmed', 'Won', 'Lost'] },
} as const satisfies Record<string, { about: string; stages: readonly string[] }>;
export type Pipeline = keyof typeof PIPELINES;
export const PIPELINE_NAMES = Object.keys(PIPELINES) as Pipeline[];
export const isClosedStage = (stage: string) => stage === 'Won' || stage === 'Lost';

export const ACTIVITY_METHODS = ['Call', 'Email', 'Meeting', 'Video call', 'Text', 'Social message', 'Event', 'Other'] as const;
export const ACTIVITY_DIRECTIONS = ['Outbound', 'Inbound'] as const;
export const ACTIVITY_OUTCOMES = ['Reached', 'No answer', 'Left message', 'Replied', 'Meeting booked', 'Not interested', 'Other'] as const;

export const CAMPAIGN_STATUSES = ['Planned', 'Active', 'Paused', 'Completed', 'Cancelled'] as const;
export const MARKETING_EXPENSE_CATEGORIES = ['Advertising', 'Sponsorship', 'Events', 'Software', 'Design and creative', 'Printing', 'Contractors', 'Gifts and swag', 'Travel', 'Other'] as const;

export const PROGRAM_STATUSES = ['Active', 'Trial', 'Paused', 'Cancelled'] as const;
export const BILLING_CYCLES = ['Monthly', 'Annual', 'One-time', 'Free', 'Other'] as const;
/** Who can see a program entry: all marketing staff, JD&Co staff only, or administrators only. */
export const PROGRAM_VISIBILITY = [['general', 'Everyone in Marketing'], ['firm', 'JD&Co Law Firm only'], ['admin', 'Administrators only']] as const;

export const WORK_TYPES = ['Social post', 'Blog or article', 'Email newsletter', 'Video', 'Podcast', 'Design', 'Event', 'Website', 'Admin', 'Other'] as const;
export const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'] as const;
export const TASK_STATUSES = ['Planned', 'In progress', 'Ready for review', 'Approved', 'Published', 'Completed'] as const;
/** Statuses only an administrator can set, or move a task out of. */
export const ADMIN_TASK_STATUSES: readonly string[] = ['Approved', 'Published'];
export const DONE_TASK_STATUSES: readonly string[] = ['Published', 'Completed'];

export const REPORT_KINDS = ['daily', 'weekly'] as const;
export const REPORT_SCOPES = ['general', 'firm'] as const;
export const REPORT_FIELDS = [
  ['completed', 'Completed work'], ['inProgress', 'Work in progress'], ['blockers', 'Blockers'], ['decisions', 'Decisions needed from Jasmine'], ['nextPriorities', 'Next priorities'],
] as const;

/** Add UTM parameters to a landing URL. Momentum builds the link only; it doesn’t install tracking or read analytics. */
export function utmUrl(landing: string, p: { source?: string; medium?: string; campaign?: string; content?: string; term?: string }) {
  if (!landing) return '';
  let u: URL;
  try { u = new URL(landing); } catch { return ''; }
  for (const [k, v] of Object.entries(p)) {
    const val = (v ?? '').trim();
    if (val) u.searchParams.set(`utm_${k}`, val); else u.searchParams.delete(`utm_${k}`);
  }
  return u.toString();
}

/* Team › Expense claims */
export const CLAIM_PAY_METHODS = ['Credit card', 'E-transfer'] as const;
export const CARD_TYPES = ['Visa', 'Mastercard', 'American Express', 'Other'] as const;
export const CLAIM_STATUSES = ['Submitted', 'Approved', 'Declined', 'Reimbursed'] as const;
