import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCsv, readTable, normalizeHeader, CsvError } from '../cli/adapters/csv.js';
import { resolveMapping, toImportRow, readFlag, SUPPLIER_NAMES } from '../cli/adapters/suppliers.js';
import { readImport, parseMap } from '../cli/import.js';

async function file(t, name, contents) {
  const dir = await mkdtemp(join(tmpdir(), 'linktrail-import-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, name);
  await writeFile(path, contents, 'utf8');
  return path;
}

test('the reader handles what spreadsheets actually write', () => {
  // Each of these fails SILENTLY in a naive split(","): a mishandled quoted field does not
  // throw, it shifts every column right and imports nonsense.
  const rows = parseCsv('﻿a,b,c\r\n1,"two, with comma",3\r\n"line\nbreak","say ""hi""",6\r\n');
  assert.deepEqual(rows[0], ['a', 'b', 'c'], 'the BOM is not part of the first column name');
  assert.deepEqual(rows[1], ['1', 'two, with comma', '3']);
  assert.deepEqual(rows[2], ['line\nbreak', 'say "hi"', '6']);
  assert.throws(() => parseCsv('a,b\n"unterminated'), error => error instanceof CsvError);
  assert.equal(normalizeHeader('Referring page URL'), normalizeHeader('referring_page_url'));
});

test('a short row is reported, not padded', async () => {
  const table = readTable('a,b,c\n1,2,3\n4,5\n\n6,7,8\n');
  assert.equal(table.records.length, 3);
  assert.equal(table.records[1].error, '2 value(s) for 3 column(s)');
  // Padding hides a wrong delimiter until the numbers are wrong, and by then the file is gone.
  assert.ok(table.records[0].values);
  assert.ok(table.records[2].values, 'a blank line is skipped, a short line is not');
});

test('an Ahrefs export maps, and every unclaimed column travels as a supplier metric', async t => {
  const path = await file(t, 'ahrefs.csv',
    'Referring page URL,Target URL,Anchor,Nofollow,First seen,Last seen,Domain rating,Traffic\n'
    + 'https://publisher.example.com/resources,https://example.com/guide,probate checklist,false,2026-03-14,2026-09-01,62,"1,200"\n');
  const result = await readImport(path, { supplier: 'ahrefs', target: 'example.com' });
  assert.equal(result.counts.accepted, 1);
  assert.equal(result.mapping.source, 'Referring page URL');
  const candidate = result.accepted[0];
  assert.equal(candidate.provider, 'imported');
  assert.equal(candidate.provider_metrics.imported.supplier, 'ahrefs');
  // A column we did not map is not noise: it is the supplier's own metric, kept under the name
  // their tool gave it and on their own scale.
  assert.deepEqual(candidate.provider_metrics.imported.supplier_metrics, { 'Domain rating': 62, Traffic: 1200 });
  assert.equal(candidate.dofollow, true);
  assert.equal(candidate.provider_first_seen, '2026-03-14T00:00:00.000Z');
  assert.deepEqual(result.unclaimed, ['Domain rating', 'Traffic']);
});

test('a renamed column is one flag away, not one release away', async t => {
  const path = await file(t, 'renamed.csv',
    'Linking page (new name),Points to,Anchor text\nhttps://p.example.com/a,https://example.com/g,guide\n');
  const failed = await readImport(path, { supplier: 'ahrefs', target: 'example.com' });
  // The message has to carry the header row and the exact flag, because the person reading it
  // is looking at a file whose columns we guessed wrong. With --target supplied, only the
  // SOURCE column is missing — the target is named, so saying "and target" would send the
  // reader looking for a flag they do not need.
  assert.match(failed.error, /could not find the source column/u);
  assert.match(failed.error, /Linking page \(new name\)/u);
  assert.match(failed.error, /--map source=<column>,target=<column>/u);
  // Without a target supplied out-of-band, both columns are still required and both are named.
  const failedNoTarget = await readImport(path, { supplier: 'ahrefs' });
  assert.match(failedNoTarget.error, /could not find the source and target column/u);

  const fixed = await readImport(path, {
    supplier: 'ahrefs', target: 'example.com',
    map: parseMap('source=Linking page (new name),target=Points to,anchor=Anchor text'),
  });
  assert.equal(fixed.counts.accepted, 1);
  assert.equal(fixed.accepted[0].anchor, 'guide');
});

test('a file about one target imports when the operator names that target, and is refused otherwise', async t => {
  // The curated-list shape (a bought master list, a project registry): every row is a place to
  // TRY for a link and the whole file is about one site. T06 settled the semantics — a missing
  // target column is a SCOPE question the operator answers with --target, never an assumption.
  const path = await file(t, 'curated.csv',
    'url,dr,link_type,source\nhttp://blogger.com/,95.0,dofollow,sneakies-connorshowler-2025-03\n');
  const refused = await readImport(path, { supplier: 'csv' });
  assert.match(refused.error, /could not find the source and target column/u);

  const named = await readImport(path, { supplier: 'csv', map: parseMap('source=url'), target: 'settledestate.com' });
  assert.equal(named.counts.accepted, 1);
  assert.equal(named.accepted[0].target_url, 'https://settledestate.com/');
  // The seller's own columns stay the seller's: DR and rel ride as metrics, and the row's own
  // source label travels in provenance rather than being flattened away.
  assert.equal(named.accepted[0].dofollow, null);
  assert.equal(named.accepted[0].rel, null);
  assert.equal(named.accepted[0].provider_metrics.imported.supplier_metrics.dr, 95);
  assert.equal(named.accepted[0].provider_metrics.imported.supplier_metrics.source, 'sneakies-connorshowler-2025-03');
});

test('an aggregate export is refused rather than turned into invented URLs', async t => {
  const path = await file(t, 'gsc.csv', 'Site,Incoming links,Linking pages\nexample.org,412,88\n');
  const result = await readImport(path, { supplier: 'google_search_console', target: 'example.com' });
  // A row that is a count per site is not a placement. Inventing a source page URL for it would
  // create a link we then check, fail to find, and report to the customer as lost.
  assert.match(result.error, /count per site, not a list of pages/u);
});

test('a nofollow column becomes rel, and a column we cannot read asserts nothing', () => {
  const header = ['Source', 'Target', 'Nofollow'];
  const { mapping, unclaimed } = resolveMapping(header, { supplier: 'csv', overrides: { source: 'Source', target: 'Target', nofollow: 'Nofollow' } });
  assert.deepEqual(unclaimed, []);
  assert.deepEqual(toImportRow({ Source: 'a', Target: 'b', Nofollow: 'true' }, mapping, unclaimed).rel, ['nofollow']);
  assert.equal(toImportRow({ Source: 'a', Target: 'b', Nofollow: 'yes' }, mapping, unclaimed).dofollow, false);
  assert.equal(toImportRow({ Source: 'a', Target: 'b', Nofollow: 'no' }, mapping, unclaimed).dofollow, true);
  // "followed" is the value a reader trusts, so a column we did not understand must not assert it.
  assert.equal(toImportRow({ Source: 'a', Target: 'b', Nofollow: 'maybe?' }, mapping, unclaimed).dofollow, undefined);
  assert.equal(readFlag('sponsored'), undefined);
});

test('rejections carry the FILE line number a customer can open to', async t => {
  const path = await file(t, 'mixed.csv',
    'Source url,Target url,First seen\n'
    + 'https://a.example.com/1,https://example.com/g,2026-01-01\n'
    + 'not-a-url,https://example.com/g,2026-01-01\n'
    + 'https://c.example.com/3,https://example.com/g,last tuesday\n'
    + 'https://d.example.com/4,https://someone-else.com/x,2026-01-01\n'
    + 'https://e.example.com/5\n');
  const result = await readImport(path, { supplier: 'semrush', target: 'example.com' });
  assert.equal(result.counts.accepted, 1);
  assert.deepEqual(result.rejected.map(entry => entry.row), [3, 4, 5, 6], 'line numbers, not array indexes');
  assert.match(result.rejected.at(-1).reason, /1 value\(s\) for 3 column\(s\)/u);
  // Every row is accounted for: nothing is dropped between reading the file and building rows.
  assert.equal(result.counts.accepted + result.counts.rejected + result.counts.duplicates, result.counts.read);
});

test('every named supplier resolves its own export', async t => {
  const shapes = {
    ahrefs: 'Referring page URL,Target URL\n',
    semrush: 'Source url,Target url\n',
    majestic: 'Source URL,Target URL,Anchor Text\n',
    moz: 'Source Page,Target Page\n',
    dataforseo: 'url_from,url_to\n',
    linkody: 'URL,Link\n',
    bing_webmaster_tools: 'Source URL,Target URL,Anchor text\n',
    google_search_console: 'Linking page,Target page\n',
  };
  for (const [supplier, header] of Object.entries(shapes)) {
    // The data row is built from the header width, because a short row is an error here and
    // that is the point of the previous test rather than a trap for this one.
    const columns = header.trim().split(',').length;
    const cells = ['https://p.example.com/a', 'https://example.com/g', ...Array.from({ length: columns - 2 }, () => 'x')];
    const path = await file(t, `${supplier}.csv`, `${header}${cells.join(',')}\n`);
    const result = await readImport(path, { supplier, target: 'example.com' });
    assert.equal(result.error, undefined, `${supplier}: ${result.error}`);
    assert.equal(result.counts.accepted, 1, supplier);
    assert.equal(result.accepted[0].provider_metrics.imported.supplier, supplier);
  }
  assert.equal(SUPPLIER_NAMES.length, Object.keys(shapes).length + 1, 'generic CSV is the one without a fixture shape');
});

test('the supplier export date and our read date stay separate', async t => {
  const path = await file(t, 'dated.csv', 'url_from,url_to\nhttps://p.example.com/a,https://example.com/g\n');
  const result = await readImport(path, {
    supplier: 'dataforseo', target: 'example.com',
    supplierGeneratedAt: '2024-02-02T00:00:00.000Z', now: '2026-09-11T06:00:00.000Z',
  });
  const metrics = result.accepted[0].provider_metrics.imported;
  assert.equal(metrics.supplier_generated_at, '2024-02-02T00:00:00.000Z');
  assert.equal(result.accepted[0].provider_retrieved_at, '2026-09-11T06:00:00.000Z');
});

test('import previews and never writes', async t => {
  const path = await file(t, 'preview.csv', 'url_from,url_to\nhttps://p.example.com/a,https://example.com/g\n');
  const result = await readImport(path, { supplier: 'dataforseo', target: 'example.com' });
  // A preview that wrote files would make a dry run indistinguishable from a real one.
  assert.ok(result.accepted.length);
  assert.equal(result.written, undefined);
});
