/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF). No dependencies. */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // a UTF-8 byte-order mark is not data
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++;
        const next = text[i];
        if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') throw new Error('CSV has characters after a closing quote');
        continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  if (inQuotes) throw new Error('CSV ended inside a quoted field');
  return rows;
}

/** Parse CSV with a header row into objects. Throws if a row has the wrong number of fields. */
export function parseCsvObjects(text: string): { header: string[]; rows: Record<string, string>[] } {
  const all = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ''));
  const header = all[0];
  if (!header) throw new Error('CSV has no header row');
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < all.length; r++) {
    const cells = all[r]!;
    if (cells.length !== header.length) {
      throw new Error(`CSV row ${r} has ${cells.length} fields, expected ${header.length}`);
    }
    const obj: Record<string, string> = {};
    header.forEach((h, k) => { obj[h] = cells[k]!; });
    rows.push(obj);
  }
  return { header, rows };
}
