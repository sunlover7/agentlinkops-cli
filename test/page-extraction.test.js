import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDocument as legacyParse, pageText as legacyText} from '../src/verifier/parser.js';
import {parseDocument, extractPage, extractPageMetadata} from '../src/page-extraction/index.js';

const URL = 'https://publisher.example.org/guides/start';
const HASH = 'a'.repeat(64);
const receipt = changes => ({version:1,representation:'raw_html',requestedUrl:URL,finalUrl:URL,httpStatus:200,
  acquiredAt:'2026-10-11T15:00:00.000Z',body:{complete:true,truncated:false,bytes:100,sha256:HASH,decodedSha256:HASH,charset:'utf-8'},
  transport:{id:'fixture',version:'1',qualified:true},coverage:{mainDocument:true,iframes:false,shadowRoots:false},...changes});

// The facade shares the implementation itself, preserving legacy links, locators
// and parser error vocabulary rather than merely matching one example's output.
test('the verifier facade reuses the same canonical parser', () => {
  assert.equal(legacyParse, parseDocument);
  const html = '<base href="/research/"><a href="topic" rel="nofollow UGC">Read<span>more</span></a>';
  const result = parseDocument(html, URL);
  assert.equal(result.links[0].targetUrl, 'https://publisher.example.org/research/topic');
  assert.equal(result.links[0].anchor, 'Readmore');
  assert.deepEqual(result.links[0].rel, ['nofollow','ugc']);
  assert.equal(result.links[0].locator.offset, html.indexOf('<a'));
});

test('metadata respects HTML syntax and entities instead of regex attribute order', () => {
  const html = '<title>County &amp; estate guide</title><meta CONTENT="A &amp; B" NAME=description>'
    + '<base href="/resources/"><link href="guide" rel="alternate canonical">'
    + '<h1>A <em>useful</em> &amp; clear guide</h1><a HREF=one>One</a><area href=two alt="Two">'
    + '<script><a href="fake">Fake</a></script><template><h1>Hidden</h1><a href="hidden">Hidden</a></template>';
  assert.deepEqual(extractPageMetadata(html, {baseUrl:URL}), {
    title:'County & estate guide',h1s:['A useful & clear guide'],meta_description:'A & B',
    canonical:'https://publisher.example.org/resources/guide',link_counts:{total:2},asset_candidate_reasons:[],
  });
});

test('empty supplied metadata has unknown counters instead of an invented empty page', () => {
  assert.deepEqual(extractPageMetadata('', {baseUrl:URL}), {
    title:null,h1s:[],meta_description:null,canonical:null,link_counts:null,asset_candidate_reasons:null,
  });
});

test('one bounded document exposes static text and accurate truncation separately from links', () => {
  const html = '<body><p>' + 'x'.repeat(120) + '</p><a href="https://customer.example.com/">customer.example.com</a></body>';
  const result = extractPage(html, {baseUrl:URL,textLimit:80});
  assert.equal(result.links.length, 1, 'complete link enumeration does not depend on text retention');
  assert.equal(result.staticText.text.length, 80);
  assert.equal(result.staticText.truncated, true);
  assert.equal(result.coverage.documentComplete, true);
  assert.equal(result.coverage.textComplete, false);
  assert.equal(result.provenance.kind, 'caller_supplied_html');
  assert.equal(result.provenance.acquiredAt, null);
  assert.equal(result.coverage.transportQualified, false);
});

test('static text at the exact cap stays complete and legacy text remains a string', () => {
  const html = '<body><p>' + 'x'.repeat(80) + '</p></body>';
  const result = extractPage(html, {baseUrl:URL,textLimit:80});
  assert.equal(result.staticText.truncated, false);
  assert.equal(legacyText(html, 80), 'x'.repeat(80));
});

test('supplied typed captures must match the page, be complete and qualified', () => {
  const result = extractPage('<p>A complete article.</p>', {baseUrl:URL,receipt:receipt()});
  assert.equal(result.provenance.kind, 'capture_receipt');
  assert.equal(result.coverage.transportQualified, true);
  for (const [capture, reason] of [
    [receipt({finalUrl:'https://other.example.org/'}), 'capture_source_mismatch'],
    [receipt({body:{complete:false,truncated:true,bytes:100,sha256:HASH,decodedSha256:HASH}}), 'capture_incomplete'],
    [receipt({transport:{id:'fixture',version:'1',qualified:false}}), 'capture_unqualified'],
    [receipt({representation:'document'}), 'capture_invalid'],
    [receipt({httpStatus:403}), 'capture_invalid'],
  ]) assert.throws(() => extractPage('<p>x</p>', {baseUrl:URL,receipt:capture}), error => error.reason === reason);
});

test('complexity refusal is shared by metadata rather than a partial link count', () => {
  const html = '<body>' + '<a href="/x">x</a>'.repeat(1001) + '</body>';
  assert.throws(() => extractPageMetadata(html, {baseUrl:URL}), error => error.reason === 'too_many_link_occurrences');
});

test('unfinished markup cannot become a complete metadata link count', () => {
  assert.throws(() => extractPageMetadata('<body><a href="', {baseUrl:URL}), error => error.reason === 'incomplete_document');
});

test('metadata without a known page URL never fabricates a canonical destination', () => {
  const result=extractPageMetadata('<link rel=canonical href=/guide><a href=/topic>Topic</a>');
  assert.equal(result.canonical,null);
  assert.equal(result.link_counts.total,1);
});
