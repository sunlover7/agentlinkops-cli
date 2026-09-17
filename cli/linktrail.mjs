#!/usr/bin/env node
// Compatibility alias for the pilot window (DP-0029): the executable is `agentlinkops`.
// One line to stderr, then the same main — stdout stays clean for `--json` readers.
import { main } from './main.js';
process.stderr.write('linktrail: this command is now `agentlinkops`; the old name keeps working during the pilot compatibility window.\n');
process.exitCode = await main();
