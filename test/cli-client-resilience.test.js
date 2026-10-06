import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, CloudError } from '../cli/client.js';

const ORIGIN='https://app.example.test', TOKEN='lt_fixture';
const page=()=>Response.json({items:[],next_cursor:null});
const unavailable=(status,headers={})=>Response.json({error:{code:status===429?'RATE_LIMITED':'SERVICE_UNAVAILABLE',message:'Try again later.'}},
  {status,headers:{'X-Request-ID':`req-${status}`,...headers}});
const client=(fetchImpl,options={})=>createClient({origin:ORIGIN,token:TOKEN,fetchImpl,...options});

test('the REST client sends the 0.6.11 release User-Agent', async () => {
  const requests = [];
  const result = await client(async (url, init) => {
    const request = new Request(url, init);
    requests.push(request);
    assert.equal(request.url, ORIGIN + '/v1/watches');
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.get('user-agent'), 'agentlinkops-cli/0.6.11');
    assert.equal(request.headers.get('authorization'), 'Bearer ' + TOKEN);
    return page();
  }).listWatches();
  assert.equal(requests.length, 1);
  assert.deepEqual(result.items, []);
});

test('a dropped GET response retries within three attempts and returns the read',async()=>{
  let calls=0;const waits=[];
  const result=await client(async()=>{if(++calls===1)throw new TypeError('fetch failed');return page();},
    {sleepImpl:async ms=>waits.push(ms)}).listWatches();
  assert.deepEqual(result.items,[]);assert.equal(calls,2);assert.deepEqual(waits,[250]);
});

test('a dropped POST response is actionable and never replays the write',async()=>{
  let calls=0;
  await assert.rejects(client(async()=>{calls++;throw new TypeError('fetch failed');})
    .callCommand('create_project',{name:'Example',domain:'example.com'}),error=>{
      assert.ok(error instanceof CloudError);assert.equal(error.code,'CLOUD_NETWORK_ERROR');assert.equal(error.status,0);
      assert.match(error.serverMessage,/Check the operation result before sending it again/);
      assert.match(error.publicError.message,/Check the operation result before sending it again/);return true;
    });
  assert.equal(calls,1);
});

test('429 retries honor delta Retry-After and retain metadata when exhausted',async()=>{
  let calls=0;const waits=[];
  await assert.rejects(client(async()=>{calls++;return unavailable(429,{'Retry-After':'2'});},
    {sleepImpl:async ms=>waits.push(ms)}).listWatches(),error=>{
      assert.equal(error.status,429);assert.equal(error.retryAfter,'2');assert.equal(error.requestId,'req-429');
      assert.equal(error.publicError.requestId,'req-429');assert.equal(error.publicError.retryAfter,'2');return true;
    });
  assert.equal(calls,3);assert.deepEqual(waits,[2000,2000]);
});

test('429 honors HTTP-date Retry-After and declines waits beyond its bound',async()=>{
  const now=Date.parse('2026-09-26T12:00:00.000Z'),waits=[];let calls=0;
  const date=new Date(now+3000).toUTCString();
  const result=await client(async()=>++calls===1?unavailable(429,{'Retry-After':date}):page(),
    {now:()=>now,sleepImpl:async ms=>waits.push(ms)}).listWatches();
  assert.deepEqual(result.items,[]);assert.equal(calls,2);assert.deepEqual(waits,[3000]);
  calls=0;
  await assert.rejects(client(async()=>{calls++;return unavailable(503,{'Retry-After':'6'});},
    {sleepImpl:async()=>assert.fail('must not retry before Retry-After')}).listWatches(),error=>{
      assert.equal(error.status,503);assert.equal(error.retryAfter,'6');return true;
    });
  assert.equal(calls,1);
});

test('a truncated throttling response still honors Retry-After and keeps its request metadata',async()=>{
  let calls=0;
  const truncated=()=>new Response(new ReadableStream({start(controller){controller.error(new TypeError('body dropped'));}}),
    {status:503,headers:{'Retry-After':'6','X-Request-ID':'req-truncated'}});
  await assert.rejects(client(async()=>{calls++;return truncated();},
    {sleepImpl:async()=>assert.fail('must not retry before Retry-After')}).listWatches(),error=>{
      assert.equal(error.status,503);assert.equal(error.retryAfter,'6');assert.equal(error.requestId,'req-truncated');
      assert.match(error.serverMessage,/requested a longer wait/);return true;
    });
  assert.equal(calls,1);
});

test('503 retries a safe read with bounded backoff',async()=>{
  let calls=0;const waits=[];
  const result=await client(async()=>++calls===1?unavailable(503):page(),
    {sleepImpl:async ms=>waits.push(ms)}).listWatches();
  assert.deepEqual(result.items,[]);assert.equal(calls,2);assert.deepEqual(waits,[250]);
});

test('400 and authentication errors do not retry',async()=>{
  for(const status of [400,401,403]) {
    let calls=0;
    await assert.rejects(client(async()=>{calls++;return Response.json({error:{code:`HTTP_${status}`}},
      {status,headers:{'X-Request-ID':`req-${status}`}});}).listWatches(),error=>{
        assert.equal(error.status,status);assert.equal(error.requestId,`req-${status}`);return true;
      });
    assert.equal(calls,1);
  }
});

test('invalid successful payload does not retry',async()=>{
  let calls=0;
  await assert.rejects(client(async()=>{calls++;return Response.json({});}).listWatches(),{code:'INVALID_RESPONSE',status:502});
  assert.equal(calls,1);
});

test('timeouts and exhausted network failures have actionable classifications',async()=>{
  let reads=0;const waits=[];
  await assert.rejects(client(async()=>{reads++;throw new DOMException('timed out','TimeoutError');},
    {sleepImpl:async ms=>waits.push(ms)}).listWatches(),error=>{
      assert.equal(error.code,'CLOUD_TIMEOUT');assert.match(error.serverMessage,/timed out after 3 attempts/);return true;
    });
  assert.equal(reads,3);assert.deepEqual(waits,[250,500]);
  await assert.rejects(client(async()=>{throw new DOMException('timed out','TimeoutError');})
    .callCommand('create_project',{name:'Example',domain:'example.com'}),error=>{
      assert.equal(error.code,'CLOUD_TIMEOUT');assert.match(error.serverMessage,/Check the operation result before sending it again/);
      assert.match(error.publicError.message,/Check the operation result before sending it again/);return true;
    });
});
