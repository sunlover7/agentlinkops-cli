import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentMain,
  locatePack,
  readPack,
  detectClients,
  planMcp,
  DEFAULT_ORIGIN,
} from "../cli/agent-setup.js";
import { AGENT_CLIENTS } from "../shared/agent-clients.js";

// DP-0036-T09: one command installs the pack and the right MCP view for every detected client,
// idempotently, without a credential, and never over a file it did not write.

async function fixture(t) {
  // macOS exposes its temporary directory as /var/folders, a symlink to
  // /private/var/folders. The installer correctly refuses symlinked target
  // paths, so give the fixture the canonical path before creating its tree.
  const root = await mkdtemp(join(await realpath(tmpdir()), "agent-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"),
    cwd = join(root, "project"),
    pack = join(root, "pack");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(join(pack, "agentlinkops-connect", "references"), {
    recursive: true,
  });
  await writeFile(join(pack, "agentlinkops-connect", "SKILL.md"), "# agentlinkops-connect\n");
  await writeFile(
    join(pack, "agentlinkops-connect", "references", "agentlinkops.md"),
    "core access reference\n",
  );
  await mkdir(join(pack, "agentlinkops-demo", "references"), {
    recursive: true,
  });
  await writeFile(
    join(pack, "agentlinkops-demo", "SKILL.md"),
    "---\nname: agentlinkops-demo\ndescription: Demo skill for the setup tests.\n---\nDo the demo.\n",
  );
  await writeFile(
    join(pack, "agentlinkops-demo", "references", "notes.md"),
    "reference\n",
  );
  await mkdir(join(pack, "not-a-skill"), { recursive: true });
  return { root, home, cwd, pack };
}
const run = async (argv, o) => {
  const out = [],
    err = [];
  const { minimal = false, ...options } = o;
  if (argv[1] === "setup" && !minimal) argv = [...argv, "--all-skills"];
  const code = await agentMain(argv, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    isTTY: false,
    env: {},
    now: () => "2026-09-16T00:00:00Z",
    ...options,
  });
  return {
    code,
    out: out.join("\n"),
    err: err.join("\n"),
    json: out.length ? JSON.parse(out.join("\n")) : null,
  };
};

test("the pack is read from the skills directory and only directories with a SKILL.md count", async (t) => {
  const { pack } = await fixture(t);
  const skills = await readPack(await locatePack(pack));
  assert.deepEqual(Object.keys(skills), ["agentlinkops-connect", "agentlinkops-demo"]);
  assert.deepEqual(Object.keys(skills["agentlinkops-connect"]).sort(), [
    "SKILL.md",
    "references/agentlinkops.md",
  ]);
  assert.deepEqual(Object.keys(skills["agentlinkops-demo"]).sort(), [
    "SKILL.md",
    "references/notes.md",
  ]);
  await assert.rejects(locatePack(join(pack, "missing")), {
    name: "ConfigError",
  });
});

test("detection reads each client's marker paths and --client forces one", async (t) => {
  const { home } = await fixture(t);
  assert.deepEqual(await detectClients(home), []);
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  assert.deepEqual(
    (await detectClients(home)).map((c) => c.id),
    ["claude-code", "codex"],
  );
  assert.deepEqual(
    (await detectClients(home, ["hermes"])).map((c) => c.id),
    ["hermes"],
  );
});

test("setup installs skills and MCP entries per client, records a receipt, and is idempotent", async (t) => {
  const { home, cwd, pack } = await fixture(t);
  for (const dir of [".claude", ".codex", ".cursor", ".gemini", ".hermes"])
    await mkdir(join(home, dir), { recursive: true });
  await writeFile(join(home, ".codex", "config.toml"), 'model = "gpt-5"\n');
  const first = await run(["agent", "setup"], { cwd, home, packDir: pack });
  assert.equal(first.code, 0, first.err || first.out);
  const r = first.json;
  assert.equal(r.origin, DEFAULT_ORIGIN);
  assert.deepEqual(
    r.clients.map((c) => c.id),
    AGENT_CLIENTS.map((c) => c.id),
  );
  const claude = r.clients.find((c) => c.id === "claude-code");
  assert.equal(claude.view, `${DEFAULT_ORIGIN}/mcp/all`);
  assert.equal(claude.mcp.action, "written");
  assert.deepEqual(JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8")), {
    mcpServers: {
      agentlinkops: { type: "http", url: `${DEFAULT_ORIGIN}/mcp/all` },
    },
  });
  assert.equal(
    await readFile(
      join(cwd, ".claude", "skills", "agentlinkops-demo", "SKILL.md"),
      "utf8",
    ),
    await readFile(join(pack, "agentlinkops-demo", "SKILL.md"), "utf8"),
  );
  assert.ok(
    await stat(
      join(
        cwd,
        ".agents",
        "skills",
        "agentlinkops-demo",
        "references",
        "notes.md",
      ),
    ),
    "codex, cursor and gemini share .agents/skills",
  );
  const codex = r.clients.find((c) => c.id === "codex");
  assert.equal(codex.view, `${DEFAULT_ORIGIN}/mcp`);
  assert.match(
    await readFile(join(home, ".codex", "config.toml"), "utf8"),
    /model = "gpt-5"\n\n\[mcp_servers\.agentlinkops\]\nurl = "https:\/\/app\.agentlinkops\.com\/mcp"\n/,
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(cwd, ".cursor", "mcp.json"), "utf8")),
    { mcpServers: { agentlinkops: { url: `${DEFAULT_ORIGIN}/mcp` } } },
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(cwd, ".gemini", "settings.json"), "utf8")),
    { mcpServers: { agentlinkops: { httpUrl: `${DEFAULT_ORIGIN}/mcp` } } },
  );
  const hermes = r.clients.find((c) => c.id === "hermes");
  assert.equal(hermes.mcp.action, "printed");
  assert.match(
    hermes.mcp.snippet,
    /url: https:\/\/app\.agentlinkops\.com\/mcp\/all/,
  );
  assert.ok(
    await stat(
      join(home, ".hermes", "skills", "agentlinkops-demo", "SKILL.md"),
    ),
  );
  assert.ok(r.next.some((n) => /no credential was stored/.test(n)));
  const receipt = JSON.parse(
    await readFile(join(cwd, ".agentlinkops", "agent-setup.json"), "utf8"),
  );
  assert.equal(receipt.installedAt, "2026-09-16T00:00:00Z");
  assert.equal(
    Object.keys(receipt.files).length,
    12,
    "four files each under .claude/skills, the shared .agents/skills and ~/.hermes/skills",
  );

  const again = await run(["agent", "setup"], { cwd, home, packDir: pack });
  assert.equal(again.code, 0);
  for (const c of again.json.clients) {
    assert.equal(c.skills.installed.length, 0, c.id);
    assert.ok(
      ["unchanged", "printed"].includes(c.mcp.action),
      `${c.id} ${c.mcp.action}`,
    );
  }
  const status = await run(["agent", "status"], { cwd, home });
  assert.equal(
    status.json.clients.find((c) => c.id === "cursor").mcp.state,
    "configured",
  );
});

test("setup never overwrites a foreign file, reports conflicts, and --dry-run writes nothing", async (t) => {
  const { home, cwd, pack } = await fixture(t);
  await mkdir(join(home, ".cursor"), { recursive: true });
  await mkdir(join(cwd, ".cursor"), { recursive: true });
  await writeFile(
    join(cwd, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        other: { url: "https://other.example/mcp" },
        agentlinkops: { url: "https://elsewhere.example/mcp" },
      },
    }),
  );
  await mkdir(join(cwd, ".agents", "skills", "agentlinkops-demo"), {
    recursive: true,
  });
  await writeFile(
    join(cwd, ".agents", "skills", "agentlinkops-demo", "SKILL.md"),
    "customer edited this\n",
  );
  const dry = await run(["agent", "setup", "--dry-run"], {
    cwd,
    home,
    packDir: pack,
  });
  assert.equal(dry.json.dryRun, true);
  assert.equal(
    await stat(join(cwd, ".agentlinkops")).catch(() => null),
    null,
    "dry run writes no receipt",
  );
  const real = await run(["agent", "setup"], { cwd, home, packDir: pack });
  assert.equal(real.code, 1, "conflicts exit 1");
  const cursor = real.json.clients.find((c) => c.id === "cursor");
  assert.equal(cursor.mcp.action, "conflict");
  assert.equal(cursor.skills.conflicts.length, 1);
  assert.equal(
    await readFile(
      join(cwd, ".agents", "skills", "agentlinkops-demo", "SKILL.md"),
      "utf8",
    ),
    "customer edited this\n",
    "the customer's file is untouched",
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(cwd, ".cursor", "mcp.json"), "utf8"))
      .mcpServers.other,
    { url: "https://other.example/mcp" },
  );
  assert.ok(real.json.next.some((n) => /edit it by hand/.test(n)));
});

