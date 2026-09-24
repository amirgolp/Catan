// Copies the web app (../web) into www/, the folder Capacitor bundles into the iOS app.
import { cpSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, '..', 'web');
const dest = join(root, 'www');
if (!existsSync(join(src, 'index.html'))) throw new Error(`web app not found at ${src}`);
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true, filter: (p) => !p.endsWith('README.md') });
console.log(`copied ${src} -> ${dest}`);
