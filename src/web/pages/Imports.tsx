import { useState } from 'react';
import { DIVISIONS, IMPORT_LIMITS, IMPORT_TARGETS, type ImportTarget } from '../../shared/constants';
import { api } from '../api';
import { fmtDateTime } from '../format';
import { hasDiv, memberOptions, useSession } from '../session';
import { DataTable, Loaded, PageHead, Pill, Status, useLoad, useToast } from '../ui';

type Row = { rowId: string; n: number; data: Record<string, string>; status: string; message: string };
type Batch = { id: string; target: ImportTarget; rows: Row[]; ignoredColumns?: string[]; committedAt?: string | null };

export function Imports() {
  const { me, members } = useSession();
  const toast = useToast();
  const targets = (Object.entries(IMPORT_TARGETS) as [ImportTarget, (typeof IMPORT_TARGETS)[ImportTarget]][]).filter(([, t]) => !t.division || hasDiv(me, t.division));
  const [target, setTarget] = useState<ImportTarget>(targets[0]?.[0] ?? 'divisionContacts');
  const [csv, setCsv] = useState('');
  const [division, setDivision] = useState(DIVISIONS.find(d => hasDiv(me, d.id))?.id ?? '');
  const [ownerId, setOwnerId] = useState(me.id);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const history = useLoad(() => api.get<{ batches: { id: string; target: ImportTarget; createdAt: string; committedAt: string | null; rows: number; committed: number }[] }>('/api/imports'), [batch?.id, batch?.committedAt]);
  const cols = IMPORT_TARGETS[target].columns.join(',');

  const preview = async () => {
    setBusy(true);
    try {
      const b = await api.post<Batch>('/api/imports/preview', { target, csv, division: target === 'divisionContacts' ? division : undefined, ownerId });
      setBatch(b); setSelected(new Set(b.rows.filter(r => r.status === 'Ready').map(r => r.rowId)));
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const commit = async () => {
    if (!batch) return;
    setBusy(true);
    try {
      const r = await api.post<{ added: number; rows: Row[] }>(`/api/imports/${batch.id}/commit`, { rowIds: [...selected] });
      setBatch({ ...batch, rows: r.rows, committedAt: new Date().toISOString() });
      toast(`${r.added} record${r.added === 1 ? '' : 's'} imported.`);
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const openBatch = async (id: string) => { const b = await api.get<Batch>(`/api/imports/${id}`); setBatch(b); setSelected(new Set()); };

  return (
    <>
      <PageHead title="Import records" sub="Preview, review, then commit. Existing records are never overwritten, and committing the same batch twice adds nothing." />
      <div className="infobox">Import in this order: clients, then matters, then client expenses. Limits: {IMPORT_LIMITS.rows} rows, {IMPORT_LIMITS.columns} columns and 300 KB per batch. Dates use YYYY-MM-DD.</div>
      <section className="card"><h3>1. Choose what to import and add a CSV file</h3>
        <div className="toolbar">
          <select aria-label="Import target" value={target} onChange={e => { setTarget(e.target.value as ImportTarget); setBatch(null); }}>{targets.map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}</select>
          {target === 'divisionContacts' && <select aria-label="Division" value={division} onChange={e => setDivision(e.target.value)}>{DIVISIONS.filter(d => hasDiv(me, d.id)).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select>}
          {target === 'divisionContacts' && <select aria-label="Staff owner" value={ownerId} onChange={e => setOwnerId(e.target.value)}>{memberOptions(members, division).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}
        </div>
        <div className="field"><label htmlFor="csv">CSV with a header row: <code>{cols}</code></label>
          <textarea id="csv" rows={7} value={csv} onChange={e => setCsv(e.target.value)} style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12.5 }} /></div>
        <div className="toolbar" style={{ margin: '12px 0 0' }}>
          <label className="btn sm" style={{ cursor: 'pointer' }}>Choose CSV file<input type="file" accept=".csv,text/csv" className="sr" onChange={async e => { const f = e.target.files?.[0]; if (!f) return; if (f.size > IMPORT_LIMITS.bytes) return toast('This file is larger than 300 KB. Split it first.'); setCsv(await f.text()); e.target.value = ''; }} /></label>
          <button className="btn primary" disabled={busy || !csv.trim()} onClick={preview}>Preview</button>
        </div>
      </section>
      {batch && (
        <section className="card"><h3>2. Review {IMPORT_TARGETS[batch.target].label.toLowerCase()}</h3>
          {!!batch.ignoredColumns?.length && <p className="note" style={{ marginTop: 0 }}>Ignored columns: {batch.ignoredColumns.join(', ')}</p>}
          <DataTable rows={batch.rows} rowKey={r => r.rowId} empty="No rows."
            columns={[
              { label: 'Use', render: r => r.status === 'Ready' && !batch.committedAt ? <input type="checkbox" aria-label={`Select row ${r.n}`} checked={selected.has(r.rowId)} onChange={e => setSelected(s => { const n = new Set(s); if (e.target.checked) n.add(r.rowId); else n.delete(r.rowId); return n; })} /> : null },
              { label: 'Row', num: true, render: r => r.n }, { label: 'Status', render: r => <Status s={r.status} /> },
              { label: 'Data', render: r => Object.entries(r.data).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' · ') },
              { label: 'Message', render: r => r.message },
            ]} />
          <div className="toolbar" style={{ margin: '12px 0 0' }}>
            {batch.committedAt ? <span className="muted">Committed {fmtDateTime(batch.committedAt)}: {batch.rows.filter(r => r.status === 'Committed').length} records added.</span>
              : <button className="btn accent" disabled={busy || !selected.size} onClick={commit}>Commit {selected.size} selected row{selected.size === 1 ? '' : 's'}</button>}
          </div>
        </section>
      )}
      <section className="card"><h3>Your batches</h3>
        <Loaded state={history}>{h => (
          <DataTable rows={h.batches} rowKey={b => b.id} empty="No batches yet."
            columns={[
              { label: 'What', render: b => IMPORT_TARGETS[b.target]?.label ?? b.target }, { label: 'Created', render: b => fmtDateTime(b.createdAt) },
              { label: 'Rows', num: true, render: b => b.rows }, { label: 'Status', render: b => b.committedAt ? <Status s="Committed" /> : <Pill>Preview</Pill> },
              { label: '', render: b => <div className="acts-cell"><button className="btn sm" onClick={() => openBatch(b.id)}>Open</button></div> },
            ]} />
        )}</Loaded>
        <p className="note">Batches are private to the person who created them.</p>
      </section>
    </>
  );
}