test("a file this command installed is refreshed when the pack changes, and the user scope prints the Claude Code command instead of editing ~/.claude.json", async (t) => {
  const { home, cwd, pack } = await fixture(t);
  await mkdir(join(home, ".claude"), { recursive: true });
  await run(["agent", "setup", "--client", "claude-code"], {
    cwd,
    home,
    packDir: pack,
  });
  await writeFile(
    join(pack, "agentlinkops-demo", "SKILL.md"),
    "---\nname: agentlinkops-demo\ndescription: Demo skill, revised.\n---\nDo the new demo.\n",
  );
  const refreshed = await run(["agent", "setup", "--client", "claude-code"], {
    cwd,
    home,
    packDir: pack,
  });
  assert.equal(refreshed.code, 0);
  assert.equal(
    refreshed.json.clients[0].skills.installed.length,
    1,
    "our own file is replaced",
  );
  assert.match(
    await readFile(
      join(cwd, ".claude", "skills", "agentlinkops-demo", "SKILL.md"),
      "utf8",
    ),
    /revised/,
  );
  const user = await run(
    [
      "agent",
      "setup",
      "--client",
      "claude-code",
      "--scope",
      "user",
      "--origin",
      "https://staging.example",
    ],
    { cwd, home, packDir: pack },
  );
  assert.equal(user.json.clients[0].mcp.action, "printed");
  assert.match(
    user.json.clients[0].mcp.snippet,
    /claude mcp add --transport http --scope user agentlinkops https:\/\/staging\.example\/mcp\/all/,
  );
  assert.ok(
    await stat(
      join(home, ".claude", "skills", "agentlinkops-demo", "SKILL.md"),
    ),
  );
  assert.equal(
    await stat(join(home, ".claude.json")).catch(() => null),
    null,
    "never edits ~/.claude.json",
  );
});

test("usage and argument errors are rejected before anything is read or written", async (t) => {
  const { home, cwd, pack } = await fixture(t);
  for (const argv of [
    ["agent"],
    ["agent", "install"],
    ["agent", "setup", "--scope", "global"],
    ["agent", "setup", "--client", "nope"],
    ["agent", "setup", "--origin", "http://insecure.example"],
    ["agent", "status", "--client", "x"],
  ])
    await assert.rejects(
      run(argv, { cwd, home, packDir: pack }),
      { name: "ConfigError" },
      argv.join(" "),
    );
  const none = await run(["agent", "setup"], { cwd, home, packDir: pack });
  assert.equal(none.code, 2);
  assert.match(none.json.next[0], /No agent client detected/);
  const plan = await planMcp(
    AGENT_CLIENTS.find((c) => c.id === "codex"),
    { cwd, home, origin: "https://o.example", scope: "project" },
  );
  assert.equal(
    plan.file,
    join(home, ".codex", "config.toml"),
    "codex config is always user-level",
  );
});

test("edited owned files block the entire upgrade, including MCP changes and new files", async (t) => {
  const f = await fixture(t);
  await run(["agent", "setup", "--client", "claude-code"], {
    ...f,
    packDir: f.pack,
  });
  const target = join(f.cwd, ".claude/skills/agentlinkops-demo/SKILL.md"),
    receipt = join(f.cwd, ".agentlinkops/agent-setup.json");
  await writeFile(target, "customer edits");
  const before = await readFile(receipt, "utf8");
  await writeFile(
    join(f.pack, "agentlinkops-demo", "new.txt"),
    "new publisher file",
  );
  const result = await run(["agent", "setup", "--client", "claude-code"], {
    ...f,
    packDir: f.pack,
  });
  assert.equal(result.code, 1);
  assert.equal(await readFile(target, "utf8"), "customer edits");
  assert.equal(await readFile(receipt, "utf8"), before);
  assert.equal(
    await stat(join(f.cwd, ".claude/skills/agentlinkops-demo/new.txt")).catch(
      () => null,
    ),
    null,
  );
});

test("package sibling scripts, references and templates resolve from installed skills and edited shared files are protected", async (t) => {
  const f = await fixture(t);
  for (const dir of ["scripts", "references", "templates"])
    await mkdir(join(f.root, dir));
  await writeFile(join(f.root, "scripts", "helper.py"), 'print("ready")\n');
  await writeFile(join(f.root, "references", "guide.md"), "retained guide");
  await writeFile(join(f.root, "templates", "draft.json"), "{}");
  // An unpaired sentinel cannot be recreated as OS metadata for a copied file.
  await writeFile(join(f.root, "scripts", "._metadata-sentinel"), "metadata");
  const result = await run(["agent", "setup", "--client", "codex"], {
    ...f,
    packDir: f.pack,
  });
  assert.equal(result.code, 0);
  const base = join(f.cwd, ".agents/skills/agentlinkops-demo");
  assert.equal(
    await readFile(join(base, "../../references/guide.md"), "utf8"),
    "retained guide",
  );
  assert.equal(
    await stat(join(base, "../../scripts/._metadata-sentinel")).catch(() => null),
    null,
  );
  await writeFile(join(base, "../../references/guide.md"), "customer guide");
  await writeFile(join(f.root, "references", "guide.md"), "new guide");
  assert.equal(
    (
      await run(["agent", "setup", "--client", "codex"], {
        ...f,
        packDir: f.pack,
      })
    ).code,
    1,
  );
  assert.equal(
    await readFile(join(base, "../../references/guide.md"), "utf8"),
    "customer guide",
  );
});

test("interrupted apply leaves a durable journal; recovery previews, preserves edits and restores previous bytes", async (t) => {
  const f = await fixture(t);
  await run(["agent", "setup", "--client", "claude-code"], {
    ...f,
    packDir: f.pack,
  });
  const target = join(f.cwd, ".claude/skills/agentlinkops-demo/SKILL.md"),
    old = await readFile(target, "utf8");
  await writeFile(
    join(f.pack, "agentlinkops-demo/SKILL.md"),
    "publisher upgrade",
  );
  await assert.rejects(
    run(["agent", "setup", "--client", "claude-code"], {
      ...f,
      packDir: f.pack,
      afterOperation: () => {
        throw Error("interrupted");
      },
    }),
    /interrupted/,
  );
  assert.equal(await readFile(target, "utf8"), "publisher upgrade");
  await assert.rejects(
    run(["agent", "setup", "--client", "claude-code"], {
      ...f,
      packDir: f.pack,
    }),
    /recover first/,
  );
  assert.equal((await run(["agent", "recover"], f)).json.status, "preview");
  assert.equal(await readFile(target, "utf8"), "publisher upgrade");
  await writeFile(target, "concurrent customer edit");
  await assert.rejects(
    run(["agent", "recover", "--apply"], f),
    /Customer edits conflict/,
  );
  assert.equal(await readFile(target, "utf8"), "concurrent customer edit");
  await writeFile(target, "publisher upgrade");
  assert.equal(
    (await run(["agent", "recover", "--apply"], f)).json.status,
    "recovered",
  );
  assert.equal(await readFile(target, "utf8"), old);
});

test("removal previews then removes only unchanged owned payloads and removes its own config section while preserving customer records and edits", async (t) => {
  const f = await fixture(t);
  await run(["agent", "setup", "--client", "claude-code"], {
    ...f,
    packDir: f.pack,
  });
  const target = join(f.cwd, ".claude/skills/agentlinkops-demo/SKILL.md");
  await writeFile(target, "customer skill");
  await writeFile(join(f.cwd, ".agentlinkops/links.jsonl"), "customer ledger");
  const config = await readFile(join(f.cwd, ".mcp.json"), "utf8");
  const preview = await run(["agent", "remove"], f);
  assert.equal(preview.json.status, "preview");
  assert.ok(
    await stat(
      join(f.cwd, ".claude/skills/agentlinkops-demo/references/notes.md"),
    ),
  );
  const removed = await run(["agent", "remove", "--apply"], f);
  assert.equal(removed.code, 1);
  assert.equal(removed.json.preserved.length, 1);
  assert.equal(await readFile(target, "utf8"), "customer skill");
  assert.equal(
    await readFile(join(f.cwd, ".agentlinkops/links.jsonl"), "utf8"),
    "customer ledger",
  );
  assert.equal(
    preview.json.configurations.includes(join(f.cwd, ".mcp.json")),
    true,
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(f.cwd, ".mcp.json"), "utf8")),
    { mcpServers: {} },
  );
  assert.equal(
    await stat(
      join(f.cwd, ".claude/skills/agentlinkops-demo/references/notes.md"),
    ).catch(() => null),
    null,
  );
});

