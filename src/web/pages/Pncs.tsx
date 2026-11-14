import { useState } from 'react';
import { ATTEMPT_METHODS, ATTEMPT_OUTCOMES, CASE_TYPES, PNC_EDITABLE_STATUSES, PNC_STATUSES, URGENCIES } from '../../shared/constants';
import { api, ApiError } from '../api';
import { businessToday, fmtDate, fmtDateTime, money } from '../format';
import { go, href } from '../router';
import { memberOptions, useSession } from '../session';
import { copyText, DataTable, DefList, FormModal, Loaded, Modal, PageHead, Pill, Status, useLoad, useToast, type Field, type Values } from '../ui';

type Pnc = { id: string; name: string; email: string; phone: string; status: string; urgency: string; caseType: string; assignedStaffId: string | null; assignedName?: string; nextAction: string; followUp: string; data: Record<string, any>; convertedClientId: string | null; convertedMatterId: string | null; rev: number; attemptCount?: number };
type Attempt = { id: string; at: string; method: string; outcome: string; notes: string; actorName: string; historicalStaff: string };

const DATA_KEYS = ['dob', 'address', 'preferredContact', 'source', 'referrer', 'lossDate', 'firstContact', 'intakeStaffId', 'summary', 'opposingParty', 'jurisdiction', 'propertyAddress', 'lendingCompany', 'loanAmountCents', 'lenderOrBorrower', 'closingDate', 'licenceType', 'limitationDate', 'noticeDate', 'verifiedBy', 'verifiedBasis', 'nonRetainerSent', 'letterLink', 'closingReason'];

function PncForm({ pnc, onClose, onSaved }: { pnc?: Pnc; onClose: () => void; onSaved: (id: string) => void }) {
  const { members, me } = useSession();
  const toast = useToast();
  const staff = memberOptions(members, 'jdco');
  const fields: Field[] = [
    { k: 'h1', l: 'Contact and source', t: 'h' },
    { k: 'name', l: 'Name', req: true }, { k: 'dob', l: 'Date of birth', t: 'date' }, { k: 'phone', l: 'Phone', t: 'tel' }, { k: 'email', l: 'Email', t: 'email' },
    { k: 'address', l: 'Address', full: true }, { k: 'preferredContact', l: 'Preferred contact', t: 'select', o: ['Phone', 'Email', 'Text'] },
    { k: 'source', l: 'Source', t: 'select', o: ['Website', 'Referral', 'Google', 'Social', 'Event', 'Podcast', 'Other'] }, { k: 'referrer', l: 'Referring person or campaign', full: true },
    { k: 'h2', l: 'Intake and responsibility', t: 'h' },
    { k: 'caseType', l: 'Case type', t: 'select', o: CASE_TYPES }, { k: 'lossDate', l: 'Date of loss', t: 'date' },
    { k: 'firstContact', l: 'First contact', t: 'date' }, { k: 'urgency', l: 'Urgency', t: 'select', blank: false, o: URGENCIES },
    { k: 'intakeStaffId', l: 'Intake staff', t: 'select', o: staff }, { k: 'assignedStaffId', l: 'Assigned staff', t: 'select', o: staff },
    { k: 'summary', l: 'Summary', t: 'textarea' }, { k: 'opposingParty', l: 'Opposing party' }, { k: 'jurisdiction', l: 'Jurisdiction' },
    { k: 'h3', l: 'Lending and property', t: 'h' },
    { k: 'propertyAddress', l: 'Property address', full: true }, { k: 'lendingCompany', l: 'Company' }, { k: 'loanAmountCents', l: 'Loan amount', t: 'money' },
    { k: 'lenderOrBorrower', l: 'Lender or borrower', t: 'select', o: ['Lender', 'Borrower'] }, { k: 'closingDate', l: 'Closing date', t: 'date' }, { k: 'licenceType', l: 'Licence type' },
    { k: 'h4', l: 'Follow-ups and dates', t: 'h' },
    { k: 'nextAction', l: 'Next action' }, { k: 'followUp', l: 'Follow-up date', t: 'date' },
    { k: 'limitationDate', l: 'Limitation date (manually verified)', t: 'date' }, { k: 'noticeDate', l: 'Notice date (manually verified)', t: 'date' },
    { k: 'verifiedBy', l: 'Verified by' }, { k: 'verifiedBasis', l: 'Verification basis' },
    { k: 'h5', l: 'Status', t: 'h' },
    { k: 'status', l: 'Status', t: 'select', blank: false, o: PNC_EDITABLE_STATUSES, help: 'Retained and Referred are set through their own workflows.' },
    { k: 'nonRetainerSent', l: 'Non-retainer letter sent', t: 'date' }, { k: 'letterLink', l: 'Letter link', t: 'url' }, { k: 'closingReason', l: 'Closing reason' },
  ];
  const initial: Values = pnc ? { ...pnc.data, ...pnc, loanAmountCents: pnc.data.loanAmountCents ?? '' } : { status: 'New', urgency: 'Normal', intakeStaffId: me.id, firstContact: businessToday() };
  return (
    <FormModal title={pnc ? 'Edit PNC' : 'Add PNC'} fields={fields} initial={initial} onClose={onClose}
      note="Momentum doesn’t calculate limitation or notice periods. Enter only dates a lawyer has verified."
      onSubmit={async v => {
        const data: Record<string, unknown> = {};
        for (const k of DATA_KEYS) data[k] = k === 'loanAmountCents' ? (v[k] || null) : (v[k] ?? '');
        if (data.intakeStaffId === '') data.intakeStaffId = null;
        const status = pnc && ['Retained', 'Referred'].includes(pnc.status) ? 'Consult booked' : v.status;
        const payload = { name: v.name, email: v.email ?? '', phone: v.phone ?? '', status, urgency: v.urgency, caseType: v.caseType ?? '', assignedStaffId: v.assignedStaffId || null, nextAction: v.nextAction ?? '', followUp: v.followUp ?? '', data };
        if (pnc) { await api.patch(`/api/pncs/${pnc.id}`, { ...payload, rev: pnc.rev }); onSaved(pnc.id); }
        else { const r = await api.post<{ id: string }>('/api/pncs', payload); onSaved(r.id); }
        toast('PNC saved.');
      }} />
  );
}

