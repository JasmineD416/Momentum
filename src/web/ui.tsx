import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from './api';
import { parseCents } from './format';

/* ---------------- Data loading ---------------- */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: ApiError | Error; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState(s => ({ ...s, loading: true }));
    load().then(data => live && setState({ data, loading: false }), error => live && setState({ error, loading: false }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: useCallback(() => setTick(t => t + 1), []) };
}

/** Standard wrapper: loading line, readable error (incl. Access denied), or the content. */
export function Loaded<T>({ state, children }: { state: { data?: T; error?: Error; loading: boolean }; children: (data: T) => ReactNode }) {
  if (state.error) {
    const denied = state.error instanceof ApiError && state.error.status === 403;
    return <>{denied ? <PageHead title="Access denied" /> : null}<section className="card"><p style={{ margin: 0 }}>{state.error.message}</p></section></>;
  }
  if (state.data === undefined) return <p className="muted">Loading…</p>;
  return <>{children(state.data)}</>;
}

/* ---------------- Toasts ---------------- */
const ToastCtx = createContext<(text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; text: string }[]>([]);
  const show = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setItems(x => [...x, { id, text }]);
    setTimeout(() => setItems(x => x.filter(i => i.id !== id)), 3500);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">{items.map(i => <div key={i.id} className="toast">{i.text}</div>)}</div>
    </ToastCtx.Provider>
  );
}

/* ---------------- Small pieces ---------------- */
const STATUS_CLS: Record<string, string> = {
  Open: 'ok', Active: 'ok', Transferred: 'warn', Closed: '', Archived: '', Complete: 'ok', 'Not applicable': '', 'In progress': 'info', 'Not started': '',
  Unpaid: 'warn', Paid: 'ok', Reimbursed: 'ok', Unknown: '', 'Not submitted': '', Submitted: 'info', Reconciled: 'ok', Recorded: '', Voided: 'bad',
  New: 'pink', Contacting: 'info', 'Consult booked': 'warn', Retained: 'ok', Referred: 'info', 'Not retained': '', Urgent: 'bad', High: 'warn',
  Draft: 'warn', 'In review': 'info', Final: 'ok', Owner: 'pink', Administrator: 'pink', Member: '', Ready: 'ok', Duplicate: 'warn', Error: 'bad', Committed: 'ok', Skipped: '',
  Planned: '', 'Ready for review': 'warn', Approved: 'info', Published: 'ok', Completed: 'ok', Paused: 'warn', Cancelled: '', Trial: 'info',
  Reviewed: 'ok', Granted: 'ok', Declined: 'bad', Unsubscribed: 'bad', Won: 'ok', Lost: 'bad', Low: '', Normal: '',
};
export const Pill = ({ children, cls = '' }: { children: ReactNode; cls?: string }) => <span className={`pill ${cls}`}>{children}</span>;
export const Status = ({ s }: { s?: string | null }) => (s ? <Pill cls={STATUS_CLS[s] ?? ''}>{s}</Pill> : <span className="muted">—</span>);
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;
export const Ext = ({ href, children = 'Open' }: { href?: string | null; children?: ReactNode }) =>
  href ? <a href={href} target="_blank" rel="noopener noreferrer">{children} ↗</a> : <span className="muted">—</span>;

export function PageHead({ title, sub, actions, crumb }: { title: string; sub?: ReactNode; actions?: ReactNode; crumb?: ReactNode }) {
  useEffect(() => { document.title = `${title} · Momentum`; }, [title]);
  return (
    <div className="ph">
      <div>{crumb && <div className="crumb">{crumb}</div>}<h1>{title}</h1>{sub && <p>{sub}</p>}</div>
      {actions && <div className="acts">{actions}</div>}
    </div>
  );
}

export function DefList({ items }: { items: [string, ReactNode][] }) {
  return <dl className="dl">{items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v === '' || v === null || v === undefined ? <span className="muted">—</span> : v}</dd></div>)}</dl>;
}

