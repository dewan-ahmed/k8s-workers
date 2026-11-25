import { cp, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Keep one source of truth while publishing self-contained Worker assets.
const root = fileURLToPath(new URL('../', import.meta.url));
for (const app of await readdir(join(root, 'apps'))) {
  const target = join(root, 'apps', app, 'public', 'theme');
  await mkdir(target, { recursive: true });
  await cp(join(root, 'packages/ui/theme'), target, { recursive: true });
}