const FILTERS = ['Active', ...PNC_STATUSES, 'All'];
export function Pncs() {
  const [filter, setFilter] = useState('Active');
  const list = useLoad(() => api.get<{ pncs: Pnc[] }>(`/api/pncs?status=${encodeURIComponent(filter)}`), [filter]);
  const [adding, setAdding] = useState(false);
  const today = businessToday();
  return (
    <>
      <PageHead title="PNC tracker" sub="Potential new clients, from first contact to retainer, referral or non-retainer." actions={<button className="btn primary" onClick={() => setAdding(true)}>Add PNC</button>} />
      <div className="tabs">{FILTERS.map(s => <button key={s} type="button" className={s === filter ? 'on' : ''} aria-pressed={s === filter} onClick={() => setFilter(s)}>{s}</button>)}</div>
      <Loaded state={list}>{d => (
        <DataTable rows={d.pncs} rowKey={p => p.id} empty="No PNCs match." search={{ placeholder: 'Search PNCs', text: p => [p.name, p.email, p.phone, p.caseType, p.nextAction].join(' ') }}
          rowClass={p => (p.followUp && p.followUp < today && !['Retained', 'Referred', 'Not retained', 'Closed'].includes(p.status) ? 'overdue' : '')}
          columns={[
            { label: 'Name', render: p => <><a className="name" href={href(`pnc/${p.id}`)}>{p.name}</a><div className="muted">{p.phone || p.email}</div></> },
            { label: 'Case type', render: p => p.caseType || '—' }, { label: 'Urgency', render: p => <Status s={p.urgency} /> },
            { label: 'Assigned', render: p => p.assignedName ?? '—' }, { label: 'Status', render: p => <Status s={p.status} /> },
            { label: 'Next action', render: p => p.nextAction ? <>{p.nextAction}<div className="muted">{fmtDate(p.followUp)}</div></> : '—' },
            { label: 'Attempts', num: true, render: p => p.attemptCount ?? 0 },
          ]} />
      )}</Loaded>
      {adding && <PncForm onClose={() => setAdding(false)} onSaved={id => go(`pnc/${id}`)} />}
    </>
  );
}

