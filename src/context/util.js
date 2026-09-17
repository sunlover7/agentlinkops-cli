// Small shared plumbing for the first-party context modules (DP-0017). Nothing here knows
// about Google or about sites: JSONL discipline, dates and byte hashes, so both halves of the
// context contract share one implementation of "append-only, newest wins, never rewrite".
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Reads a JSONL file into rows, reporting unreadable lines instead of dropping them. A dropped
 * line is a fact that stops being countable; the ledger reader taught this lesson first.
 */
export async function readJsonl(path) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { rows: [], problems: [], missing: true }; throw error; }
  const rows = [], problems = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { problems.push({ line: index + 1, reason: 'not_json' }); }
  }
  return { rows, problems, missing: false };
}

export async function appendJsonl(path, rows) {
  if (!rows.length) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

export async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** `YYYY-MM-DD` for a Date or ISO string, in UTC. Window arithmetic is done in UTC day steps. */
export function dayStamp(value) {
  return (typeof value === 'function' ? value() : value ?? new Date()).toISOString().slice(0, 10);
}

export function parseDay(stamp) {
  const [y, m, d] = String(stamp).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function isValidDay(stamp) {
  return typeof stamp === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(stamp) && Number.isFinite(parseDay(stamp));
}

export function addDays(stamp, days) {
  return new Date(parseDay(stamp) + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(start, end) {
  return Math.round((parseDay(end) - parseDay(start)) / 86_400_000) + 1; // inclusive
}

/** SHA-256 hex of a string's UTF-8 bytes. Identifies bytes without storing them. */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

/** The number Google's API always meant, or null. Never a coerced zero. */
export function numberOrNullOr(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
