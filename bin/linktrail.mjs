#!/usr/bin/env node
// Compatibility alias for the rename window: the executable is `agentlinkops`. The alias stops
// working on 2026-10-15. One line to stderr, then the same main; stdout stays clean for --json readers.
import { main } from '../cli/main.js';
process.stderr.write('linktrail: this command is now `agentlinkops`; the old name keeps working during the pilot compatibility window.\n');
process.exitCode = await main();