test("source and destination symlinks, corrupt receipts and traversal are refused before writes", async (t) => {
  const f = await fixture(t);
  await symlink(join(f.root, "elsewhere"), join(f.pack, "unsafe"));
  await assert.rejects(
    run(["agent", "setup", "--client", "claude-code"], {
      ...f,
      packDir: f.pack,
    }),
    /symlink/i,
  );
  await rm(join(f.pack, "unsafe"));
  await mkdir(join(f.root, "outside"));
  await symlink(join(f.root, "outside"), join(f.cwd, ".claude"));
  await assert.rejects(
    run(["agent", "setup", "--client", "claude-code"], {
      ...f,
      packDir: f.pack,
    }),
    /Symlink/,
  );
  assert.deepEqual(
    await import("node:fs/promises").then((fs) =>
      fs.readdir(join(f.root, "outside")),
    ),
    [],
  );
  await rm(join(f.cwd, ".claude"));
  await mkdir(join(f.cwd, ".agentlinkops"));
  await writeFile(join(f.cwd, ".agentlinkops/agent-setup.json"), "{broken");
  await assert.rejects(
    run(["agent", "setup", "--client", "claude-code"], {
      ...f,
      packDir: f.pack,
    }),
    /invalid JSON/,
  );
  await assert.rejects(
    run(["agent", "setup", "--client", "claude-code"], {
      ...f,
      cwd: f.cwd + "/../project",
      packDir: f.pack,
    }),
    /parent traversal/,
  );
});

test("user scope owns one stable home receipt across projects and writes relative client config under home", async (t) => {
  const f = await fixture(t);
  await run(["agent", "setup", "--client", "cursor", "--scope", "user"], {
    ...f,
    packDir: f.pack,
  });
  assert.ok(await stat(join(f.home, ".cursor/mcp.json")));
  assert.ok(await stat(join(f.home, ".agentlinkops/agent-setup-user.json")));
  assert.equal(
    await stat(join(f.cwd, ".agentlinkops/agent-setup.json")).catch(() => null),
    null,
  );
  const second = join(f.root, "other-project");
  await mkdir(second);
  await writeFile(join(f.pack, "agentlinkops-demo/SKILL.md"), "next version");
  assert.equal(
    (
      await run(["agent", "setup", "--client", "cursor", "--scope", "user"], {
        ...f,
        cwd: second,
        packDir: f.pack,
      })
    ).code,
    0,
  );
  assert.equal(
    await readFile(
      join(f.home, ".agents/skills/agentlinkops-demo/SKILL.md"),
      "utf8",
    ),
    "next version",
  );
});

