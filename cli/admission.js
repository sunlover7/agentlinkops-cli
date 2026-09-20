import * as R from '../shared/admission-report-contract.js';
import { parseArgs } from "./args.js";
import { ConfigError } from "./config.js";
import * as C from "../shared/admission-contract.js";

// The caller supplies its already configured scoped client; this module never
// reads credentials or falls back to a different project.
const operations = {
  reevaluate:{name:'reevaluate_admission',input:R.admissionReevaluateInput,output:R.admissionReevaluateOutput,flags:['source','limit','cursor']},
  receipt:{name:'get_admission_decisions',input:R.admissionReceiptInput,output:R.admissionReceiptOutput,flags:['id']},
  list: {
    name: "list_admission_rules",
    input: C.admissionListInput,
    output: C.admissionListOutput,
    flags: ["limit", "cursor"],
  },
  add: {
    name: "add_admission_rule",
    input: C.admissionRuleInput,
    output: C.admissionMutationOutput,
    flags: ["kind", "value", "note", "disabled"],
  },
  update: {
    name: "update_admission_rule",
    input: C.admissionUpdateInput,
    output: C.admissionMutationOutput,
    flags: ["id", "revision", "value", "note", "enable", "disable"],
  },
  remove: {
    name: "delete_admission_rule",
    input: C.admissionDeleteInput,
    output: C.admissionDeleteOutput,
    flags: ["id", "revision", "apply"],
  },
  evaluate: {
    name: "evaluate_admission",
    input: C.admissionEvaluateInput,
    output: C.admissionEvaluateOutput,
    flags: ["url", "context"],
  },
};
export async function admissionMain(
  argv,
  { client, out = console.log, err = console.error } = {},
) {
  try {
    const seen = new Set();
    for (const token of argv.filter((a) => a.startsWith("--"))) {
      const name = token.slice(2).split("=")[0];
      if (seen.has(name) && name !== "url")
        throw new ConfigError("Duplicate admission option.");
      seen.add(name);
    }
    const a = parseArgs(argv, ["url"]),
      op = operations[a._[0]];
    if (
      !op ||
      a._.length !== 1 ||
      Object.keys(a).some(
        (k) => !["_", "project", "json", ...op.flags].includes(k),
      )
    )
      throw new ConfigError(
        "Use admission list|add|update|remove|evaluate|reevaluate|receipt with --project and explicit rule arguments.",
      );
    for (const flag of ["json", "disabled", "enable", "disable", "apply"])
      if (a[flag] !== undefined && a[flag] !== true)
        throw new ConfigError(`--${flag} takes no value.`);
    if (a.enable && a.disable)
      throw new ConfigError("Choose --enable or --disable, not both.");
    const body = { projectId: a.project };
    if (["list","reevaluate"].includes(a._[0])) {
      if (a.limit !== undefined) body.limit = Number(a.limit);
      if (a.cursor !== undefined) body.cursor = a.cursor;
    }
    if (a._[0] === "add") {
      Object.assign(body, { kind: a.kind, value: a.value });
      if (a.disabled) body.enabled = false;
    }
    if (["add", "update"].includes(a._[0])) {
      if (a.note !== undefined) body.note = a.note;
      if (a.value !== undefined) body.value = a.value;
    }
    if (["update", "remove"].includes(a._[0]))
      Object.assign(body, { ruleId: a.id, revision: Number(a.revision) });
    if (a._[0] === "update") {
      if (a.enable || a.disable) body.enabled = !!a.enable;
      if (
        a.value === undefined &&
        a.note === undefined &&
        !a.enable &&
        !a.disable
      )
        throw new ConfigError(
          "An update requires a changed value, note or enabled state.",
        );
    }
    if (a._[0] === "remove" && a.apply !== true)
      throw new ConfigError(
        "Removal requires --apply and the reviewed rule revision.",
      );
    if (a._[0] === "evaluate") {
      body.urls = a.url;
      if (a.context !== undefined) body.context = a.context;
    }
    if(a._[0]==='reevaluate')body.source=a.source;
    if(a._[0]==='receipt')body.operationId=a.id;
    const parsed = op.input.safeParse(body);
    if (!parsed.success)
      throw new ConfigError(
        "Invalid admission arguments; project, bounds, kind and revision must match the command contract.",
      );
    if (!client || typeof client.callCommand !== "function")
      throw new ConfigError(
        "Admission requires a configured scoped cloud client.",
      );
    const result = op.output.safeParse(
      await client.callCommand(op.name, parsed.data),
    );
    if (!result.success)
      throw new ConfigError(
        "Invalid admission response; no result was accepted.",
      );
    out(JSON.stringify(result.data, null, 2));
    return 0;
  } catch (error) {
    err(error?.code ? `${error.code}: ${error.message}` : error.message);
    return 2;
  }
}