export function PncDetail({ id }: { id: string }) {
  const d = useLoad(() => api.get<{ pnc: Pnc; attempts: Attempt[] }>(`/api/pncs/${id}`), [id]);
  const counsel = useLoad(() => api.get<{ counsel: { id: string; name: string; firm: string }[] }>('/api/counsel'), []);
  const toast = useToast();
  const [modal, setModal] = useState<'' | 'edit' | 'attempt' | 'referral' | 'convert' | 'summary'>('');
  const [summary, setSummary] = useState('');
  const [candidates, setCandidates] = useState<{ id: string; lastName: string; firstName: string; dob: string; email: string }[]>([]);
  const lawyerOpts = (counsel.data?.counsel ?? []).map(l => [l.id, l.firm ? `${l.name} (${l.firm})` : l.name] as [string, string]);
  const lawyerName = (lid?: string | null) => counsel.data?.counsel.find(l => l.id === lid)?.name ?? '';
  return (
    <Loaded state={d}>{({ pnc: p, attempts }) => {
      const x = p.data;
      const consentOk = x.consentDate && x.consentLawyerId === x.receivingLawyerId;
      return (
        <>
          <PageHead title={p.name} sub={<><Status s={p.status} /> <Status s={p.urgency} /></>} crumb={<a href={href('pncs')}>← PNC tracker</a>}
            actions={p.status !== 'Retained' ? <button className="btn" onClick={() => setModal('edit')}>Edit intake</button> : undefined} />
          <section className="card">
            <div className="dl-h">Contact and source</div>
            <DefList items={[['Phone', p.phone], ['Email', p.email], ['Date of birth', x.dob ? fmtDate(x.dob) : ''], ['Address', x.address], ['Preferred contact', x.preferredContact], ['Source', x.source], ['Referred by', x.referrer]]} />
            <div className="dl-h">Intake</div>
            <DefList items={[['Case type', p.caseType], ['Date of loss', x.lossDate ? fmtDate(x.lossDate) : ''], ['First contact', x.firstContact ? fmtDate(x.firstContact) : ''], ['Assigned staff', p.assignedName ?? ''], ['Opposing party', x.opposingParty], ['Jurisdiction', x.jurisdiction], ['Summary', <span style={{ whiteSpace: 'pre-wrap' }}>{x.summary}</span>]]} />
            {(x.propertyAddress || x.lendingCompany || x.loanAmountCents) && <><div className="dl-h">Lending and property</div>
              <DefList items={[['Property', x.propertyAddress], ['Company', x.lendingCompany], ['Loan amount', x.loanAmountCents ? money(x.loanAmountCents) : ''], ['Lender or borrower', x.lenderOrBorrower], ['Closing date', x.closingDate ? fmtDate(x.closingDate) : ''], ['Licence type', x.licenceType]]} /></>}
            <div className="dl-h">Follow-ups and dates</div>
            <DefList items={[['Next action', p.nextAction], ['Follow-up', p.followUp ? fmtDate(p.followUp) : ''], ['Limitation date', x.limitationDate ? fmtDate(x.limitationDate) : ''], ['Notice date', x.noticeDate ? fmtDate(x.noticeDate) : ''], ['Verified by', x.verifiedBy], ['Basis', x.verifiedBasis]]} />
          </section>
          <section className="card"><h3>Contact attempts <button className="btn sm primary" onClick={() => setModal('attempt')}>Log attempt</button></h3>
            <DataTable rows={attempts} rowKey={a => a.id} empty="No contact attempts logged."
              columns={[
                { label: 'When', render: a => fmtDateTime(a.at) }, { label: 'Method', render: a => a.method }, { label: 'Outcome', render: a => a.outcome }, { label: 'Notes', render: a => a.notes || '—' },
                { label: 'Staff', render: a => a.historicalStaff ? <>{a.historicalStaff} <Pill>Imported</Pill><div className="muted">Imported by {a.actorName}</div></> : a.actorName },
              ]} />
          </section>
          <div className="cols2">
            <section className="card"><h3>Referral {p.status !== 'Retained' && <button className="btn sm" onClick={() => setModal('referral')}>Edit referral</button>}</h3>
              <DefList items={[['Receiving lawyer', lawyerName(x.receivingLawyerId)], ['Consent date', consentOk ? fmtDate(x.consentDate) : x.receivingLawyerId ? <span style={{ color: 'var(--bad)' }}>Needs dated consent for this lawyer</span> : ''], ['Consent evidence', x.consentEvidence], ['Outcome', x.referralOutcome], ['Fee review notes', x.feeNotes]]} />
              <div style={{ marginTop: 12 }}><button className="btn sm" onClick={async () => { try { setSummary((await api.get<{ text: string }>(`/api/pncs/${p.id}/referral-summary`)).text); setModal('summary'); } catch (e) { toast((e as Error).message); } }}>Prepare referral summary</button></div>
              <p className="note">Preparing or copying a summary sends nothing. Fee fields record a lawyer’s review; Momentum doesn’t check fee compliance.</p>
            </section>
            <section className="card"><h3>Open a client file</h3>
              {p.convertedMatterId ? <p style={{ marginTop: 0 }}>Converted to a client file. <a href={href(`client/${p.convertedClientId}`)}>Open the client</a>. Retainer signed {fmtDate(x.retainerDate)}.</p>
                : p.status === 'Referred' ? <p className="muted" style={{ margin: 0 }}>This PNC was referred out.</p>
                : <><p className="muted" style={{ marginTop: 0 }}>Record the signed retainer, retainer date, responsible lawyer and a unique file number. The intake and contact history are kept.</p><button className="btn accent" onClick={() => { setCandidates([]); setModal('convert'); }}>Convert to client file</button></>}
            </section>
          </div>

          {modal === 'edit' && <PncForm pnc={p} onClose={() => setModal('')} onSaved={() => d.reload()} />}
          {modal === 'attempt' && <FormModal title="Log contact attempt" size="narrow" onClose={() => setModal('')}
            initial={{ at: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) }}
            fields={[{ k: 'at', l: 'Actual date and time', t: 'datetime', req: true }, { k: 'method', l: 'Method', t: 'select', req: true, o: ATTEMPT_METHODS }, { k: 'outcome', l: 'Outcome', t: 'select', req: true, o: ATTEMPT_OUTCOMES }, { k: 'notes', l: 'Notes', t: 'textarea' }]}
            onSubmit={async v => { await api.post(`/api/pncs/${p.id}/attempts`, { at: new Date(v.at).toISOString(), method: v.method, outcome: v.outcome, notes: v.notes ?? '' }); toast('Attempt logged.'); d.reload(); }} />}
          {modal === 'referral' && <FormModal title="Referral" size="narrow" onClose={() => setModal('')} initial={{ ...x, markReferred: p.status === 'Referred' }}
            fields={[
              { k: 'receivingLawyerId', l: 'Receiving lawyer', t: 'select', o: lawyerOpts, full: true },
              { k: 'consentDate', l: 'Consent date', t: 'date', help: 'Consent must name this specific lawyer.' }, { k: 'consentEvidence', l: 'Consent evidence' },
              { k: 'referralOutcome', l: 'Outcome', t: 'select', o: ['Pending', 'Accepted', 'Declined'] }, { k: 'referralReason', l: 'Outcome reason' },
              { k: 'feeNotes', l: 'Fee review notes', t: 'textarea' }, { k: 'markReferred', l: 'Status', t: 'check', cl: 'Referral accepted; mark this PNC as Referred' },
            ]}
            onSubmit={async v => {
              const r = await api.patch<{ consentCleared: boolean }>(`/api/pncs/${p.id}/referral`, { receivingLawyerId: v.receivingLawyerId || null, consentDate: v.consentDate ?? '', consentEvidence: v.consentEvidence ?? '', referralOutcome: v.referralOutcome ?? '', referralReason: v.referralReason ?? '', feeNotes: v.feeNotes ?? '', markReferred: !!v.markReferred, rev: p.rev });
              toast(r.consentCleared ? 'The lawyer changed, so the earlier consent was cleared. Record fresh consent.' : 'Referral saved.'); d.reload();
            }} />}
          {modal === 'summary' && <Modal title="Referral summary" onClose={() => setModal('')} footer={<><button className="btn" onClick={() => copyText(summary, toast)}>Copy</button><button className="btn ghost" onClick={() => setModal('')}>Close</button></>}>
            <textarea readOnly rows={16} value={summary} aria-label="Referral summary" style={{ width: '100%', font: 'inherit', padding: 10, border: '1px solid var(--line)', borderRadius: 8 }} />
            <p className="note">Nothing has been sent. Copy this into your own email if you choose to send it.</p>
          </Modal>}
          {modal === 'convert' && <FormModal title="Convert to client file" size="narrow" onClose={() => setModal('')} submitLabel="Open client file"
            initial={{ caseType: p.caseType, lawyerId: lawyerOpts.find(([, n]) => n.startsWith('Jasmine Daya'))?.[0] ?? '' }}
            intro={candidates.length ? <div className="warnbox">{candidates.length === 1 ? 'An existing client looks' : `${candidates.length} existing clients look`} like a match. Choose one to link, or create a new client.</div> : null}
            fields={[
              ...((['Not retained', 'Closed'].includes(p.status) || x.nonRetainerSent) ? [{ k: 'conflictReviewed', l: 'Prior status review', t: 'check', req: true, full: true, cl: 'I reviewed the non-retainer or closed-intake status' } as Field] : []),
              ...(candidates.length ? [{ k: 'linkClientId', l: 'Possible existing client', t: 'select', req: true, full: true, blank: 'Choose an option', o: [...candidates.map(c => [c.id, `Link to ${c.lastName}, ${c.firstName} (DOB ${c.dob || '—'}, ${c.email || 'no email'})`] as [string, string]), ['new', 'Create a new client anyway'] as [string, string]] } as Field] : []),
              { k: 'retainerSigned', l: 'Signed retainer', t: 'check', req: true, cl: 'The retainer is signed' }, { k: 'retainerDate', l: 'Retainer date', t: 'date', req: true },
              { k: 'lawyerId', l: 'Responsible lawyer', t: 'select', req: true, o: lawyerOpts }, { k: 'fileNumber', l: 'File number', req: true },
              { k: 'caseType', l: 'Case type', t: 'select', req: true, o: CASE_TYPES },
            ]}
            onSubmit={async v => {
              try {
                const r = await api.post<{ clientId: string }>(`/api/pncs/${p.id}/convert`, { retainerSigned: !!v.retainerSigned, retainerDate: v.retainerDate, lawyerId: v.lawyerId, fileNumber: v.fileNumber, caseType: v.caseType, conflictReviewed: !!v.conflictReviewed, linkClientId: v.linkClientId && v.linkClientId !== 'new' ? v.linkClientId : null, createNewClient: v.linkClientId === 'new', rev: p.rev });
                toast('Client file opened.'); go(`client/${r.clientId}`);
              } catch (e) {
                if (e instanceof ApiError && e.status === 409 && Array.isArray(e.data.candidates)) { setCandidates(e.data.candidates as typeof candidates); throw new Error('This person may already be a client. Choose one to link below, or choose to create a new client, then select Open client file again.'); }
                throw e;
              }
            }} />}
        </>
      );
    }}</Loaded>
  );
}