test("actual five-skill installation resolves package references and runs the relocated CRM helper without a ledger", async (t) => {
  const f = await fixture(t),
    packDir = new URL("../skills", import.meta.url)
      .pathname;
  const result = await run(["agent", "setup", "--client", "claude-code"], {
    ...f,
    packDir,
  });
  assert.equal(result.code, 0);
  const fs = await import("node:fs/promises"),
    { execFile } = await import("node:child_process"),
    { promisify } = await import("node:util");
  const base = join(f.cwd, ".claude"),
    dirs = (await fs.readdir(join(base, "skills"))).filter((name) =>
      name.startsWith("agentlinkops-"),
    );
  assert.equal(dirs.length, 5);
  assert.equal(dirs.includes("agentlinkops-setup"), false);
  for (const name of dirs) {
    const path = join(base, "skills", name, "SKILL.md"),
      text = await readFile(path, "utf8");
    for (const [, link] of text.matchAll(/\]\(([^)]+)\)/gu)) {
      if (/^(?:https?:|#)/u.test(link)) continue;
      assert.ok(
        await stat(join(path, "..", link.split("#")[0])),
        `${name}: ${link}`,
      );
    }
  }
  const execution = await promisify(execFile)(
    "python3",
    ["-B", join(base, "scripts/agentlinkops.py"), "templates"],
    { cwd: f.cwd, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  assert.ok(JSON.parse(execution.stdout).campaigns);
  assert.equal(
    await stat(join(f.cwd, ".agentlinkops/links.jsonl")).catch(() => null),
    null,
  );
  const receiptPath = join(f.cwd, ".agentlinkops/agent-setup.json");
  const receiptBefore = await readFile(receiptPath, "utf8");
  assert.equal(
    (
      await run(["agent", "setup", "--client", "claude-code"], {
        ...f,
        packDir,
      })
    ).code,
    0,
  );
  assert.equal(await readFile(receiptPath, "utf8"), receiptBefore);
  const ledger = join(f.cwd, ".agentlinkops/links.jsonl");
  await writeFile(ledger, "customer records remain readable\n");
  assert.equal((await run(["agent", "remove", "--apply"], f)).code, 0);
  assert.equal(
    await readFile(ledger, "utf8"),
    "customer records remain readable\n",
  );
  assert.equal(
    await stat(join(base, "scripts/agentlinkops.py")).catch(() => null),
    null,
  );
  assert.equal(await stat(receiptPath).catch(() => null), null);
  assert.deepEqual(
    JSON.parse(await readFile(join(f.cwd, ".mcp.json"))).mcpServers,
    {},
  );
});

test("actual process death is recoverable; corrupt backups and forged config ownership are refused", async (t) => {
  const f = await fixture(t),
    { execFile } = await import("node:child_process"),
    { promisify } = await import("node:util"),
    execute = promisify(execFile);
  const code = `import {agentMain} from ${JSON.stringify(new URL("../cli/agent-setup.js", import.meta.url).href)};await agentMain(['agent','setup','--client','claude-code','--all-skills'],{cwd:${JSON.stringify(f.cwd)},home:${JSON.stringify(f.home)},packDir:${JSON.stringify(f.pack)},out:()=>{},afterOperation:()=>process.kill(process.pid,'SIGKILL')});`;
  await assert.rejects(
    execute(process.execPath, ["--input-type=module", "-e", code]),
    (e) => e.signal === "SIGKILL",
  );
  const journal = join(f.cwd, ".agentlinkops/agent-setup-project.journal.json"),
    saved = await readFile(journal, "utf8"),
    modified = JSON.parse(saved);
  modified.entries[0].after = "corrupt";
  await writeFile(journal, JSON.stringify(modified));
  await assert.rejects(run(["agent", "recover", "--apply"], f), /Corrupt/);
  await writeFile(journal, saved);
  assert.equal(
    (await run(["agent", "recover", "--apply"], f)).json.status,
    "recovered",
  );
  assert.equal(
    await stat(join(f.cwd, ".claude/skills/agentlinkops-connect/SKILL.md")).catch(() => null),
    null,
    "the first core payload written before process death is rolled back",
  );
  assert.equal(
    await stat(join(f.cwd, ".claude/skills/agentlinkops-demo/SKILL.md")).catch(
      () => null,
    ),
    null,
  );
  await writeFile(
    join(f.cwd, ".agentlinkops/agent-setup.json"),
    JSON.stringify({ files: { [join(f.cwd, ".mcp.json")]: "a".repeat(64) } }),
  );
  await assert.rejects(
    run(["agent", "remove", "--apply"], f),
    /ownership receipt is invalid/,
  );
});

test("concurrent configuration edits invalidate the preflight without installing any payload", async (t) => {
  const f = await fixture(t),
    { writeFileSync } = await import("node:fs");
  await assert.rejects(
    run(["agent", "setup", "--client", "claude-code"], {
      ...f,
      packDir: f.pack,
      now: () => {
        writeFileSync(
          join(f.cwd, ".mcp.json"),
          '{"customer":"changed after planning"}',
        );
        return "2026-09-20T00:00:00Z";
      },
    }),
    /changed after planning/,
  );
  assert.equal(
    await readFile(join(f.cwd, ".mcp.json"), "utf8"),
    '{"customer":"changed after planning"}',
  );
  assert.equal(
    await stat(join(f.cwd, ".claude/skills/agentlinkops-connect/SKILL.md")).catch(() => null),
    null,
    "preflight also prevents the first core payload from being installed",
  );
  assert.equal(
    await stat(join(f.cwd, ".claude/skills/agentlinkops-demo/SKILL.md")).catch(
      () => null,
    ),
    null,
  );
});

test("upgrade prunes obsolete owned files only in selected client roots; edited obsolete files survive", async (t) => {
  const f = await fixture(t);
  const args = [
    "agent",
    "setup",
    "--client",
    "claude-code",
    "--client",
    "cursor",
  ];
  await writeFile(
    join(f.pack, "agentlinkops-demo", "old.md"),
    "old shipped file",
  );
  await run(args, { ...f, packDir: f.pack });
  const oldClaude = join(f.cwd, ".claude/skills/agentlinkops-demo/old.md");
  const oldCursor = join(f.cwd, ".agents/skills/agentlinkops-demo/old.md");
  const edited = join(
    f.cwd,
    ".claude/skills/agentlinkops-demo/references/notes.md",
  );
  await writeFile(edited, "customer changes");
  await rm(join(f.pack, "agentlinkops-demo", "old.md"));
  await rm(join(f.pack, "agentlinkops-demo", "references", "notes.md"));
  const one = ["agent", "setup", "--client", "claude-code"];
  const preview = await run([...one, "--dry-run"], { ...f, packDir: f.pack });
  assert.deepEqual(preview.json.pruned, [oldClaude]);
  assert.deepEqual(preview.json.preservedObsolete, [edited]);
  assert.equal(await readFile(oldClaude, "utf8"), "old shipped file");
  const result = await run(one, { ...f, packDir: f.pack });
  assert.equal(result.code, 0);
  assert.equal(await stat(oldClaude).catch(() => null), null);
  assert.equal(await readFile(oldCursor, "utf8"), "old shipped file");
  assert.equal(await readFile(edited, "utf8"), "customer changes");
  const receipt = JSON.parse(
    await readFile(join(f.cwd, ".agentlinkops/agent-setup.json")),
  );
  assert.equal(receipt.files[oldClaude], undefined);
  assert.ok(receipt.files[oldCursor]);
  assert.ok(receipt.files[edited]);
});

test("JSON MCP removal owns only its created section and retains unrelated later config edits", async (t) => {
  const f = await fixture(t),
    file = join(f.cwd, ".mcp.json");
  await writeFile(
    file,
    JSON.stringify({
      theme: "dark",
      mcpServers: { other: { command: "local" } },
    }),
  );
  await run(["agent", "setup", "--client", "claude-code"], {
    ...f,
    packDir: f.pack,
  });
  const config = JSON.parse(await readFile(file));
  config.preferences = { custom: true };
  // Reordered equivalent section remains owned.
  config.mcpServers.agentlinkops = {
    url: config.mcpServers.agentlinkops.url,
    type: "http",
  };
  await writeFile(file, JSON.stringify(config));
  assert.equal((await run(["agent", "remove", "--apply"], f)).code, 0);
  assert.deepEqual(JSON.parse(await readFile(file)), {
    theme: "dark",
    preferences: { custom: true },
    mcpServers: { other: { command: "local" } },
  });
  assert.equal(
    await stat(join(f.cwd, ".agentlinkops/agent-setup.json")).catch(() => null),
    null,
  );
});

test("pre-existing matching and edited MCP sections are never removed", async (t) => {
  for (const preexisting of [true, false]) {
    const f = await fixture(t),
      file = join(f.cwd, ".mcp.json");
    if (preexisting)
      await writeFile(
        file,
        JSON.stringify({
          mcpServers: {
            agentlinkops: { type: "http", url: `${DEFAULT_ORIGIN}/mcp/all` },
          },
        }),
      );
    await run(["agent", "setup", "--client", "claude-code"], {
      ...f,
      packDir: f.pack,
    });
    if (!preexisting) {
      const c = JSON.parse(await readFile(file));
      c.mcpServers.agentlinkops.headers = { local: "customer" };
      await writeFile(file, JSON.stringify(c));
    }
    const before = await readFile(file, "utf8");
    const result = await run(["agent", "remove", "--apply"], f);
    assert.equal(result.code, preexisting ? 0 : 1);
    assert.equal(await readFile(file, "utf8"), before);
    if (!preexisting) assert.deepEqual(result.json.preserved, [file]);
  }
});

test("TOML removal retains unrelated tables and preserves modified or ambiguous owned sections", async (t) => {
  for (const extra of ["unrelated", "comment", "nested", "multiline"]) {
    const f = await fixture(t),
      file = join(f.home, ".codex/config.toml");
    await mkdir(join(f.home, ".codex"));
    await writeFile(file, 'model = "existing"\n');
    await run(["agent", "setup", "--client", "codex"], {
      ...f,
      packDir: f.pack,
    });
    const original = await readFile(file, "utf8");
    const suffix =
      extra === "unrelated"
        ? '\n[mcp_servers.other]\nurl = "https://other.example"\n'
        : extra === "comment"
          ? "# customer comment\n"
          : extra === "nested"
            ? '[mcp_servers.agentlinkops.headers]\nname = "custom"\n'
            : '\n[custom]\ntext = """\nanything\n"""\n';
    await writeFile(file, original + suffix);
    const result = await run(["agent", "remove", "--apply"], f);
    assert.equal(result.code, extra === "unrelated" ? 0 : 1);
    const after = await readFile(file, "utf8");
    if (extra === "unrelated") {
      assert.ok(after.includes('model = "existing"'));
      assert.ok(after.endsWith(suffix.trimStart()));
      assert.ok(!after.includes("[mcp_servers.agentlinkops]"));
    } else assert.equal(after, original + suffix);
  }
});

test("journal recovers pruned payloads and MCP removal with original exact bytes", async (t) => {
  for (const action of ["prune", "remove"]) {
    const f = await fixture(t);
    const args = ["agent", "setup", "--client", "claude-code"];
    await run(args, { ...f, packDir: f.pack });
    const file = join(
      f.cwd,
      ".claude/skills/agentlinkops-demo/references/notes.md",
    );
    const config = join(f.cwd, ".mcp.json");
    const receipt = join(f.cwd, ".agentlinkops/agent-setup.json");
    const core = join(f.cwd, ".claude/skills/agentlinkops-connect/SKILL.md");
    const before = await Promise.all(
      [file, core, config, receipt].map((p) => readFile(p, "utf8")),
    );
    if (action === "prune")
      await rm(join(f.pack, "agentlinkops-demo/references/notes.md"));
    await assert.rejects(
      run(action === "prune" ? args : ["agent", "remove", "--apply"], {
        ...f,
        packDir: f.pack,
        afterOperation: async () => {
          if (
            action === "prune" ||
            !(await readFile(config, "utf8")).includes("agentlinkops")
          )
            throw new Error("interrupted");
        },
      }),
      /interrupted/,
    );
    assert.equal((await run(["agent", "recover", "--apply"], f)).code, 0);
    assert.deepEqual(
      await Promise.all(
        [file, core, config, receipt].map((p) => readFile(p, "utf8")),
      ),
      before,
    );
  }
});

test("legacy receipts never adopt MCP sections and malformed config is preserved", async (t) => {
  for (const legacy of [true, false]) {
    const f = await fixture(t),
      file = join(f.cwd, ".mcp.json");
    await run(["agent", "setup", "--client", "claude-code"], {
      ...f,
      packDir: f.pack,
    });
    if (legacy) {
      const path = join(f.cwd, ".agentlinkops/agent-setup.json");
      const receipt = JSON.parse(await readFile(path));
      delete receipt.mcp;
      await writeFile(path, JSON.stringify(receipt));
    } else await writeFile(file, "{customer editing in progress");
    const before = await readFile(file, "utf8");
    assert.equal(
      (await run(["agent", "remove", "--apply"], f)).code,
      legacy ? 0 : 1,
    );
    assert.equal(await readFile(file, "utf8"), before);
  }
});

test("real process kill after MCP removal restores config and deleted payloads", async (t) => {
  const f = await fixture(t);
  await run(["agent", "setup", "--client", "claude-code"], {
    ...f,
    packDir: f.pack,
  });
  const config = join(f.cwd, ".mcp.json");
  const payload = join(f.cwd, ".claude/skills/agentlinkops-demo/SKILL.md");
  const core = join(f.cwd, ".claude/skills/agentlinkops-connect/SKILL.md");
  const before = await Promise.all(
    [config, core, payload].map((p) => readFile(p, "utf8")),
  );
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const code = `import {agentMain} from ${JSON.stringify(new URL("../cli/agent-setup.js", import.meta.url).href)};import{readFile}from'node:fs/promises';await agentMain(['agent','remove','--apply'],{cwd:${JSON.stringify(f.cwd)},home:${JSON.stringify(f.home)},out:()=>{},afterOperation:async()=>{if(!(await readFile(${JSON.stringify(config)},'utf8')).includes('agentlinkops'))process.kill(process.pid,'SIGKILL')}});`;
  await assert.rejects(
    promisify(execFile)(process.execPath, ["--input-type=module", "-e", code]),
    (e) => e.signal === "SIGKILL",
  );
  assert.equal((await run(["agent", "recover", "--apply"], f)).code, 0);
  assert.deepEqual(
    await Promise.all([config, core, payload].map((p) => readFile(p, "utf8"))),
    before,
  );
});

test("JSON section removal preserves exact foreign numeric values and formatting", async (t) => {
  for (const position of ["first", "middle", "last"]) {
    const f = await fixture(t),
      file = join(f.cwd, ".mcp.json");
    await run(["agent", "setup", "--client", "claude-code"], {
      ...f,
      packDir: f.pack,
    });
    const entry =
      '"agentlinkops": { "url": "https://app.agentlinkops.com/mcp/all", "type": "http" }';
    const foreign =
      '"other":{"large":900719925474099312345,"array":["{", {"x":true}]},"same":1,"same":2';
    const servers =
      position === "first"
        ? `${entry},${foreign}`
        : position === "middle"
          ? `"before":{},${entry},${foreign}`
          : `${foreign},${entry}`;
    const before = `{ "mcpServers": {${servers}}, "huge": 123456789012345678901234 }\n`;
    await writeFile(file, before);
    assert.equal((await run(["agent", "remove", "--apply"], f)).code, 0);
    assert.equal(
      await readFile(file, "utf8"),
      before.replace(position === "last" ? `,${entry}` : `${entry},`, ""),
    );
  }
});

// DP-0006-T24: default core setup and additive, explicitly selected recipes.
async function minimalFixture(t) {
  const f = await fixture(t);
  for (const id of ['agentlinkops-campaigns', 'agentlinkops-assets']) {
    await mkdir(join(f.pack, id));
    await writeFile(join(f.pack, id, 'SKILL.md'), `# ${id}\n`);
  }
  await mkdir(join(f.root, 'references', 'recipes'), { recursive: true });
  await mkdir(join(f.root, 'scripts'));
  await writeFile(join(f.root, 'scripts', 'crm.py'), '# optional support\n');
  const recipes = [
    { id: 'campaign', path: 'campaign.md', version: '1.0.6', skill: 'agentlinkops-campaigns' },
    { id: 'asset', path: 'asset.md', version: '1.0.0', skill: 'agentlinkops-assets' },
  ];
  await writeFile(join(f.root, 'references', 'recipes', 'catalog.json'), JSON.stringify({ schemaVersion: 1, recipes }));
  await writeFile(join(f.root, 'references', 'recipes', 'command-notes.md'), '# Recipe command notes\n');
  for (const row of recipes) await writeFile(join(f.root, 'references', 'recipes', row.path), `# ${row.id} ${row.version}\n`);
  await writeFile(join(f.cwd, 'AGENTS.md'), 'customer editorial policy\n');
  await writeFile(join(f.cwd, 'ledger.json'), '{"customer":"records"}\n');
  return { ...f, packDir: f.pack, minimal: true };
}
const absent = async (path) => assert.equal(await stat(path).catch(() => null), null);
const receiptAt = (f) => join(f.cwd, '.agentlinkops', 'agent-setup.json');

async function installerOwnedSnapshot(f) {
  const receipt = JSON.parse(await readFile(receiptAt(f), 'utf8'));
  const paths = new Set([
    receiptAt(f), ...Object.keys(receipt.files), ...Object.keys(receipt.mcp ?? {}),
    join(f.cwd, 'AGENTS.md'), join(f.cwd, 'ledger.json'),
  ]);
  return Object.fromEntries(await Promise.all([...paths].map(async path => [path, await readFile(path, 'utf8')])));
}

test('core-only setup installs connection/reference without optional payloads or customer-policy changes', async (t) => {
  const f = await minimalFixture(t);
  const result = await run(['agent', 'setup', '--client', 'claude-code'], f);
  assert.equal(result.code, 0);
  assert.deepEqual(result.json.selection, { mode: 'selected', skills: ['agentlinkops-connect'], recipes: [] });
  assert.equal(await readFile(join(f.cwd, '.claude/skills/agentlinkops-connect/references/agentlinkops.md'), 'utf8'), 'core access reference\n');
  for (const path of ['.claude/skills/agentlinkops-campaigns', '.claude/skills/agentlinkops-assets', '.claude/scripts', '.claude/references']) await absent(join(f.cwd, path));
  assert.equal(await readFile(join(f.cwd, 'AGENTS.md'), 'utf8'), 'customer editorial policy\n');
  assert.equal(await readFile(join(f.cwd, 'ledger.json'), 'utf8'), '{"customer":"records"}\n');
  assert.equal(JSON.parse(await readFile(receiptAt(f))).files[join(f.cwd, 'AGENTS.md')], undefined);
});

test('selected recipe installs its versioned body and associated skill; removal retains core, other recipe and MCP', async (t) => {
  const f = await minimalFixture(t);
  const result = await run(['agent', 'setup', '--client', 'claude-code', '--recipe', 'campaign', '--recipe', 'asset'], f);
  assert.equal(result.code, 0);
  assert.deepEqual(result.json.selection.recipes.map(({ id, version }) => ({ id, version })), [{ id: 'campaign', version: '1.0.6' }, { id: 'asset', version: '1.0.0' }]);
  const campaign = join(f.cwd, '.claude/references/recipes/campaign.md');
  const beforeMcp = await readFile(join(f.cwd, '.mcp.json'), 'utf8');
  const preview = await run(['agent', 'remove', '--recipe', 'campaign'], f);
  assert.deepEqual(preview.json.removed, [campaign]);
  assert.equal(await readFile(campaign, 'utf8'), '# campaign 1.0.6\n');
  const removed = await run(['agent', 'remove', '--recipe', 'campaign', '--apply'], f);
  assert.equal(removed.code, 0);
  await absent(campaign);
  assert.equal(await readFile(join(f.cwd, '.mcp.json'), 'utf8'), beforeMcp);
  for (const path of ['.claude/skills/agentlinkops-connect/SKILL.md', '.claude/skills/agentlinkops-campaigns/SKILL.md', '.claude/references/recipes/asset.md', '.claude/scripts/crm.py']) assert.ok(await stat(join(f.cwd, path)));
});

test('a single selected recipe does not install unrelated recipe bodies', async (t) => {
  const f = await minimalFixture(t);
  await run(['agent', 'setup', '--client', 'codex', '--recipe', 'campaign'], f);
  await absent(join(f.cwd, '.agents/references/recipes/asset.md'));
  await absent(join(f.cwd, '.agents/skills/agentlinkops-assets'));
  assert.equal(await readFile(join(f.cwd, '.agents/references/recipes/campaign.md'), 'utf8'), '# campaign 1.0.6\n');
});

test('skill-alone removal refuses retained recipe dependencies after a core-only upgrade; explicit joint removal preserves other payloads', async (t) => {
  const f = await minimalFixture(t);
  await run(['agent', 'setup', '--client', 'claude-code', '--recipe', 'campaign', '--recipe', 'asset'], f);
  await writeFile(join(f.pack, 'agentlinkops-connect', 'SKILL.md'), '---\nname: agentlinkops-connect\ndescription: Upgraded synthetic connection guidance.\n---\n# Connect to AgentLinkOps\n');
  const upgraded = await run(['agent', 'setup', '--client', 'claude-code'], f);
  assert.equal(upgraded.code, 0, upgraded.err || upgraded.out);
  assert.deepEqual(JSON.parse(await readFile(receiptAt(f), 'utf8')).lastSetupSelection.recipes, []);
  const before = await installerOwnedSnapshot(f);
  for (const apply of [[], ['--apply']]) {
    await assert.rejects(
      run(['agent', 'remove', '--skill', 'agentlinkops-campaigns', ...apply], f),
      error => error.name === 'ConfigError' &&
        /recipe campaign \(requires skill agentlinkops-campaigns/u.test(error.message) &&
        /--recipe campaign with --skill agentlinkops-campaigns/u.test(error.message),
    );
    assert.deepEqual(await installerOwnedSnapshot(f), before);
    await absent(join(f.cwd, '.agentlinkops', 'agent-setup-project.journal.json'));
    await absent(join(f.cwd, '.agentlinkops', 'agent-setup-project.lock'));
  }
  const removed = await run(['agent', 'remove', '--recipe', 'campaign', '--skill', 'agentlinkops-campaigns', '--apply'], f);
  assert.equal(removed.code, 0, removed.err || removed.out);
  await absent(join(f.cwd, '.claude', 'references', 'recipes', 'campaign.md'));
  await absent(join(f.cwd, '.claude', 'skills', 'agentlinkops-campaigns', 'SKILL.md'));
  for (const path of [
    '.claude/references/recipes/asset.md', '.claude/skills/agentlinkops-assets/SKILL.md',
    '.claude/skills/agentlinkops-connect/SKILL.md', '.mcp.json', 'AGENTS.md', 'ledger.json',
  ]) assert.equal(await readFile(join(f.cwd, path), 'utf8'), before[join(f.cwd, path)]);
});

test('core-alone removal refuses retained MCP ownership and optional dependents without consulting the current package', async (t) => {
  for (const optional of [false, true]) {
    const f = await minimalFixture(t);
    await run(['agent', 'setup', '--client', 'claude-code', ...(optional ? ['--recipe', 'campaign'] : [])], f);
    if (optional) await writeFile(join(f.cwd, '.claude', 'skills', 'agentlinkops-campaigns', 'SKILL.md'), 'customer campaign policy\n');
    await rm(f.pack, { recursive: true });
    const before = await installerOwnedSnapshot(f);
    for (const apply of [[], ['--apply']]) {
      await assert.rejects(
        run(['agent', 'remove', '--skill', 'agentlinkops-connect', ...apply], f),
        error => error.name === 'ConfigError' && /retained MCP connection ownership/u.test(error.message) &&
          /preview agent remove --scope project/u.test(error.message) &&
          (!optional || (/skill agentlinkops-campaigns/u.test(error.message) && /recipe campaign/u.test(error.message))),
      );
      assert.deepEqual(await installerOwnedSnapshot(f), before);
      await absent(join(f.cwd, '.agentlinkops', 'agent-setup-project.journal.json'));
      await absent(join(f.cwd, '.agentlinkops', 'agent-setup-project.lock'));
    }
  }
});

test('an edited dependent recipe blocks joint skill removal instead of orphaning or deleting customer instructions', async (t) => {
  const f = await minimalFixture(t);
  await run(['agent', 'setup', '--client', 'claude-code', '--recipe', 'campaign'], f);
  await writeFile(join(f.cwd, '.claude', 'references', 'recipes', 'campaign.md'), 'customer recovery instructions\n');
  const before = await installerOwnedSnapshot(f);
  await assert.rejects(
    run(['agent', 'remove', '--recipe', 'campaign', '--skill', 'agentlinkops-campaigns', '--apply'], f),
    error => error.name === 'ConfigError' && /recipe campaign/u.test(error.message) && /reconciling customer edits/u.test(error.message),
  );
  assert.deepEqual(await installerOwnedSnapshot(f), before);
  await absent(join(f.cwd, '.agentlinkops', 'agent-setup-project.journal.json'));
});

test('edited recipe dependency metadata cannot authorize removing a skill beneath a surviving recipe', async (t) => {
  const f = await minimalFixture(t);
  await run(['agent', 'setup', '--client', 'claude-code', '--recipe', 'campaign'], f);
  const path = join(f.cwd, '.claude', 'references', 'recipes', 'catalog.json');
  const catalog = JSON.parse(await readFile(path, 'utf8'));
  catalog.recipes.find(row => row.id === 'campaign').skill = 'agentlinkops-assets';
  await writeFile(path, JSON.stringify(catalog));
  const before = await installerOwnedSnapshot(f);
  await assert.rejects(
    run(['agent', 'remove', '--skill', 'agentlinkops-campaigns', '--apply'], f),
    /Cannot determine dependencies of surviving recipes campaign: the owned recipe catalog is missing, edited or invalid/u,
  );
  assert.deepEqual(await installerOwnedSnapshot(f), before);
  await absent(join(f.cwd, '.agentlinkops', 'agent-setup-project.journal.json'));
});

test('default upgrade preserves a historical complete-pack installation and reports retained optional files', async (t) => {
  const f = await minimalFixture(t);
  await run(['agent', 'setup', '--client', 'claude-code', '--all-skills'], f);
  const optional = join(f.cwd, '.claude/skills/agentlinkops-campaigns/SKILL.md');
  await writeFile(optional, 'customer customized campaign\n');
  await writeFile(join(f.pack, 'agentlinkops-connect/SKILL.md'), '# upgraded core\n');
  const upgraded = await run(['agent', 'setup', '--client', 'claude-code'], f);
  assert.equal(upgraded.code, 0);
  assert.ok(upgraded.json.retainedExisting.includes(optional));
  assert.equal(await readFile(optional, 'utf8'), 'customer customized campaign\n');
  assert.ok(JSON.parse(await readFile(receiptAt(f))).files[optional]);
  assert.equal(await readFile(join(f.cwd, '.claude/skills/agentlinkops-connect/SKILL.md'), 'utf8'), '# upgraded core\n');
});

test('targeted removal preserves edited owned skill files and retains exact ownership for later reconciliation', async (t) => {
  const f = await minimalFixture(t);
  await run(['agent', 'setup', '--client', 'claude-code', '--skill', 'agentlinkops-campaigns'], f);
  const target = join(f.cwd, '.claude/skills/agentlinkops-campaigns/SKILL.md');
  const before = JSON.parse(await readFile(receiptAt(f))).files[target];
  await writeFile(target, 'customer campaign rules\n');
  const removed = await run(['agent', 'remove', '--skill', 'agentlinkops-campaigns', '--apply'], f);
  assert.equal(removed.code, 1);
  assert.deepEqual(removed.json.preserved, [target]);
  assert.equal(await readFile(target, 'utf8'), 'customer campaign rules\n');
  assert.equal(JSON.parse(await readFile(receiptAt(f))).files[target], before);
});

test('missing, traversal and conflicting selections refuse before any installer writes', async (t) => {
  const f = await minimalFixture(t);
  for (const selection of [ ['--skill', '../customer'], ['--recipe'], ['--skill', 'unknown'], ['--recipe', 'unknown'], ['--all-skills', '--recipe', 'campaign'] ]) {
    await assert.rejects(run(['agent', 'setup', '--client', 'claude-code', ...selection], f), { name: 'ConfigError' });
    await absent(receiptAt(f));
    await absent(join(f.cwd, '.mcp.json'));
  }
  await assert.rejects(run(['agent', 'remove', '--skill', 'unowned', '--apply'], f), /not owned/);
});

test('an interrupted recipe removal recovers exact payload and receipt without deleting the core', async (t) => {
  const f = await minimalFixture(t);
  await run(['agent', 'setup', '--client', 'claude-code', '--recipe', 'campaign'], f);
  const recipe = join(f.cwd, '.claude/references/recipes/campaign.md');
  const before = await readFile(receiptAt(f), 'utf8');
  await assert.rejects(run(['agent', 'remove', '--recipe', 'campaign', '--apply'], { ...f, afterOperation: () => { throw Error('interrupted removal'); } }), /interrupted removal/);
  await absent(recipe);
  assert.equal((await run(['agent', 'recover', '--apply'], f)).code, 0);
  assert.equal(await readFile(recipe, 'utf8'), '# campaign 1.0.6\n');
  assert.equal(await readFile(receiptAt(f), 'utf8'), before);
  assert.ok(await stat(join(f.cwd, '.claude/skills/agentlinkops-connect/SKILL.md')));
});

test('user-scope minimal setup and optional dry run work without a repository and preserve user instructions', async (t) => {
  const f = await minimalFixture(t);
  await writeFile(join(f.home, 'AGENTS.md'), 'user rules\n');
  await run(['agent', 'setup', '--client', 'codex', '--scope', 'user'], f);
  const preview = await run(['agent', 'setup', '--client', 'codex', '--scope', 'user', '--recipe', 'campaign', '--dry-run'], f);
  assert.equal(preview.code, 0);
  assert.equal(preview.json.selection.recipes[0].version, '1.0.6');
  await absent(join(f.home, '.agents/skills/agentlinkops-campaigns'));
  assert.equal(await readFile(join(f.home, 'AGENTS.md'), 'utf8'), 'user rules\n');
});

test('recipe catalog corruption and duplicate IDs are refused before writes, including mismatched paths', async (t) => {
  const f = await minimalFixture(t);
  const path = join(f.root, 'references/recipes/catalog.json');
  for (const catalog of [
    { schemaVersion: 1, recipes: [{ id: 'campaign', path: '../policy.md', version: '1.0.6', skill: 'agentlinkops-campaigns' }] },
    { schemaVersion: 1, recipes: [{ id: 'campaign', path: 'campaign.md', version: 'unversioned', skill: 'agentlinkops-campaigns' }] },
    { schemaVersion: 1, recipes: Array(2).fill({ id: 'campaign', path: 'campaign.md', version: '1.0.6', skill: 'agentlinkops-campaigns' }) },
  ]) {
    await writeFile(path, JSON.stringify(catalog));
    await assert.rejects(run(['agent', 'setup', '--client', 'claude-code', '--recipe', 'campaign'], f), /invalid recipe/);
    await absent(receiptAt(f));
    await absent(join(f.cwd, '.mcp.json'));
  }
});

test('selected recipe update conflict prevents all writes and keeps customer edits and prior receipt', async (t) => {
  const f = await minimalFixture(t);
  const args = ['agent', 'setup', '--client', 'claude-code', '--recipe', 'campaign'];
  await run(args, f);
  const path = join(f.cwd, '.claude/references/recipes/campaign.md');
  const before = await readFile(receiptAt(f), 'utf8');
  await writeFile(path, 'customer recipe\n');
  await writeFile(join(f.root, 'references/recipes/campaign.md'), '# updated supplier recipe\n');
  await writeFile(join(f.pack, 'agentlinkops-connect/SKILL.md'), '# core upgrade pending\n');
  const result = await run(args, f);
  assert.equal(result.code, 1);
  assert.equal(await readFile(path, 'utf8'), 'customer recipe\n');
  assert.equal(await readFile(receiptAt(f), 'utf8'), before);
  assert.equal(await readFile(join(f.cwd, '.claude/skills/agentlinkops-connect/SKILL.md'), 'utf8'), '# agentlinkops-connect\n');
});


test('an incomplete core package refuses before installing an unusable connection skill', async (t) => {
  const f = await minimalFixture(t);
  await rm(join(f.pack, 'agentlinkops-connect/references/agentlinkops.md'));
  await assert.rejects(run(['agent', 'setup', '--client', 'claude-code'], f), /core connection reference is missing/);
  await absent(receiptAt(f));
  await absent(join(f.cwd, '.mcp.json'));
});

async function installationSentinels(f) {
  const mcp = join(f.cwd, '.mcp.json');
  const codex = join(f.home, '.codex', 'config.toml');
  await writeFile(mcp, '{"mcpServers":{"customer":{"url":"https://customer.example/mcp"}}}\n');
  await mkdir(join(f.home, '.codex'));
  await writeFile(codex, 'model = "customer-default"\n');
  const paths = [mcp, codex, join(f.cwd, 'AGENTS.md'), join(f.cwd, 'ledger.json')];
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, await readFile(path, 'utf8')])));
}

