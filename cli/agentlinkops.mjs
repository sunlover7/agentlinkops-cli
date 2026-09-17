#!/usr/bin/env node
// The `agentlinkops` executable. `linktrail.mjs` beside it is the compatibility alias.
import { main } from './main.js';
process.exitCode = await main();
