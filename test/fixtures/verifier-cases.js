// Verifier cases shared by the cloud verifier tests and the local CLI tests.
//
// The point of DP-0014 is that `linktrail check` runs the EXACT verifier the cloud runs. A
// forked fixture suite would let the two drift and still show two green suites, which is the
// only outcome that would make the claim false without anyone noticing. So both sides import
// this file, and a case added here is asserted on both.
export const SOURCE = 'https://publisher.com/article';
export const TARGET = 'https://customer.com/guide';

export const CASES = Object.freeze([
  {
    name: 'an ordinary editorial link is present with its anchor and rel',
    html: '<p>See the <a href="https://customer.com/guide" rel="nofollow ugc">probate checklist</a>.</p>',
    expect: { state: 'present', occurrences: 1, anchor: 'probate checklist', rel: ['nofollow', 'ugc'] },
  },
  {
    name: 'a page that simply does not link to the target is absent',
    html: '<p>An article about something else entirely, with <a href="https://elsewhere.com/">a link</a>.</p>',
    expect: { state: 'absent', reason: 'no_matching_link_in_complete_html', occurrences: 0 },
  },
  {
    name: 'a link in a comment or a script string cannot satisfy a watch',
    html: `<!-- <a href="${TARGET}">Fake</a> --><script>var x = '<a href="${TARGET}">Fake</a>';</script>
      <p>${'Real editorial text. '.repeat(8)}</p>`,
    expect: { state: 'absent', occurrences: 0 },
  },
  {
    name: 'a look-alike host is not the target',
    html: '<a href="https://customer.com.evil.com/guide">Look-alike</a>',
    expect: { state: 'absent', occurrences: 0 },
  },
  {
    name: 'the target inside an open-redirect parameter is not a link to it',
    html: '<a href="https://evil.com/?url=https://customer.com/guide">Redirector</a>',
    expect: { state: 'absent', occurrences: 0 },
  },
  {
    name: 'an app shell with no links and no text cannot conclude absence',
    html: '<div id="root"></div><script src="/app.js"></script>',
    expect: { state: 'unknown', reason: 'possible_render_required', occurrences: 0 },
  },
  {
    name: 'a login wall cannot conclude absence',
    html: '<form><input type="password" name="p"></form><p>Sign in to continue.</p>',
    expect: { state: 'unknown', reason: 'possible_login_wall', occurrences: 0 },
  },
  {
    name: 'a challenge page cannot conclude absence',
    html: '<title>Just a moment...</title><p>Checking your browser.</p>',
    expect: { state: 'unknown', reason: 'access_challenge', occurrences: 0 },
  },
  {
    name: 'every occurrence is kept, not collapsed to one row per destination',
    html: `<a href="${TARGET}">First</a><p>text</p><a href="${TARGET}" rel="nofollow">Second</a>`,
    expect: { state: 'present', occurrences: 2 },
  },
  {
    name: 'domain scope accepts a subdomain and rejects a look-alike',
    html: '<a href="https://customer.com.evil.com/">Bad</a><a href="https://a.customer.com/elsewhere">Good</a>',
    input: { targetScope: 'domain' },
    expect: { state: 'present', occurrences: 1, anchor: 'Good' },
  },
]);