async function assertInstallationUntouched(f, sentinels) {
  for (const [path, bytes] of Object.entries(sentinels))
    assert.equal(await readFile(path, 'utf8'), bytes, `installer changed ${path} before refusing`);
  for (const path of ['.claude', '.agents', '.agentlinkops']) await absent(join(f.cwd, path));
  for (const path of ['.agents', '.agentlinkops']) await absent(join(f.home, path));
}

test('full-pack setup refuses missing or empty core payloads before changing configs, records or ownership', async (t) => {
  for (const [part, empty] of [
    ['SKILL.md', false], ['SKILL.md', true],
    ['references/agentlinkops.md', false], ['references/agentlinkops.md', true],
  ]) {
    const f = await minimalFixture(t);
    const sentinels = await installationSentinels(f);
    const path = join(f.pack, 'agentlinkops-connect', part);
    if (empty) await writeFile(path, '');
    else await rm(path);
    await assert.rejects(
      run(['agent', 'setup', '--client', 'claude-code', '--client', 'codex', '--all-skills'], f),
      /core connection (?:skill|reference) is missing/u,
    );
    await assertInstallationUntouched(f, sentinels);
  }
});

test('selected recipes refuse missing or empty shared command notes before any installation effects', async (t) => {
  for (const empty of [false, true]) {
    const f = await minimalFixture(t);
    const sentinels = await installationSentinels(f);
    const path = join(f.root, 'references', 'recipes', 'command-notes.md');
    if (empty) await writeFile(path, '');
    else await rm(path);
    await assert.rejects(
      run(['agent', 'setup', '--client', 'claude-code', '--client', 'codex', '--recipe', 'campaign'], f),
      /required recipe command notes are missing/u,
    );
    await assertInstallationUntouched(f, sentinels);
  }
});

