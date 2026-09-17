import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from './args.js';
import { parseCsv, CsvError } from './adapters/csv.js';

export const GSC_BROWSER_HELP = `agentlinkops gsc-links --property PROPERTY --session SESSION --out FILE.csv [--kind latest|sample]

Export GSC links through your signed-in browser and installed Playwriter.
Use an existing Playwriter session. The command opens and closes its own tab.
Files must be new. CSV exports are limited to 20 MiB and include a receipt.
Review column mapping before importing. The export does not prove links are live.`;

// This factory also runs in Playwriter's CommonJS sandbox. Keep dependencies explicit.
export function createGscBrowserExporter({ fs, path, createHash, parseCsv }) {
  const limit = 20 * 1024 * 1024;
  const fail = (code, message) => Object.assign(new Error(message), { code, exitCode: 2 });
  async function bounded(promise, milliseconds) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(fail('download_timeout', 'The CSV download timed out. Retry the export.')), milliseconds); })]); }
    finally { clearTimeout(timer); }
  }
  function propertyValue(value) {
    if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value)) throw fail('invalid_property', 'Provide an exact GSC property.');
    if (value.startsWith('sc-domain:')) {
      const host = value.slice(10);
      if (host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?$/i.test(host) || host.split('.').some(x => x.length > 63)) throw fail('invalid_property', 'Provide a valid GSC domain property.');
      return value;
    }
    let url;
    try { url = new URL(value); } catch { throw fail('invalid_property', 'Provide a valid GSC URL property.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.href !== value) throw fail('invalid_property', 'Use the exact GSC URL property, including its trailing slash.');
    return value;
  }
  function assertPage(page, property, { initial = false } = {}) {
    const current = page.url();
    if (initial && current === 'about:blank') return;
    let url;
    try { url = new URL(current); } catch { throw fail('unexpected_origin', 'The browser left Search Console.'); }
    if (url.origin === 'https://accounts.google.com') throw fail('login_required', 'Sign in to Google in your browser, then retry.');
    if (url.origin !== 'https://search.google.com' || url.username || url.password) throw fail('unexpected_origin', 'The browser left Search Console.');
    if (url.pathname !== '/search-console/links' || url.searchParams.getAll('resource_id').length !== 1 || url.searchParams.get('resource_id') !== property) throw fail('property_mismatch', 'The browser property does not match the requested GSC property.');
  }
  async function pageState(page, property) {
    assertPage(page, property);
    const body = await page.locator('body').innerText({ timeout: 5000 });
    if (/processing data|check (?:back )?again in (?:a (?:day|few days)|a day or so)/i.test(body)) throw fail('processing_data', 'Google is processing this property. Retry when its Links report has data.');
    if (/you (?:do not|don.t) have (?:access|permission)|access denied|verify (?:your )?ownership|ownership verification/i.test(body)) throw fail('permission_required', 'This Google account needs access to the selected property.');
    if (/sign in to (?:continue|google search console)/i.test(body)) throw fail('login_required', 'Sign in to Google in your browser, then retry.');
  }
  async function visibleChoice(page, text) {
    for (const locator of [page.getByRole('menuitem', { name: text, exact: true }), page.getByRole('button', { name: text, exact: true }), page.getByText(text, { exact: true })]) {
      if (await locator.count() === 1 && await locator.isVisible()) return locator;
    }
    return null;
  }
  async function choice(page, property, text, timeout = 10000) {
    const until = Date.now() + timeout;
    do {
      await pageState(page, property);
      const found = await visibleChoice(page, text);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < until);
    throw fail('export_unavailable', 'The expected GSC export control is unavailable. Open the Links report to check its state.');
  }
  return async function exportLinks({ page, property, outputPath, kind = 'latest', now = () => new Date() }) {
    property = propertyValue(property);
    if (!['latest', 'sample'].includes(kind)) throw fail('invalid_kind', 'Choose latest or sample.');
    if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath) || !outputPath.toLowerCase().endsWith('.csv') || /[\u0000-\u001f\u007f]/u.test(outputPath)) throw fail('invalid_output', 'Choose an absolute CSV output path.');
    const parent = await fs.realpath(path.dirname(outputPath));
    if (parent !== path.resolve(path.dirname(outputPath))) throw fail('unsafe_output', 'The output directory must not use symbolic links.');
    const receiptPath = `${outputPath}.receipt.json`;
    for (const candidate of [outputPath, receiptPath]) {
      try { await fs.lstat(candidate); throw fail('output_exists', 'The output or receipt file already exists. Choose a new path.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    assertPage(page, property, { initial: true });
    const report = new URL('https://search.google.com/search-console/links');
    report.searchParams.set('resource_id', property);
    report.searchParams.set('hl', 'en');
    let download, ownedOutput = false, ownedReceipt = false;
    const receive = item => { if (!download) download = item; };
    try {
      await page.goto(report.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const exportButton = await choice(page, property, 'Export external links');
      await exportButton.click({ timeout: 5000 });
      await pageState(page, property);
      const kindButton = await choice(page, property, kind === 'latest' ? 'Latest links' : 'More sample links');
      page.on('download', receive);
      await kindButton.click({ timeout: 5000 });
      const until = Date.now() + 15000;
      let csvClicked = false;
      do {
        await pageState(page, property);
        if (download) break;
        if (!csvClicked) {
          const csvButton = await visibleChoice(page, 'Download CSV') || await visibleChoice(page, 'CSV');
          if (csvButton) { await csvButton.click({ timeout: 5000 }); csvClicked = true; }
        }
        if (!download) await new Promise(resolve => setTimeout(resolve, 200));
      } while (!download && Date.now() < until);
      if (!download) throw fail('download_unavailable', 'Google did not provide a CSV download. Check the Links report and retry.');
      assertPage(page, property);
      // The browser owns authenticated retrieval. Never extract cookies or replay private RPCs.
      let stream;
      try { stream = await bounded(download.createReadStream(), 15000); } catch { /* The extension can emit downloads without a relay-side artifact. */ }
      const hash = createHash('sha256');
      const chunks = [];
      let bytes = 0;
      async function accept(data) {
        const chunk = Buffer.from(data);
        bytes += chunk.length;
        if (bytes > limit) throw fail('export_too_large', 'The CSV export exceeds the 20 MiB limit.');
        hash.update(chunk); chunks.push(chunk);
      }
      let retrievalTransport = 'download-stream';
      try {
        if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
          const iterator = stream[Symbol.asyncIterator]();
          const streamDeadline = Date.now() + 15000;
          while (true) {
            const remaining = streamDeadline - Date.now();
            if (remaining <= 0) throw fail('download_timeout', 'The CSV download timed out. Retry the export.');
            const {value: data, done} = await bounded(iterator.next(), remaining);
            if (done) break;
            await accept(data);
          }
        }
      } finally { stream?.destroy?.(); }
      if (!bytes) {
        // Extension mode may have no relay-side file. Read only the URL emitted by
        // this page's download event, inside that same signed-in page. No cookies,
        // request headers or private RPC identifiers leave the browser.
        const downloadUrl = download.url();
        const parsed = new URL(downloadUrl);
        const allowed = (parsed.protocol === 'https:' && parsed.origin === 'https://search.google.com' && !parsed.username && !parsed.password) ||
          (parsed.protocol === 'blob:' && parsed.origin === 'https://search.google.com') ||
          /^data:text\/csv[;,]/i.test(downloadUrl);
        if (!allowed) throw fail('unsafe_download', 'Google returned an unsupported download address. Export the CSV manually.');
        assertPage(page, property);
        const result = await bounded(page.evaluate(async ({ url, maxBytes }) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 12000);
          let reader;
          try {
            const response = await fetch(url, { credentials: 'include', redirect: 'error', signal: controller.signal });
            if (!response.ok || !response.body) return { error: 'download_unavailable' };
            if (Number(response.headers.get('content-length')) > maxBytes) return { error: 'export_too_large' };
            reader = response.body.getReader();
            let total = 0;
            const encoded = [];
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              total += value.byteLength;
              if (total > maxBytes) return { error: 'export_too_large' };
              let binary = '';
              for (let offset = 0; offset < value.length; offset += 32768) binary += String.fromCharCode(...value.subarray(offset, offset + 32768));
              encoded.push(btoa(binary));
            }
            return { chunks: encoded };
          } catch { return { error: 'download_unavailable' }; }
          finally { clearTimeout(timer); await reader?.cancel().catch(() => {}); controller.abort(); }
        }, { url: downloadUrl, maxBytes: limit }), 15000);
        if (result.error) throw fail(result.error, result.error === 'export_too_large' ? 'The CSV export exceeds the 20 MiB limit.' : 'The browser could not read its CSV download. Export it manually and import the file.');
        for (const encoded of result.chunks) await accept(Buffer.from(encoded, 'base64'));
        retrievalTransport = 'browser-download-url';
      }
      const csv = Buffer.concat(chunks).toString('utf8');
      if (!bytes || /^\s*</.test(csv) || csv.includes('\u0000')) throw fail('invalid_csv', 'The downloaded file is not a CSV export.');
      let rows;
      try { rows = parseCsv(csv); } catch { throw fail('invalid_csv', 'The CSV export has invalid quoting.'); }
      const headers = rows[0]?.map(value => value.trim()) ?? [];
      const sourceHeader = headers.find(value => /^(linking page|links|source url)$/i.test(value));
      if (!sourceHeader || headers.length > 30 || new Set(headers).size !== headers.length || headers.some(value => /^(top linking sites|top linked pages|domain|link count|external links)$/i.test(value)) || rows.slice(1).some(row => row.length !== headers.length)) throw fail('unsupported_csv', 'The CSV columns differ from the supported GSC exports. Review the export format.');
      const sourceIndex = headers.indexOf(sourceHeader);
      if (rows.slice(1).some(row => {
        try { const source = new URL(row[sourceIndex]); return !['http:', 'https:'].includes(source.protocol) || Boolean(source.username || source.password); }
        catch { return true; }
      })) throw fail('unsupported_csv', 'The source column must contain page URLs. Review the export format.');
      const timestamp = typeof now === 'function' ? now() : now;
      const receipt = {
        schema_version: 1, retrieved_by: 'gsc-browser-export', retrieval_transport: retrievalTransport, property, kind,
        captured_at: new Date(timestamp).toISOString(), output_path: outputPath,
        sha256: hash.digest('hex'), bytes, rows: rows.length - 1, headers,
        source_column: sourceHeader, target_mapping_required: true,
        sampled: true, current_link_status: 'unverified',
      };
      await fs.writeFile(outputPath, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 }); ownedOutput = true;
      await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); ownedReceipt = true;
      return receipt;
    } catch (error) {
      await download?.cancel?.().catch(() => {});
      if (ownedOutput) await fs.unlink(outputPath).catch(() => {});
      if (ownedReceipt) await fs.unlink(receiptPath).catch(() => {});
      if (error.exitCode === 2) throw error;
      throw fail('browser_export_failed', 'GSC export failed. Check your browser session and retry.');
    } finally {
      page.off('download', receive);
      await download?.delete?.().catch(() => {});
    }
  };
}

