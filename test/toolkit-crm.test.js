import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/agentlinkops.py', import.meta.url));

function fixture(t, initialize = true) {
  const root = mkdtempSync(join(tmpdir(), 'linktrail-crm-'));
  const db = join(root, 'crm.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = (...args) => JSON.parse(execFileSync('python3', [script, '--db', db, ...args], { encoding: 'utf8', stdio: 'pipe' }));
  const put = (entity, value) => JSON.parse(execFileSync('python3', [script, '--db', db, entity, 'upsert'], { input: JSON.stringify(value), encoding: 'utf8', stdio: 'pipe' }));
  const python = (code, ...args) => execFileSync('python3', ['-c', code, db, ...args], { encoding: 'utf8' });
  if (initialize) cli('init', '--workspace', 'workspace-a');
  return { root, db, cli, put, python };
}

function event(id = 'event-1', extra = {}) {
  return {
    id, workspace_id: 'workspace-a', cursor: `opaque-${id}`, type: 'watch.checked',
    project_id: 'project-a', watch_id: 'watch-a', created_at: '2026-09-09T12:00:00Z',
    data: { before: null, after: { state: 'present', source_url: 'https://publisher.example/resources', target_url: 'https://product.example/guide' } },
    ...extra,
  };
}

function page(events, extra = {}) {
  return { workspace_id: 'workspace-a', events, next_cursor: events.at(-1)?.cursor ?? 'opaque-zero', has_more: false, ...extra };
}

async function service(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function sync(db, origin, ...args) {
  return JSON.parse((await exec('python3', [script, '--db', db, 'sync', ...args], {
    env: { ...process.env, AGENTLINKOPS_API_URL: origin, AGENTLINKOPS_API_KEY: 'test-only-not-a-real-key' },
  })).stdout);
}

const readDb = `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]); c.row_factory=sqlite3.Row
print(json.dumps({'events':c.execute('select count(*) from cloud_events').fetchone()[0], 'cursor':c.execute('select cursor from sync_state').fetchone()[0], 'placements':[dict(x) for x in c.execute('select * from placements')]}))`;

test('offline campaign lifecycle supports all entities, partial updates, references and portable export', t => {
  const f = fixture(t);
  assert.equal(f.put('product', { id: 'p1', name: 'Product', url: 'https://product.example/', target_pages: ['https://product.example/guide'] }).id, 'p1');
  f.put('campaign', { id: 'c1', product_id: 'p1', name: 'Resources', type: 'resource_addition' });
  f.put('contact', { id: 'editor', publisher_url: 'https://publisher.example/', email: 'editor@publisher.example', source_url: 'https://publisher.example/about', observed_at: '2026-09-09T10:00:00Z' });
  f.put('opportunity', { id: 'o1', campaign_id: 'c1', contact_id: 'editor', source_url: 'https://publisher.example/resources', target_url: 'https://product.example/guide', notes: 'Qualified by editor relevance.' });
  f.put('activity', { id: 'a1', opportunity_id: 'o1', kind: 'sent', external_message_id: 'mail-system-id', occurred_at: '2026-09-09T10:00:00Z' });
  f.put('placement', { id: 'l1', opportunity_id: 'o1', source_url: 'https://publisher.example/resources', target_url: 'https://product.example/guide' });
  f.put('opportunity', { id: 'o1', status: 'accepted' });
  assert.equal(f.cli('opportunity', 'list', '--id', 'o1')[0].notes, 'Qualified by editor relevance.');
  const exported = f.cli('export');
  assert.equal(exported.records.activity[0].external_message_id, 'mail-system-id');
  assert.equal(Object.keys(exported.records).length, 6);
  assert.equal(f.cli('init', '--workspace', 'workspace-a').schema_version, 4);
  assert.equal(statSync(f.db).mode & 0o777, 0o600);
});

test('invalid bulk records roll back all writes and reject message bodies and credentials', t => {
  const f = fixture(t);
  assert.throws(() => f.put('product', [
    { id: 'p1', name: 'First', url: 'https://product.example/' },
    { id: 'p2', name: 'Second', url: 'https://product.example/', api_key: 'not-stored' },
  ]));
  assert.equal(f.cli('product', 'list').length, 0);
  assert.throws(() => f.put('activity', { id: 'a1', kind: 'sent', occurred_at: '2026-09-09T10:00:00Z', body: 'Do not store email contents' }));
  assert.throws(() => f.put('opportunity', { id: 'o1', source_url: 'https://a.example/', target_url: 'https://b.example/', campaign_id: 'missing' }));
  assert.equal(f.cli('activity', 'list').length, 0);
});

test('paginated sync creates placements, resumes from cursor, and deduplicates repeated events', async t => {
  const f = fixture(t);
  let requests = 0;
  const first = event();
  const second = event('event-2', { type: 'placement_lost', data: { after: { state: 'confirmed_missing', source_url: 'https://publisher.example/resources', target_url: 'https://product.example/guide' } } });
  const origin = await service(t, (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-only-not-a-real-key');
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.pathname, '/v1/events');
    requests += 1;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(url.searchParams.get('cursor') ? page([second]) : page([first], { has_more: true })));
  });
  assert.deepEqual(await sync(f.db, origin), { applied: 2, pages: 2, next_cursor: second.cursor, has_more: false });
  assert.equal((await sync(f.db, origin)).applied, 0);
  const saved = JSON.parse(f.python(readDb));
  assert.equal(saved.events, 2);
  assert.equal(saved.placements.length, 1);
  assert.equal(JSON.parse(saved.placements[0].cloud_state).state, 'confirmed_missing');
  assert.equal(requests, 3);
});

