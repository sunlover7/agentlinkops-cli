// Local scheduling is explicit: no crontab is changed until register/remove is called.
import { resolve, dirname, basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { validateAlertWebhook } from './alert.js';

const CADENCES = { hourly: '17 * * * *', daily: '17 9 * * *', weekly: '17 9 * * 1', monthly: '17 9 1 * *' };
const PREFIX = '# agentlinkops:citation-watch:';
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";

function run(args, input, execFileImpl) {
  return new Promise((resolveResult, reject) => {
    const child = execFileImpl('crontab', args, (error, stdout, stderr) => {
      if (!error) return resolveResult(stdout ?? '');
      if (args[0] === '-l' && error.code === 1 && /^no crontab for [^\r\n]+\s*$/i.test((stderr ?? '').trim())) return resolveResult('');
      reject(new Error('Unable to ' + (args[0] === '-l' ? 'read' : 'write') + ' crontab', { cause: error }));
    });
    if (input !== undefined) {
      child.stdin.on('error', reject);
      child.stdin.end(input);
    }
  });
}
function markerName(value) {
  if (!value || /[\r\n\0]/.test(value)) throw new Error('Invalid citation watch name');
  return encodeURIComponent(value);
}
function replace(existing, marker, line) {
  const lines = existing.split('\n').filter(value => value && !value.endsWith(marker));
  if (line) lines.push(line);
  return lines.join('\n') + (lines.length ? '\n' : '');
}
export async function registerWatch({ panelPath, cadence = 'weekly', dir, out, webhook, execFileImpl = execFile, binary = process.argv[1], nodeBinary = process.execPath }) {
  if (!CADENCES[cadence]) throw new Error(`unknown cadence: ${cadence}`);
  if (webhook) validateAlertWebhook(webhook);
  const absolute = resolve(panelPath);
  const ledgerDir = resolve(dir ?? join(dirname(absolute), '.agentlinkops'));
  const reportPath = resolve(out ?? join(ledgerDir, 'citations', 'report.html'));
  const marker = PREFIX + markerName(basename(absolute, '.json'));
  for (const value of [absolute, ledgerDir, reportPath, binary, nodeBinary]) {
    if (!value || /[\r\n\0]/.test(value)) throw new Error('Invalid citation watch path');
  }
  const cli = `${quote(nodeBinary)} ${quote(resolve(binary))}`;
  const delivery = webhook ? ` --webhook ${quote(webhook)} --report ${quote(reportPath)}` : '';
  const common = `${quote(absolute)} --dir ${quote(ledgerDir)}`;
  // Exit 1 means an actionable decline, so it must still produce its report and alert.
  const command = `cd ${quote(dirname(absolute))} && { ${cli} citation run ${common}; status=$?; if [ "$status" -le 1 ]; then ${cli} citation report ${common} --out ${quote(reportPath)} && ${cli} citation alert ${common}${delivery}; else exit "$status"; fi; }`;
  // Cron interprets percent even inside shell quotes.
  const cronLine = `${CADENCES[cadence]} ${command.replace(/%/g, '\\%')} 2>&1 | logger -t agentlinkops-citation ${marker}`;
  const existing = await run(['-l'], undefined, execFileImpl);
  await run(['-'], replace(existing, marker, cronLine), execFileImpl);
  return { cadence, cronSpec: CADENCES[cadence], panelPath: absolute, marker, next: 'according to the crontab host timezone' };
}
export async function listWatches({ execFileImpl = execFile } = {}) {
  const existing = await run(['-l'], undefined, execFileImpl);
  return existing.split('\n').filter(line => line.includes(PREFIX)).map(line => ({
    panel: decodeURIComponent(line.slice(line.lastIndexOf(PREFIX) + PREFIX.length)),
    cron: line.trim().split(/\s+/).slice(0, 5).join(' '),
  }));
}
export async function removeWatch(panelName, { execFileImpl = execFile } = {}) {
  const marker = PREFIX + markerName(panelName);
  const existing = await run(['-l'], undefined, execFileImpl);
  await run(['-'], replace(existing, marker), execFileImpl);
  return { removed: panelName };
}
