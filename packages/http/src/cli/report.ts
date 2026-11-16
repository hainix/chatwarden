// What init tells the person (design 5.4 and 5.6): the human report, and the versioned `--json` document. Both are plain text, `\n` only,
// with `/` in every printed path; neither holds a secret, an absolute path or the text of a file.
import type { FileAction, FileResult, Result } from './apply.js';
import type { CliEnv } from './env.js';
import type { Plan } from './types.js';

/** The six lines for an adopter's own chat handler (design 6.3), printed when init does not add the chat box. */
const CHAT_HOOK = [
  'const kit = await createKit();',
  'kit.cw.rooms.seat(roomId, seatId, { clientKey, accountId, ip }, handle);   // when a player joins a room',
  'const r = kit.cw.chat.accept(roomId, seatId, text);                        // before broadcasting a line',
  "if ('refuse' in r) tellOnlyThisPlayer(r.refuse.reason, r.refuse.until);    // never broadcast a refused line",
  'else broadcast(r.deliver.text);                                            // starred text when the profile stars swearing',
];

const HEADINGS: Record<FileAction, { done: string; dry: string }> = {
  created: { done: 'Created', dry: 'Would create' },
  unchanged: { done: 'Unchanged', dry: 'Unchanged' },
  skipped: { done: 'Skipped (the file exists and differs, so it was left alone)', dry: 'Would skip (the file exists and differs)' },
  overwritten: { done: 'Overwritten', dry: 'Would overwrite' },
  'created-new': { done: 'Written beside (the file exists and differs)', dry: 'Would write beside (the file exists and differs)' },
};
const ORDER: FileAction[] = ['created', 'unchanged', 'skipped', 'overwritten', 'created-new'];

function section(lines: string[], file: FileResult[], action: FileAction, dryRun: boolean): void {
  const group = file.filter((f) => f.action === action);
  if (group.length === 0) return;
  lines.push(dryRun ? HEADINGS[action].dry : HEADINGS[action].done);
  for (const f of group) lines.push(action === 'created-new' ? `  ${f.path} -> ${f.writtenTo ?? ''}` : `  ${f.path}`);
  if (action === 'skipped') lines.push('  Re-run with --on-conflict new to write the new version beside each of these, then compare.');
  lines.push('');
}

/** The report for a person: what happened to each file, anything to fix, and the next steps in a fixed order. */
export function renderHuman(plan: Plan, result: Result): string {
  const lines: string[] = [];
  if (result.dryRun) lines.push('Dry run: nothing was written. This is what init would do.', '');
  for (const action of ORDER) section(lines, result.files, action, result.dryRun);

  if (result.error) lines.push('Error', `  ${result.error.message}`, '');
  if (plan.warnings.length > 0) {
    lines.push('Warnings');
    for (const warning of plan.warnings) lines.push(`  - ${warning}`);
    lines.push('');
  }
  if (plan.todo.length > 0) {
    lines.push('Starter code to replace before you go live');
    for (const item of plan.todo) lines.push(`  ${item.file}:${item.line} ${item.marker}`);
    lines.push('');
  }

  const installed = result.install?.ran === true;
  if (installed) lines.push(`Installed with ${plan.install.manager}.`, '');
  if (result.install?.failed) lines.push('The install did not finish. Run it yourself:', `  ${plan.install.command}`, '');
  const steps = installed ? plan.nextSteps.slice(1) : plan.nextSteps;
  lines.push('Next steps');
  steps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));

  if (plan.answers.chat === 'none') {
    lines.push('', 'To moderate your own chat, call the check where each line arrives:');
    for (const line of CHAT_HOOK) lines.push(`  ${line}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The `--json` document (design 5.6), `version: 1`. A field is added, never repurposed. */
export function renderJson(plan: Plan, result: Result, version: string): string {
  const document: Record<string, unknown> = {
    version: 1,
    chatwarden: version,
    ok: result.error === undefined,
    dryRun: result.dryRun,
    answers: plan.answers,
    files: result.files.map((file) => ({
      path: file.path,
      action: file.action,
      ...(file.reason ? { reason: file.reason } : {}),
      ...(file.writtenTo ? { writtenTo: file.writtenTo } : {}),
    })),
    install: { manager: plan.install.manager, command: plan.install.command, ran: result.install?.ran === true },
    env: plan.env.map((entry) => ({ name: entry.name, required: entry.required })),
    todo: plan.todo,
    nextSteps: plan.nextSteps,
    warnings: plan.warnings,
  };
  if (result.error) document.error = { kind: result.error.kind, ...(result.error.path ? { path: result.error.path } : {}), message: result.error.message };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Print the report: with `--json` the document and nothing else; otherwise the human text. Both go to standard output. */
export function emitReport(env: CliEnv, plan: Plan, result: Result, options: { json: boolean; version: string }): void {
  env.stdout.write(options.json ? renderJson(plan, result, options.version) : renderHuman(plan, result));
}
