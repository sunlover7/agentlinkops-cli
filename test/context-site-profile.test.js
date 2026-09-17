// DP-0017-T03 acceptance, against the contract's fixture table (sitemap-bounded,
// profile-vs-facts). Every fetch is a fixture transport or fixture acquisition over the real
// module — no live site, no CMS, no credentials. Sitemap parsing and limits are the shipped
// src/corpus/seeds.js, imported (not copied): the counters below are its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  buildSiteProfile, renderSiteProfile, validateProfileCitations, readSiteFacts,
  createSiteTransport, derivePageFields, PROFILE_LIMITS,
} from '../src/context/site-profile.js';
import { contextPaths } from '../src/context/gsc.js';

const ORIGIN = 'https://example.com';

async function sandbox(t, { manual = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'linktrail-profile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = contextPaths({ dir });
  const { mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(paths.gsc), { recursive: true });
  if (manual !== null) await writeFile(paths.manual, manual, 'utf8');
  return { dir, paths };
}

/** A fixture document transport keyed by URL: { text } | { error: { reason, status } } | { bytes: Uint8Array }. */
function fakeTransport(map) {
  return {
    async fetchText(url) {
      const entry = map[url];
      if (!entry) return { ok: false, url, status: 404, reason: 'not_found' };
      if (entry.error) return { ok: false, url, status: entry.error.status ?? null, reason: entry.error.reason };
      if (entry.bytes) return { ok: true, url, final_url: url, status: 200, bytes: entry.bytes.byteLength, data: entry.bytes };
      return { ok: true, url, final_url: url, status: 200, text: entry.text, bytes: entry.text.length, gzipped: false };
    },
  };
}

/** A fixture page acquisition keyed by URL: { html } | { status, outcome? } | absent (404). */
function fakeAcquisition(map) {
  return {
    async fetchPage(url) {
      const entry = map[url];
      if (!entry) return { outcome: 'not_found', reason: 'source_http_404', final_url: url, http_status: 404, robots: null, html: null, bytes: 0 };
      if (entry.status) return { outcome: entry.outcome ?? 'unavailable', reason: entry.reason ?? `source_http_${entry.status}`, final_url: url, http_status: entry.status, robots: null, html: null, bytes: 0 };
      return { outcome: 'fetched', final_url: url, http_status: 200, robots: { reason: 'robots_allowed' }, html: entry.html, bytes: entry.html.length };
    },
  };
}

const urlset = urls => `<?xml version="1.0"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${u}</loc></url>`).join('\n')}\n</urlset>`;
const robots = sitemaps => `User-agent: *\nAllow: /\n${sitemaps.map(s => `Sitemap: ${s}`).join('\n')}\n`;
const pageHtml = (title, extra = '') => `<!doctype html><html><head><title>${title}</title><meta name="description" content="A tool for families."><link rel="canonical" href="${ORIGIN}/tools/estimator"></head><body><h1>${title}</h1><a href="/guide">guide</a>${extra}</body></html>`;

const MANUAL = `# Site context

## Target pages
- ${ORIGIN}/tools/estate-estimator
- ${ORIGIN}/missing-page

## Site description
A plain-English estate-settlement guide.

