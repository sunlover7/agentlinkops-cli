// Compile the vendored oneglanse browser layer (TypeScript, MIT-attributed) into
// plain ESM JavaScript under src/citations/browser/gen/. Lives beside the vendored tree (a
// hand-maintained subtree of the generated package: `node vendor/build-oneglanse.mjs`). The vendored tree stays
// the source of truth; this script is the only build step and is idempotent.
//
// Deliberately NOT compiled: lib/browser/launch.ts and lib/browser/proxy/** —
// their orchestration is oneglanse-shaped (ThorData hardcoded, app modes) and is
// replaced by our own src/citations/browser/launch.js, which consumes the
// compiled primitives below.
import { build } from 'esbuild';
import { rm, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const vendor = join(here, 'oneglanse');
const outdir = join(here, '..', 'src', 'citations', 'browser', 'gen');

// Orchestration we replace with our own launch/engine: oneglanse's launch.ts
// (app modes) and the ThorData-hardcoded proxy acquisition.
// Also excluded: two files that import orchestration this build does not compile (the proxy
// agent runner needs core/runAgents, the editor wait helper needs env). Nothing in the engine
// reaches them, and a package must not carry an import it cannot resolve.
const EXCLUDED = ['lib/browser/launch.ts', 'lib/browser/proxy/runner.ts', 'lib/input/editor/waitForReady.ts'];

async function collect(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collect(full)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const ENTRIES = (await collect(vendor))
  .map((f) => relative(vendor, f))
  .filter((f) => !EXCLUDED.includes(f));

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const result = await build({
  entryPoints: ENTRIES.map((e) => join(vendor, e)),
  outdir,
  bundle: false,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outbase: vendor,
  // No alias needed: cross-package imports ("playwright", "@oneglanse/types")
  // are type-only in the vendored tree and are stripped by the TS transform.
  logLevel: 'warning',
});

const errors = result.errors ?? [];
if (errors.length > 0) {
  console.error(`oneglanse build failed with ${errors.length} error(s)`);
  process.exit(1);
}

// Rewrite the cross-package @oneglanse/* runtime imports to our local shims,
// computing the correct relative depth per compiled file.
import { readFile, writeFile } from 'node:fs/promises';
import { relative as relPath, dirname as dirOf } from 'node:path';
const shimDir = join(here, '..', 'src', 'citations', 'browser', 'shims');
const SHIM_MAP = {
  '@oneglanse/errors': join(shimDir, 'errors.js'),
  '@oneglanse/utils': join(shimDir, 'utils.js'),
  '@oneglanse/types': join(shimDir, 'types.js'),
};
async function rewrite(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { await rewrite(full); continue; }
    if (!entry.name.endsWith('.js')) continue;
    let text = await readFile(full, 'utf8');
    let changed = false;
    for (const [spec, shimPath] of Object.entries(SHIM_MAP)) {
      if (text.includes(`from "${spec}"`)) {
        let rel = relPath(dirOf(full), shimPath).replaceAll('\\', '/');
        if (!rel.startsWith('.')) rel = `./${rel}`;
        text = text.replaceAll(`from "${spec}"`, `from "${rel}"`);
        changed = true;
      }
    }
    if (changed) await writeFile(full, text);
  }
}
await rewrite(outdir);
console.log(`oneglanse compiled ${ENTRIES.length} modules -> src/citations/browser/gen/ (imports shimmed)`);