test('cloud state updates retain local notes, outreach status and opportunity relationships', async t => {
  const f = fixture(t);
  f.put('opportunity', { id: 'o1', source_url: 'https://publisher.example/resources', target_url: 'https://product.example/guide' });
  f.put('placement', { id: 'my-placement', opportunity_id: 'o1', project_id: 'project-a', watch_id: 'watch-a', source_url: 'https://publisher.example/resources', target_url: 'https://product.example/guide', status: 'editor-confirmed', notes: 'Keep this relationship context.', cost_amount: '25.50', cost_currency: 'USD' });
  const origin = await service(t, (_req, res) => res.end(JSON.stringify(page([event()]))));
  await sync(f.db, origin);
  const row = f.cli('placement', 'list')[0];
  assert.equal(row.notes, 'Keep this relationship context.');
  assert.equal(row.status, 'editor-confirmed');
  assert.equal(row.opportunity_id, 'o1');
  assert.equal(row.cloud_state.state, 'present');
  assert.equal(row.cost_amount, '25.5');
  assert.equal(row.cost_currency, 'USD');
});

test('a failure partway through a page rolls back events, new placements and cursor', async t => {
  const f = fixture(t);
  const bad = event('event-2', { watch_id: 'watch-b', data: { after: 'malformed' } });
  const origin = await service(t, (_req, res) => res.end(JSON.stringify(page([event(), bad]))));
  await assert.rejects(sync(f.db, origin), error => error.stderr.includes('INVALID_EVENT_PAGE'));
  assert.deepEqual(JSON.parse(f.python(readDb)), { events: 0, cursor: null, placements: [] });
});

test('workspace mismatch and mismatched nested watch IDs fail without advancing the feed', async t => {
  for (const broken of [page([event()], { workspace_id: 'another-workspace' }), page([event('e1', { workspace_id: 'another-workspace' })]), page([event('e1', { data: { after: { watch_id: 'another-watch' } } })])]) {
    const f = fixture(t);
    const origin = await service(t, (_req, res) => res.end(JSON.stringify(broken)));
    await assert.rejects(sync(f.db, origin));
    assert.equal(JSON.parse(f.python(readDb)).cursor, null);
    assert.equal(JSON.parse(f.python(readDb)).events, 0);
  }
});

test('expired cursor preserves committed state and reports a recovery requirement', async t => {
  const f = fixture(t);
  let expired = false;
  const origin = await service(t, (_req, res) => {
    res.statusCode = expired ? 410 : 200;
    res.end(JSON.stringify(expired ? { error: { code: 'CURSOR_EXPIRED' } } : page([event()])));
  });
  await sync(f.db, origin);
  const before = f.python(readDb);
  expired = true;
  await assert.rejects(sync(f.db, origin), error => error.stderr.includes('CURSOR_EXPIRED'));
  assert.equal(f.python(readDb), before);
});

