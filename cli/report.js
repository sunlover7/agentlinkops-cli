// `agentlinkops report`: one self-contained HTML file, reproducible from a frozen dataset.
//
// **Reproducible is the requirement, and it is the one that constrains the design.** The same
// ledger and the same observations must produce byte-identical output, because a report a
// customer sends to a client is a document they may have to produce again months later and
// defend as unchanged. So: no clock read that is not an input, no random ids, stable ordering,
// and a content digest printed in the footer so "identical" is checkable rather than claimed.
//
// **A report timestamp does not make its observations fresh.** Every row carries the date IT was
// observed, and the header states the range, because the single most misleading thing a link
// report can do is print today's date above a figure from March.
//
// Self-contained: no external stylesheet, font, script or image. That makes it openable offline
// forever, printable to PDF from any browser, and incapable of telling anyone it was opened.
import { createHash } from 'node:crypto';
import { latestByEntry } from './mirror.js';

export const REPORT_VERSION = 1;

/** HTML-escape. Every value below is publisher or customer content and none of it is trusted. */
export const escape = value => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

const STATE_LABEL = Object.freeze({
  present: 'Present', absent: 'Not found', unknown: 'Could not check',
  source_unavailable: 'Page unavailable', unchecked: 'Never checked',
});

/**
 * The frozen dataset a report renders.
 *
 * Selection happens here and nowhere else, so a caller can hold this object, assert it, and know
 * the rendered document is a pure function of it.
 */
export function freezeDataset(entries, observations, { asOf, title = 'Backlink report', includeNotes = false, includeRetired = false } = {}) {
  const latest = latestByEntry(observations);
  const rows = entries
    .filter(entry => includeRetired || entry.intent !== 'retired')
    .map(entry => {
      const row = latest.get(entry.id) ?? null;
      return {
        id: entry.id, intent: entry.intent, source: entry.source, target: entry.target, scope: entry.scope,
        expected_anchor: entry.expect?.anchor ?? null,
        state: row?.state ?? 'unchecked',
        reason: row?.reason ?? null,
        occurrences: row?.occurrences ?? 0,
        checked_at: row?.checked_at ?? null,
        checked_by: row?.source ?? null,
        anchor: row?.result?.occurrences?.[0]?.anchor ?? null,
        rel: row?.result?.occurrences?.[0]?.rel ?? [],
        // Opt-in, because a note can hold commercial context — what a placement cost, what a
        // publisher said — and a report is the document most likely to be forwarded.
        note: includeNotes ? (entry.note ?? null) : null,
        ref: includeNotes ? (entry.ref ?? null) : null,
      };
    })
    // Stable ordering, by state then id: byte-identical output needs a total order with no ties
    // broken by insertion.
    .sort((a, b) => (a.state === b.state ? (a.id < b.id ? -1 : 1) : (a.state < b.state ? -1 : 1)));

  const dates = rows.map(row => row.checked_at).filter(Boolean).sort();
  const counts = rows.reduce((acc, row) => { acc[row.state] = (acc[row.state] ?? 0) + 1; return acc; }, {});
  return {
    v: REPORT_VERSION, title, as_of: asOf, include_notes: includeNotes,
    rows,
    totals: { entries: rows.length, ...counts },
    // Stated rather than implied. A report over a ledger nobody has checked is not a report about
    // links, and the reader should see that before the table.
    coverage: {
      checked: rows.filter(row => row.checked_at).length,
      never_checked: rows.filter(row => !row.checked_at).length,
      observed_from: dates[0] ?? null,
      observed_to: dates.at(-1) ?? null,
    },
  };
}

