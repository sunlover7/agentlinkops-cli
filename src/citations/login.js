// `agentlinkops citation login ENGINE` — one-time session persistence.
// Opens a visible browser window (or an Xvfb virtual display on headless
// Linux), navigates to the engine's URL, waits for the person to log in,
// then saves the storageState (cookies + localStorage) as a JSON file the
// engine adapter reads on every subsequent run.
//
// The saved session belongs to the person: it never leaves their machine,
// it's never synced to the hosted service, and `citation logout ENGINE`
// removes it. This is the CLI-own-browser posture — the user's account,
// their risk, their data.
import * as fs from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';

const SESSIONS_DIR = join(homedir(), '.agentlinkops', 'citations', 'sessions');

const ENGINE_URLS = Object.freeze({
  chatgpt: 'https://chatgpt.com/',
  grok: 'https://grok.com/',
  copilot: 'https://copilot.microsoft.com/',
  perplexity: 'https://www.perplexity.ai/',
  gemini: 'https://gemini.google.com/',
  claude: 'https://claude.ai/',
  bing: 'https://www.bing.com/',
});

async function saveSession(sessionDir, engineName, state, { sessionFs = fs, platform = process.platform } = {}) {
  const fail = () => Object.assign(new Error('Session storage requires a real private directory (0700) and regular private files (0600). Choose private storage and remove symbolic links.'), { code: 'PRIVATE_STORAGE_REQUIRED' });
  const privateMode = (info, mode) => platform === 'win32' || (info.mode & 0o7777) === mode;
  await sessionFs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const directory = await sessionFs.lstat(sessionDir);
  if (!directory.isDirectory() || !privateMode(directory, 0o700)) throw fail();
  const sessionPath = join(sessionDir, `${engineName}.json`);
  const inspect = async () => {
    try {
      const info = await sessionFs.lstat(sessionPath);
      if (!info.isFile() || !privateMode(info, 0o600)) throw fail();
      return info;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const previous = await inspect();
  const temporary = join(sessionDir, `.${engineName}.${randomUUID()}.tmp`);
  let handle, owned = false;
  try {
    handle = await sessionFs.open(temporary, 'wx', 0o600); owned = true;
    const info = await handle.stat();
    if (!info.isFile() || !privateMode(info, 0o600)) throw fail();
    await handle.writeFile(JSON.stringify(state, null, 2));
    await handle.sync();
    await handle.close(); handle = undefined;
    const currentDirectory = await sessionFs.lstat(sessionDir);
    if (!currentDirectory.isDirectory() || !privateMode(currentDirectory, 0o700) || currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino) throw fail();
    const current = await inspect();
    if (Boolean(current) !== Boolean(previous) || (current && ['dev', 'ino', 'size', 'mtimeMs'].some(key => current[key] !== previous[key]))) {
      throw Object.assign(new Error('The saved session changed during login. Retry without another session writer.'), { code: 'SESSION_CHANGED' });
    }
    await sessionFs.rename(temporary, sessionPath); owned = false;
    return sessionPath;
  } finally {
    await handle?.close().catch(() => {});
    if (owned) await sessionFs.unlink(temporary).catch(() => {});
  }
}

export async function loginEngine({ engineName, timeoutMs = 180_000, runtime = {} }) {
  const url = ENGINE_URLS[engineName];
  if (!url) {
    throw new Error(`unknown engine for login: ${engineName} (known: ${Object.keys(ENGINE_URLS).join(', ')})`);
  }

  // Lazy import playwright-core so the CLI still works without browser tooling.
  const { firefox } = runtime.playwright ?? await import('playwright-core');
  const { resolveCamoufoxLaunchOptions } = runtime.camoufox ?? await import('./browser/gen/lib/browser/camoufox.js');
  const { ensureDisplay, detectDisplay } = runtime.display ?? await import('./browser/gen/lib/browser/display.js');

  // On headless Linux, create a virtual display so the browser renders visibly
  // for X11 forwarding over ssh. On macOS, the browser opens directly.
  let displayHandle = null;
  let display;
  let browser;
  try {
  if ((runtime.platform ?? process.platform) === 'linux' && !detectDisplay()) {
    displayHandle = await ensureDisplay({ allowExistingDisplay: false });
    display = displayHandle.display;
  }

  const options = await resolveCamoufoxLaunchOptions({
    provider: engineName,
    display,
    headlessMode: 'headful', // login requires a visible browser
  });

  browser = await firefox.launch({ ...options, executablePath: options.executablePath });
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/New_York' });
  const page = await context.newPage();

  (runtime.log ?? console.log)(`Opening ${url} — log in; the session saves after login is detected or the timeout expires.`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Wait for login: poll for a logged-in indicator or timeout.
  const deadline = Date.now() + timeoutMs;
  let loggedIn = false;
  while (Date.now() < deadline && !loggedIn) {
    await page.waitForTimeout(5000);
    loggedIn = await page.evaluate(() => {
      // Generic login indicators: cookie-based session markers
      const cookies = document.cookie;
      if (/session|auth|token|login/i.test(cookies)) return true;
      // Surface-specific: the login button disappeared
      const loginBtn = document.querySelector('button[data-testid*="login"], a[href*="login"], button[aria-label*="Log in"]');
      if (!loginBtn) return document.querySelectorAll('textarea, [contenteditable="true"]').length > 0;
      return false;
    }).catch(() => false);
  }

  // Save the storageState regardless: even a partial session may work
  // (anonymous surfaces don't need login, and the adapter handles both).
  const state = await context.storageState();
  const sessionDir = runtime.sessionDir ?? SESSIONS_DIR;
  const sessionPath = await saveSession(sessionDir, engineName, state, runtime);

  return {
    engine: engineName,
    sessionPath,
    loggedIn: loggedIn || 'saved-partial-state',
    cookies: state.cookies?.length ?? 0,
    origins: state.origins?.length ?? 0,
  };
  } finally {
    let timer;
    try { await Promise.race([browser?.close().catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, runtime.cleanupTimeoutMs ?? 5000); })]); }
    finally { clearTimeout(timer); await displayHandle?.cleanup?.(); }
  }
}

export async function logoutEngine({ engineName }) {
  if (!Object.hasOwn(ENGINE_URLS, engineName)) throw new Error('unknown engine for logout');
  const sessionPath = join(SESSIONS_DIR, `${engineName}.json`);
  try {
    await rm(sessionPath);
    return { engine: engineName, removed: true };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { engine: engineName, removed: false, note: 'no session file found' };
  }
}

export async function listSessions() {
  try {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(SESSIONS_DIR);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
  } catch {
    return [];
  }
}
