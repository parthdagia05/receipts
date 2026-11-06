/**
 * Writes public/favicon.svg from the shared mark definition.
 *
 * Run with `npm run favicon` after editing src/brand/mark.ts. Keeping the
 * favicon generated rather than hand-maintained is the only way the tab icon
 * and the sidebar mark stay the same drawing.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { markSvg } from '../src/brand/mark.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'public', 'favicon.svg');

writeFileSync(target, markSvg(), 'utf8');
console.log(`wrote ${target}`);
