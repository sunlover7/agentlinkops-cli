import {
  readFile,
  mkdir,
  readdir,
  lstat,
  open,
  rename,
  unlink,
  rm,
} from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { parseArgs } from "./args.js";
import { ConfigError } from "./config.js";
import { AGENT_CLIENTS, clientById } from "../shared/agent-clients.js";
import { NUDGE } from "./skill.js";

// DP-0036-T09: `agentlinkops agent setup` (Stripe's `stripe agent setup` shape). It detects the
// agent clients on this machine, installs the skill pack at each client's path with digest
// verification, and writes the MCP entry for the view that client should use, from the one
// client table in shared/agent-clients.js. It stores no credential: OAuth happens in the
// client. It is idempotent, never overwrites a file it did not write, and prints exactly what
// changed. `agent status` reports what is installed without touching anything.
const USAGE =
  "agent setup [--client ID ...] [--scope project|user] [--origin URL] [--pack DIR] [--dry-run] [--json] | agent status [--json] | agent remove|recover [--scope project|user] [--apply] [--json]";
export const DEFAULT_ORIGIN = "https://app.agentlinkops.com";
export const SERVER_NAME = "agentlinkops";
const RECEIPT = ".agentlinkops/agent-setup.json";
const SHARED = Symbol("package siblings");
const ignored = (path) =>
  /(^|\/)(?:\._[^/]*|__pycache__|\.DS_Store)(?:\/|$)|\.(?:py[co]|sqlite(?:3)?(?:-[a-z]+)?|bak)$/u.test(
    path,
  );
async function safePath(path) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    path.split(/[\\/]/u).includes("..")
  )
    throw new ConfigError(
      "Use a canonical absolute path without parent traversal.",
    );
  let current = resolve(path);
  const components = [];
  while (dirname(current) !== current) {
    components.unshift(current);
    current = dirname(current);
  }
  for (const part of components) {
    let info;
    try {
      info = await lstat(part);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    if (info.isSymbolicLink())
      throw new ConfigError("Symlink installation paths are not supported.");
    if (part !== resolve(path) && !info.isDirectory())
      throw new ConfigError("Installation ancestor is not a directory.");
  }
}
async function bytesAt(path) {
  await safePath(path);
  try {
    const info = await lstat(path);
    if (!info.isFile())
      throw new ConfigError("Installation target is not a regular file.");
    return await readFile(path);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// Where the pack's skills live: beside the packaged CLI (packages/agentlinkops-cli/skills), in
// the assembled plugin, or in this repository's toolkit. The first that exists wins.
export async function locatePack(
  explicit = null,
  from = fileURLToPath(import.meta.url),
) {
  const candidates = explicit
    ? [explicit]
    : [
        join(dirname(from), "..", "skills"),
        join(dirname(from), "..", "dist", "plugin", "agentlinkops", "skills"),
        join(
          dirname(from),
          "..",
          "toolkit",
          "plugin",
          "agentlinkops",
          "skills",
        ),
      ];
  for (const dir of candidates) {
    if (dir.split(/[\\/]/u).includes(".."))
      throw new ConfigError("Package path must not contain parent traversal.");
    await safePath(resolve(dir));
    const entries = await readdir(dir, { withFileTypes: true }).catch(
      () => null,
    );
    if (entries?.some((e) => e.isDirectory())) return resolve(dir);
  }
  throw new ConfigError(
    explicit
      ? `No skills found under ${explicit}.`
      : "No skill pack found beside this CLI; pass --pack DIR or install the agentlinkops package.",
  );
}

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const full = join(dir, entry.name);
    if (ignored(relative(base, full).replaceAll("\\", "/"))) continue;
    if (entry.isSymbolicLink())
      throw new ConfigError("Package source contains a symlink.");
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else if (entry.isFile()) out.push(relative(base, full));
  }
  return out;
}

