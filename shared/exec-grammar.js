// DP-0059: the exec grammar — one command string, five verbs, shared by the MCP exec tool,
// the CLI and the measurement scripts so one grammar serves every surface (the PostHog
// single-exec pattern: the catalog is searched and inspected on demand instead of listed).
// Pure: no imports, no environment, safe in Workerd, Node and the bundler.
//
//   search [--toolset T] [--limit N] <words>
//   tools [toolset]
//   describe [--output-schema] [--examples] <name> [<name> ...]
//   schema <name> [<field.path>]
//   call [--json] <name> <json_input>
//
// Parsing is quote-aware so a JSON body or a quoted pattern survives intact, and the body of
// `call` is taken as the raw remainder after the command name (it may span lines). A request
// that stacks several commands is detected and reported, never executed partially.

export const EXEC_VERBS = ['search', 'tools', 'describe', 'schema', 'call'];
const VERB_ALIASES = { info: 'describe', run: 'call', help: 'help' };

export const EXEC_USAGE = [
  'CLI-style command string. One command per exec call; several exec calls can run in parallel.',
  '  search [--toolset T] [--limit N] <words>  find commands by task (name, toolset, description, parameters, keywords)',
  '  tools [toolset]                           grouped command names',
  '  describe [--output-schema] [--examples] <name> [<name> ...]  exact input schema, scopes, aliases, examples',
  '  schema <name> [<field.path>]              drill into one field of a schema (dot paths, e.g. scope.target, members.0.role)',
  '  call [--json] <name> <json_input>         run the command with one JSON object; --json returns full rows instead of the concise projection',
  'Find with search, describe a name once, then call it and reuse the schema. Never guess a schema; never describe before every call.',
].join('\n');

export const BATCH_MESSAGE = count =>
  `exec runs one command per call and this request held ${count}. Send each one as its own exec call; you can issue them in parallel.`;

// A describe or schema answer larger than this is summarized, with drill-down hints on the
// fields that need them (chars, not tokens: ~5.5k tokens at the measurement ratio).
export const INFO_CHAR_LIMIT = 20000;

// --- tokenizer ---------------------------------------------------------------------------------

// Splits on whitespace outside single or double quotes; backslash escapes the quote character
// inside a quoted span. Returns tokens with their span in the raw string so `call` can slice
// its JSON body out of the original text.
function tokenize(input) {
  const tokens = [];
  let index = 0;
  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index])) index++;
    if (index >= input.length) break;
    const start = index;
    let value = '';
    let quoted = false;
    while (index < input.length) {
      const char = input[index];
      if (char === '"' || char === "'") {
        if (quoted === false) { quoted = char; index++; continue; }
        if (quoted === char) {
          if (input[index + 1] === char) { value += char; index += 2; continue; } // doubled quote escapes itself
          quoted = false; index++; continue;
        }
      }
      if (char === '\\' && quoted && input[index + 1] === quoted) { value += quoted; index += 2; continue; }
      if (!quoted && /\s/.test(char)) break;
      value += char; index++;
    }
    if (quoted) throw new GrammarError('UNTERMINATED_QUOTE', `A ${quoted}-quoted span never closes.`, 'Quote the whole argument, or drop the quotes.');
    tokens.push({ value, start, end: index });
  }
  return tokens;
}

class GrammarError extends Error {
  constructor(code, message, next) { super(message); this.code = code; this.next = next; }
}

const usage = (message, next) => ({ ok: false, error: { code: 'EXEC_USAGE', message, next: next ?? EXEC_USAGE } });

const BOOLEAN_FLAGS = {
  describe: ['--output-schema', '--examples'],
  call: ['--json'],
  search: [],
  tools: [],
  schema: [],
};
const VALUE_FLAGS = {
  search: ['--toolset', '--limit'],
  describe: [],
  call: [],
  tools: [],
  schema: [],
};

