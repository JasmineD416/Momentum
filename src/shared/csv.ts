/** Parse CSV text (RFC 4180 quoting, CRLF or LF) into rows of cells, dropping blank rows. */
export function parseCsv(t: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], f = '', q = false;
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); // byte-order mark from Excel
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += ch;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}
