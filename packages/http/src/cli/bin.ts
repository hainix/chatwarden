#!/usr/bin/env node
// The `chatwarden` command: `npx chatwarden init`. All it does is run the CLI with the real process and set the exit code.
import { runCli } from './index.js';

const code = await runCli(process.argv.slice(2));
process.exitCode = code;
// A server that was told to stop (or told twice) leaves at once, whatever is still open.
if (process.argv[2] === 'serve') process.exit(code);
