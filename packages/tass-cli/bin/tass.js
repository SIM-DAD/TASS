#!/usr/bin/env node
// tass — CLI launcher. All logic lives in lib/cli.js (built from src/cli.ts).
process.exitCode = require('../lib/cli.js').main(process.argv.slice(2));