test('missing cursor and malformed event shapes produce structured errors without writes', async t => {
  for (const broken of [page([event()], { next_cursor: null }), page([null]), page([event('e1', { data: null })]), page([event('e1', { data: { after: null } })])]) {
    const f = fixture(t);
    const origin = await service(t, (_req, res) => res.end(JSON.stringify(broken)));
    await assert.rejects(sync(f.db, origin), error => {
      assert.ok(JSON.parse(error.stderr).error.code);
      assert.ok(!error.stderr.includes('Traceback'));
      return true;
    });
    assert.equal(JSON.parse(f.python(readDb)).events, 0);
  }
});

test('project-scoped empty pages advance opaque scan cursors; future events are retained', async t => {
  const f = fixture(t);
  let phase = 0;
  const origin = await service(t, (_req, res) => {
    res.end(JSON.stringify(phase++ === 0 ? page([], { next_cursor: 'opaque-hidden-highwater' }) : page([event('future', { type: 'research.completed', watch_id: null, data: { job_id: 'job1' } })])));
  });
  assert.equal((await sync(f.db, origin)).next_cursor, 'opaque-hidden-highwater');
  await sync(f.db, origin);
  const saved = JSON.parse(f.python(readDb));
  assert.equal(saved.events, 1);
  assert.equal(saved.placements.length, 0);
});

test('changed duplicate payload fails; known cursor cannot rewind', async t => {
  const f = fixture(t);
  let response = page([event(), event('event-2')]);
  const origin = await service(t, (_req, res) => res.end(JSON.stringify(response)));
  await sync(f.db, origin);
  response = page([event('event-2', { data: { after: { state: 'unknown' } } })]);
  await assert.rejects(sync(f.db, origin), error => error.stderr.includes('EVENT_CONFLICT'));
  response = page([event()]);
  await assert.rejects(sync(f.db, origin), error => error.stderr.includes('INVALID_EVENT_PAGE'));
  assert.equal(JSON.parse(f.python(readDb)).cursor, 'opaque-event-2');
});

test('HTTP redirects do not forward credentials and endpoint changes fail before a request', async t => {
  const f = fixture(t);
  let leaked = 0;
  const target = await service(t, (_req, res) => { leaked += 1; res.end('{}'); });
  const origin = await service(t, (_req, res) => { res.writeHead(302, { Location: target }); res.end(); });
  await assert.rejects(sync(f.db, origin), error => error.stderr.includes('HTTP_ERROR'));
  assert.equal(leaked, 0);
  const valid = await service(t, (_req, res) => res.end(JSON.stringify(page([event()]))));
  await sync(f.db, valid);
  await assert.rejects(sync(f.db, target), error => error.stderr.includes('ENDPOINT_MISMATCH'));
  assert.equal(leaked, 0);
});

test('guarded migrations refuse unrelated DBs, workspace changes, downgrades and tampered checksums', t => {
  const unrelated = fixture(t, false);
  unrelated.python("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('create table important_data (id integer)'); c.commit()");
  const before = readFileSync(unrelated.db);
  assert.throws(() => unrelated.cli('init', '--workspace', 'workspace-a'));
  assert.deepEqual(readFileSync(unrelated.db), before);
  const f = fixture(t);
  assert.throws(() => f.cli('init', '--workspace', 'workspace-b'));
  f.python("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('pragma user_version=999'); c.commit()");
  assert.throws(() => f.cli('migrate'));
  f.python("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('pragma user_version=4'); c.execute(\"update schema_migrations set checksum='tampered' where version=1\"); c.commit()");
  assert.throws(() => f.cli('migrate'));
});