test('actual bundled optional skills route recipe installation explicitly without requiring unselected bodies', async (t) => {
  const realPack = fileURLToPath(new URL('../skills/', import.meta.url));
  for (const [id, recipe] of [
    ['agentlinkops-campaigns', 'qualified-campaign-handoff'],
    ['agentlinkops-assets', 'sourced-linkable-asset'],
    ['agentlinkops-crm', 'placement-reconciliation'],
  ]) {
    const f = await fixture(t);
    const result = await run(['agent', 'setup', '--client', 'claude-code', '--skill', id], { ...f, packDir: realPack, minimal: true });
    assert.equal(result.code, 0, result.err || result.out);
    const instruction = await readFile(join(f.cwd, '.claude/skills', id, 'SKILL.md'), 'utf8');
    assert.ok(instruction.includes(`agentlinkops agent setup --recipe ${recipe}`));
    assert.ok(instruction.includes('Recipes are optional.'));
    await absent(join(f.cwd, '.claude/references/recipes', `${recipe}.md`));
    assert.deepEqual(result.json.selection.recipes, []);
    if (id === 'agentlinkops-campaigns') {
      assert.ok(instruction.includes('agentlinkops agent setup --skill agentlinkops-discovery'));
      assert.ok(instruction.includes('Supplied candidates do not require that optional skill.'));
      await absent(join(f.cwd, '.claude/skills/agentlinkops-discovery'));
    }
    assert.ok(await stat(join(f.cwd, '.claude/skills/agentlinkops-connect/references/agentlinkops.md')));
  }
});

