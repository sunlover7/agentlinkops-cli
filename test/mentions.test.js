import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import { scanMentions, scanPages, findOccurrences, MENTION_LIMITS, MentionError } from '../src/mentions.js';

const TARGET = 'https://customer.com/';
const scan = (html, options = {}) => scanMentions(html, 'https://publisher.com/article', { targetUrl: TARGET, ...options });
const page = body => `<html><head><title>An article</title></head><body>${body}</body></html>`;

test('a page that names the customer and does not link to them is the opportunity', () => {
  const result = scan(page('<p>We recommend customer.com for state guides.</p><a href="https://elsewhere.com/">Elsewhere</a>'));
  assert.equal(result.state, 'mentioned_not_linked');
  assert.equal(result.reason, 'mention_without_link_in_complete_page');
  assert.equal(result.occurrence_count, 1);
  assert.equal(result.links_to_target, 0);
  assert.match(result.occurrences[0].context, /We recommend customer\.com for state guides/u);
  assert.equal(result.complete, true);
});

test('a mention that is already linked is a placement, not an opportunity', () => {
  const result = scan(page('<p>We recommend customer.com.</p><a href="https://customer.com/guide">The guide</a>'));
  // Telling a customer to go ask for a link they already have is the fastest way to lose a
  // publisher.
  assert.equal(result.state, 'mentioned_and_linked');
  assert.equal(result.links_to_target, 1);
  assert.equal(result.anchors[0].anchor, 'The guide');
});

test('a mention a reader cannot see is not a mention', () => {
  for (const [label, body] of [
    ['script', '<p>Nothing.</p><a href="https://o.com/">o</a><script>var u = "customer.com";</script>'],
    ['comment', '<p>Nothing.</p><a href="https://o.com/">o</a><!-- customer.com -->'],
    ['style', '<p>Nothing.</p><a href="https://o.com/">o</a><style>/* customer.com */</style>'],
    ['noscript', '<p>Nothing.</p><a href="https://o.com/">o</a><noscript>customer.com</noscript>'],
  ]) {
    // The same rule the verifier applies to links: what a parser can see is not what a person
    // reads, and a brand name in an analytics config is not a citation.
    assert.equal(scan(page(body)).state, 'not_mentioned', label);
  }
});

test('a page we could not read completely yields UNKNOWN, never an absence', () => {
  // The conclusion this tool draws is an absence — no link on this page — and an absence is only
  // meaningful on a page we read completely. A reclamation tool that forgot this would generate
  // outreach about links that are already there.
  const cases = {
    access_challenge: '<html><head><title>Just a moment...</title></head><body>customer.com</body></html>',
    possible_login_wall: page('<form><input type="password" name="p"></form>customer.com'),
    possible_render_required: '<html><body><div id="root"></div><script src="/app.js"></script></body></html>',
    navigation_requires_browser: '<html><head><meta http-equiv="refresh" content="0;url=/x"></head><body>customer.com</body></html>',
  };
  for (const [reason, html] of Object.entries(cases)) {
    const result = scanMentions(html, 'https://publisher.com/article', { targetUrl: TARGET });
    assert.equal(result.state, 'unknown', reason);
    assert.equal(result.reason, reason);
    assert.equal(result.complete, false);
  }
});

test('a near-miss host is not the customer', () => {
  // The same refusal the URL layer makes for links, applied to text.
  for (const body of [
    '<p>notcustomer.community is different.</p>',
    '<p>See customer.com.evil.com instead.</p>',
    '<p>Mail us at hello@customer.com</p>',
  ]) {
    assert.equal(scan(page(`${body}<a href="https://o.com/">o</a>`)).state, 'not_mentioned', body);
  }
  // And the real thing still matches with punctuation around it.
  assert.equal(scan(page('<p>Try customer.com, it helps.</p><a href="https://o.com/">o</a>')).state, 'mentioned_not_linked');
});