/* ---------------- Tables with search ---------------- */
export type Column<T> = { label: string; num?: boolean; render: (row: T) => ReactNode };
export function DataTable<T>({ columns, rows, empty, search, rowClass, rowKey, foot }: {
  columns: Column<T>[]; rows: T[]; empty: ReactNode; search?: { placeholder: string; text: (row: T) => string }; rowClass?: (row: T) => string; rowKey: (row: T) => string; foot?: ReactNode;
}) {
  const [q, setQ] = useState('');
  const shown = search && q.trim() ? rows.filter(r => search.text(r).toLowerCase().includes(q.trim().toLowerCase())) : rows;
  return (
    <>
      {search && <div className="toolbar"><input type="search" placeholder={search.placeholder} aria-label={search.placeholder} value={q} onChange={e => setQ(e.target.value)} /></div>}
      {!rows.length ? <Empty>{empty}</Empty> : !shown.length ? <Empty>Nothing matches “{q}”.</Empty> : (
        <div className="tblwrap"><table>
          <thead><tr>{columns.map((c, i) => <th key={i} className={c.num ? 'num' : undefined}>{c.label || <span className="sr">Actions</span>}</th>)}</tr></thead>
          <tbody>{shown.map(r => <tr key={rowKey(r)} className={rowClass?.(r)}>{columns.map((c, i) => <td key={i} className={c.num ? 'num' : undefined}>{c.render(r)}</td>)}</tr>)}</tbody>
          {foot}
        </table></div>
      )}
    </>
  );
}

/* ---------------- Dialogs ---------------- */
export function Modal({ title, onClose, children, footer, size = '' }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: '' | 'narrow' }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current!; if (!d.open) d.showModal(); return () => d.close(); }, []);
  return (
    <dialog ref={ref} className={`modal ${size}`} onCancel={e => { e.preventDefault(); onClose(); }}>
      <div className="dlg">
        <header><h2>{title}</h2><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>×</button></header>
        <div className="body">{children}</div>
        <footer>{footer ?? <button type="button" className="btn ghost" onClick={onClose}>Close</button>}</footer>
      </div>
    </dialog>
  );
}

export function Confirm({ title, text, label, onConfirm, onClose }: { title: string; text: ReactNode; label: string; onConfirm: () => Promise<void>; onClose: () => void }) {
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} size="narrow" footer={<>
      <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
      <button type="button" className="btn primary" disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } catch (e) { setErr((e as Error).message); setBusy(false); } }}>{label}</button>
    </>}>
      <p style={{ marginTop: 0 }}>{text}</p>{err && <p className="err" role="alert">{err}</p>}
    </Modal>
  );
}

/* ---------------- Forms ---------------- */
type Opt = string | [string, string];
export type Field = {
  k: string; l: string; t?: 'text' | 'email' | 'tel' | 'date' | 'datetime' | 'select' | 'textarea' | 'money' | 'check' | 'multi' | 'url' | 'number' | 'password' | 'file' | 'h';
  o?: readonly Opt[]; req?: boolean; full?: boolean; help?: string; cl?: string; blank?: string | false; rows?: number;
  /** Money only: an empty box gives null ("not recorded") instead of 0. */
  nullable?: boolean;
  /** File only: accepted types, as for <input accept>. */
  accept?: string;
};
export type Values = Record<string, any>;