/**
 * Parse one exec command string.
 *
 * @returns {{ok:true, verb:string} & Record<string, unknown> | {ok:false, error:{code:string, message:string, next:string}}}
 */
export function parseExecCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return usage('The command string is empty.', 'Pick a verb: ' + EXEC_VERBS.join(', ') + '.');
  let tokens;
  try { tokens = tokenize(command); } catch (error) {
    return { ok: false, error: { code: error.code, message: error.message, next: error.next } };
  }
  if (!tokens.length) return usage('The command string is empty.', 'Pick a verb: ' + EXEC_VERBS.join(', ') + '.');
  const requested = tokens[0].value;
  const verb = VERB_ALIASES[requested] ?? requested;
  if (![...EXEC_VERBS, 'help'].includes(verb)) {
    return { ok: false, error: { code: 'UNKNOWN_VERB', message: `"${requested}" is not an exec verb.`, next: 'Verbs: ' + EXEC_VERBS.join(', ') + '.' } };
  }
  if (verb === 'help') return { ok: true, verb: 'help' };

  const flags = {};
  let cursor = 1;
  const takeFlags = () => {
    while (cursor < tokens.length && tokens[cursor].value.startsWith('--')) {
      const flag = tokens[cursor].value;
      const booleanOk = BOOLEAN_FLAGS[verb]?.includes(flag);
      const valueOk = VALUE_FLAGS[verb]?.includes(flag);
      if (!booleanOk && !valueOk) throw new GrammarError('UNKNOWN_FLAG', `--${flag.slice(2)} is not a ${verb} flag.`, EXEC_USAGE);
      if (valueOk) {
        const valueToken = tokens[cursor + 1];
        if (!valueToken) throw new GrammarError('FLAG_NEEDS_VALUE', `${flag} needs a value.`, EXEC_USAGE);
        flags[flag.slice(2)] = valueToken.value;
        cursor += 2;
      } else {
        flags[flag.slice(2)] = true;
        cursor += 1;
      }
    }
  };
  try { takeFlags(); } catch (error) { return { ok: false, error: { code: error.code, message: error.message, next: error.next } }; }
  const operands = tokens.slice(cursor);

  if (verb === 'search') {
    const query = command.slice(tokens[cursor]?.start ?? command.length).trim();
    if (!query) return usage('search needs words to find commands by.', 'Example: search destination health');
    const limit = flags.limit === undefined ? undefined : Number(flags.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 25)) return usage(`--limit must be an integer from 1 to 25, not "${flags.limit}".`);
    return { ok: true, verb, query, toolset: flags.toolset ?? null, limit };
  }
  if (verb === 'tools') {
    if (operands.length > 1) return usage('tools takes at most one toolset name.');
    return { ok: true, verb, toolset: operands[0]?.value ?? null };
  }
  if (verb === 'describe') {
    const names = operands.map(token => token.value);
    if (!names.length) return usage('describe needs at least one command name.', 'search finds the right name first.');
    if (names.length > 10) return usage('describe takes at most ten names per call.');
    return { ok: true, verb, names, outputSchema: flags['output-schema'] === true, examples: flags.examples === true };
  }
  if (verb === 'schema') {
    if (!operands.length) return usage('schema needs a command name.', 'Example: schema monitor_link scope.target');
    if (operands.length > 2) return usage('schema takes a command name and at most one field path.');
    return { ok: true, verb, name: operands[0].value, path: operands[1]?.value ?? null };
  }
  // call: flags and the command name are tokens; the JSON body is the raw remainder.
  if (!operands.length) return usage('call needs a command name.', 'search finds the right name first.');
  const name = operands[0].value;
  const jsonText = command.slice(operands[0].end).trim();
  return { ok: true, verb, name, jsonText: jsonText || '{}', detailed: flags.json === true };
}

// --- batch detection ----------------------------------------------------------------------------

