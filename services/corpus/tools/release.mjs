#!/usr/bin/env node
// Build a terms release from a copy of the database (design 7). See ../README.md, "Cutting a release".
import { run } from './run.mjs';

await run('release');