test('schema upgrade preserves records and creates a restorable backup first', t => {
  const f = fixture(t, false);
  f.python(`import sys
sys.path.insert(0,sys.argv[2])
import agentlinkops as linktrail
all_migrations=linktrail.migrations()
linktrail.migrations=lambda:all_migrations[:1]
c=linktrail.connect(sys.argv[1],True)
linktrail.migrate(c,sys.argv[1],'workspace-a',True)
c.execute("insert into products(id,name,url,created_at,updated_at) values ('p1','Original','https://example.com/','2026-09-09','2026-09-09')")
c.close()`, dirname(script));
  const result = f.cli('migrate');
  assert.equal(result.schema_version, 4);
  assert.equal(f.cli('product', 'list')[0].name, 'Original');
  assert.equal(readdirSync(f.root).filter(name => name.endsWith('.bak')).length, 1);
  const backupVersion = execFileSync('python3', ['-c', "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('pragma user_version').fetchone()[0])", result.backup], { encoding: 'utf8' }).trim();
  assert.equal(backupVersion, '1');
});

test('CSV neutralizes formula text and export refuses to overwrite existing files', t => {
  const f = fixture(t);
  f.put('contact', { id: 'editor', publisher_url: 'https://example.com/', name: '=1+1' });
  const output = execFileSync('python3', [script, '--db', f.db, 'export', '--format', 'csv', '--entity', 'contact'], { encoding: 'utf8' });
  assert.ok(output.includes("'=1+1"));
  const path = join(f.root, 'export.json');
  writeFileSync(path, 'existing export');
  assert.throws(() => f.cli('export', '--output', path));
  assert.equal(readFileSync(path, 'utf8'), 'existing export');
});

test('disavow imports normalize and deduplicate rules while retaining comments and source provenance', t => {
  const f = fixture(t);
  const path = join(f.root, 'rules.txt');
  writeFileSync(path, '\ufeff# Publisher review\r\ndomain:Bad.Example.COM\r\nhttps://Other.Example/Über?keep=Case#section\r\ndomain:bad.example.com\r\n');
  const input = ['disavow', 'import', '--property', 'https://My.Example/', '--source', 'User-reviewed existing list', '--file', path];
  assert.equal(f.cli(...input).rules_added, 2);
  assert.equal(f.cli(...input).rules_added, 0);
  const rules = f.cli('disavow', 'list', '--property', 'https://my.example/');
  assert.equal(rules.length, 2);
  assert.equal(rules[0].value, 'bad.example.com');
  assert.equal(rules[0].provenance.length, 2);
  assert.deepEqual(rules[0].provenance[0].comments, [{ line: 1, text: 'Publisher review' }]);
  assert.equal(rules[1].value, 'https://other.example/Über?keep=Case#section');
  const snapshot = f.cli('export').disavow;
  assert.equal(snapshot.sources.length, 1);
  assert.ok(snapshot.sources[0].raw_text.includes('# Publisher review'));
  assert.equal(snapshot.provenance.length, 3);
});

test('disavow export is deterministic, property-scoped and excludes disabled rules and private notes', t => {
  const f = fixture(t);
  const upsert = (property, value) => JSON.parse(execFileSync('python3', [script, '--db', f.db, 'disavow', 'upsert', '--property', property, '--source', 'User choice'], { input: JSON.stringify(value), encoding: 'utf8', stdio: 'pipe' }));
  upsert('https://my.example/', { kind: 'url', value: 'https://bad.example/page', notes: 'Private assessment note' });
  upsert('https://my.example/', { kind: 'domain', value: 'z.example' });
  upsert('https://my.example/', { kind: 'domain', value: 'a.example' });
  upsert('https://other.example/', { kind: 'domain', value: 'separate.example' });
  upsert('https://my.example/', { kind: 'domain', value: 'z.example', active: false, notes: 'Keep disabled' });
  const path = join(f.root, 'old-list.txt'); writeFileSync(path, 'domain:z.example\n');
  f.cli('disavow', 'import', '--property', 'https://my.example/', '--source', 'Older list', '--file', path);
  const exportText = () => execFileSync('python3', [script, '--db', f.db, 'disavow', 'export', '--property', 'https://my.example/'], { encoding: 'utf8', stdio: 'pipe' });
  const expected = '# AgentLinkOps user-managed disavow rules\n# Property: https://my.example/\ndomain:a.example\nhttps://bad.example/page\n';
  assert.equal(exportText(), expected);
  assert.equal(exportText(), expected);
  const disabled = f.cli('disavow', 'list', '--property', 'https://my.example/').find(rule => rule.value === 'z.example');
  assert.equal(disabled.active, false);
  assert.equal(disabled.notes, 'Keep disabled');
  assert.equal(disabled.provenance.length, 3);
  assert.equal(f.cli('disavow', 'list', '--property', 'https://other.example/').length, 1);
});