// The pack as {skillName: {relPath: {bytes, digest}}}; only directories with a SKILL.md count.
export async function readPack(dir) {
  dir = resolve(dir);
  await safePath(dir);
  const skills = {};
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.some((e) => e.isSymbolicLink() && !ignored(e.name)))
    throw new ConfigError("Package source contains a symlink.");
  for (const entry of entries
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const root = join(dir, entry.name);
    if (ignored(entry.name)) continue;
    if (!(await bytesAt(join(root, "SKILL.md")))) continue;
    const files = {};
    for (const rel of await walk(root)) {
      const bytes = await readFile(join(root, rel));
      files[rel] = { bytes, digest: sha256(bytes) };
    }
    skills[entry.name] = files;
  }
  if (!Object.keys(skills).length)
    throw new ConfigError(`No skills with a SKILL.md under ${dir}.`);
  const siblings = {};
  for (const name of ["scripts", "references", "templates"]) {
    const path = join(dir, "..", name);
    await safePath(path);
    const info = await lstat(path).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (!info) continue;
    if (!info.isDirectory())
      throw new ConfigError("Shared package dependency must be a directory.");
    for (const rel of await walk(path)) {
      const bytes = await readFile(join(path, rel));
      siblings[`${name}/${rel}`] = { bytes, digest: sha256(bytes) };
    }
  }
  const files = [
    ...Object.values(skills).flatMap(Object.values),
    ...Object.values(siblings),
  ];
  if (
    files.length > 10000 ||
    files.reduce((n, f) => n + f.bytes.length, 0) > 32 * 1024 * 1024
  )
    throw new ConfigError(
      "Skill package exceeds the 10000-file/32MiB install bound.",
    );
  Object.defineProperty(skills, SHARED, { value: siblings });
  return skills;
}

const expand = (path, home) =>
  path.startsWith("~/") ? join(home, path.slice(2)) : path;
const exists = async (path) => !!(await lstat(path).catch(() => null));

export async function detectClients(home, only = null) {
  const found = [];
  for (const client of AGENT_CLIENTS) {
    if (only && !only.includes(client.id)) continue;
    const detected = only?.includes(client.id)
      ? true
      : (
          await Promise.all(client.detect.map((p) => exists(expand(p, home))))
        ).some(Boolean);
    if (detected) found.push(client);
  }
  return found;
}

// MCP entry writers per format. JSON files are merged under mcpServers; TOML gets a table
// appended when absent; YAML clients get the snippet printed, never an edit of a config we do
// not own. Every writer returns {file, action, entry} with action in written | unchanged |
// conflict | printed.
function mcpEntry(client, url) {
  switch (client.mcp.format) {
    case "mcpServers-json":
      return client.id === "claude-code" ? { type: "http", url } : { url };
    case "mcpServers-httpUrl":
      return { httpUrl: url };
    default:
      return { url };
  }
}
export async function planMcp(client, { cwd, home, origin, scope }) {
  const url = `${origin}${client.view}`;
  const entry = mcpEntry(client, url);
  const userScope = client.mcp.scope === "user" || scope === "user";
  const expanded = expand(client.mcp.file, home);
  const file = isAbsolute(expanded)
    ? expanded
    : join(userScope ? home : cwd, expanded);
  if (client.mcp.format === "toml-mcp_servers") {
    const prior = await bytesAt(file),
      text = prior?.toString("utf8") ?? "";
    const table = `[mcp_servers.${SERVER_NAME}]`;
    if (text.includes(table))
      return {
        file,
        action: text.includes(`url = "${url}"`) ? "unchanged" : "conflict",
        entry,
        url,
        note: text.includes(`url = "${url}"`)
          ? undefined
          : `${table} already exists with a different url; edit it by hand.`,
      };
    return {
      file,
      action: "write",
      entry,
      url,
      beforeHash: prior === null ? null : sha256(prior),
      text: `${text.length && !text.endsWith("\n") ? `${text}\n` : text}\n${table}\nurl = "${url}"\n`,
    };
  }
  if (client.mcp.format === "yaml-mcp_servers")
    return {
      file,
      action: "printed",
      entry,
      url,
      snippet: `mcp_servers:\n  ${SERVER_NAME}:\n    url: ${url}\n`,
    };
  if (
    client.id === "claude-code" &&
    (client.mcp.scope === "user" || scope === "user")
  )
    return {
      file: expand("~/.claude.json", home),
      action: "printed",
      entry,
      url,
      snippet: `claude mcp add --transport http --scope user ${SERVER_NAME} ${url}`,
    };
  const prior = await bytesAt(file),
    text = prior?.toString("utf8") ?? null;
  let config = {};
  if (text !== null) {
    try {
      config = JSON.parse(text);
    } catch {
      return {
        file,
        action: "conflict",
        entry,
        url,
        note: "existing file is not valid JSON; edit it by hand.",
      };
    }
  }
  const servers = config.mcpServers ?? {};
  const current = servers[SERVER_NAME];
  if (current && JSON.stringify(current) === JSON.stringify(entry))
    return { file, action: "unchanged", entry, url };
  if (current)
    return {
      file,
      action: "conflict",
      entry,
      url,
      note: `mcpServers.${SERVER_NAME} already exists with a different entry; edit it by hand.`,
    };
  return {
    file,
    action: "write",
    entry,
    url,
    beforeHash: prior === null ? null : sha256(prior),
    text: `${JSON.stringify({ ...config, mcpServers: { ...servers, [SERVER_NAME]: entry } }, null, 2)}\n`,
  };
}

