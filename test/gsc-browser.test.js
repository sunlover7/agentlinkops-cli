import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { createGscBrowserExporter, exportGscLinks, gscLinksMain } from '../cli/gsc-browser.js';
import { parseCsv } from '../cli/adapters/csv.js';

const CSV = Buffer.from('Links,Discovered\r\nhttps://publisher.example/article,2026-09-13\r\n');
async function workspace(t) {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'gsc-browser-test-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, outputPath: join(dir, 'links.csv') };
}
function browser({ csv = CSV, status = '', redirect, direct = false, start = 'about:blank', chunks, downloadUrl = 'data:text/csv,Links%0Ahttps%3A%2F%2Fpublisher.example%2Farticle%0A', browserResult } = {}) {
  let url = start, stage = 0;
  const clicks = [], listeners = new Map();
  let cancelled = false, deleted = false;
  const download = { url: () => downloadUrl, createReadStream: async () => Readable.from(chunks ?? [csv]), cancel: async () => { cancelled = true; }, delete: async () => { deleted = true; } };
  const available = text => (stage === 0 && text === 'Export external links') || (stage === 1 && ['Latest links', 'More sample links'].includes(text)) || (stage === 2 && text === 'CSV');
  const locate = text => ({ count: async () => Number(available(text)), isVisible: async () => available(text), click: async () => {
    assert.ok(available(text)); clicks.push(text); stage++;
    if ((direct && stage === 2) || stage === 3) listeners.get('download')?.(download);
  } });
  const page = {
    evaluate: async (fn, args) => browserResult ?? fn(args), url: () => url, goto: async next => { url = redirect ?? next; },
    locator: () => ({ innerText: async () => status }),
    getByRole: (_, opts) => locate(opts.name), getByText: text => locate(text),
    on: (name, fn) => listeners.set(name, fn), off: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); },
  };
  return { page, clicks, listeners, get cancelled() { return cancelled; }, get deleted() { return deleted; } };
}