const startsWithVerb = line => {
  const match = /^[^\S\n]*([A-Za-z_][A-Za-z0-9_-]*)/.exec(line ?? '');
  if (!match) return false;
  const verb = VERB_ALIASES[match[1]] ?? match[1].toLowerCase();
  return [...EXEC_VERBS, 'help'].includes(verb);
};

// Only `call` can legitimately span lines (its JSON body); it is complete once that body parses.
function isComplete(command) {
  const parsed = parseExecCommand(command);
  if (!parsed.ok || parsed.verb !== 'call') return true;
  try { JSON.parse(parsed.jsonText); return true; } catch { return false; }
}

/** Returns the stacked commands when the string holds several, else undefined. */
export function splitBatchedCommands(command) {
  if (typeof command !== 'string') return undefined;
  const lines = command.split('\n');
  if (lines.length < 2 || !startsWithVerb(lines[0])) return undefined;
  const commands = [];
  let current = lines[0];
  for (const line of lines.slice(1)) {
    if (startsWithVerb(line) && isComplete(current)) { commands.push(current); current = line; continue; }
    current += '\n' + line;
  }
  if (!commands.length) return undefined;
  commands.push(current);
  return commands.map(entry => entry.trim()).filter(Boolean);
}

// --- schema drill-down ---------------------------------------------------------------------------

// zod's toJSONSchema factors shared shapes into $defs with #/$defs/name pointers. Resolve one
// against the root, with a depth guard so a recursive schema cannot loop the walk.
function deref(schema, root, depth = 0) {
  let cursor = schema;
  let steps = 0;
  while (cursor && typeof cursor === 'object' && typeof cursor.$ref === 'string' && steps++ < 20) {
    if (!cursor.$ref.startsWith('#/')) return null;
    let node = root;
    for (const segment of cursor.$ref.slice(2).split('/')) {
      const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
      if (node == null || typeof node !== 'object' || !(key in node)) return null;
      node = node[key];
    }
    cursor = node;
  }
  return depth > 20 ? null : cursor;
}

const isComplex = schema =>
  schema != null && typeof schema === 'object' && (
    (schema.type === 'object' && schema.properties && Object.keys(schema.properties).length > 0) ||
    schema.type === 'array' ||
    Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf) ||
    JSON.stringify(schema).length > 800
  );