test('a one-word brand needs the customer to mean it, because length cannot decide', () => {
  // "Settled" is seven characters; "Notion" and "Stripe" are six. Length cannot tell a brand from
  // an ordinary word without a dictionary we do not have, so the rule is structural.
  const result = scan(page('<p>The matter was settled last week.</p><a href="https://o.com/">o</a>'), { brands: ['Settled'] });
  assert.equal(result.state, 'not_mentioned');
  assert.equal(result.rejected_brands[0].reason, 'single_word_brand_needs_force');
  assert.match(result.rejected_brands[0].note, /force: true/u);

  // Multi-word is distinctive on its own, and the occurrence says which needle found it.
  const named = scan(page('<p>Settled Estate publishes county guides.</p><a href="https://o.com/">o</a>'), { brands: ['Settled Estate'] });
  assert.equal(named.state, 'mentioned_not_linked');
  assert.equal(named.occurrences[0].kind, 'brand');

  // And a customer who means their one-word brand can say so, once.
  const forced = scan(page('<p>The matter was settled last week.</p><a href="https://o.com/">o</a>'),
    { brands: [{ value: 'Settled', force: true }] });
  assert.equal(forced.state, 'mentioned_not_linked');
  assert.equal(MENTION_LIMITS.brands, 5);
});

test('element boundaries are word boundaries', () => {
  // Without this, `<p>…customer.com</p><a>Guide</a>` reads as `customer.comGuide`: the two words
  // glued together, which put a joined string into every occurrence context a customer sees.
  const found = findOccurrences('See customer.com Guide', 'customer.com');
  assert.equal(found.length, 1);
  const result = scan(page('<p>Recommended: customer.com</p><a href="https://o.com/">Guide</a>'));
  assert.equal(result.state, 'mentioned_not_linked');
  assert.match(result.occurrences[0].context, /customer\.com Guide/u);
});

test('a scan over many pages states its denominator', () => {
  const pages = [
    { url: 'https://a.com/1', html: page('<p>customer.com is useful.</p><a href="https://o.com/">o</a>') },
    { url: 'https://a.com/2', html: page('<p>customer.com</p><a href="https://customer.com/g">g</a>') },
    { url: 'https://a.com/3', html: page('<p>Nothing relevant.</p><a href="https://o.com/">o</a>') },
    { url: 'https://a.com/4', html: '<html><head><title>Just a moment...</title></head><body>x</body></html>' },
  ];
  const result = scanPages(pages, { targetUrl: TARGET });
  assert.equal(result.pages_scanned, 4);
  assert.equal(result.reclaimable.length, 1);
  assert.equal(result.already_linked, 1);
  // 1 reclaimable out of 3 READABLE is a different fact from 1 out of 4, and an unknown is
  // neither a yes nor a no.
  assert.deepEqual(result.coverage, { readable: 3, unreadable: 1 });
});

test('an invalid target or page is refused rather than scanned', () => {
  assert.throws(() => scanMentions('<body>x</body>', 'https://p.com/a', { targetUrl: 'http://127.0.0.1/' }),
    error => error instanceof MentionError && /invalid_target/u.test(error.code));
  assert.throws(() => scanMentions('<body>x</body>', 'not a url', { targetUrl: TARGET }),
    error => error instanceof MentionError && /invalid_page/u.test(error.code));
});

test('the occurrence count is how many times the page names the target, not how many we stored', () => {
  const body = Array.from({ length: 80 }, (_, i) => `<p>Paragraph ${i} cites Internal Revenue Service guidance.</p>`).join('');
  const result = scanMentions(`<!doctype html><html><head><title>Guide</title></head><body>${body}</body></html>`,
    'https://publisher.example.com/a', { targetUrl: 'https://www.irs.gov/', targetScope: 'domain', brands: ['Internal Revenue Service'] });
  assert.equal(result.state, 'mentioned_not_linked');
  // A storage cap reported as a count would turn 80 mentions into 25 and say nothing about it.
  assert.equal(result.occurrence_count, 80);
  assert.equal(result.occurrences_kept, MENTION_LIMITS.occurrences);
  assert.equal(result.occurrences.length, MENTION_LIMITS.occurrences);
  assert.equal(result.occurrences_truncated, true);

  // And a page under the cap reports all three consistently, with nothing cut.
  const few = scanMentions('<!doctype html><html><head><title>g</title></head><body><p>Internal Revenue Service</p></body></html>',
    'https://publisher.example.com/b', { targetUrl: 'https://www.irs.gov/', targetScope: 'domain', brands: ['Internal Revenue Service'] });
  assert.equal(few.occurrence_count, 1);
  assert.equal(few.occurrences_kept, 1);
  assert.equal(few.occurrences_truncated, false);
});


