import test from "node:test";
import assert from "node:assert/strict";
import { admissionMain } from "../cli/admission.js";
const rule = {
  id: "r",
  workspace_id: "w",
  project_id: "p",
  kind: "reject_domain",
  value: "bad.example.com",
  source: "manual",
  enabled: true,
  note: "",
  revision: 2,
  created_by: "u",
  created_at: "2026-09-20",
  updated_at: "2026-09-20",
};
const decision = {
  index: 0,
  url: "https://bad.example.com/",
  normalized_url: "https://bad.example.com/",
  host: "bad.example.com",
  decision: "rejected",
  reason: "reject_domain",
  rule_kind: "reject_domain",
  rule_id: "r",
  rule_value: "bad.example.com",
  cap: null,
};
function harness(reply) {
  const calls = [],
    outputs = [],
    errors = [];
  return {
    calls,
    outputs,
    errors,
    options: {
      client: {
        async callCommand(name, body) {
          calls.push({ name, body });
          return typeof reply === "function" ? reply(name, body) : reply;
        },
      },
      out: (t) => outputs.push(JSON.parse(t)),
      err: (t) => errors.push(t),
    },
  };
}
test("CLI sends explicit scoped rule configuration and preserves optimistic revisions", async () => {
  const h = harness({ rule, revision: 3, created: true });
  assert.equal(
    await admissionMain(
      [
        "add",
        "--project",
        "p",
        "--kind",
        "reject_domain",
        "--value",
        "bad.example.com",
        "--disabled",
      ],
      h.options,
    ),
    0,
  );
  assert.deepEqual(h.calls[0], {
    name: "add_admission_rule",
    body: {
      projectId: "p",
      kind: "reject_domain",
      value: "bad.example.com",
      enabled: false,
    },
  });
  assert.equal(
    await admissionMain(
      [
        "update",
        "--project",
        "p",
        "--id",
        "r",
        "--revision",
        "2",
        "--enable",
        "--note",
        "reviewed",
      ],
      h.options,
    ),
    0,
  );
  assert.deepEqual(h.calls[1].body, {
    projectId: "p",
    ruleId: "r",
    revision: 2,
    enabled: true,
    note: "reviewed",
  });
});
test("preview preserves all decisions and records no mutation; pagination cursor round trips", async () => {
  const h = harness({
    decisions: [decision],
    summary: { total: 1, admitted: 0, rejected: 1, by_rule: { r: 1 } },
    policy_revision: 3,
    disavow_revision: 4,
    context: "import",
    recorded: false,
  });
  assert.equal(
    await admissionMain(
      [
        "evaluate",
        "--project",
        "p",
        "--url",
        decision.url,
        "--context",
        "import",
      ],
      h.options,
    ),
    0,
  );
  assert.equal(h.calls[0].name, "evaluate_admission");
  assert.equal(h.outputs[0].recorded, false);
  assert.deepEqual(h.outputs[0].decisions, [decision]);
  const list = harness({
    rules: [rule],
    revision: 3,
    managed_disavow_count: 1,
    cursor: "next",
  });
  assert.equal(
    await admissionMain(
      ["list", "--project", "p", "--limit", "1", "--cursor", "previous"],
      list.options,
    ),
    0,
  );
  assert.deepEqual(list.calls[0].body, {
    projectId: "p",
    limit: 1,
    cursor: "previous",
  });
  assert.equal(list.outputs[0].cursor, "next");
});
test("invalid, ambiguous or unapproved destructive CLI input never contacts the server", async () => {
  for (const args of [
    ["list"],
    ["list", "--project", "p", "--limit", "1.5"],
    ["add", "--project", "p", "--kind", "regex", "--value", ".*"],
    ["update", "--project", "p", "--id", "r", "--revision", "2"],
    [
      "update",
      "--project",
      "p",
      "--id",
      "r",
      "--revision",
      "2",
      "--enable",
      "--disable",
    ],
    ["remove", "--project", "p", "--id", "r", "--revision", "2"],
    [
      "remove",
      "--project",
      "p",
      "--id",
      "r",
      "--revision",
      "2",
      "--apply=false",
    ],
    ["list", "--project", "p", "--project", "other"],
    [
      "evaluate",
      "--project",
      "p",
      "--url",
      "https://example.com/",
      "--unknown",
    ],
  ]) {
    const h = harness({});
    assert.equal(await admissionMain(args, h.options), 2, args.join(" "));
    assert.equal(h.calls.length, 0);
    assert.equal(h.outputs.length, 0);
  }
});
test("removal uses reviewed revision; scope/CAS errors and invalid responses fail without replay", async () => {
  const h = harness({ deleted: true, rule_id: "r", revision: 4 });
  assert.equal(
    await admissionMain(
      ["remove", "--project", "p", "--id", "r", "--revision", "2", "--apply"],
      h.options,
    ),
    0,
  );
  assert.deepEqual(h.calls[0], {
    name: "delete_admission_rule",
    body: { projectId: "p", ruleId: "r", revision: 2 },
  });
  for (const reply of [
    () => {
      throw Object.assign(Error("Reload policy"), {
        code: "ADMISSION_REVISION_CONFLICT",
      });
    },
    () => ({ rules: "invalid" }),
  ]) {
    const h = harness(reply);
    assert.equal(await admissionMain(["list", "--project", "p"], h.options), 2);
    assert.equal(h.calls.length, 1);
    assert.equal(h.outputs.length, 0);
  }
});