// Only sections created by this installer are owned. Existing matching entries are
// deliberately not adopted; older receipts without section ownership leave them alone.
function configFile(client, cwd, home, scope) {
  const expanded = expand(client.mcp.file, home);
  return isAbsolute(expanded)
    ? expanded
    : join(
        client.mcp.scope === "user" || scope === "user" ? home : cwd,
        expanded,
      );
}
function validMcpOwnership(path, record, cwd, home, scope) {
  const client = clientById(record?.client);
  return (
    client &&
    record.format === client.mcp.format &&
    path === configFile(client, cwd, home, scope) &&
    ["mcpServers-json", "mcpServers-httpUrl", "toml-mcp_servers"].includes(
      record.format,
    ) &&
    typeof record.url === "string" &&
    /^https?:\/\//u.test(record.url) &&
    !/[\r\n"\\]/u.test(record.url)
  );
}
// Locate the owned JSON property without serializing foreign fields (including
// large numbers, duplicate foreign keys, whitespace and their exact bytes).
function removeJsonMcpSection(text) {
  const tokens = [
    ...text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/gu),
  ].map((m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
  function members(index) {
    if (tokens[index]?.text !== "{") return null;
    const result = [];
    let i = index + 1;
    while (tokens[i].text !== "}") {
      const key = tokens[i],
        valueIndex = i + 2;
      i = valueIndex;
      if (["{", "["].includes(tokens[i].text)) {
        let depth = 0;
        do {
          if (["{", "["].includes(tokens[i].text)) depth++;
          if (["}", "]"].includes(tokens[i].text)) depth--;
          i++;
        } while (depth);
      } else i++;
      result.push({
        name: JSON.parse(key.text),
        start: key.start,
        end: tokens[i - 1].end,
        valueIndex,
      });
      if (tokens[i].text === ",") i++;
    }
    return result;
  }
  const roots = members(0)?.filter((m) => m.name === "mcpServers");
  if (roots?.length !== 1) return null;
  const servers = members(roots[0].valueIndex);
  const owned = servers?.filter((m) => m.name === SERVER_NAME);
  if (owned?.length !== 1) return null;
  const fields = members(owned[0].valueIndex);
  if (!fields || new Set(fields.map((m) => m.name)).size !== fields.length)
    return null;
  const at = servers.indexOf(owned[0]);
  const start =
    at === servers.length - 1 && at > 0 ? servers[at - 1].end : owned[0].start;
  const end = at < servers.length - 1 ? servers[at + 1].start : owned[0].end;
  return text.slice(0, start) + text.slice(end);
}

async function planMcpRemoval(path, record) {
  const before = await bytesAt(path);
  if (before === null) return { absent: true };
  const text = before.toString("utf8");
  let next;
  if (record.format === "toml-mcp_servers") {
    if (text.includes('"""') || text.includes("'''"))
      return { preserved: true };
    const header = `[mcp_servers.${SERVER_NAME}]`;
    const lines = text.split(/(?<=\n)/u);
    const matches = lines
      .map((line, index) => (line.trim() === header ? index : -1))
      .filter((i) => i >= 0);
    // Nested/quoted/duplicate definitions require manual review. This bounded
    // writer owns only the exact simple table it generated, not arbitrary TOML.
    const related = lines.filter((line) =>
      /^\s*\[.*mcp_servers.*agentlinkops/u.test(line),
    );
    if (!matches.length && !related.length) return { absent: true };
    if (matches.length !== 1 || related.length !== 1)
      return { preserved: true };
    const start = matches[0];
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/u.test(lines[end])) end++;
    const section = lines.slice(start, end).join("");
    if (section.trimEnd() !== `${header}\nurl = "${record.url}"`)
      return { preserved: true };
    next = lines.slice(0, start).join("") + lines.slice(end).join("");
  } else {
    let config;
    try {
      config = JSON.parse(text);
    } catch {
      return { preserved: true };
    }
    if (!config || typeof config !== "object" || Array.isArray(config))
      return { preserved: true };
    const servers = config.mcpServers;
    if (servers === undefined) return { absent: true };
    if (!servers || typeof servers !== "object" || Array.isArray(servers))
      return { preserved: true };
    if (!Object.hasOwn(servers, SERVER_NAME)) return { absent: true };
    if (
      !isDeepStrictEqual(
        servers[SERVER_NAME],
        mcpEntry(clientById(record.client), record.url),
      )
    )
      return { preserved: true };
    next = removeJsonMcpSection(text);
    if (next === null) return { preserved: true };
  }
  return {
    operation: { path, bytes: Buffer.from(next), expected: sha256(before) },
  };
}

// Skill installation plan for one client: per file, install | unchanged | conflict.
export async function planSkills(client, pack, { cwd, home, scope, receipt }) {
  const base =
    scope === "user" || !client.skills.project
      ? client.skills.user
      : client.skills.project;
  const root = expand(base, home);
  const dir = isAbsolute(root) ? root : join(cwd, root);
  const plan = {
    dir,
    install: [],
    unchanged: [],
    conflicts: [],
    desired: [],
    roots: [
      dir,
      ...["scripts", "references", "templates"].map((name) =>
        join(dir, "..", name),
      ),
    ],
  };
  const entries = [];
  for (const [name, files] of Object.entries(pack))
    for (const [rel, data] of Object.entries(files))
      entries.push({ target: join(dir, name, rel), ...data });
  for (const [rel, data] of Object.entries(pack[SHARED] ?? {}))
    entries.push({ target: join(dir, "..", rel), ...data });
  plan.desired = entries.map((e) => e.target);
  for (const { target, digest, bytes } of entries) {
    const existing = await bytesAt(target),
      before = existing === null ? null : sha256(existing);
    if (before === digest) {
      plan.unchanged.push(target);
      continue;
    }
    if (existing === null || receipt?.files?.[target] === before)
      plan.install.push({
        target,
        digest,
        bytes,
        before,
        replaces: receipt?.files?.[target],
      });
    else
      plan.conflicts.push({
        target,
        note: "Existing file differs from the last installed digest or is not owned; customer content was left untouched.",
      });
  }
  return plan;
}

function locations(cwd, home, scope) {
  const base = scope === "user" ? home : cwd;
  return {
    receipt: join(
      base,
      scope === "user" ? ".agentlinkops/agent-setup-user.json" : RECEIPT,
    ),
    journal: join(base, `.agentlinkops/agent-setup-${scope}.journal.json`),
    lock: join(base, `.agentlinkops/agent-setup-${scope}.lock`),
  };
}
function allowedPath(path, cwd, home, receiptPath, controls = true) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path)
    return false;
  if (path === receiptPath) return controls;
  for (const client of AGENT_CLIENTS) {
    for (const base of [
      client.skills.project ? join(cwd, client.skills.project) : null,
      expand(client.skills.user, home),
    ].filter(Boolean)) {
      const rel = relative(base, path);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return true;
      for (const sibling of ["scripts", "references", "templates"]) {
        const r = relative(join(base, "..", sibling), path);
        if (r && !r.startsWith("..") && !isAbsolute(r)) return true;
      }
    }
    const config = client.mcp.file.startsWith("~/")
      ? expand(client.mcp.file, home)
      : join(cwd, client.mcp.file);
    if (controls && (path === config || path === join(home, client.mcp.file)))
      return true;
  }
  return false;
}
async function readReceipt(path, cwd, home) {
  const bytes = await bytesAt(path);
  if (bytes === null) return null;
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new ConfigError(
      "Installer receipt is invalid JSON; inspect it without overwriting.",
    );
  }
  if (
    !value ||
    !value.files ||
    typeof value.files !== "object" ||
    Array.isArray(value.files) ||
    Object.entries(value.files).some(
      ([p, d]) =>
        !allowedPath(p, cwd, home, path, false) ||
        typeof d !== "string" ||
        !/^[a-f0-9]{64}$/u.test(d),
    )
  )
    throw new ConfigError("Installer ownership receipt is invalid.");
  if (
    value.mcp !== undefined &&
    (!value.mcp ||
      typeof value.mcp !== "object" ||
      Array.isArray(value.mcp) ||
      Object.entries(value.mcp).some(
        ([p, r]) => !validMcpOwnership(p, r, cwd, home, value.scope),
      ))
  )
    throw new ConfigError("Installer MCP ownership receipt is invalid.");
  return value;
}
async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    // Some platforms/filesystems do not support directory handles/fsync.
    if (
      ![
        "EINVAL",
        "ENOTSUP",
        "EISDIR",
        "EBADF",
        ...(process.platform === "win32" ? ["EPERM", "EACCES"] : []),
      ].includes(error.code)
    )
      throw error;
  } finally {
    await handle?.close();
  }
}
async function durableMkdir(path) {
  const first = await mkdir(path, { recursive: true });
  if (first) {
    const boundary = dirname(first);
    for (let current = path; ; current = dirname(current)) {
      await syncDirectory(current);
      if (current === boundary || current === dirname(current)) break;
    }
  }
}
async function durableUnlink(path) {
  await unlink(path);
  await syncDirectory(dirname(path));
}
async function atomicWrite(path, bytes) {
  await safePath(path);
  await durableMkdir(dirname(path));
  const temporary = `${path}.agentlinkops-${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}
async function transaction(paths, operations, { cwd, home, afterOperation }) {
  await safePath(paths.lock);
  await durableMkdir(dirname(paths.lock));
  let lock;
  try {
    lock = await open(paths.lock, "wx", 0o600);
  } catch (e) {
    if (e.code === "EEXIST")
      throw new ConfigError(
        "Installer lock exists; inspect or recover the interrupted operation.",
      );
    throw e;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    await lock.sync();
    if (await bytesAt(paths.journal))
      throw new ConfigError(
        "An interrupted installer transaction exists; recover first.",
      );
    const entries = [];
    for (const op of operations) {
      if (!allowedPath(op.path, cwd, home, paths.receipt))
        throw new ConfigError("Unsafe planned installer target.");
      const before = await bytesAt(op.path);
      if ((before === null ? null : sha256(before)) !== op.expected)
        throw new ConfigError(
          "Installation target changed after planning; retry.",
        );
      entries.push({
        path: op.path,
        before: before?.toString("base64") ?? null,
        after: op.bytes?.toString("base64") ?? null,
        beforeHash: before === null ? null : sha256(before),
        afterHash: op.bytes === null ? null : sha256(op.bytes),
      });
    }
    const journal = { schema: 1, receipt: paths.receipt, entries };
    await atomicWrite(paths.journal, Buffer.from(JSON.stringify(journal)));
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i],
        current = await bytesAt(e.path);
      if ((current === null ? null : sha256(current)) !== e.beforeHash)
        throw new ConfigError(
          "Installation target changed during apply; recover before retrying.",
        );
      if (e.after === null) await durableUnlink(e.path);
      else await atomicWrite(e.path, Buffer.from(e.after, "base64"));
      await afterOperation?.(i);
    }
    await durableUnlink(paths.journal);
  } finally {
    await lock.close();
    await rm(paths.lock, { force: true });
  }
}
async function recover(paths, { cwd, home, apply }) {
  const lock = await bytesAt(paths.lock);
  if (lock) {
    let pid;
    try {
      pid = JSON.parse(lock).pid;
    } catch {
      throw new ConfigError("Invalid installer lock.");
    }
    if (!Number.isInteger(pid) || pid < 1)
      throw new ConfigError("Invalid installer lock.");
    try {
      process.kill(pid, 0);
      throw new ConfigError("Installer process is still running.");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  }
  const bytes = await bytesAt(paths.journal);
  if (!bytes)
    throw new ConfigError(
      "No recovery journal; inspect any stale lock manually.",
    );
  let j;
  try {
    j = JSON.parse(bytes);
  } catch {
    throw new ConfigError("Invalid recovery journal.");
  }
  if (
    j.schema !== 1 ||
    j.receipt !== paths.receipt ||
    !Array.isArray(j.entries) ||
    j.entries.length > 20000
  )
    throw new ConfigError("Invalid recovery journal.");
  const seen = new Set();
  for (const e of j.entries) {
    if (!allowedPath(e.path, cwd, home, paths.receipt) || seen.has(e.path))
      throw new ConfigError("Unsafe recovery target.");
    seen.add(e.path);
    for (const key of ["before", "after"]) {
      const bytes =
        e[key] === null
          ? null
          : typeof e[key] === "string"
            ? Buffer.from(e[key], "base64")
            : undefined;
      if (
        bytes === undefined ||
        (bytes === null ? null : sha256(bytes)) !== e[`${key}Hash`]
      )
        throw new ConfigError("Corrupt installer recovery backup.");
    }
    const current = await bytesAt(e.path),
      hash = current === null ? null : sha256(current);
    if (hash !== e.beforeHash && hash !== e.afterHash)
      throw new ConfigError(
        "Customer edits conflict with recovery; no rollback performed.",
      );
  }
  if (apply) {
    if (lock) await rm(paths.lock, { force: true });
    const handle = await open(paths.lock, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      for (const e of [...j.entries].reverse()) {
        const current = await bytesAt(e.path),
          hash = current === null ? null : sha256(current);
        if (hash !== e.beforeHash && hash !== e.afterHash)
          throw new ConfigError("Customer edits conflict with recovery.");
        if (e.before === null) {
          if (current !== null) await durableUnlink(e.path);
        } else await atomicWrite(e.path, Buffer.from(e.before, "base64"));
      }
      await durableUnlink(paths.journal);
    } finally {
      await handle.close();
      await rm(paths.lock, { force: true });
    }
  }
  return {
    status: apply ? "recovered" : "preview",
    operations: j.entries.length,
  };
}

export async function agentMain(
  argv,
  {
    cwd = process.cwd(),
    home = homedir(),
    env = process.env,
    out = console.log,
    err = console.error,
    isTTY = process.stdout.isTTY === true,
    packDir = null,
    now = () => new Date().toISOString(),
    afterOperation,
  } = {},
) {
  const args = parseArgs(argv, ["client"]);
  const [command, sub] = args._;
  if (
    command !== "agent" ||
    !["setup", "status", "remove", "recover"].includes(sub) ||
    args._.length !== 2
  )
    throw new ConfigError(USAGE);
  const allowed =
    sub === "setup"
      ? ["_", "client", "scope", "origin", "pack", "dry-run", "json"]
      : ["remove", "recover"].includes(sub)
        ? ["_", "scope", "apply", "json"]
        : ["_", "json"];
  if (Object.keys(args).some((k) => !allowed.includes(k)))
    throw new ConfigError(USAGE);
  const json = args.json === true || !isTTY;
  const scope = args.scope ?? "project";
  if (!["project", "user"].includes(scope))
    throw new ConfigError("--scope is project or user");
  const origin = (
    args.origin ??
    env.AGENTLINKOPS_API_URL ??
    env.LINKTRAIL_API_URL ??
    DEFAULT_ORIGIN
  ).replace(/\/$/u, "");
  if (!/^https:\/\/[^/?#]+$/u.test(origin))
    throw new ConfigError("--origin must be an https origin without a path.");
  const only = args.client ? [].concat(args.client) : null;
  for (const id of only ?? [])
    if (!clientById(id))
      throw new ConfigError(
        `Unknown client ${id}. Clients: ${AGENT_CLIENTS.map((c) => c.id).join(", ")}.`,
      );
  if ([cwd, home].some((p) => p.split(/[\\/]/u).includes("..")))
    throw new ConfigError(
      "Installation roots must not contain parent traversal.",
    );
  cwd = resolve(cwd);
  home = resolve(home);
  await safePath(cwd);
  await safePath(home);
  const paths = locations(cwd, home, scope);
  if (sub === "recover") {
    const report = await recover(paths, {
      cwd,
      home,
      apply: args.apply === true,
    });
    out(JSON.stringify(report, null, 2));
    return 0;
  }
  const receipt = await readReceipt(paths.receipt, cwd, home);
  if (sub === "remove") {
    const operations = [],
      preserved = [];
    for (const [path, digest] of Object.entries(receipt?.files ?? {})) {
      const bytes = await bytesAt(path);
      if (bytes === null) continue;
      if (sha256(bytes) !== digest) {
        preserved.push(path);
        continue;
      }
      operations.push({ path, bytes: null, expected: digest });
    }
    const remainingMcp = { ...(receipt?.mcp ?? {}) };
    const configurations = [];
    for (const [path, record] of Object.entries(remainingMcp)) {
      const planned = await planMcpRemoval(path, record);
      if (planned.preserved) {
        preserved.push(path);
        continue;
      }
      delete remainingMcp[path];
      if (planned.operation) {
        operations.push(planned.operation);
        configurations.push(path);
      }
    }
    const remaining = Object.fromEntries(
      Object.entries(receipt?.files ?? {}).filter(([p]) =>
        preserved.includes(p),
      ),
    );
    if (receipt) {
      const prior = await bytesAt(paths.receipt);
      operations.push({
        path: paths.receipt,
        bytes:
          Object.keys(remaining).length || Object.keys(remainingMcp).length
            ? Buffer.from(
                JSON.stringify(
                  { ...receipt, files: remaining, mcp: remainingMcp },
                  null,
                  2,
                ) + "\n",
              )
            : null,
        expected: sha256(prior),
      });
    }
    if (args.apply === true && operations.length)
      await transaction(paths, operations, { cwd, home, afterOperation });
    out(
      JSON.stringify(
        {
          status: args.apply === true ? "removed" : "preview",
          removed: operations
            .filter((o) => o.path !== paths.receipt && o.bytes === null)
            .map((o) => o.path),
          preserved,
          configurations,
        },
        null,
        2,
      ),
    );
    return preserved.length ? 1 : 0;
  }
  if (sub === "setup" && (await bytesAt(paths.journal)))
    throw new ConfigError(
      "An interrupted installer transaction exists; recover first.",
    );

  if (sub === "status") {
    const clients = await detectClients(home, only);
    const report = { origin, clients: [] };
    for (const client of clients) {
      const mcp = await planMcp(client, { cwd, home, origin, scope });
      report.clients.push({
        id: client.id,
        name: client.name,
        view: `${origin}${client.view}`,
        mcp: {
          file: mcp.file,
          state:
            mcp.action === "unchanged"
              ? "configured"
              : mcp.action === "conflict"
                ? "different"
                : "absent",
        },
      });
    }
    report.receipt = receipt
      ? {
          installedAt: receipt.installedAt,
          files: Object.keys(receipt.files).length,
        }
      : null;
    out(json ? JSON.stringify(report, null, 2) : renderStatus(report));
    return 0;
  }

  const pack = await readPack(await locatePack(args.pack ?? packDir));
  const clients = await detectClients(home, only);
  const report = {
    origin,
    scope,
    dryRun: args["dry-run"] === true,
    clients: [],
    next: [],
  };
  if (!clients.length) {
    report.next.push(
      `No agent client detected. Pass --client with one of ${AGENT_CLIENTS.map((c) => c.id).join(", ")}.`,
    );
    out(json ? JSON.stringify(report, null, 2) : report.next.join("\n"));
    return 2;
  }
  const ownedFiles = { ...(receipt?.files ?? {}) },
    operations = new Map();
  const ownedMcp = { ...(receipt?.mcp ?? {}) },
    desired = new Set(),
    selectedRoots = new Set();
  for (const client of clients) {
    const skills = await planSkills(client, pack, {
      cwd,
      home,
      scope,
      receipt,
    });
    for (const path of skills.desired) desired.add(path);
    for (const path of skills.roots) selectedRoots.add(path);
    const mcp = await planMcp(client, { cwd, home, origin, scope });
    const entry = {
      id: client.id,
      name: client.name,
      view: mcp.url,
      reason: client.reason,
      skills: {
        dir: skills.dir,
        installed: [],
        unchanged: skills.unchanged.length,
        conflicts: skills.conflicts,
      },
      mcp: {
        file: mcp.file,
        action: mcp.action,
        ...(mcp.note ? { note: mcp.note } : {}),
        ...(mcp.snippet ? { snippet: mcp.snippet } : {}),
      },
    };
    for (const item of skills.install) {
      operations.set(item.target, {
        path: item.target,
        bytes: item.bytes,
        expected: item.before,
      });
      ownedFiles[item.target] = item.digest;
      entry.skills.installed.push(item.target);
    }
    if (mcp.action === "write") {
      ownedMcp[mcp.file] = {
        client: client.id,
        format: client.mcp.format,
        url: mcp.url,
      };
      operations.set(mcp.file, {
        path: mcp.file,
        bytes: Buffer.from(mcp.text),
        expected: mcp.beforeHash,
      });
      entry.mcp.action = report.dryRun ? "would write" : "planned";
    }
    if (mcp.action === "printed")
      report.next.push(
        `${client.name}: add the MCP server yourself:\n${mcp.snippet}`,
      );
    if (mcp.action === "conflict")
      report.next.push(`${client.name}: ${mcp.note}`);
    for (const c of skills.conflicts)
      report.next.push(`${client.name}: ${c.target} ${c.note}`);
    report.clients.push(entry);
  }
  report.pruned = [];
  report.preservedObsolete = [];
  let ownershipChanged = false;
  for (const [path, digest] of Object.entries(ownedFiles)) {
    if (
      desired.has(path) ||
      ![...selectedRoots].some((root) => {
        const rel = relative(root, path);
        return rel && !rel.startsWith("..") && !isAbsolute(rel);
      })
    )
      continue;
    const current = await bytesAt(path);
    if (current !== null && sha256(current) !== digest) {
      report.preservedObsolete.push(path);
      continue;
    }
    delete ownedFiles[path];
    ownershipChanged = true;
    if (current !== null) {
      operations.set(path, { path, bytes: null, expected: digest });
      report.pruned.push(path);
    }
  }
  const conflicts = report.clients.some(
    (c) => c.skills.conflicts.length || c.mcp.action === "conflict",
  );
  if (
    !report.dryRun &&
    !conflicts &&
    (operations.size || ownershipChanged || !receipt)
  ) {
    const oldReceipt = await bytesAt(paths.receipt),
      next = Buffer.from(
        JSON.stringify(
          {
            installedAt: now(),
            origin,
            scope,
            clients: report.clients.map((c) => c.id),
            files: ownedFiles,
            mcp: ownedMcp,
          },
          null,
          2,
        ) + "\n",
      );
    operations.set(paths.receipt, {
      path: paths.receipt,
      bytes: next,
      expected: oldReceipt === null ? null : sha256(oldReceipt),
    });
    await transaction(paths, [...operations.values()], {
      cwd,
      home,
      afterOperation,
    });
    for (const c of report.clients)
      if (c.mcp.action === "planned") c.mcp.action = "written";
  }
  if (conflicts) {
    report.pruned = [];
    report.next.push(
      "Conflicts prevented all installation writes. Resolve them and retry.",
    );
    for (const c of report.clients) {
      c.skills.installed = [];
      if (c.mcp.action === "planned") c.mcp.action = "not applied";
    }
  }
  report.next.push(
    "Sign in through each client's MCP OAuth flow; no credential was stored by this command.",
  );
  report.next.push(NUDGE);
  out(json ? JSON.stringify(report, null, 2) : renderSetup(report));
  return report.clients.some(
    (c) => c.skills.conflicts.length || c.mcp.action === "conflict",
  )
    ? 1
    : 0;
}

function renderStatus(report) {
  const lines = [`origin ${report.origin}`];
  for (const c of report.clients)
    lines.push(
      `${c.name.padEnd(12)} ${c.mcp.state.padEnd(11)} ${c.view}  (${c.mcp.file})`,
    );
  lines.push(
    report.receipt
      ? `receipt: ${report.receipt.files} files installed at ${report.receipt.installedAt}`
      : "receipt: none (run agentlinkops agent setup)",
  );
  return lines.join("\n");
}
function renderSetup(report) {
  const lines = [
    `${report.dryRun ? "plan" : "done"}: origin ${report.origin}, scope ${report.scope}`,
  ];
  for (const c of report.clients) {
    lines.push(`${c.name}: view ${c.view}`);
    lines.push(
      `  skills → ${c.skills.dir}: ${c.skills.installed.length} ${report.dryRun ? "to install" : "installed"}, ${c.skills.unchanged} unchanged${c.skills.conflicts.length ? `, ${c.skills.conflicts.length} conflicts` : ""}`,
    );
    lines.push(`  mcp    → ${c.mcp.file}: ${c.mcp.action}`);
  }
  for (const path of report.pruned ?? [])
    lines.push(
      `  obsolete → ${path}: ${report.dryRun ? "would remove" : "removed"}`,
    );
  for (const path of report.preservedObsolete ?? [])
    lines.push(`  obsolete → ${path}: preserved customer edits`);
  for (const n of report.next) lines.push("", n);
  return lines.join("\n");
}