test('origin injection and noncanonical URLs refuse before files, configs, receipt or journal writes', async (t) => {
  const f = await minimalFixture(t);
  for (const origin of [
    'https://example.com"\nforeign = "changed', 'https://example.com\\escape',
    'https://name:secret@example.com', 'https://example.com\r\n',
    'https://example.com/path', 'https://example.com?query', 'https://example.com#hash',
    'http://example.com', true,
  ]) {
    const argv = origin === true ? ['agent', 'setup', '--client', 'codex', '--origin'] : ['agent', 'setup', '--client', 'codex', `--origin=${origin}`];
    await assert.rejects(run(argv, f), { name: 'ConfigError' });
    await absent(receiptAt(f));
    await absent(join(f.home, '.codex/config.toml'));
    await absent(join(f.cwd, '.agents'));
    await absent(join(f.cwd, '.agentlinkops'));
  }
  assert.equal((await run(['agent', 'setup', '--client', 'codex', '--origin=https://private.example/'], f)).code, 0);
  assert.ok((await readFile(join(f.home, '.codex/config.toml'), 'utf8')).includes('https://private.example/mcp'));
});

// Exercise maintained recipe payloads, rather than the synthetic selection fixtures above.
// The assembled OSS package has skills at its root; source tests use the maintained tree.
async function maintainedRecipePack() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const source = join(root, 'toolkit', 'plugin', 'agentlinkops', 'skills');
  const sourcePresent = await stat(source).catch(() => null);
  const packDir = sourcePresent ? source : join(root, 'skills');
  // Writing stages are assembled from their maintained content sources; the raw
  // product toolkit contains only the five product skills. Packaged tests use
  // their own complete skills tree, without consulting the product checkout.
  const assembledPackDir = sourcePresent ? join(root, 'dist', 'plugin', 'agentlinkops', 'skills') : packDir;
  const recipesDir = join(packDir, '..', 'references', 'recipes');
  const catalog = JSON.parse(await readFile(join(recipesDir, 'catalog.json'), 'utf8'));
  return { packDir, assembledPackDir, recipesDir, catalog };
}

const optionalWritingStages = [
  'source-cited-content-builder',
  'source-cited-humanizer',
  'content-defingerprinting',
  'internal-linking-optimizer',
  'pre-publish-review',
];

async function assertInstalledRecipeReferences(text, directory, catalog, label) {
  for (const paragraph of text.split(/\n\s*\n/u)) {
    for (const match of paragraph.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/gu)) {
      const reference = match[1].split('#')[0];
      if (!reference || /^[a-z][a-z0-9+.-]*:/iu.test(reference) || !/\.(?:md|json)$/u.test(reference)) continue;
      if (await stat(join(directory, reference)).catch(() => null)) continue;
      const continuation = catalog.recipes.find(row =>
        reference === row.path || reference === `../../references/recipes/${row.path}`);
      const selections = [...paragraph.matchAll(/--recipe\s+([a-z][a-z0-9-]*)/gu)].map(row => row[1]);
      const optional = /\boptional\b|\bIf the customer chooses\b|\bor select a packaged continuation separately\b/u.test(paragraph);
      assert.ok(
        continuation && optional && selections.includes(continuation.id) && /\bbefore reading\b/u.test(paragraph),
        `${label} requires an unavailable reference without explicit prior recipe selection: ${match[1]}`,
      );
    }
  }
}

test('actual default core-only instructions have installed mandatory references and explicitly selected optional continuations', async (t) => {
  const { packDir, catalog } = await maintainedRecipePack();
  const pack = await readPack(packDir);
  const f = { ...await fixture(t), packDir, minimal: true };
  const result = await run(['agent', 'setup', '--client', 'claude-code'], f);
  assert.equal(result.code, 0, result.err || result.out);
  assert.deepEqual(result.json.selection, { mode: 'selected', skills: ['agentlinkops-connect'], recipes: [] });
  const connectionGuidance = result.json.next.find(line => /MCP OAuth flow/u.test(line));
  assert.match(connectionGuidance, /For a chosen hosted task, sign in/u, 'setup makes hosted sign-in conditional on a chosen task');
  assert.match(connectionGuidance, /Local supplied-link checks require no AgentLinkOps account/u, 'setup preserves the accountless supplied-link path');
  assert.match(connectionGuidance, /no credential was stored by this command/u);
  const base = join(f.cwd, '.claude');
  const core = join(base, 'skills', 'agentlinkops-connect');
  const receipt = JSON.parse(await readFile(receiptAt(f), 'utf8'));
  assert.deepEqual(Object.keys(receipt.files).sort(), Object.keys(pack['agentlinkops-connect']).map(path => join(core, path)).sort());
  for (const [relative, source] of Object.entries(pack['agentlinkops-connect'])) {
    const path = join(core, relative);
    const installed = await readFile(path);
    assert.ok(installed.equals(source.bytes), `default core payload differs from maintained package: ${relative}`);
    if (relative.endsWith('.md'))
      await assertInstalledRecipeReferences(installed.toString('utf8'), dirname(path), catalog, `default core ${relative}`);
  }
  for (const id of Object.keys(pack).filter(id => id !== 'agentlinkops-connect'))
    await absent(join(base, 'skills', id));
  for (const directory of ['references', 'scripts', 'templates']) await absent(join(base, directory));
});