test('text retention limits never turn unseen mentions into a page-wide absence', () => {
  const result=scan(page('<p>'+ 'x'.repeat(120) + ' customer.com</p><a href="https://o.com/">o</a>'),{textLimit:80});
  assert.equal(result.state,'unknown');
  assert.equal(result.reason,'text_extraction_truncated');
  assert.equal(result.complete,false);
  assert.equal(result.coverage.documentComplete,true);
  assert.equal(result.coverage.textComplete,false);
});
test('truncated fetched bodies remain unknown in individual and corpus scans', () => {
  const html=page('<p>Nothing relevant.</p><a href="https://o.com/">o</a>');
  const result=scan(html,{bodyTruncated:true});
  assert.equal(result.state,'unknown');assert.equal(result.reason,'incomplete_body');
  const many=scanPages([{url:'https://publisher.com/article',html,body_truncated:true}],{targetUrl:TARGET});
  assert.deepEqual(many.counts,{unknown:1});assert.deepEqual(many.coverage,{readable:0,unreadable:1});assert.equal(many.reclaimable.length,0);
});
test('missing body and legacy supplied HTML remain distinct evidence', () => {
  const missing=scan(null);assert.equal(missing.state,'unknown');assert.equal(missing.reason,'html_required');
  const supplied=scan(page('<p>customer.com</p><a href="https://o.com/">o</a>'));
  assert.equal(supplied.provenance.kind,'caller_supplied_html');assert.equal(supplied.provenance.qualified,false);
  assert.equal(supplied.complete,true,'complete describes the caller-supplied document, not qualified network acquisition');
});
test('receipt-aware mention scans preserve render provenance and refuse unqualified or incomplete captures', () => {
  const hash='a'.repeat(64),html=page('<p>customer.com</p><a href="https://o.com/">o</a>');
  const receipt={version:1,representation:'rendered_dom',requestedUrl:'https://publisher.com/article',finalUrl:'https://publisher.com/article',httpStatus:200,
    acquiredAt:'2026-10-11T15:00:00.000Z',body:{complete:true,truncated:false,bytes:100,sha256:hash,decodedSha256:hash,charset:'utf-8'},
    transport:{id:'fixture',version:'1',qualified:true},coverage:{mainDocument:true,iframes:false,shadowRoots:false}};
  const result=scan(html,{receipt});assert.equal(result.state,'mentioned_not_linked');assert.equal(result.provenance.representation,'rendered_dom');assert.equal(result.provenance.qualified,true);
  for(const [capture,reason] of [[{...receipt,transport:{...receipt.transport,qualified:false}},'capture_unqualified'],
    [{...receipt,body:{...receipt.body,truncated:true}},'capture_incomplete']]){
    const result=scan(html,{receipt:capture});assert.equal(result.state,'unknown');assert.equal(result.reason,reason);assert.equal(result.complete,false);
  }
});

const wrapper=(destination,key='url')=>`https://gate.sc/?${key}=${encodeURIComponent(destination)}&token=WRAPPER_PRIVATE_MARKER`;
const wrapperAnchor=(destination,key='url')=>`<a href="${wrapper(destination,key).replace(/&/gu,'&amp;')}">Website</a>`;
const editorial=extra=>page(`<article><p>${'A complete public estate guide explains useful options and resources for its readers. '.repeat(3)}We recommend customer.com for another guide.</p>${extra}</article>`);

test('target-containing physical wrappers remain unknown while preserving declared constructed capture facts',()=>{
 const html=editorial(wrapperAnchor(TARGET)),bytes=Buffer.from(html,'utf8'),hash=createHash('sha256').update(bytes).digest('hex');
 // This pure extraction control preserves declared receipt facts. The actual
 // operator controls separately prove their join to one screened document read.
 const receipt={version:1,representation:'raw_html',requestedUrl:'https://publisher.com/article',finalUrl:'https://publisher.com/article',httpStatus:200,
  acquiredAt:'2026-10-12T20:00:00.000Z',body:{complete:true,truncated:false,bytes:bytes.length,sha256:hash,decodedSha256:hash,charset:'utf-8'},
  transport:{id:'constructed_fixture',version:'1',qualified:true},coverage:{mainDocument:true,iframes:false,shadowRoots:false}};
 const result=scan(html,{receipt});assert.equal(result.state,'unknown');assert.equal(result.reason,'target_in_redirect_parameter');
 assert.equal(result.complete,false);assert.equal(result.occurrence_count,0);assert.deepEqual(result.occurrences,[]);assert.equal(result.links_to_target,0);
 assert.equal(result.coverage.bodyComplete,true);assert.equal(result.coverage.documentComplete,true);assert.equal(result.provenance.qualified,true);
 assert.equal(receipt.body.complete,true);assert.equal(receipt.body.truncated,false);
 assert.doesNotMatch(JSON.stringify(result),/WRAPPER_PRIVATE_MARKER|gate\.sc/);
 const many=scanPages([{url:'https://publisher.com/article',html,receipt}],{targetUrl:TARGET});
 assert.deepEqual(many.counts,{unknown:1});assert.deepEqual(many.coverage,{readable:0,unreadable:1});assert.deepEqual(many.reclaimable,[]);assert.equal(many.already_linked,0);
});

