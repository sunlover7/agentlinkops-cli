// The citation report: a single self-contained HTML file that renders every
// cell's evidence — trend, screenshots inline, Wilson intervals, honest
// classifications — in a format a marketing manager can forward to a client.
//
// No external assets. No server. No JavaScript. Opens in any browser,
// survives email forwarding, and carries the screenshots as base64 because
// linked screenshots break the moment the evidence directory moves.
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { join, basename, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { wilsonInterval } from './stats.js';
import { citationPanelSchema, engineIdentity, cellId, targetKey, panelLocaleContext, localizedPromptId } from './contract.js';

export async function panelEpochs({ dir, panel }) {
  const parsed = citationPanelSchema.parse(panel);
  const ids = new Set(parsed.engines.flatMap(engine => parsed.prompts.flatMap(prompt => parsed.targets.map(target =>
    cellId(engineIdentity(engine), localizedPromptId(prompt.id ?? createHash('sha256').update(prompt.text).digest('hex').slice(0, 10), panelLocaleContext(parsed, engine)), targetKey(target))))));
  let text;
  try { text = await readFile(join(dir, 'citations-epochs.jsonl'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rows = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const groups = new Map();
  for (const row of rows) { if (!groups.has(row.epoch_id)) groups.set(row.epoch_id, []); groups.get(row.epoch_id).push(row); }
  return [...groups.values()].reverse().filter(cells => cells.length === ids.size && new Set(cells.map(cell => cell.cell_id)).size === ids.size && cells.every(cell => ids.has(cell.cell_id)));
}
export async function latestPanelEpoch(options) {
  return (await panelEpochs(options))[0] ?? null;
}


const esc = (text) => String(text ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const pct = (v) => `${Math.round(v * 100)}%`;

const CLASSIFICATION_STYLE = {
  first_epoch: { label: 'First epoch', color: '#6b7280', bg: '#f3f4f6' },
  insufficient_data: { label: 'Insufficient data', color: '#92400e', bg: '#fef3c7' },
  declined: { label: 'Declined', color: '#991b1b', bg: '#fee2e2' },
  grown: { label: 'Grown', color: '#065f46', bg: '#d1fae5' },
  not_distinguishable: { label: 'Not distinguishable', color: '#6b7280', bg: '#f3f4f6' },
};

function classificationBadge(cls) {
  const s = CLASSIFICATION_STYLE[cls] ?? { label: cls, color: '#6b7280', bg: '#f3f4f6' };
  return `<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600;color:${s.color};background:${s.bg};margin-left:8px">${esc(s.label)}</span>`;
}

// The local epoch contract stores smoothed estimates. Display empirical fractions
// from the retained counts without changing those original evidence bytes.
function reportCell(row) {
  if (!Number.isSafeInteger(row.k) || !Number.isSafeInteger(row.n) || row.k < 0 || row.n < 0 || row.k > row.n) {
    throw new Error('Invalid retained citation counts');
  }
  const interval = wilsonInterval(row.k, row.n);
  const rate = row.n ? row.k / row.n : null;
  return { ...row, rate, ci_low: interval?.[0] ?? null, ci_high: interval?.[1] ?? null,
    rate_recomputed: row.rate !== rate };
}

function rateBar(rate, low, high) {
  if (rate === null || low === null || high === null) return '<div>Unknown: no interpretable observations</div>';
  return `
  <div style="margin:8px 0 4px 0">
    <div style="font-size:22px;font-weight:700;color:#111827">${pct(rate)} <span style="font-size:13px;font-weight:400;color:#6b7280">cited (${pct(low)}–${pct(high)} Wilson 95%)</span></div>
    <div style="position:relative;height:8px;border-radius:4px;background:#e5e7eb;margin-top:6px;overflow:hidden">
      <div style="position:absolute;left:${low * 100}%;width:${(high - low) * 100}%;top:0;bottom:0;background:#3b82f6;border-radius:4px;opacity:0.5"></div>
      <div style="position:absolute;left:${rate * 100}%;width:2px;top:-2px;bottom:-2px;background:#1d4ed8"></div>
    </div>
  </div>`;
}

function supplementalStats(cell) {
  if (!cell.statistics) return '';
  const { confidence_sequence: sequence, epoch_comparison: comparison, changepoint } = cell.statistics;
  const bounds = sequence?.interval ? `${pct(sequence.interval[0])}–${pct(sequence.interval[1])}` : 'not available';
  return `<details style="margin-top:12px;font-size:12px;color:#6b7280"><summary>Supplemental statistics</summary>
    <p>The classification above is descriptive. These bounds apply within this fixed epoch across its planned cells; they do not promise lifetime coverage.</p>
    <p>Sequential bounds: ${esc(bounds)}. Method: ${esc(sequence?.method ?? 'insufficient data')}.</p>
    <p>Corrected epoch comparison: ${esc(comparison?.verdict ?? 'no baseline')}. Change-point analysis is exploratory and does not establish a change date.</p>
    ${changepoint?.candidate ? `<p>Within-epoch candidate at observation ${esc(changepoint.candidate.index + 1)}.</p>` : ''}
  </details>`;
}

function evidenceCard(cell, envelope, screenshotB64) {
  const [enginePart, promptPart, targetPart] = cell.cell_id.split('|');
  const citedDomains = [...new Set((envelope?.citations ?? []).map((c) => {
    try { return new URL(c.url).hostname; } catch { return null; }
  }).filter(Boolean))];

  return `
  <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:16px;background:#fff">
    <div class="cell-heading" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <div>
        <span style="font-size:14px;font-weight:700;color:#111827;font-family:ui-monospace,monospace">${esc(enginePart)}</span>
        <span style="font-size:12px;color:#6b7280;margin-left:8px">${esc(promptPart)}</span>
        <div style="font-size:12px;color:#6b7280;margin-top:4px">Target: ${esc(targetPart)}</div>
      </div>
      ${classificationBadge(cell.classification)}
    </div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:8px">${envelope?.locale_context ? `Requested locale: ${esc(envelope.locale_context.locale)}; country: ${esc(envelope.locale_context.country)}; basis: ${esc(envelope.locale_context.mode)}.` : 'Locale not retained for this observation.'}</div>
    ${rateBar(cell.rate, cell.ci_low, cell.ci_high)}
    ${supplementalStats(cell)}
    <div style="font-size:11px;color:#9ca3af;margin-top:2px">n=${esc(cell.n)} rendered · ${esc(cell.unknowns)} unknown${cell.unknowns === 1 ? '' : 's'} excluded · ${esc(cell.mentioned)} mentioned without citation</div>
    ${screenshotB64 ? `
    <details style="margin-top:12px">
      <summary style="font-size:12px;color:#3b82f6;cursor:pointer;font-weight:500">View answer screenshot</summary>
      <img src="data:image/png;base64,${screenshotB64}" style="max-width:100%;border-radius:8px;border:1px solid #e5e7eb;margin-top:8px" alt="Answer surface screenshot" />
    </details>` : '<div style="font-size:12px;color:#6b7280;margin-top:12px">No screenshot retained for this observation.</div>'}
    ${envelope?.answer ? `
    <details style="margin-top:8px">
      <summary style="font-size:12px;color:#3b82f6;cursor:pointer;font-weight:500">View answer text</summary>
      <div style="font-size:13px;color:#374151;margin-top:8px;padding:12px;background:#f9fafb;border-radius:8px;white-space:pre-wrap;max-height:300px;overflow-y:auto">${esc(envelope.answer.slice(0, 2000))}${envelope.answer.length > 2000 ? '\n…' : ''}</div>
    </details>` : ''}
    ${citedDomains.length > 0 ? `
    <div style="margin-top:10px">
      <span style="font-size:11px;font-weight:600;color:#374151">Cited domains:</span>
      ${citedDomains.map((d) => `<span style="display:inline-block;padding:1px 8px;border-radius:8px;font-size:11px;background:#eff6ff;color:#1e40af;margin:2px 2px">${esc(d)}</span>`).join('')}
    </div>` : `<div style="margin-top:10px;font-size:11px;color:#9ca3af">No cited source URLs retained for this observation.</div>`}
  </div>`;
}

function summaryParagraph(cells, panelName) {
  const totalN = cells.reduce((sum, c) => sum + c.n, 0);
  const totalK = cells.reduce((sum, c) => sum + c.k, 0);
  const declined = cells.filter((c) => c.classification === 'declined').length;
  const grown = cells.filter((c) => c.classification === 'grown').length;
  const insufficient = cells.filter((c) => c.classification === 'insufficient_data').length;
  const unknowns = cells.reduce((sum, c) => sum + c.unknowns, 0);

  const parts = [];
  parts.push(totalN === 0 ? 'no observations could be interpreted' : `${totalK} of ${totalN} rendered observations cited the target`);
  if (unknowns > 0) parts.push(`${unknowns} unknown${unknowns === 1 ? ' was' : 's were'} excluded from the denominator`);
  if (declined > 0) parts.push(`${declined} cell${declined === 1 ? '' : 's'} ${declined === 1 ? 'carries' : 'carry'} a recorded decline classification`);
  if (grown > 0) parts.push(`${grown} cell${grown === 1 ? '' : 's'} grew`);
  if (insufficient > 0) parts.push(`${insufficient} cell${insufficient === 1 ? '' : 's'} ${insufficient === 1 ? 'has' : 'have'} insufficient data to interpret`);
  if (declined === 0 && grown === 0 && insufficient === 0 && totalN > 0) parts.push('no change passed the comparison threshold');

  return `Across ${cells.length} monitored cell${cells.length === 1 ? '' : 's'}, ${parts.join('. ')}. `;
}

export async function generateReport({ dir, epochId, panel, history = [], now = new Date() }) {
  if (typeof epochId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(epochId)) throw new Error('Invalid citation epoch identifier');
  // Read the epoch rows for this epoch
  const epochsPath = join(dir, 'citations-epochs.jsonl');
  const epochsText = await readFile(epochsPath, 'utf8').catch(() => '');
  const allRows = epochsText.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const cells = allRows.filter((r) => r.epoch_id === epochId).map(reportCell);
  history = history.map(rows => rows.map(reportCell));
  if (cells.length === 0) throw new Error(`no epoch rows found for ${epochId}`);

  // Read the evidence envelopes for this epoch (latest per cell)
  const evidenceRoot = join(dir, 'citations', 'evidence', epochId);
  const rootStat = await lstat(evidenceRoot).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (rootStat?.isSymbolicLink()) throw new Error('Citation evidence directory must not be a symlink');
  if (rootStat && !(await realpath(evidenceRoot)).startsWith((await realpath(dir)) + sep)) throw new Error('Citation evidence must stay inside its ledger');
  const evidenceFiles = rootStat ? await readdir(evidenceRoot) : [];
  const envelopes = new Map();
  const screenshots = new Map();
  for (const file of evidenceFiles) {
    if (!file.endsWith('.json')) continue;
    if (!(await lstat(join(evidenceRoot, file))).isFile()) continue;
    try {
      const env = JSON.parse(await readFile(join(evidenceRoot, file), 'utf8'));
      if (env.epoch_id !== epochId || !cells.some(cell => cell.cell_id === env.cell_id)) continue;
      const existing = envelopes.get(env.cell_id);
      if (!existing || env.run_index > existing.run_index) {
        envelopes.set(env.cell_id, env);
        screenshots.delete(env.cell_id);
        // Look for the sibling screenshot
        const shotFile = file.replace('.json', '.screenshot.png');
        if (evidenceFiles.includes(shotFile) && (await lstat(join(evidenceRoot, shotFile))).isFile()) {
          const shotBuf = await readFile(join(evidenceRoot, shotFile));
          screenshots.set(env.cell_id, shotBuf.toString('base64'));
        }
      }
    } catch { /* skip unreadable */ }
  }

  const totalSpent = Math.max(0, ...cells.map(c => c.spent_estimate_usd ?? 0));
  const engineList = [...new Set(cells.map((c) => c.cell_id.split('|')[0]))];

  const cards = cells.map((cell) => evidenceCard(cell, envelopes.get(cell.cell_id), screenshots.get(cell.cell_id))).join('\n');
  const summary = summaryParagraph(cells, panel?.note ?? 'Citation panel');
  const historyHtml = history.length > 1 ? `<section style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px 20px;margin-bottom:20px">
    <h2 style="margin:0 0 12px;font-size:18px">Recent epochs</h2>
    <p style="font-size:13px;color:#6b7280">Rates stay separate for each engine, prompt and target. Answer evidence below is from the latest epoch.</p>
    ${history.map(rows => `<div style="margin-top:12px"><h3 style="font-size:14px;margin:0 0 8px">${esc(rows[0]?.epoch_id)}</h3><ul style="padding-left:18px;font-size:12px;line-height:1.6">${rows.map(row => `<li><span style="font-family:monospace">${esc(row.cell_id)}</span>: ${row.rate === null ? 'unknown' : `${pct(row.rate)} cited (${pct(row.ci_low)}–${pct(row.ci_high)} Wilson 95%)`}; n=${esc(row.n)}; ${esc(CLASSIFICATION_STYLE[row.classification]?.label ?? row.classification)}</li>`).join('')}</ul></div>`).join('')}
  </section>` : '';


  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Citation Report - ${esc(now.toISOString().slice(0, 10))}</title>
<style>*{box-sizing:border-box} body{overflow-wrap:anywhere} .cell-heading{flex-wrap:wrap;gap:8px} @media(max-width:480px){body{padding:12px!important}.report-header{padding:20px!important}}</style>
</head>
<body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827">
<div style="max-width:720px;margin:0 auto">

<div class="report-header" style="background:#111827;border-radius:16px;padding:24px 28px;margin-bottom:20px">
  <div style="font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">AgentLinkOps Citation Report</div>
  <h1 style="margin:0;font-size:24px;font-weight:700;color:#fff">${esc(panel?.note ?? 'Citation monitoring epoch')}</h1>
  <div style="font-size:13px;color:#9ca3af;margin-top:4px">${esc(now.toISOString().slice(0, 10))} · ${engineList.length} engine${engineList.length === 1 ? '' : 's'} · ${cells.length} cell${cells.length === 1 ? '' : 's'} · estimated spend $${totalSpent.toFixed(4)}</div>
</div>

<div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px 20px;margin-bottom:20px">
  <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Summary</div>
  <div style="font-size:14px;line-height:1.6;color:#374151">${esc(summary)}</div>
</div>

${cells.some(cell => cell.rate_recomputed) || history.some(rows => rows.some(row => row.rate_recomputed)) ? '<p style="font-size:12px;color:#6b7280">Display rates use retained citation counts (k/n). Stored estimates differ; source records have not been changed. Cells with no interpretable observations remain unknown.</p>' : ''}
${historyHtml}
${cards}

<div style="margin-top:24px;padding:16px;background:#f9fafb;border-radius:12px;border:1px solid #e5e7eb">
  <div style="font-size:11px;color:#6b7280;line-height:1.5">
    <strong>Evidence integrity:</strong> This report includes retained answer text and screenshots where available.
    Unknown outcomes do not count toward citation rates. Each rate includes its sample size and Wilson 95% interval.
    Cells with too little data carry an insufficient-data label. Answer text and screenshots may contain private information;
    review them before sharing this file. AgentLinkOps generated this report.
  </div>
</div>

</div>
</body>
</html>`;
}