test('exports exact CSV bytes, private files, checksum, provenance and unknown target mapping', async t => {
  const { outputPath } = await workspace(t);
  const mock = browser();
  const receipt = await exportGscLinks({ page: mock.page, property: 'sc-domain:example.com', outputPath, now: () => new Date('2026-09-14T12:00:00Z') });
  assert.deepEqual(await fs.readFile(outputPath), CSV);
  assert.equal((await fs.stat(outputPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(`${outputPath}.receipt.json`)).mode & 0o777, 0o600);
  assert.equal(receipt.sha256, createHash('sha256').update(CSV).digest('hex'));
  assert.equal(receipt.retrieved_by, 'gsc-browser-export');
  assert.equal(receipt.captured_at, '2026-09-14T12:00:00.000Z');
  assert.equal(receipt.source_column, 'Links');
  assert.equal(receipt.target_mapping_required, true);
  assert.equal(receipt.current_link_status, 'unverified');
  assert.equal(receipt.rows, 1);
  assert.deepEqual(mock.clicks, ['Export external links', 'Latest links', 'CSV']);
  assert.equal(mock.listeners.size, 0);
  assert.ok(mock.deleted);
  assert.deepEqual(JSON.parse(await fs.readFile(`${outputPath}.receipt.json`, 'utf8')), receipt);
});

test('sample links support direct download and Linking page headers', async t => {
  const { outputPath } = await workspace(t);
  const csv = Buffer.from('"Linking page"\n"https://publisher.example/a,b"\n');
  const mock = browser({ csv, direct: true });
  const receipt = await exportGscLinks({ page: mock.page, property: 'https://example.com/', kind: 'sample', outputPath });
  assert.equal(receipt.source_column, 'Linking page');
  assert.equal(receipt.rows, 1);
  assert.deepEqual(mock.clicks, ['Export external links', 'More sample links']);
});

test('serialized Playwriter factory retains private-file checks with explicit dependencies', async t => {
  const { outputPath } = await workspace(t);
  const factory = runInNewContext(`(${createGscBrowserExporter.toString()})`, { Buffer, URL, setTimeout, clearTimeout });
  const exporter = factory({ fs, path, createHash, parseCsv, platform: process.platform });
  await exporter({ page: browser().page, property: 'sc-domain:example.com', outputPath });
  assert.deepEqual(await fs.readFile(outputPath), CSV);
  assert.equal((await fs.stat(outputPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(`${outputPath}.receipt.json`)).mode & 0o777, 0o600);
});

for (const invalidFile of ['output', 'receipt']) {
  test(`refuses unsupported ${invalidFile} permissions before writing either export artifact`, async t => {
    const { outputPath } = await workspace(t);
    let writes = 0, closes = 0;
    const exporter = createGscBrowserExporter({ path, createHash, parseCsv, platform: 'darwin', fs: { ...fs,
      open: async (file, ...args) => {
        const handle = await fs.open(file, ...args);
        return {
          stat: async () => {
            const info = await handle.stat();
            const invalid = invalidFile === 'output' ? file === outputPath : file !== outputPath;
            return { isFile: () => info.isFile(), mode: invalid ? 0o100700 : 0o100600 };
          },
          writeFile: async value => { writes++; return handle.writeFile(value); },
          close: async () => { closes++; return handle.close(); },
        };
      },
    } });
    const mock = browser();
    await assert.rejects(exporter({ page: mock.page, property: 'sc-domain:example.com', outputPath }), { code: 'private_storage_required' });
    assert.equal(writes, 0); assert.equal(closes, 2);
    for (const file of [outputPath, `${outputPath}.receipt.json`]) await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
    assert.ok(mock.cancelled); assert.ok(mock.deleted); assert.equal(mock.listeners.size, 0);
  });
}

test('receipt creation collision preserves the competing file and removes only the empty owned output', async t => {
  const { outputPath } = await workspace(t);
  const receiptPath = `${outputPath}.receipt.json`;
  const exporter = createGscBrowserExporter({ path, createHash, parseCsv, fs: { ...fs,
    open: async (file, ...args) => {
      if (file === receiptPath) await fs.writeFile(file, 'owner receipt');
      return fs.open(file, ...args);
    },
  } });
  await assert.rejects(exporter({ page: browser().page, property: 'sc-domain:example.com', outputPath }), { code: 'output_exists' });
  assert.equal(await fs.readFile(receiptPath, 'utf8'), 'owner receipt');
  await assert.rejects(fs.lstat(outputPath), { code: 'ENOENT' });
});

test('partial output write failure removes both owned artifacts', async t => {
  const { outputPath } = await workspace(t);
  const exporter = createGscBrowserExporter({ path, createHash, parseCsv, fs: { ...fs,
    open: async (file, ...args) => {
      const handle = await fs.open(file, ...args);
      return {
        stat: () => handle.stat(), close: () => handle.close(),
        writeFile: async value => { await handle.writeFile(value.slice(0, 4)); throw new Error('fixture disk failure'); },
      };
    },
  } });
  await assert.rejects(exporter({ page: browser().page, property: 'sc-domain:example.com', outputPath }), { code: 'browser_export_failed' });
  for (const file of [outputPath, `${outputPath}.receipt.json`]) await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
});

for (const [status, code] of [['Processing data, please check again in a day or so', 'processing_data'], ["You don't have access to this property", 'permission_required'], ['Sign in to continue', 'login_required']]) {
  test(`refuses ${code} before export clicks`, async t => {
    const { outputPath } = await workspace(t);
    const mock = browser({ status });
    await assert.rejects(exportGscLinks({ page: mock.page, property: 'sc-domain:example.com', outputPath }), { code });
    assert.deepEqual(mock.clicks, []);
    await assert.rejects(fs.lstat(outputPath), { code: 'ENOENT' });
  });
}

for (const [redirect, code] of [
  ['https://search.google.com.evil.example/search-console/links?resource_id=sc-domain:example.com', 'unexpected_origin'],
  ['http://search.google.com/search-console/links?resource_id=sc-domain:example.com', 'unexpected_origin'],
  ['https://search.google.com/search-console/links?resource_id=sc-domain:other.example', 'property_mismatch'],
  ['https://search.google.com/search-console/links?resource_id=sc-domain:example.com&resource_id=sc-domain:example.com', 'property_mismatch'],
  ['https://accounts.google.com/signin', 'login_required'],
]) {
  test(`refuses unsafe redirect ${redirect}`, async t => {
    const { outputPath } = await workspace(t);
    const mock = browser({ redirect });
    await assert.rejects(exportGscLinks({ page: mock.page, property: 'sc-domain:example.com', outputPath }), { code });
    assert.equal(mock.clicks.length, 0);
  });
}

test('refuses to navigate an existing unrelated page', async t => {
  const { outputPath } = await workspace(t);
  const mock = browser({ start: 'https://example.com/' });
  await assert.rejects(exportGscLinks({ page: mock.page, property: 'sc-domain:example.com', outputPath }), { code: 'unexpected_origin' });
  assert.equal(mock.page.url(), 'https://example.com/');
});

test('rejects malicious property values and invalid kinds', async t => {
  const { outputPath } = await workspace(t);
  for (const property of ['javascript:alert(1)', 'https://user:pass@example.com/', 'sc-domain:example.com?x=1', 'https://example.com/#fragment', 'https://example.com', 'sc-domain:a..com']) {
    await assert.rejects(exportGscLinks({ page: browser().page, property, outputPath }), { code: 'invalid_property' });
  }
  await assert.rejects(exportGscLinks({ page: browser().page, property: 'sc-domain:example.com', outputPath, kind: 'all' }), { code: 'invalid_kind' });
});

test('does not overwrite existing output, receipt, or follow symlinks', async t => {
  const { dir, outputPath } = await workspace(t);
  await fs.writeFile(outputPath, 'original');
  await assert.rejects(exportGscLinks({ page: browser().page, property: 'sc-domain:example.com', outputPath }), { code: 'output_exists' });
  assert.equal(await fs.readFile(outputPath, 'utf8'), 'original');
  await fs.unlink(outputPath);
  await fs.symlink(join(dir, 'missing'), outputPath);
  await assert.rejects(exportGscLinks({ page: browser().page, property: 'sc-domain:example.com', outputPath }), { code: 'output_exists' });
  await fs.unlink(outputPath);
  await fs.writeFile(`${outputPath}.receipt.json`, 'original');
  await assert.rejects(exportGscLinks({ page: browser().page, property: 'sc-domain:example.com', outputPath }), { code: 'output_exists' });
});

test('cancels oversized stream and removes partial files', async t => {
  const { outputPath } = await workspace(t);
  const mock = browser({ chunks: [CSV, Buffer.alloc(20 * 1024 * 1024)] });
  await assert.rejects(exportGscLinks({ page: mock.page, property: 'sc-domain:example.com', outputPath }), { code: 'export_too_large' });
  assert.ok(mock.cancelled);
  assert.ok(mock.deleted);
  await assert.rejects(fs.lstat(outputPath), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(`${outputPath}.receipt.json`), { code: 'ENOENT' });
});

for (const [csv, code] of [['<html>Sign in</html>', 'invalid_csv'], ['Linking page\n"unfinished', 'invalid_csv'], ['Top linking sites,Links\n', 'unsupported_csv'], ['Links,Discovered\na,b,c\n', 'unsupported_csv']]) {
  test(`rejects malformed or unsupported CSV ${code}: ${csv}`, async t => {
    const { outputPath } = await workspace(t);
    // Aggregate reports must not pass just because they contain a Links count column.
    const mock = browser({ csv: Buffer.from(csv) });
    await assert.rejects(exportGscLinks({ page: mock.page, property: 'sc-domain:example.com', outputPath }), { code });
    await assert.rejects(fs.lstat(outputPath), { code: 'ENOENT' });
  });
}

test('CLI passes an argument array and removes its temporary script without leaking relay logs', async t => {
  const { dir } = await workspace(t);
  let scriptPath;
  const output = [];
  const code = await gscLinksMain(['gsc-links', '--property', 'sc-domain:example.com', '--session', '123', '--out', 'links.csv'], { cwd: dir, out: text => output.push(text), execFileImpl: async (command, args, opts) => {
    assert.equal(command, 'playwriter'); assert.equal(args[0], '-s'); assert.equal(args[1], '123');
    assert.equal(opts.cwd, dir); scriptPath = args[3];
    const script = await fs.readFile(scriptPath, 'utf8');
    assert.match(script, /context.newPage\(\)/); assert.match(script, /exportPage.close\(\)/);
    assert.ok(script.includes("platform:require('node:os').platform()"));
    assert.ok(!script.includes('context.close('));
    return { stdout: 'relay diagnostic must not appear\n[log] AGENTLINKOPS_GSC_RECEIPT {"sha256":"abc"}\n' };
  } });
  assert.equal(code, 0); assert.deepEqual(output.map(JSON.parse), [{ sha256: 'abc' }]);
  await assert.rejects(fs.lstat(scriptPath), { code: 'ENOENT' });
});

test('CLI reports structured browser errors and rejects option injection', async t => {
  const { dir } = await workspace(t);
  await assert.rejects(gscLinksMain(['--property', 'sc-domain:example.com', '--session', 'a;whoami', '--out', 'x.csv'], { cwd: dir }), { exitCode: 2 });
  await assert.rejects(gscLinksMain(['--property', 'sc-domain:example.com', '--session', '1', '--out', 'x.csv'], { cwd: dir, execFileImpl: async () => ({ stdout: 'AGENTLINKOPS_GSC_ERROR {"code":"processing_data","message":"Google is processing this property."}\n' }) }), { code: 'processing_data', message: 'Google is processing this property.' });
});


test('extension download fallback reads the emitted CSV URL in the page and preserves bytes', async t => {
  const { outputPath } = await workspace(t);
  const mock = browser({ chunks: [] });
  const receipt = await exportGscLinks({ page: mock.page, property: 'sc-domain:example.com', outputPath });
  assert.equal(receipt.retrieval_transport, 'browser-download-url');
  assert.equal(await fs.readFile(outputPath, 'utf8'), 'Links\nhttps://publisher.example/article\n');
});

test('extension fallback refuses arbitrary download origins before browser fetch', async t => {
  const { outputPath } = await workspace(t);
  for (const downloadUrl of ['https://evil.example/export.csv', 'file:///etc/passwd', 'blob:https://evil.example/123', 'https://search.google.com.evil.example/export', 'data:text/html,private']) {
    const mock = browser({ chunks: [], downloadUrl });
    mock.page.evaluate = () => { assert.fail('untrusted download URL reached browser fetch'); };
    await assert.rejects(exportGscLinks({ page: mock.page, property: 'sc-domain:example.com', outputPath }), { code: 'unsafe_download' });
  }
});

test('extension fallback preserves browser byte-limit errors without saving output', async t => {
  const { outputPath } = await workspace(t);
  const mock = browser({ chunks: [], browserResult: { error: 'export_too_large' } });
  await assert.rejects(exportGscLinks({ page: mock.page, property: 'sc-domain:example.com', outputPath }), { code: 'export_too_large' });
  await assert.rejects(fs.lstat(outputPath), { code: 'ENOENT' });
});