test('invalid disavow import leaves every rule and source unchanged', t => {
  const f = fixture(t);
  for (const content of ['domain:valid.example\nhttps://bad.example/subpath/*\n', 'domain:valid.example\ndomain:https://bad.example/\n', 'domain:valid.example\nhttps://user:pass@bad.example/\n']) {
    const path = join(f.root, 'invalid.txt'); writeFileSync(path, content);
    assert.throws(() => f.cli('disavow', 'import', '--property', 'https://my.example/', '--source', 'Invalid candidate file', '--file', path));
    assert.deepEqual(f.cli('export').disavow, { rules: [], sources: [], provenance: [] });
  }
});

test('disavow parser enforces Google file encoding, size, URL length and physical line limits', t => {
  const f = fixture(t);
  const invalid = [Buffer.from([0xff, 0xfe, 0x64, 0x00]), Buffer.alloc(2000001, 32), Buffer.from('\n'.repeat(100001)), Buffer.from('https://bad.example/' + 'x'.repeat(2048))];
  for (const data of invalid) {
    const path = join(f.root, 'invalid.txt'); writeFileSync(path, data);
    assert.throws(() => f.cli('disavow', 'import', '--property', 'https://my.example/', '--source', 'Invalid file', '--file', path));
  }
  assert.equal(f.cli('disavow', 'list', '--property', 'https://my.example/').length, 0);
});

test('disavow files never overwrite an existing export and JSON backup includes provenance', t => {
  const f = fixture(t);
  const source = join(f.root, 'source.txt'); writeFileSync(source, '# Evidence note\ndomain:bad.example\n');
  f.cli('disavow', 'import', '--property', 'https://my.example/', '--source', 'Reviewed import', '--file', source);
  const output = join(f.root, 'export.txt'); writeFileSync(output, 'existing approved list');
  assert.throws(() => f.cli('disavow', 'export', '--property', 'https://my.example/', '--output', output));
  assert.equal(readFileSync(output, 'utf8'), 'existing approved list');
  assert.equal(f.cli('export').disavow.sources[0].source_label, 'Reviewed import');
});

test('disavow migration upgrades a populated v2 CRM with a backup and preserves workspace and synced history', t => {
  const f = fixture(t, false);
  f.python(`import sys
sys.path.insert(0,sys.argv[2])
import agentlinkops as linktrail
original=linktrail.migrations()
linktrail.migrations=lambda:original[:2]
c=linktrail.connect(sys.argv[1],True)
linktrail.migrate(c,sys.argv[1],'workspace-a',True)
linktrail.upsert(c,'placement',{'id':'local-placement','source_url':'https://publisher.example/','target_url':'https://my.example/','notes':'Retain my private notes'})
c.execute("update sync_state set cursor='opaque-existing-cursor',endpoint='https://cloud.example'")
c.close()`, dirname(script));
  const result = f.cli('migrate');
  assert.equal(result.schema_version, 4);
  assert.equal(f.cli('placement', 'list')[0].notes, 'Retain my private notes');
  assert.equal(f.cli('status').sync.cursor, 'opaque-existing-cursor');
  assert.equal(f.cli('status').workspace_id, 'workspace-a');
  assert.equal(f.cli('disavow', 'list', '--property', 'https://my.example/').length, 0);
  const version = execFileSync('python3', ['-c', "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('pragma user_version').fetchone()[0])", result.backup], { encoding: 'utf8' }).trim();
  assert.equal(version, '2');
});