test('each maintained recipe alone installs its exact body and core plus associated skill without absent publisher requirements', async (t) => {
  const { packDir, recipesDir, catalog } = await maintainedRecipePack();
  assert.deepEqual(catalog.recipes.map(row => row.id).sort(), [
    'placement-reconciliation', 'qualified-campaign-handoff', 'site-context-brief', 'sourced-linkable-asset',
  ]);
  const allSkills = Object.keys(await readPack(packDir));
  for (const row of catalog.recipes) {
    const f = await fixture(t);
    const result = await run(['agent', 'setup', '--client', 'claude-code', '--recipe', row.id], { ...f, packDir, minimal: true });
    assert.equal(result.code, 0, result.err || result.out);
    const selectedSkills = [...new Set(['agentlinkops-connect', row.skill])];
    assert.deepEqual(result.json.selection, {
      mode: 'selected', skills: selectedSkills,
      recipes: [{ id: row.id, version: row.version, skill: row.skill }],
    });
    const installedRecipes = join(f.cwd, '.claude', 'references', 'recipes');
    const body = await readFile(join(installedRecipes, row.path), 'utf8');
    assert.equal(body, await readFile(join(recipesDir, row.path), 'utf8'));
    assert.ok(body.includes(`Version: \`${row.version}\``));
    for (const id of allSkills) {
      const path = join(f.cwd, '.claude', 'skills', id, 'SKILL.md');
      if (selectedSkills.includes(id)) assert.ok(await stat(path));
      else await absent(path);
    }
    for (const other of catalog.recipes.filter(other => other.id !== row.id))
      await absent(join(installedRecipes, other.path));
    await assertInstalledRecipeReferences(body, installedRecipes, catalog, row.id);
    const notes = await readFile(join(installedRecipes, 'command-notes.md'), 'utf8');
    await assertInstalledRecipeReferences(notes, installedRecipes, catalog, `${row.id} command notes`);
    assert.match(notes, /Selecting a recipe does not select the packaged content skills/u);
    for (const id of optionalWritingStages) {
      await absent(join(f.cwd, '.claude', 'skills', id, 'SKILL.md'));
      assert.ok(notes.includes(`--skill ${id}`), `missing explicit opt-in for ${id}`);
    }
  }
});

test('maintained assets and campaigns keep customer processes and records while writing stages and continuations are selected separately', async (t) => {
  const { packDir, assembledPackDir } = await maintainedRecipePack();
  const f = { ...await fixture(t), packDir, minimal: true };
  const policy = 'Use the customer editorial checklist and existing record format.\n';
  const records = 'record_id,publication_state\nasset-17,draft\n';
  await writeFile(join(f.cwd, 'AGENTS.md'), policy);
  await writeFile(join(f.cwd, 'customer-records.csv'), records);
  const recipePath = id => join(f.cwd, '.claude', 'references', 'recipes', `${id}.md`);
  assert.equal((await run(['agent', 'setup', '--client', 'claude-code', '--recipe', 'sourced-linkable-asset'], f)).code, 0);
  const asset = await readFile(recipePath('sourced-linkable-asset'), 'utf8');
  assert.match(asset, /customer's chosen source, editorial and review process/u);
  assert.match(asset, /an unrun pass is not a completed review/u);
  assert.match(asset, /A draft, green build or copied command does not prove publication/u);
  assert.match(asset, /select it separately with `agentlinkops agent setup --recipe qualified-campaign-handoff` before reading it/u);
  await absent(recipePath('qualified-campaign-handoff'));
  for (const id of optionalWritingStages) await absent(join(f.cwd, '.claude', 'skills', id, 'SKILL.md'));

  const writing = await run(['agent', 'setup', '--client', 'claude-code', ...optionalWritingStages.flatMap(id => ['--skill', id])], { ...f, packDir: assembledPackDir });
  assert.equal(writing.code, 0, writing.err || writing.out);
  assert.deepEqual(writing.json.selection.skills, ['agentlinkops-connect', ...optionalWritingStages]);
  assert.deepEqual(writing.json.selection.recipes, []);
  for (const id of optionalWritingStages) assert.ok(await stat(join(f.cwd, '.claude', 'skills', id, 'SKILL.md')));
  assert.equal(await readFile(recipePath('sourced-linkable-asset'), 'utf8'), asset);
  await absent(recipePath('qualified-campaign-handoff'));

  const continuation = await run(['agent', 'setup', '--client', 'claude-code', '--recipe', 'qualified-campaign-handoff'], f);
  assert.equal(continuation.code, 0, continuation.err || continuation.out);
  assert.deepEqual(continuation.json.selection.recipes.map(row => row.id), ['qualified-campaign-handoff']);
  assert.equal(await readFile(recipePath('sourced-linkable-asset'), 'utf8'), asset);
  const campaign = await readFile(recipePath('qualified-campaign-handoff'), 'utf8');
  assert.match(campaign, /customer's chosen source, editorial and review process/u);
  assert.match(campaign, /customer's chosen files, CRM or other record system owns contacts and relationships/u);
  assert.match(campaign, /bundled local CRM is optional and applies only when the customer chooses that store/u);
  assert.match(campaign, /this recipe sends no messages and activates no sequence/u);
  for (const id of ['agentlinkops-assets', 'agentlinkops-campaigns']) {
    const skill = await readFile(join(f.cwd, '.claude', 'skills', id, 'SKILL.md'), 'utf8');
    assert.match(skill, /customer's chosen files, CRM or other record system/u);
    assert.match(skill, /bundled local CRM is optional/u);
  }
  assert.match(await readFile(join(f.cwd, '.claude', 'skills', 'agentlinkops-assets', 'SKILL.md'), 'utf8'), /A completed local edit does not establish that the page is deployed/u);
  assert.equal(await readFile(join(f.cwd, 'AGENTS.md'), 'utf8'), policy);
  assert.equal(await readFile(join(f.cwd, 'customer-records.csv'), 'utf8'), records);
});

test('removing a maintained recipe and its optional skill leaves accountless checks usable in the customer chosen record format', async (t) => {
  const { checkToFile, validateLocalResult } = await import('../cli/local-result.js');
  const { verifyLink } = await import('../src/verifier/index.js');
  const { packDir } = await maintainedRecipePack();
  const f = { ...await fixture(t), packDir, minimal: true };
  const policy = 'Review and persist observations using our existing CSV and JSON files.\n';
  const recordDir = join(f.cwd, 'customer-evidence');
  const records = 'placement_id,source,target\np-17,https://publisher.example.com/resources,https://example.com/guide\n';
  await mkdir(recordDir);
  await writeFile(join(f.cwd, 'AGENTS.md'), policy);
  await writeFile(join(recordDir, 'placements.csv'), records);
  assert.equal((await run(['agent', 'setup', '--client', 'claude-code', '--recipe', 'placement-reconciliation'], f)).code, 0);
  const corePath = join(f.cwd, '.claude', 'skills', 'agentlinkops-connect', 'references', 'agentlinkops.md');
  const coreBefore = await readFile(corePath, 'utf8');
  const mcpBefore = await readFile(join(f.cwd, '.mcp.json'), 'utf8');
  const input = { source: 'https://publisher.example.com/resources', target: 'https://example.com/guide', scope: 'exact' };
  const fetched = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    assert.ok([input.source, 'https://publisher.example.com/robots.txt'].includes(href), `unexpected outbound fixture URL: ${href}`);
    fetched.push(href);
    return href.endsWith('/robots.txt')
      ? new Response('', { status: 404 })
      : new Response(`<!doctype html><html><body><a href="${input.target}">Customer guide</a></body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const options = { hostDelayMs: 0, verify: (value, options) => verifyLink(value, { ...options, fetchImpl, now: '2026-10-06T12:00:00Z' }) };
  const beforePath = join(recordDir, 'before-removal.json');
  const before = await checkToFile(input, beforePath, options);
  assert.equal(before.observation.state, 'present');
  assert.equal(before.observation.evidence.complete, true);
  assert.deepEqual(before.provenance, { execution: 'local', verifier: 'agentlinkops-shared-verifier', raw_html_included: false });
  assert.equal(validateLocalResult(JSON.parse(await readFile(beforePath, 'utf8'))).result_id, before.result_id);

  const removed = await run(['agent', 'remove', '--recipe', 'placement-reconciliation', '--skill', 'agentlinkops-crm', '--apply'], f);
  assert.equal(removed.code, 0, removed.err || removed.out);
  await absent(join(f.cwd, '.claude', 'references', 'recipes', 'placement-reconciliation.md'));
  for (const id of Object.keys(await readPack(packDir)).filter(id => id !== 'agentlinkops-connect'))
    await absent(join(f.cwd, '.claude', 'skills', id, 'SKILL.md'));
  assert.equal(await readFile(corePath, 'utf8'), coreBefore);
  assert.equal(await readFile(join(f.cwd, '.mcp.json'), 'utf8'), mcpBefore);

  // Inject only the HTTP transport; execute the shared verifier and actual portable-file path.
  const afterPath = join(recordDir, 'after-removal.json');
  const after = await checkToFile(input, afterPath, options);
  assert.deepEqual(after, before);
  assert.equal(validateLocalResult(JSON.parse(await readFile(afterPath, 'utf8'))).result_id, before.result_id);
  assert.equal(fetched.filter(url => url === input.source).length, 2);
  assert.equal(await readFile(join(f.cwd, 'AGENTS.md'), 'utf8'), policy);
  assert.equal(await readFile(join(recordDir, 'placements.csv'), 'utf8'), records);
  for (const path of ['.agentlinkops/config.json', '.agentlinkops/links.jsonl', '.agentlinkops/observations.jsonl', 'agentlinkops.sqlite', '.linktrail'])
    await absent(join(f.cwd, path));
});
