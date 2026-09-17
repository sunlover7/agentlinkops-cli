// Signed DP-0004 notifications wake the existing authenticated pull; they are never facts.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { cloudObservationRows } from './sync.js';
import { readObservations, appendObservations, writeObservations, observationKey, dedupeObservations } from './mirror.js';

export function verifyDelivery({ body, headers, secret, workspaceId, now = Date.now() }) {
  if (typeof secret !== 'string' || !secret || !workspaceId) throw new Error('delivery requires secret and workspace identity');
  if (typeof body !== 'string' || Buffer.byteLength(body) > 262144) throw new Error('invalid delivery body');
  const h = new Headers(headers);
  // DP-0029: deliveries carry AgentLinkOps-* headers, and Linktrail-* alongside them for the
  // compatibility window. Either set verifies; the new one is read first.
  const header = name => h.get(`AgentLinkOps-${name}`) ?? h.get(`Linktrail-${name}`);
  const timestamp = header('Timestamp');
  if (!/^\d+$/.test(timestamp ?? '') || Math.abs(now / 1000 - Number(timestamp)) > 300) throw new Error('expired or invalid delivery timestamp');
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
  const valid = (header('Signature') ?? '').split(/\s+/).some(part => {
    if (!/^v1=[a-f0-9]{64}$/.test(part)) return false;
    return timingSafeEqual(expected, Buffer.from(part.slice(3), 'hex'));
  });
  if (!valid) throw new Error('invalid delivery signature');
  const payload = JSON.parse(body);
  if (payload.v !== 1 || payload.workspace_id !== workspaceId || !['events', 'target_events'].includes(payload.feed)
    || !payload.id || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1) throw new Error('invalid delivery identity');
  return payload;
}

export async function appendEventHistory(path, events) {
  let text = '';
  try { text = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const key = event => {
    if (!event.id) throw new Error('event missing stable identity');
    // Event IDs have feed-specific prefixes; include explicit feed when present.
    return `${event.feed ?? (event.target_id ? 'target_events' : 'events')}|${event.id}`;
  };
  const seen = new Set(text.split('\n').filter(line => line.trim()).map(line => key(JSON.parse(line))));
  const fresh = events.filter(event => { const id = key(event); if (seen.has(id)) return false; seen.add(id); return true; });
  if (fresh.length) {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, (text && !text.endsWith('\n') ? '\n' : '') + fresh.map(row => JSON.stringify(row)).join('\n') + '\n');
  }
  return fresh.length;
}

export async function persistPulledHistory(config, events, targetEvents, index) {
  const existing = await readObservations(config.paths.observations);
  if (existing.problems.length) throw new Error('cannot replay into malformed observation history');
  let repaired=0;
  if(existing.rows.some(row=>row.source==='cloud'&&!row.projection_version)) {
    let raw='';
    try { raw=await readFile(config.paths.events,'utf8'); } catch(error) { if(error.code!=='ENOENT')throw error; }
    const held=raw.split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));
    const corrected=new Map(cloudObservationRows([...held,...events],index).map(row=>[observationKey(row),row]));
    existing.rows=existing.rows.map(row=>{
      const replacement=corrected.get(observationKey(row));
      if(row.source==='cloud'&&!row.projection_version&&replacement){repaired++;return replacement;}
      return row;
    });
    if(repaired)await writeObservations(config.paths.observations,existing.rows);
  }
  const rows = cloudObservationRows(events, index);
  const { fresh, duplicates } = dedupeObservations(existing.rows, rows);
  await appendObservations(config.paths.observations, fresh);
  await appendEventHistory(config.paths.events, [...events, ...targetEvents]);
  return { fresh, duplicates, repaired };
}
