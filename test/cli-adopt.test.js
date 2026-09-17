import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCrm, CrmError } from '../cli/adapters/sqlite-crm.js';
import { main } from '../cli/main.js';
import { readLedger } from '../cli/ledger.js';

const MIGRATION = new URL('../scripts/migrations/001_crm.sql', import.meta.url);

/** A real CRM database, built from the toolkit's OWN migration rather than a hand-made schema. */
async function crm(t, rows = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'linktrail-crm-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'crm.sqlite');
  const db = new DatabaseSync(path);
  db.exec(readFileSync(MIGRATION, 'utf8'));
  const now = '2026-09-11T00:00:00.000Z';
  for (const row of rows.opportunities ?? []) {
    db.prepare('INSERT INTO opportunities(id,source_url,target_url,type,status,evidence,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(row.id, row.source_url, row.target_url, 'custom', row.status ?? 'candidate', '{}', row.notes ?? '', now, now);
  }
  for (const row of rows.placements ?? []) {
    db.prepare('INSERT INTO placements(id,opportunity_id,source_url,target_url,status,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(row.id, row.opportunity_id ?? null, row.source_url, row.target_url, row.status ?? 'pending', row.notes ?? '', now, now);
  }
  db.close();
  return { dir, path };
}

test('a CRM adopts into ledger entries, read-only and with no schema change', async t => {
  const before = await crm(t, {
    opportunities: [{ id: 'op_1', source_url: 'https://a.com/resources', target_url: 'https://me.com/guide' }],
    placements: [{ id: 'pl_1', source_url: 'https://b.com/post', target_url: 'https://me.com/guide' }],
  });
  const result = readCrm(before.path);
  assert.equal(result.entries.length, 2);
  const byRef = Object.fromEntries(result.entries.map(entry => [entry.ref, entry]));
  // A placement is a link the customer believes exists, so absence is the alarm. An opportunity
  // is one they want, so appearing is the news. That is the whole difference.
  assert.equal(byRef['crm/placements/pl_1'].intent, 'expected');
  assert.equal(byRef['crm/opportunities/op_1'].intent, 'wanted');

  // Read-only: the file is untouched, and nothing was added to its schema.
  const db = new DatabaseSync(before.path, { readOnly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
  db.close();
  assert.ok(tables.includes('placements'));
  assert.equal(tables.some(name => name.startsWith('ledger')), false, 'the adapter added nothing');
});

test('an opportunity that became a placement is not watched twice', async t => {
  const { path } = await crm(t, {
    opportunities: [{ id: 'op_2', source_url: 'https://c.com/x', target_url: 'https://me.com/g' }],
    placements: [{ id: 'pl_2', opportunity_id: 'op_2', source_url: 'https://c.com/x', target_url: 'https://me.com/g' }],
  });
  const result = readCrm(path);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].ref, 'crm/placements/pl_2', 'the placement supersedes the opportunity it came from');
});

test('a status that means "stop" retires, and every other status is NAMED as assumed active', async t => {
  const { path } = await crm(t, {
    opportunities: [
      { id: 'op_3', source_url: 'https://d.com/a', target_url: 'https://me.com/g', status: 'rejected' },
      { id: 'op_4', source_url: 'https://e.com/a', target_url: 'https://me.com/g', status: 'awaiting-editor' },
    ],
    placements: [{ id: 'pl_3', source_url: 'https://f.com/a', target_url: 'https://me.com/g', status: 'lost' }],
  });
  const result = readCrm(path);
  const byRef = Object.fromEntries(result.entries.map(entry => [entry.ref, entry]));
  assert.equal(byRef['crm/opportunities/op_3'].intent, 'retired');
  assert.equal(byRef['crm/placements/pl_3'].intent, 'retired');
  // `status` in this CRM is free text, so refusing every unrecognised value would refuse nearly
  // every row. What the adapter does instead is say what it assumed.
  assert.equal(byRef['crm/opportunities/op_4'].intent, 'wanted');
  assert.ok(result.assumed_active.opportunity.includes('awaiting-editor'));
  assert.equal(result.assumed_active.placement.includes('lost'), false);
});

test('a database that is not an AgentLinkOps CRM says so instead of importing nothing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'linktrail-notcrm-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'other.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE unrelated (id TEXT)');
  db.close();
  assert.throws(() => readCrm(path), error => error instanceof CrmError && /not an AgentLinkOps CRM/u.test(error.message));
  assert.throws(() => readCrm(join(dir, 'missing.sqlite')), error => error instanceof CrmError);
});

test('adopt previews, then writes, then is idempotent', async t => {
  const { dir, path } = await crm(t, {
    placements: [{ id: 'pl_4', source_url: 'https://g.com/a', target_url: 'https://me.com/g' }],
  });
  const run = argv => {
    const out = [], err = [];
    return main(argv, { cwd: dir, out: line => out.push(String(line)), err: line => err.push(String(line)) })
      .then(code => ({ code, out: out.join('\n'), err: err.join('\n') }));
  };
  await run(['init']);
  let result = await run(['adopt', path]);
  assert.equal(result.code, 0);
  assert.match(result.out, /preview only/u);
  assert.equal((await readLedger(join(dir, '.agentlinkops/links.jsonl'))).entries.length, 0, 'a preview writes nothing');

  result = await run(['adopt', path, '--write']);
  assert.match(result.out, /appended 1/u);
  assert.equal((await readLedger(join(dir, '.agentlinkops/links.jsonl'))).entries.length, 1);

  // Ids derive from the CRM row id, so adopting again is a no-op rather than a duplicate.
  result = await run(['adopt', path, '--write']);
  assert.match(result.out, /appended 0, skipped 1/u);
  assert.equal((await readLedger(join(dir, '.agentlinkops/links.jsonl'))).entries.length, 1);
});