const firstSentence = (text, max = 120) => {
  const sentence = String(text ?? '').split(/(?<=\.)\s/)[0] ?? '';
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max + 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).replace(/[,;:]$/, '')}…`;
};

// One line of scalar facts for a schema node: type, enum, default, bounds, description.
export function shapeOf(schema, root) {
  const node = deref(schema, root) ?? schema;
  if (node == null || typeof node !== 'object') return { type: 'any' };
  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants)) return { type: 'one of', variants: variants.map(v => shapeOf(v, root).type ?? 'any'), description: firstSentence(node.description) || undefined };
  const shape = {};
  if (node.type) shape.type = node.type;
  if (Array.isArray(node.enum)) shape.enum = node.enum.slice(0, 12);
  if (node.default !== undefined) shape.default = node.default;
  if (node.minimum !== undefined || node.maximum !== undefined) shape.bounds = [node.minimum, node.maximum];
  if (node.minLength !== undefined || node.maxLength !== undefined) shape.length = [node.minLength, node.maxLength];
  if (node.format) shape.format = node.format;
  if (node.description) shape.description = firstSentence(node.description);
  return shape;
}

/**
 * Summarize a schema for a describe or schema answer that exceeded the character budget:
 * object properties collapse to their shape, complex children carry a hint naming the
 * `schema <name> <path>` call that expands them.
 */
export function summarizeSchema(schema, name, path = '') {
  const root = schema;
  const summarizeNode = (node, nodePath) => {
    if (node == null || typeof node !== 'object') return node;
    if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) {
      return { ...node, anyOf: undefined, oneOf: undefined, variants: (node.anyOf ?? node.oneOf).map(v => shapeOf(v, root)), note: `Summarized; drill with schema ${name}${nodePath ? ` ${nodePath}.0` : ''} for one variant.` };
    }
    if (node.type === 'array') {
      const items = node.items ? shapeOf(node.items, root) : { type: 'any' };
      return { type: 'array', items, ...(node.minItems !== undefined || node.maxItems !== undefined ? { length: [node.minItems, node.maxItems] } : {}), ...(isComplex(node.items) ? { hint: `schema ${name}${nodePath ? ` ${nodePath}.0` : ''}` } : {}), note: 'Summarized array.' };
    }
    if (node.type === 'object' || node.properties) {
      const properties = {};
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        const drill = `schema ${name}${nodePath ? ` ${nodePath}.${key}` : ` ${key}`}`;
        const summarized = shapeOf(child, root);
        if (isComplex(child)) properties[key] = { ...summarized, hint: drill };
        else properties[key] = child; // small scalars travel whole
      }
      return {
        type: 'object',
        ...(Array.isArray(node.required) ? { required: node.required } : {}),
        properties,
        ...(node.additionalProperties !== undefined ? { additionalProperties: node.additionalProperties } : {}),
        note: `Summarized to fit the context budget; expand any field carrying a hint with schema ${name} <field.path>.`,
      };
    }
    return shapeOf(node, root);
  };
  return summarizeNode(deref(schema, root) ?? schema, path);
}

/**
 * Resolve a dot path against a JSON schema: object properties by name, array items by a
 * numeric segment or by a property of the item type, anyOf/oneOf by variant index or by a
 * property any object variant defines. Returns the subschema, or null when the path does not
 * exist.
 */
export function resolveSchemaPath(schema, dotPath) {
  if (!dotPath) return schema;
  const root = schema;
  let cursor = deref(schema, root);
  for (const rawSegment of dotPath.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return null;
    const segment = rawSegment.trim();
    if (!segment) return null;
    const variants = cursor.anyOf ?? cursor.oneOf;
    if (cursor.properties?.[segment] !== undefined) { cursor = deref(cursor.properties[segment], root); continue; }
    if (variants) {
      const index = /^\d+$/.test(segment) ? Number(segment) : NaN;
      if (!Number.isNaN(index)) { cursor = deref(variants[index], root); continue; }
      for (const variant of variants) {
        const candidate = deref(variant, root);
        if (candidate?.properties?.[segment] !== undefined) { cursor = deref(candidate.properties[segment], root); break; }
      }
      if (cursor == null) return null;
      continue;
    }
    const items = deref(cursor.items, root);
    if (items) {
      if (/^\d+$/.test(segment)) { cursor = items; continue; }
      if (items.properties?.[segment] !== undefined) { cursor = deref(items.properties[segment], root); continue; }
      const itemVariants = items.anyOf ?? items.oneOf;
      if (itemVariants) {
        const index = /^\d+$/.test(segment) ? Number(segment) : NaN;
        if (!Number.isNaN(index)) { cursor = deref(itemVariants[index], root); continue; }
        for (const variant of itemVariants) {
          const candidate = deref(variant, root);
          if (candidate?.properties?.[segment] !== undefined) { cursor = deref(candidate.properties[segment], root); break; }
        }
        if (cursor == null) return null;
        continue;
      }
    }
    return null;
  }
  return cursor ?? null;
}

/** The child paths a wrong drill attempt can name, one level down. */
export function listAvailablePaths(schema) {
  const root = schema;
  const node = deref(schema, root);
  if (node == null || typeof node !== 'object') return [];
  if (node.properties) return Object.keys(node.properties);
  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants)) return variants.map((_, index) => String(index));
  if (node.items) {
    const items = deref(node.items, root);
    if (items?.properties) return Object.keys(items.properties);
    return ['items'];
  }
  return [];
}
