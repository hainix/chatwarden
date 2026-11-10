// Removes build output (dist, *.tsbuildinfo) from every package and example, so the next build starts clean.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const group of ['packages', 'examples']) {
  const base = join(root, group);
  if (!existsSync(base)) continue;
  for (const d of readdirSync(base, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = join(base, d.name);
    rmSync(join(dir, 'dist'), { recursive: true, force: true });
    for (const f of readdirSync(dir)) if (f.endsWith('.tsbuildinfo')) rmSync(join(dir, f), { force: true });
  }
}