test('HTML report is deterministic, escaped, self-contained and excludes local notes and costs by default', t => {
  const f = fixture(t);
  f.put('placement', { id: 'p1', project_id: 'report-project', source_url: 'https://publisher.example/?q="&x=<tag>', target_url: 'https://product.example/guide', notes: 'PRIVATE NOTE <script>alert(1)</script>', cost_amount: '12.50', cost_currency: 'USD' });
  f.python("import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); c.execute('update placements set cloud_state=?,cloud_observed_at=?',(json.dumps({'state':'present'}),'2026-09-09T12:00:00Z')); c.commit()");
  const first = join(f.root, 'report.html'); const second = join(f.root, 'report-again.html');
  const options = ['report', '--title', 'Brand <script>unsafe()</script>', '--brand', 'Agency & Partners', '--project', 'report-project', '--generated-at', '2026-09-09T14:00:00Z'];
  assert.equal(f.cli(...options, '--output', first).placements, 1);
  f.cli(...options, '--output', second);
  const html = readFileSync(first, 'utf8');
  assert.equal(html, readFileSync(second, 'utf8'));
  assert.ok(html.includes('Brand &lt;script&gt;unsafe()&lt;/script&gt;'));
  assert.ok(html.includes('Agency &amp; Partners'));
  assert.ok(html.includes('&quot;&amp;x=&lt;tag&gt;'));
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('PRIVATE NOTE'));
  assert.ok(!html.includes('USD 12.5'));
  assert.ok(!html.includes('workspace-a'));
  assert.ok(!html.includes('report-project'));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes('2026-09-09T12:00:00Z'));
  assert.throws(() => f.cli(...options, '--output', first));
  assert.equal(html, readFileSync(first, 'utf8'));
});

test('HTML report includes explicitly selected notes and costs, filters projects and never mixes currencies', t => {
  const f = fixture(t);
  for (const record of [
    { id: 'p1', project_id: 'selected', cost_amount: '0.1', cost_currency: 'USD', notes: '<b>Private note</b>' },
    { id: 'p2', project_id: 'selected', cost_amount: '0.2', cost_currency: 'USD' },
    { id: 'p3', project_id: 'selected', cost_amount: '3.5', cost_currency: 'EUR' },
    { id: 'p4', project_id: 'excluded', cost_amount: '999', cost_currency: 'USD' },
  ]) f.put('placement', { ...record, source_url: `https://publisher.example/${record.id}`, target_url: 'https://product.example/guide' });
  const path = join(f.root, 'costs.html');
  const result = f.cli('report', '--project', 'selected', '--include-notes', '--include-costs', '--output', path);
  assert.equal(result.placements, 3);
  assert.equal(result.included_local_notes, true);
  assert.equal(result.included_local_costs, true);
  const html = readFileSync(path, 'utf8');
  assert.ok(html.includes('&lt;b&gt;Private note&lt;/b&gt;'));
  assert.ok(html.includes('<li>USD 0.3</li>'));
  assert.ok(html.includes('<li>EUR 3.5</li>'));
  assert.ok(!html.includes('999'));
  assert.ok(!html.includes('publisher.example/p4'));
});

test('local cost validation refuses floats, missing currency and negative amounts and can explicitly clear costs', t => {
  const f = fixture(t);
  const record = { id: 'p1', source_url: 'https://publisher.example/', target_url: 'https://product.example/' };
  assert.throws(() => f.put('placement', { ...record, cost_amount: 0.1, cost_currency: 'USD' }));
  assert.throws(() => f.put('placement', { ...record, cost_amount: '10' }));
  assert.throws(() => f.put('placement', { ...record, cost_amount: '-1', cost_currency: 'USD' }));
  assert.equal(f.cli('placement', 'list').length, 0);
  f.put('placement', { ...record, cost_amount: '12.500', cost_currency: 'USD' });
  f.put('placement', { id: 'p1', notes: 'Cost is preserved by unrelated updates' });
  assert.equal(f.cli('placement', 'list')[0].cost_amount, '12.5');
  f.put('placement', { id: 'p1', cost_amount: null, cost_currency: null });
  assert.equal(f.cli('placement', 'list')[0].cost_amount, null);
});

test('HTML report refuses unsafe link protocols even if a database was externally modified', t => {
  const f = fixture(t);
  f.put('placement', { id: 'p1', source_url: 'https://publisher.example/', target_url: 'https://product.example/' });
  f.python("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('update placements set source_url=?',(\"javascript:alert(1)\",)); c.commit()");
  const path = join(f.root, 'unsafe.html');
  f.cli('report', '--output', path);
  const html = readFileSync(path, 'utf8');
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('javascript:alert(1)'));
});
