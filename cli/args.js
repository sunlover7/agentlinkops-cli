export function parseArgs(argv, multi = [], initial = {}) {
  const MULTI = new Set(multi);
  const args = { _: [], ...initial };
  const set = (key, value) => { if (MULTI.has(key)) (args[key] ??= []).push(value); else args[key] = value; };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) { args._.push(value); continue; }
    const equals = value.indexOf('=');
    if (equals > 2) { set(value.slice(2, equals), value.slice(equals + 1)); continue; }
    const key = value.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; continue; }
    set(key, next);
    i++;
  }
  return args;
}

