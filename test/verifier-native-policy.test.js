import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyLink, verifyLinks, transitionState } from '../src/verifier/index.js';
import { publicFetcher } from '../src/verifier/fetch.js';
const sourceUrl = 'https://publisher.com/profile';
const targetUrl = 'https://customer.com/';
const input = { sourceUrl, targetUrl, targetScope: 'domain' };
const shell = '<!doctype html><html><body><div id="app"></div><script src="/app.js"></script></body></html>';
const page = body => `<!doctype html><html><head><title>Public profile</title></head><body>${body}</body></html>`;
const anchor = `<a href="${targetUrl}" rel="nofollow">Customer</a>`;
function options(extra = {}, html = page(anchor)) {
  const doc = { html, finalUrl: sourceUrl, httpStatus: 200, redirects: [], ready: true,
    bodyTruncated: false, rendererVersion: 'cf-native-1', contentType: 'text/html; charset=utf-8',
    cfMitigated: '', challenge: false, visibleLogin: false, browserClosed: true,
    browserVersion: 'Chrome/128', userAgent: 'LinktrailBot/0.1', requestCount: 3,
    durationMs: 250, terminationReason: null,
    robotsHistory: [{sourceUrl, robotsUrl:'https://publisher.com/robots.txt', httpStatus:200,
      productToken:'LinktrailBot', allowed:true, reason:'robots_allowed', crawlDelaySeconds:0}], ...extra };
  return {publicFetchSafe:true, includeHtml:false,
    fetchImpl:async url=>url.endsWith('/robots.txt')?new Response('',{status:404}):new Response(shell,{headers:{'content-type':'text/html'}}),
    renderPage:Object.assign(async()=>doc,{publicFetchSafe:true,requiresNavigationAuthorization:true,positiveOnly:true,strictEvidenceVersion:1})};
}

test('native positive uses existing target/anchor/rel rules and bounded metadata',async()=>{
  const result=await verifyLink({...input,expectedRel:['nofollow']},options({robotsHistory:undefined}));
  assert.equal(result.state,'unknown'); // missing authorization evidence is invalid
  const found=await verifyLink({...input,expectedRel:['nofollow']},options({secret:'never-export'}));
  assert.equal(found.state,'present');assert.equal(found.expectations.satisfied,true);
  assert.equal(found.evidence.browser.rendererVersion,'cf-native-1');
  assert.equal(JSON.stringify(found).includes('never-export'),false);
});

test('ready and unready empty native DOM never produce absent or loss',async()=>{
  for(const ready of [true,false]){
    const r=await verifyLink(input,options({ready},page('<p>Biography without link.</p>')));
    assert.equal(r.state,'unknown');assert.equal(r.reason,'render_no_positive_evidence');
    assert.equal(r.evidence.complete,false);assert.equal(r.linkSignature,undefined);
    assert.equal(transitionState({},r).lastSuccessfulObservation,null);
  }
});

for(const [name,extra] of Object.entries({
  challenge:{cfMitigated:'challenge'}, challengeSignal:{challenge:true}, guardrails:{cfMitigated:'guardrails'},
  login:{visibleLogin:true}, nonHtml:{contentType:'application/json'}, status403:{httpStatus:403},
  status429:{httpStatus:429}, unclosed:{browserClosed:false}, stopped:{terminationReason:'request_limit'},
  tooManyRequests:{requestCount:151}, exceededDeadline:{durationMs:20001},
  missingRobots:{robotsHistory:[]}, missingContentType:{contentType:undefined},
  missingChallenge:{challenge:undefined}, malformedHeader:{contentType:'text/html\r\nprivate-marker'},
})) test(`native ${name} cannot promote even a matching anchor`,async()=>{
  const r=await verifyLink(input,options(extra));assert.equal(r.state,'unknown');
  assert.equal(r.evidence.complete,false);assert.equal(r.occurrences.length,0);
});

test('shared acquisition keeps unmatched siblings unknown',async()=>{
  const opts=options();const render=opts.renderPage;let calls=0;
  opts.renderPage=Object.assign(async(...args)=>{calls++;return render(...args);},render);
  const rows=await verifyLinks([input,{...input,targetUrl:'https://different.com/'}],opts);
  assert.equal(calls,1);assert.deepEqual(rows.map(r=>r.state),['present','unknown']);
});

test('native navigation authorization obeys robots and paces without fetching the source',async()=>{
  const calls=[], paced=[];const controller=new AbortController();
  const f=publicFetcher({fetchImpl:async url=>{calls.push(url);return new Response('User-agent: *\nDisallow: /private\nCrawl-delay: 2',{headers:{'content-type':'text/plain'}});},beforeFetch:async(url,ctx)=>paced.push({url,kind:ctx.kind,delay:ctx.crawlDelaySeconds})},controller.signal);
  const allowed=await f.authorizeNavigation(sourceUrl,{});assert.equal(allowed.allowed,true);
  await assert.rejects(f.authorizeNavigation('https://publisher.com/private',{}),/robots_disallowed/);
  assert.deepEqual(calls,['https://publisher.com/robots.txt']);
  assert.equal(paced.at(-1).url,sourceUrl);assert.equal(paced.at(-1).delay,2);
});

test('native static positive survives failed comparison and wrappers remain unconfirmed',async()=>{
  const opts=options({challenge:true});opts.compareRendered=true;
  opts.fetchImpl=async url=>url.endsWith('/robots.txt')?new Response('',{status:404}):new Response(page(anchor),{headers:{'content-type':'text/html'}});
  const retained=await verifyLink(input,opts);assert.equal(retained.state,'present');assert.equal(retained.evidence.method,'http_html');
  const wrapper=await verifyLink(input,options({},page(`<a href="https://redirector.com/?url=${encodeURIComponent(targetUrl)}">Customer</a>`)));
  assert.equal(wrapper.state,'unknown');assert.equal(wrapper.occurrences.length,0);
});

test('native redirected target page cannot confirm its own links',async()=>{
  const row={sourceUrl:targetUrl,robotsUrl:targetUrl+'robots.txt',httpStatus:200,productToken:'LinktrailBot',allowed:true,reason:'robots_allowed',crawlDelaySeconds:0};
  const opts=options({finalUrl:targetUrl,redirects:[{from:sourceUrl,to:targetUrl,status:302}],robotsHistory:[{...row,sourceUrl,robotsUrl:'https://publisher.com/robots.txt'},row]});
  const r=await verifyLink(input,opts);assert.equal(r.state,'unknown');assert.equal(r.reason,'source_redirects_to_target');
});

test('bounded render Retry-After survives unknown observation without exposing provider text',async()=>{
  const opts=options();opts.renderPage=Object.assign(async()=>{throw Object.assign(new Error('private-provider-payload'),{retryAfterSeconds:120});},opts.renderPage);
  const result=await verifyLink(input,opts);assert.equal(result.state,'unknown');assert.equal(result.retryAfterSeconds,120);
  assert.equal(JSON.stringify(result).includes('private-provider-payload'),false);
});
