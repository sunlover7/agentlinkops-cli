// A dependency-free RFC 4180 reader.
//
// Written rather than depended on because the CLI is meant to run anywhere with no install, and
// because the failure that matters here is silent: a parser that mishandles a quoted field
// containing a comma does not throw, it shifts every column right and imports nonsense.
export class CsvError extends Error {
  constructor(message, line) { super(message); this.name = 'CsvError'; this.line = line; this.exitCode = 2; }
}

/** Rows of raw string cells. Quoted fields may contain commas, quotes and newlines. */
export function parseCsv(text, { delimiter = ',' } = {}) {
  // A BOM at the start of a spreadsheet export becomes part of the first header name, and then
  // the first column never matches anything. Excel writes one by default.
  const input = text.replace(/^﻿/u, '');
  const rows = [];
  let row = [], field = '', quoted = false, line = 1, started = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; continue; }
        quoted = false; continue;
      }
      if (char === '\n') line++;
      field += char;
      continue;
    }
    if (char === '"' && field === '') { quoted = true; started = true; continue; }
    if (char === delimiter) { row.push(field); field = ''; started = false; continue; }
    if (char === '\r') continue;
    if (char === '\n') {
      line++;
      if (row.length || field !== '' || started) { row.push(field); rows.push(row); }
      row = []; field = ''; started = false;
      continue;
    }
    field += char; started = true;
  }
  if (quoted) throw new CsvError('the file ends inside a quoted field', line);
  if (row.length || field !== '' || started) { row.push(field); rows.push(row); }
  return rows;
}

/** Normalised for matching: case, punctuation and spacing are not information here. */
export const normalizeHeader = name => String(name).toLowerCase().replace(/[\s_\-.()/]+/gu, '').trim();

/**
 * Header row plus objects keyed by the ORIGINAL header, so an unmapped column keeps the name
 * the customer's tool gave it.
 */
export function readTable(text, options = {}) {
  const rows = parseCsv(text, options);
  if (!rows.length) throw new CsvError('the file is empty', 1);
  const header = rows[0].map(cell => cell.trim());
  if (!header.some(Boolean)) throw new CsvError('the first row is blank, so there are no column names', 1);
  const records = [];
  rows.slice(1).forEach((cells, index) => {
    // A short or long row is a REPORT, not a silent pad or truncate: it usually means the file
    // is not the delimiter we think it is, and padding hides that until the numbers are wrong.
    if (cells.length !== header.length && cells.some(Boolean)) {
      records.push({ line: index + 2, error: `${cells.length} value(s) for ${header.length} column(s)` });
      return;
    }
    if (!cells.some(Boolean)) return;
    records.push({ line: index + 2, values: Object.fromEntries(header.map((name, position) => [name, cells[position] ?? ''])) });
  });
  return { header, records };
}