export const exportGscLinks = createGscBrowserExporter({ fs, path, createHash, parseCsv });

export async function gscLinksMain(argv, { cwd = process.cwd(), out = console.log, execFileImpl = promisify(execFile) } = {}) {
  const args = parseArgs(argv);
  if (args._[0] === 'gsc-links') args._.shift();
  if (args.help === true && Object.keys(args).length === 2 && !args._.length) { out(GSC_BROWSER_HELP); return 0; }
  if (args._.length || Object.keys(args).some(key => !['_', 'property', 'session', 'out', 'kind'].includes(key)) ||
      ['property', 'session', 'out'].some(key => typeof args[key] !== 'string' || !args[key]) ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(args.session) || (args.kind !== undefined && !['latest', 'sample'].includes(args.kind))) {
    throw Object.assign(new Error(GSC_BROWSER_HELP), { exitCode: 2 });
  }
  const outputPath = path.resolve(cwd, args.out);
  const scratch = await fs.mkdtemp(path.join(tmpdir(), 'agentlinkops-gsc-'));
  try {
    // Pass source/config as a file argument, never interpolate a shell command.
    const script = `const CsvError = ${CsvError.toString()};\nconst parseCsv = ${parseCsv.toString()};\nconst exportLinks = (${createGscBrowserExporter.toString()})({fs:require('node:fs').promises,path:require('node:path'),createHash:require('node:crypto').createHash,parseCsv});\nconst config = ${JSON.stringify({ property: args.property, outputPath, kind: args.kind ?? 'latest' })};\nconst exportPage = await context.newPage();\ntry { const receipt = await exportLinks({...config,page:exportPage}); console.log('AGENTLINKOPS_GSC_RECEIPT '+JSON.stringify(receipt)); } catch(error) { console.log('AGENTLINKOPS_GSC_ERROR '+JSON.stringify({code:error.code||'browser_export_failed',message:error.message})); } finally { await exportPage.close(); }\n`;
    const scriptPath = path.join(scratch, 'export.js');
    await fs.writeFile(scriptPath, script, { mode: 0o600 });
    let stdout;
    try { ({ stdout } = await execFileImpl('playwriter', ['-s', args.session, '-f', scriptPath, '--timeout', '60000'], { cwd, timeout: 65000, maxBuffer: 1024 * 1024 })); }
    catch { throw Object.assign(new Error('Playwriter could not finish the export. Check the session and installed command.'), { code: 'playwriter_failed', exitCode: 2 }); }
    const lines = stdout.split('\n').map(line => line.replace(/^\[log\]\s*/, ''));
    const errorLine = lines.find(line => line.startsWith('AGENTLINKOPS_GSC_ERROR '));
    if (errorLine) { const error = JSON.parse(errorLine.slice('AGENTLINKOPS_GSC_ERROR '.length)); throw Object.assign(new Error(error.message), { code: error.code, exitCode: 2 }); }
    const receiptLine = lines.find(line => line.startsWith('AGENTLINKOPS_GSC_RECEIPT '));
    if (!receiptLine) throw Object.assign(new Error('Playwriter returned no export receipt.'), { code: 'receipt_missing', exitCode: 2 });
    const receipt = JSON.parse(receiptLine.slice('AGENTLINKOPS_GSC_RECEIPT '.length));
    out(JSON.stringify(receipt, null, 2));
    return 0;
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}