function FieldInput({ f, v, set }: { f: Field; v: any; set: (v: any) => void }) {
  const id = useId();
  const opts = (f.o ?? []).map(o => (Array.isArray(o) ? o : [o, o]) as [string, string]);
  const label = <label htmlFor={id}>{f.l}{f.req && <span className="req" aria-hidden="true"> *</span>}</label>;
  const help = f.help ? <small>{f.help}</small> : null;
  if (f.t === 'h') return <div className="fh">{f.l}</div>;
  if (f.t === 'check') return <div className={`field${f.full ? ' full' : ''}`}><span className="lbl">{f.l}</span><label className="chk"><input id={id} type="checkbox" checked={!!v} onChange={e => set(e.target.checked)} /> {f.cl ?? 'Yes'}</label>{help}</div>;
  if (f.t === 'multi') return <div className="field full"><span className="lbl">{f.l}</span><div className="multi">{opts.map(([val, txt]) => (
    <label key={val} className="chk"><input type="checkbox" checked={(v ?? []).includes(val)} onChange={e => set(e.target.checked ? [...(v ?? []), val] : (v ?? []).filter((x: string) => x !== val))} /> {txt}</label>
  ))}</div>{help}</div>;
  let input: ReactNode;
  if (f.t === 'select') input = <select id={id} value={v ?? ''} onChange={e => set(e.target.value)} aria-required={f.req}>{f.blank !== false && <option value="">{f.blank || '—'}</option>}{opts.map(([val, txt]) => <option key={val} value={val}>{txt}</option>)}</select>;
  else if (f.t === 'textarea') input = <textarea id={id} rows={f.rows ?? 3} value={v ?? ''} onChange={e => set(e.target.value)} />;
  else if (f.t === 'file') input = <input id={id} type="file" accept={f.accept} onChange={e => set(e.target.files?.[0] ?? null)} />;
  else if (f.t === 'money') input = <input id={id} inputMode="decimal" placeholder="0.00" value={v ?? ''} onChange={e => set(e.target.value)} />;
  else input = <input id={id} type={f.t === 'datetime' ? 'datetime-local' : f.t === 'url' ? 'url' : f.t ?? 'text'} value={v ?? ''} onChange={e => set(e.target.value)} autoComplete={f.t === 'password' ? 'new-password' : undefined} />;
  return <div className={`field${f.full || f.t === 'textarea' ? ' full' : ''}`}>{label}{input}{help}</div>;
}

/** Money fields are edited as "125.00" strings and handed back as integer cents. */
function toForm(fields: Field[], initial: Values) {
  const out: Values = { ...initial };
  for (const f of fields) if (f.t === 'money') out[f.k] = typeof initial[f.k] === 'number' ? (initial[f.k] / 100).toFixed(2) : '';
  return out;
}
function fromForm(fields: Field[], values: Values): Values | string {
  const out: Values = { ...values };
  for (const f of fields) {
    if (f.t === 'h') continue;
    const v = values[f.k];
    if (f.req && (v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && !v.length))) return `${f.l} is required.`;
    if (f.t === 'money') {
      if (v === undefined || v === null || v === '') out[f.k] = f.req ? NaN : f.nullable ? null : 0;
      else { const c = parseCents(String(v)); if (Number.isNaN(c)) return `${f.l} must be an amount, like 125.00.`; out[f.k] = c; }
    }
    if (f.t === 'url' && v && !/^https:\/\/\S+$/i.test(String(v))) return `${f.l} must be an HTTPS link.`;
    if (f.t === 'select' && v === '') out[f.k] = f.blank === false ? v : (f.k.endsWith('Id') ? null : '');
  }
  return out;
}

export function FormModal({ title, fields, initial = {}, onSubmit, onClose, submitLabel = 'Save', intro, note, size = '', live }: {
  title: string; fields: Field[]; initial?: Values; onSubmit: (v: Values) => Promise<void>; onClose: () => void; submitLabel?: string; intro?: ReactNode; note?: ReactNode; size?: '' | 'narrow';
  /** Optional preview computed from the current (unsaved) values. */
  live?: (v: Values) => ReactNode;
}) {
  const [values, setValues] = useState<Values>(() => toForm(fields, initial));
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const out = fromForm(fields, values);
    if (typeof out === 'string') return setErr(out);
    setBusy(true); setErr('');
    try { await onSubmit(out); onClose(); } catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} size={size} footer={null}>
      <form onSubmit={submit} noValidate>
        {intro}
        <div className="fgrid">{fields.map(f => <FieldInput key={f.k} f={f} v={values[f.k]} set={v => setValues(s => ({ ...s, [f.k]: v }))} />)}</div>
        {live?.(values)}
        {note && <p className="note">{note}</p>}
        {err && <p className="err" role="alert">{err}</p>}
        <div className="form-actions"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button></div>
      </form>
    </Modal>
  );
}

/** Copy text with a fallback when the clipboard is unavailable. */
export async function copyText(text: string, toast: (t: string) => void) {
  try { await navigator.clipboard.writeText(text); toast('Copied.'); } catch { toast('Couldn’t copy automatically. Select the text and press Ctrl+C.'); }
}