test('a genuine direct match takes precedence over a wrapper for the same target',()=>{
 const result=scan(editorial(`${wrapperAnchor(TARGET)}<a href="https://customer.com/guide" rel="nofollow">Customer guide</a>`));
 assert.equal(result.state,'mentioned_and_linked');assert.equal(result.complete,true);assert.equal(result.links_to_target,1);
 assert.equal(result.anchors[0].anchor,'Customer guide');assert.deepEqual(result.anchors[0].rel,['nofollow']);
});

test('wrapper uncertainty follows the declared target scope and preserves unrelated ordinary mentions',()=>{
 for(const [targetScope,targetUrl,destination,uncertain]of [
  ['exact','https://customer.com/guide?kind=1','https://customer.com/guide?kind=1#part',true],
  ['exact','https://customer.com/guide?kind=1','https://customer.com/guide?kind=2',false],
  ['domain',TARGET,'https://blog.customer.com/guide',true],
  ['domain',TARGET,'https://customer.com.evil.com/guide',false],
  ['subdomain',TARGET,'https://blog.customer.com/guide',false],
  ['path','https://customer.com/guide?kind=1','https://customer.com/guide/child?kind=1',true],
  ['path','https://customer.com/guide?kind=1','https://customer.com/guidebook?kind=1',false],
  ['path','https://customer.com/guide?kind=1','https://customer.com/guide/child?kind=2',false],
 ]){
  const result=scan(editorial(wrapperAnchor(destination)),{targetScope,targetUrl});
  assert.equal(result.state,uncertain?'unknown':'mentioned_not_linked',`${targetScope}: ${destination}`);
  assert.equal(result.complete,!uncertain);assert.equal(result.links_to_target,0);
  if(uncertain)assert.equal(result.reason,'target_in_redirect_parameter');
 }
});

test('inert, malformed, nested, repeated-encoded and private URL payloads do not manufacture wrapper uncertainty',()=>{
 for(const [label,extra]of [
  ['comment',`<!-- ${wrapperAnchor(TARGET)} -->`],
  ['script',`<script>const example=${JSON.stringify(wrapper(TARGET))};</script>`],
  ['template',`<template>${wrapperAnchor(TARGET)}</template>`],
  ['noscript',`<noscript>${wrapperAnchor(TARGET)}</noscript>`],
  ['hidden text',`<div hidden>${wrapper(TARGET)}</div>`],
  ['data attribute',`<a href="https://elsewhere.com/" data-url="${wrapper(TARGET)}">Other</a>`],
  ['unrecognized parameter',wrapperAnchor(TARGET,'q')],
  ['malformed URL',wrapperAnchor('https://[')],
  ['nested wrapper',wrapperAnchor(wrapper(TARGET))],
  ['double encoding',wrapperAnchor(encodeURIComponent(TARGET))],
  ['private destination',wrapperAnchor('http://127.0.0.1/')],
  ['private wrapper',`<a href="http://127.0.0.1/?url=${encodeURIComponent(TARGET)}">Website</a>`],
 ]){
  const result=scan(editorial(extra));assert.equal(result.state,'mentioned_not_linked',label);assert.equal(result.complete,true,label);
  assert.equal(result.reason,'mention_without_link_in_complete_page',label);
 }
 // A hidden physical anchor remains part of the static link index. The guard
 // stays conservative without claiming that a browser rendered it visibly.
 const hidden=scan(editorial(`<div hidden>${wrapperAnchor(TARGET)}</div>`));
 assert.equal(hidden.state,'unknown');assert.equal(hidden.reason,'target_in_redirect_parameter');
});