const STYLE = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;padding:32px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;background:#fff}
h1{font-size:22px;margin:0 0 4px}
.sub{color:#555;margin:0 0 24px}
.cards{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 24px}
.card{border:1px solid #ddd;border-radius:6px;padding:10px 14px;min-width:120px}
.card b{display:block;font-size:20px}
.card span{color:#555;font-size:12px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid #eee}
th{background:#fafafa;border-bottom:1px solid #ddd;font-weight:600}
td.url{word-break:break-all;max-width:340px}
.state{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;border:1px solid #ccc}
.present{background:#eef7ee;border-color:#b6d7b6}
.absent{background:#fdeeee;border-color:#e2b6b6}
.unknown,.unchecked,.source_unavailable{background:#f6f6f6}
.note{color:#555;font-size:12px}
footer{margin-top:28px;padding-top:12px;border-top:1px solid #eee;color:#555;font-size:12px}
.caveat{margin:18px 0;padding:10px 14px;border-left:3px solid #ddd;color:#444;font-size:13px}
@media print{body{padding:0}th{background:#fff}tr{break-inside:avoid}.card{break-inside:avoid}}
`.trim();

/**
 * Renders the frozen dataset. A pure function of its argument: same input, same bytes.
 *
 * The digest in the footer is over the DATASET rather than over the HTML, so it stays stable
 * across a cosmetic change to this template while still changing the moment a figure does.
 */
export function renderReport(dataset, { brand = null } = {}) {
  const digest = createHash('sha256').update(JSON.stringify(dataset)).digest('hex');
  const card = (label, value) => `<div class="card"><b>${escape(value)}</b><span>${escape(label)}</span></div>`;
  const coverage = dataset.coverage;
  const rows = dataset.rows.map(row => `<tr>
      <td class="url"><a href="${escape(row.source)}">${escape(row.source)}</a></td>
      <td class="url">${escape(row.target)}</td>
      <td><span class="state ${escape(row.state)}">${escape(STATE_LABEL[row.state] ?? row.state)}</span></td>
      <td>${row.anchor ? escape(row.anchor) : '<span class="note">&mdash;</span>'}${(row.rel ?? []).length ? `<div class="note">rel: ${escape(row.rel.join(' '))}</div>` : ''}</td>
      <td>${row.checked_at ? escape(row.checked_at.slice(0, 10)) : '<span class="note">never</span>'}</td>
      ${dataset.include_notes ? `<td class="note">${escape(row.ref ?? '')}${row.note ? `<div>${escape(row.note)}</div>` : ''}</td>` : ''}
    </tr>`).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(dataset.title)}</title><style>${STYLE}</style></head>
<body>
<h1>${escape(dataset.title)}</h1>
<p class="sub">${brand ? `${escape(brand)} &middot; ` : ''}Prepared ${escape(dataset.as_of)}</p>
<div class="cards">
${card('links in report', dataset.totals.entries)}
${card('present', dataset.totals.present ?? 0)}
${card('not found', dataset.totals.absent ?? 0)}
${card('could not check', (dataset.totals.unknown ?? 0) + (dataset.totals.source_unavailable ?? 0))}
${card('never checked', dataset.totals.unchecked ?? 0)}
</div>
<p class="caveat"><strong>What these dates mean.</strong> Every row shows the date that link was
last observed, between ${escape(coverage.observed_from ?? 'n/a')} and ${escape(coverage.observed_to ?? 'n/a')}.
The date at the top is when this document was prepared and does not make any observation newer
than it is. ${coverage.never_checked ? `${coverage.never_checked} of ${dataset.totals.entries} links have never been checked and are listed as such.` : ''}</p>
<p class="caveat"><strong>What a result means.</strong> &ldquo;Present&rdquo; means the link was in
the HTML the publisher served. &ldquo;Could not check&rdquo; is not the same as
&ldquo;not found&rdquo;: it means the page could not be read, and no conclusion was drawn.
JavaScript execution and visual visibility were not checked.</p>
<table><thead><tr>
<th>Source page</th><th>Target</th><th>Result</th><th>Anchor</th><th>Observed</th>${dataset.include_notes ? '<th>Notes</th>' : ''}
</tr></thead><tbody>
${rows}
</tbody></table>
<footer>
AgentLinkOps report v${dataset.v}. Dataset digest <code>${escape(digest)}</code> &mdash; the same
ledger and observations always produce this digest.
${dataset.include_notes ? 'Private notes are included in this document.' : 'Private notes and references are excluded.'}
</footer>
</body></html>
`;
}

/** The digest a caller can compare without rendering. */
export const datasetDigest = dataset => createHash('sha256').update(JSON.stringify(dataset)).digest('hex');
