/** Shared error identity, including callers of the legacy verifier/fetch.js facade. */
export class VerificationError extends Error {
  constructor(reason, details = {}) {
    super(reason);
    this.name = 'VerificationError';
    this.reason = reason;
    Object.assign(this, details);
  }
}

/** Cancellation is best effort and must not extend the owner's deadline. */
export function cancelBody(response) {
  try { response.body?.cancel().catch(() => {}); } catch { /* Already locked/closed. */ }
}

/** Race every blocking phase against the same caller-owned signal. */
export function withAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(new VerificationError('timeout'));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); reject(new VerificationError('timeout')); };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}

/**
 * Consume a body without decoding it. A transport may expose decoded response bytes
 * even with Content-Encoding present, so that header disables wire-length equality.
 * The returned bytes describe exactly the representation the reader consumed.
 */
export async function readBoundedBytes(response, maxBytes, signal) {
  const length = response.headers.get('content-length');
  const encoded = response.headers.get('content-encoding');
  if (!encoded && length && Number(length) > maxBytes) {
    cancelBody(response);
    throw new VerificationError('body_too_large');
  }
  const reader = response.body?.getReader();
  if (!reader) return { data: new Uint8Array(0), bytes: 0 };
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new VerificationError('body_too_large');
      chunks.push(value);
    }
    if (!encoded && length && Number(length) !== bytes) throw new VerificationError('incomplete_body');
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return { data, bytes };
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Decode only a complete bounded representation; invalid input is never empty HTML. */
export function decodeBytes(data, charset = 'utf-8') {
  try { return new TextDecoder(charset, { fatal: true }).decode(data); }
  catch { throw new VerificationError('unsupported_or_invalid_encoding'); }
}

/** Existing verifier API, including its no-body return shape and charset behavior. */
export async function readBounded(response, maxBytes, signal) {
  const body = await readBoundedBytes(response, maxBytes, signal);
  if (!response.body) return { text: '', bytes: 0 };
  const contentType = response.headers.get('content-type') ?? '';
  const charset = /charset\s*=\s*["']?([^\s;"']+)/iu.exec(contentType)?.[1] ?? 'utf-8';
  return { text: decodeBytes(body.data, charset), bytes: body.bytes, data: body.data };
}

/** A refusal may retain a small diagnostic prefix; it is never a complete page capture. */
export async function readBodyDiagnostic(response, signal, maxBytes = 64 * 1024) {
  const reader=response.body?.getReader(),chunks=[];
  const controller=new AbortController(),abort=()=>controller.abort();
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  // Diagnostics must not consume the recovery window or wait for a publisher
  // to finish an error stream. The caller's earlier deadline still wins.
  const timer=setTimeout(abort,250);
  let bytes=0,complete=!reader,truncated=false;
  try {
    if(reader)while(true){
      const {done,value}=await withAbort(reader.read(),controller.signal);
      if(done){complete=true;break;}
      const keep=Math.min(value.byteLength,maxBytes-bytes);
      if(keep){chunks.push(value.slice(0,keep));bytes+=keep;}
      if(keep<value.byteLength||bytes===maxBytes){truncated=true;reader.cancel().catch(()=>{});break;}
    }
  }catch(error){
    reader?.cancel().catch(()=>{});
    if(signal?.aborted||!controller.signal.aborted)throw error;
    truncated=true;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);reader?.releaseLock();}
  const data=new Uint8Array(bytes);let offset=0;
  for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
  const length=response.headers.get('content-length');
  if(!response.headers.get('content-encoding')&&length&&Number(length)!==bytes)complete=false;
  const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),b=>b.toString(16).padStart(2,'0')).join('');
  const text=new TextDecoder('utf-8').decode(data);
  // Saved diagnostics carry facts and a digest, never publisher/error text or cookies.
  return {version:1,bytes,complete,truncated,sha256,
    looksLikeHtml:/<(?:!doctype\s+html|html|body|head)\b/iu.test(text)};
}

/**
 * Inflate incrementally and apply the cap to output chunks before retaining them.
 * Unlike synchronous gunzip, this never materializes an unbounded expanded document.
 * Web streams keep the implementation usable in both Workers and Node runtimes.
 */
export async function inflateGzipBounded(data, maxBytes, signal) {
  if (signal?.aborted) throw new VerificationError('timeout');
  // Feed small slices: a transform must not be handed an entire compressed bomb in
  // one write before its output consumer has an opportunity to enforce the bound.
  let offset = 0;
  const compressed = new ReadableStream({
    pull(controller) {
      if (signal?.aborted) { controller.error(new VerificationError('timeout')); return; }
      if (offset >= data.length) { controller.close(); return; }
      const next = Math.min(offset + 1024, data.length);
      controller.enqueue(data.subarray(offset, next));
      offset = next;
    },
  });
  const expanded = compressed.pipeThrough(new DecompressionStream('gzip'));
  return readBoundedBytes(new Response(expanded), maxBytes, signal);
}
