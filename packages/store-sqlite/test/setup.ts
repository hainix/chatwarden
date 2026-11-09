import { silenceSqliteExperimentalWarning } from './filterWarnings.js';

// Keeps test output pristine on Node 22, where node:sqlite prints an ExperimentalWarning on first load.
silenceSqliteExperimentalWarning();
