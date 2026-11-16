#!/usr/bin/env node
// The `chatwarden` command: `npx chatwarden init`. All it does is run the CLI with the real process and set the exit code.
import { runCli } from './index.js';

process.exitCode = await runCli(process.argv.slice(2));
