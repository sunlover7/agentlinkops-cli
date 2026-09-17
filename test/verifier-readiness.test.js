import test from 'node:test';
import assert from 'node:assert/strict';
import { assessReadiness } from '../src/verifier/readiness.js';
import { parseDocument } from '../src/verifier/parser.js';

const targetUrl = 'https://settledestate.com/';
const assess = (html) => assessReadiness({ html, parsed: parseDocument(html, 'https://example.org/profile'), targetUrl });

test('navigation does not make an empty hydrated application conclusive', () => {
  const result = assess('<head><script src="/app.js"></script></head><body><nav><a href="/">Home</a></nav><div id="__next"></div></body>');
  assert.equal(result.requiresRender, true);
  assert.equal(result.reason, 'empty_application_root');
});

test('profile data in script and an empty profile container require rendering', () => {
  const html = `<nav><a href="/">Home</a></nav><div id="profile"></div><script>window.profile={website:"${targetUrl}"};</script>`;
  const result = assess(html);
  assert.equal(result.reason, 'profile_target_in_script_only');
  assert.equal(parseDocument(html, 'https://example.org/').links.some((link) => link.targetUrl === targetUrl), false);
});

test('an inline URL example does not invalidate a static article', () => {
  const result = assess(`<article>This is a complete public article with readable content and no backlink.</article><script>const example="${targetUrl}";</script>`);
  assert.equal(result.targetInScript, true);
  assert.equal(result.requiresRender, false);
});

test('populated SSR application roots remain conclusive', () => {
  const result = assess('<div id="root"><main><h1>My profile</h1><p>Writer and photographer.</p></main></div><script src="/hydrate.js"></script>');
  assert.equal(result.requiresRender, false);
});

test('a root containing only navigation still requires rendering', () => {
  assert.equal(assess('<div id="app"><nav><a href="/">Home</a></nav></div><script src="/app.js"></script>').requiresRender, true);
});

test('populated nested roots contribute content to their containing application', () => {
  assert.equal(assess('<div id="app"><div id="profile">My biography</div></div><script src="/app.js"></script>').requiresRender, false);
});

test('an empty optional app widget beside substantive content is not a page shell', () => {
  assert.equal(assess('<article>This is a complete public article with readable content and no backlink.</article><div id="app"></div><script src="/widget.js"></script>').requiresRender, false);
});

test('explicitly hidden password widgets do not establish a login wall', () => {
  for (const attributes of ['hidden', 'style="display: none !important"', 'style="visibility:hidden"']) {
    const result = assess(`<div ${attributes}><input type="password"></div>`);
    assert.equal(result.hasVisiblePassword, false);
    assert.equal(result.possibleLoginWall, false);
  }
  assert.equal(assess('<dialog><input type="password"></dialog>').possibleLoginWall, false);
});

test('visible password form gating the page remains a possible login wall', () => {
  assert.equal(assess('<h1>Sign in</h1><form><label>Password<input type="password"></label><button>Log in</button></form>').possibleLoginWall, true);
});

test('visible optional login widget does not gate a substantive public article', () => {
  assert.equal(assess('<article>This is a complete public article with readable content and no backlink.</article><form><input type="password"></form>').possibleLoginWall, false);
});

test('template password fields are inert, ARIA alone does not establish visual hiding', () => {
  assert.equal(assess('<template><input type="password"></template>').possibleLoginWall, false);
  assert.equal(assess('<div aria-hidden="true"><input type="password"></div>').possibleLoginWall, true);
});

test('ordinary script-bearing static HTML is conclusive', () => {
  assert.equal(assess('<p>A short static message.</p><script src="/analytics.js"></script>').requiresRender, false);
});

test('size and parser complexity limits return an inconclusive readiness result', () => {
  assert.equal(assessReadiness({ html: 'x'.repeat(2 * 1024 * 1024 + 1) }).reason, 'readiness_limit_exceeded');
  assert.equal(assessReadiness({ html: '<div></div>'.repeat(25_001) }).reason, 'readiness_limit_exceeded');
});
