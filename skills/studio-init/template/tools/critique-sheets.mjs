// Evidence sheets of tools/critique.mjs: pages of whole rows, page 1 = <base>.png, page n = <base>-n.png (the rule tools/stills.mjs
// follows too, through writeSheetPages). A run removes the pages of the earlier run it no longer writes.
import fs from 'node:fs';
import path from 'node:path';
import { writeSheetPages, clearStaleSheets } from './stills.mjs';
import { round } from './critique-metrics.mjs';

/** Pages of one sheet → files in outDir (stale pages of earlier runs removed); records the first file in images and every page in pagesOut. */
export function saveSheet(outDir, base, pages, items, images, pagesOut) {
  const files = writeSheetPages(path.join(outDir, `${base}.png`), pages.map((p) => p.png));
  images[base] = path.basename(files[0]);
  pagesOut[base] = pages.map((p, i) => ({ file: path.basename(files[i]), tiles: p.to - p.from, from: round(items[p.from].t, 3), to: round(items[p.to - 1].t, 3) }));
}

/** A sheet this run has no tiles for must not leave the pages of the last run behind. */
export function dropSheet(outDir, base) {
  const out = path.join(outDir, `${base}.png`);
  try { fs.rmSync(out, { force: true }); } catch { /* in use: leave it */ }
  clearStaleSheets(out, 0);
}
