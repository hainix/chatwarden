import type { ReportCategory } from '@chatwarden/core';

/** The report categories the kit knows, in the kit's order (a test keeps this the same as core's `REPORT_CATEGORIES`). */
export const CATEGORIES: readonly ReportCategory[] = ['harassment', 'hate', 'cheating', 'spam', 'disruption', 'other'];

/** The longest note the kit keeps (a test keeps this the same as core's `REPORT_NOTE_MAX`). */
export const NOTE_MAX = 500;

/** How many days a warning stays on a record (a test keeps this the same as core's notice record window). */
export const WARNING_DAYS = 90;
