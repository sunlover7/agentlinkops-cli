// Citation alert: deliver the report when a cell classifies as declined.
// Uses the same SMTP pattern as the send-email skill (zero-dependency Python
// script). The alert only fires on complete evidence — insufficient_data
// and first_epoch never trigger, exactly as the contract requires.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

export function shouldAlert(cells) {
  return cells.some((c) => c.classification === 'declined');
}

export async function sendAlertEmail({ to, subject, htmlPath, smtp = {}, execFileImpl = execFile }) {
  if (!to || !htmlPath) throw new Error('sendAlertEmail needs to and htmlPath');
  const { host, port, user, pass, from } = smtp;
  if (!host || !user || !pass) {
    // No SMTP configured — log the alert locally; the report file IS the alert.
    return { delivered: false, reason: 'no smtp configured', htmlPath };
  }
  const html = await readFile(htmlPath, 'utf8');
  // Strip the outer HTML tags for the plain-text body (the HTML stays as an
  // attachment in a real deployment; for v1 the file path is the artifact).
  const textBody = html
    .replace(/<style[^>]*>.*?<\/style>/gs, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);

  const python = `
import json, sys, smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
data = json.load(sys.stdin)
msg = MIMEMultipart('alternative')
msg['Subject'] = data['subject']
msg['From'] = data['from']
msg['To'] = data['to']
msg.attach(MIMEText(data['text'], 'plain'))
msg.attach(MIMEText(data['html'], 'html'))
with smtplib.SMTP(data['host'], data['port'], timeout=30) as s:
    s.starttls()
    s.login(data['user'], data['pass'])
    s.send_message(msg)
`;
  return new Promise((resolve, reject) => {
    const child = execFileImpl('python3', ['-c', python], (err) => {
      if (err) reject(new Error('smtp send failed'));
      else resolve({ delivered: true, htmlPath });
    });
    child.stdin.on('error', () => reject(new Error('smtp input failed')));
    child.stdin.end(JSON.stringify({ subject: subject ?? 'Citation decline', from: from ?? user, to,
      text: textBody, html, host, port: Number(port ?? 587), user, pass }));
  });
}

// Delivery is opt-in and configured by the person running the local CLI.
export function validateAlertWebhook(endpoint) {
  const url = new URL(endpoint);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('citation webhook requires HTTPS (HTTP is allowed only on loopback)');
  }
  return url;
}
export async function sendAlertWebhook({ endpoint, epochId, cells, htmlPath, fetchImpl = globalThis.fetch }) {
  const url = validateAlertWebhook(endpoint);
  if (!shouldAlert(cells)) return { delivered: false, reason: 'no decline' };
  const html = await readFile(htmlPath, 'utf8');
  const response = await fetchImpl(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schema_version: 1, type: 'citation.declined', epoch_id: epochId,
      cells: cells.filter(cell => cell.classification === 'declined'), report: { content_type: 'text/html', html } }),
  }).catch(() => { throw new Error('citation webhook delivery failed'); });
  if (!response.ok) throw new Error(`citation webhook delivery failed (HTTP ${response.status})`);
  return { delivered: true };
}