## Known assets
- Estate cost estimator
`;

// ---------------------------------------------------------------------------
// Fixture: sitemap-bounded — robots-refused, oversized, truncated, gzipped; counters preserved.
// ---------------------------------------------------------------------------

test('a robots-refused site refuses the sitemap lane and keeps every outcome unknown, never "no assets"', async t => {
  const { paths } = await sandbox(t, { manual: MANUAL });
  const result = await buildSiteProfile({
    site: ORIGIN, paths, manual: null,
    transport: fakeTransport({ [`${ORIGIN}/robots.txt`]: { error: { reason: 'http_403', status: 403 } } }),
    acquisition: fakeAcquisition({ [`${ORIGIN}/tools/estate-estimator`]: { html: pageHtml('Estate cost estimator') } }),
  });
  assert.equal(result.robots.outcome, 'unreadable');
  assert.equal(result.sitemaps.documents, 0);
  assert.equal(result.sitemaps.failures['robots_unreadable_http_403'], 1);
  assert.deepEqual(result.sitemaps.urls_found, 0);
  // The missing manual target stays an explicit row; unreadable pages carry null candidates.
  const missing = result.pages.find(p => p.url === `${ORIGIN}/missing-page`);
  assert.equal(missing.outcome, 'not_found');
  assert.equal(missing.asset_candidate_reasons, null, 'unknown, never "no assets"');
  assert.ok(result.notes.some(n => n.includes('never "no assets"')));
});

// The gzip and oversize fixtures must go through the REAL transport (its gunzip path and the
// shipped 10 MiB bound), so they use a fetchImpl serving Response objects with pacing off.
function realTransportWith(map, { hostDelayMs = 0 } = {}) {
  const fetchImpl = async url => {
    const entry = map[url];
    if (!entry) return new Response(null, { status: 404 });
    if (entry.status) return new Response(null, { status: entry.status });
    return new Response(entry.body, { status: 200, headers: { 'content-type': entry.type ?? 'application/xml' } });
  };
  return createSiteTransport({ fetchImpl, hostDelayMs });
}

test('a gzipped sitemap is decompressed by the acquisition layer and parsed by seeds.js unchanged', async t => {
  const { paths } = await sandbox(t);
  const gzipped = gzipSync(Buffer.from(urlset([`${ORIGIN}/a`, `${ORIGIN}/tools/calculator`]), 'utf8'));
  const result = await buildSiteProfile({
    site: ORIGIN, paths,
    transport: realTransportWith({
      [`${ORIGIN}/robots.txt`]: { body: robots([`${ORIGIN}/sitemap.xml.gz`]), type: 'text/plain' },
      [`${ORIGIN}/sitemap.xml.gz`]: { body: gzipped },
    }),
    acquisition: fakeAcquisition({}),
  });
  assert.equal(result.sitemaps.documents, 1);
  assert.equal(result.sitemaps.urls_found, 2);
  const facts = (await readSiteFacts(paths.siteFacts)).rows;
  const sitemapFact = facts.find(row => row.kind === 'site.sitemap');
  assert.equal(sitemapFact.gzipped, true);
  assert.equal(sitemapFact.urls, 2);
  assert.ok(sitemapFact.content_sha256, 'the bytes are identified by hash, never stored');
});

test('an oversized sitemap (past the 10 MiB seeds limit) is refused after inflation', async t => {
  const { paths } = await sandbox(t);
  // Gzip of >10 MiB of padding: tiny on the wire, oversized once inflated — the real path a
  // hostile or accidental .gz sitemap takes through the shipped bound.
  const oversized = gzipSync(Buffer.from(`<?xml version="1.0"?><urlset>${(`<!--${'x'.repeat(60)}-->`).repeat(180_000)}</urlset>`, 'utf8'));
  const result = await buildSiteProfile({
    site: ORIGIN, paths,
    transport: realTransportWith({
      [`${ORIGIN}/robots.txt`]: { body: robots([`${ORIGIN}/sitemap.xml.gz`]), type: 'text/plain' },
      [`${ORIGIN}/sitemap.xml.gz`]: { body: oversized },
    }),
    acquisition: fakeAcquisition({}),
  });
  assert.equal(result.sitemaps.failures.sitemap_too_large, 1);
  assert.equal(result.sitemaps.urls_found, 0);
});

test('a 50,001-URL document is truncated at the protocol cap and the counters survive verbatim', async t => {
  const { paths } = await sandbox(t);
  const urls = Array.from({ length: 50_001 }, (_, i) => `${ORIGIN}/p/${i}`);
  // One relative entry, early enough to be seen before the URL cap trips: the parser's own
  // `skipped.not_absolute` counter must reach the output.
  const document = urlset([...urls.slice(0, 10), '/relative', ...urls.slice(10)]);
  const result = await buildSiteProfile({
    site: ORIGIN, paths,
    transport: fakeTransport({
      [`${ORIGIN}/robots.txt`]: { text: robots([`${ORIGIN}/sitemap.xml`]) },
      [`${ORIGIN}/sitemap.xml`]: { text: document },
    }),
    acquisition: fakeAcquisition({}),
  });
  assert.equal(result.sitemaps.truncated, true, 'truncated is preserved, never summarized into "sitemap read"');
  assert.equal(result.sitemaps.skipped.not_absolute, 1, 'the parser skipped counter, verbatim');
  assert.equal(result.sitemaps.urls_found, 50_000, 'the per-document URL cap held');
  const facts = (await readSiteFacts(paths.siteFacts)).rows;
  const sitemapFact = facts.find(row => row.kind === 'site.sitemap');
  assert.equal(sitemapFact.truncated, true);
  assert.deepEqual(sitemapFact.skipped, { not_absolute: 1 });
});

test('the document cap (3) counts an index and its children, and dropped directives are counted', async t => {
  const { paths } = await sandbox(t);
  const children = [`${ORIGIN}/sm-a.xml`, `${ORIGIN}/sm-b.xml`, `${ORIGIN}/sm-c.xml`, `${ORIGIN}/sm-d.xml`];
  const result = await buildSiteProfile({
    site: ORIGIN, paths,
    transport: fakeTransport({
      [`${ORIGIN}/robots.txt`]: { text: robots([`${ORIGIN}/index.xml`, ...children]) },
      [`${ORIGIN}/index.xml`]: { text: `<?xml version="1.0"?><sitemapindex>${children.map(u => `<sitemap><loc>${u}</loc></sitemap>`).join('')}</sitemapindex>` },
      [`${ORIGIN}/sm-a.xml`]: { text: urlset([`${ORIGIN}/a1`]) },
      [`${ORIGIN}/sm-b.xml`]: { text: urlset([`${ORIGIN}/b1`]) },
      [`${ORIGIN}/sm-c.xml`]: { text: urlset([`${ORIGIN}/c1`]) },
    }),
    acquisition: fakeAcquisition({}),
  });
  assert.equal(result.sitemaps.documents, 3, 'the index plus two children; the third child and sm-d are beyond the bound');
  assert.equal(result.sitemaps.capped, true);
  assert.equal(result.sitemaps.directives_seen, 5, 'five directives declared, three documents read, the drop counted');
  assert.equal(result.sitemaps.urls_found, 2);
});

test('selected pages are hard-capped at 10 with the cap reported', async t => {
  const { paths } = await sandbox(t);
  const urls = Array.from({ length: 15 }, (_, i) => `${ORIGIN}/s/${i}`);
  const result = await buildSiteProfile({
    site: ORIGIN, paths,
    transport: fakeTransport({
      [`${ORIGIN}/robots.txt`]: { text: robots([`${ORIGIN}/sitemap.xml`]) },
      [`${ORIGIN}/sitemap.xml`]: { text: urlset(urls) },
    }),
    acquisition: fakeAcquisition(Object.fromEntries(urls.map(u => [u, { html: pageHtml('Page') }]))),
  });
  assert.equal(PROFILE_LIMITS.selectedPages, 10);
  assert.equal(result.pages.length, 10);
  assert.equal(result.limits.pages_capped, true);
});

// ---------------------------------------------------------------------------
// Fixture: profile-vs-facts — a judgment cites its fact row; editing the judgment never edits
// facts.
// ---------------------------------------------------------------------------

test('profile-vs-facts: judgments cite fact rows and manual entries; editing a judgment never edits a fact', async t => {
  const { paths } = await sandbox(t, { manual: MANUAL });
  const build = await buildSiteProfile({
    site: ORIGIN, paths,
    transport: fakeTransport({
      [`${ORIGIN}/robots.txt`]: { text: robots([`${ORIGIN}/sitemap.xml`]) },
      [`${ORIGIN}/sitemap.xml`]: { text: urlset([`${ORIGIN}/tools/estate-estimator`, `${ORIGIN}/guide`]) },
    }),
    acquisition: fakeAcquisition({
      [`${ORIGIN}/tools/estate-estimator`]: { html: pageHtml('Estate cost estimator') },
      [`${ORIGIN}/guide`]: { html: pageHtml('Probate guide') },
      [`${ORIGIN}/missing-page`]: { status: 404 },
    }),
  });
  assert.equal(build.pages.length, 4, 'two manual targets + homepage + one sitemap page');

  const factsBefore = await readFile(paths.siteFacts, 'utf8');
  const manual = (await import('../src/context/gsc.js')).parseManual(await readFile(paths.manual, 'utf8'));
  const markdown = renderSiteProfile({ facts: (await readSiteFacts(paths.siteFacts)).rows, manual, origin: ORIGIN });
  assert.ok(markdown.includes('## Audience') && markdown.includes('## Assets') && markdown.includes('## Campaign targets'));
  assert.ok(/asset_path_convention|matches_manual_asset_name/.test(markdown), 'an asset candidate is nominated with its reason');

  let check = validateProfileCitations({ profileText: markdown, facts: (await readSiteFacts(paths.siteFacts)).rows, manual });
  assert.equal(check.citations > 0, true);
  assert.deepEqual(check.unresolved, []);

  // Edit a judgment — the agent's whole job — keeping the citation. The facts file is untouched.
  const edited = markdown.replace('- TODO(judgment): who this site is for', '- Families mid-probate, mostly mobile, arriving from court searches: TODO(judgment) who this site is for');
  check = validateProfileCitations({ profileText: edited, facts: (await readSiteFacts(paths.siteFacts)).rows, manual });
  assert.deepEqual(check.unresolved, [], 'an edited judgment with its citation intact still validates');
  assert.equal(check.facts_read_only, true);
  assert.equal(await readFile(paths.siteFacts, 'utf8'), factsBefore, 'editing the profile changed zero fact rows');

  // A citation the facts cannot back is reported, never silently dropped.
  const orphan = validateProfileCitations({ profileText: '- Judgment backed by nothing. [fact:fdeadbeef99]', facts: [], manual });
  assert.deepEqual(orphan.unresolved, ['fact:fdeadbeef99']);

  // Missing pages stay explicit in the profile.
  assert.ok(markdown.includes('MISSING/UNKNOWN'), 'the 404 manual target is named, not dropped');
});

test('derivePageFields: titles, h1s, description, canonical; asset candidates nominate by path and manual name', () => {
  const derived = derivePageFields(pageHtml('Estate cost estimator', '<h1>Second h1</h1>'));
  assert.equal(derived.title, 'Estate cost estimator');
  assert.deepEqual(derived.h1s, ['Estate cost estimator', 'Second h1']);
  assert.equal(derived.meta_description, 'A tool for families.');
  assert.equal(derived.canonical, `${ORIGIN}/tools/estimator`);
  assert.equal(derived.link_counts.total, 1);
  assert.deepEqual(derivePageFields(''), { title: null, h1s: [], meta_description: null, canonical: null, link_counts: null, asset_candidate_reasons: null });
});

// ---------------------------------------------------------------------------
// The real document transport: manual redirects, the public-URL boundary, and the robots
// bound. Page robots posture itself is inherited from the verifier through createAcquisition
// and is not re-tested here.
// ---------------------------------------------------------------------------

test('the document transport follows redirects manually, refuses non-public URLs and loops', async () => {
  const seen = [];
  const fetchImpl = async url => {
    seen.push(url);
    if (url === `${ORIGIN}/robots.txt`) return new Response(null, { status: 301, headers: { location: `${ORIGIN}/moved-robots.txt` } });
    if (url === `${ORIGIN}/moved-robots.txt`) return new Response('User-agent: *\nAllow: /\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    if (url === 'https://loop-test-publisher.com/robots.txt') return new Response(null, { status: 302, headers: { location: 'https://loop-test-publisher.com/robots.txt' } });
    return new Response('nope', { status: 200 });
  };
  const make = () => createSiteTransport({ fetchImpl, timeoutMs: 500, hostDelayMs: 0 });
  const ok = await make().fetchText(`${ORIGIN}/robots.txt`);
  assert.equal(ok.ok, true);
  assert.equal(ok.final_url, `${ORIGIN}/moved-robots.txt`);
  assert.deepEqual(seen, [`${ORIGIN}/robots.txt`, `${ORIGIN}/moved-robots.txt`], 'redirects are followed manually, never by the transport');
  const loop = await make().fetchText('https://loop-test-publisher.com/robots.txt');
  assert.equal(loop.ok, false);
  assert.equal(loop.reason, 'redirect_loop');
  const unsafe = await make().fetchText('http://127.0.0.1/robots.txt');
  assert.equal(unsafe.ok, false);
  assert.ok(unsafe.reason.startsWith('unsafe_url:'), 'the public-only destination boundary is inherited from the verifier');
});
