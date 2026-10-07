// skills/showreel/scripts/roll.mjs: the seeded brief randomizer. Node built-ins only, so every test runs anywhere.
// The regression here: the script decided "am I the main module" with path.resolve() on both sides, so a run through a
// symlink or junction (a symlinked skills install, macOS /tmp) did nothing and exited 0 without a word.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(REPO, 'skills', 'showreel', 'scripts');
const SCRIPT = path.join(SCRIPTS, 'roll.mjs');
const R = await import(pathToFileURL(SCRIPT).href);

// Temp dirs are removed when the file is done; a link is unlinked first, never followed.
const made = new Set();
const tmp = (prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.add(dir); return dir; };
function rmTree(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const p = path.join(dir, name);
    let isLink = false;
    try { isLink = fs.lstatSync(p).isSymbolicLink(); } catch { /* vanished */ }
    if (!isLink) continue;
    try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch { return; } } // could not unlink: leak the dir rather than recurse into the target
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
after(() => { for (const dir of made) rmTree(dir); });

/** A link to `target` in a fresh temp dir, or null when the platform refuses to create one. */
function linkTo(target) {
  const link = path.join(tmp('ms-roll-link-'), 'link');
  try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch { return null; }
  return link;
}

const run = (args, cwd = REPO) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => resolve({ code, out, err }));
});

test('isMain: real paths decide, so a symlink or junction to the script still counts; other files and missing paths do not', (t) => {
  const url = pathToFileURL(SCRIPT).href;
  assert.equal(R.isMain(url, SCRIPT), true);
  assert.equal(R.isMain(url, path.join(SCRIPTS, '..', 'scripts', 'roll.mjs')), true, 'a path that is not normalized');
  if (process.platform === 'win32') assert.equal(R.isMain(url, SCRIPT.toUpperCase()), true, 'case does not matter on Windows');
  assert.equal(R.isMain(url, path.join(SCRIPTS, 'nothing.mjs')), false);
  assert.equal(R.isMain(url, null), false);
  assert.equal(R.isMain(url, ''), false);
  assert.equal(R.isMain('not a url', SCRIPT), false, 'a bad URL does not throw');
  const link = linkTo(SCRIPTS);
  if (!link) { t.skip('cannot create a symlink or junction here'); return; }
  assert.equal(R.isMain(url, path.join(link, 'roll.mjs')), true, 'through the link');
});

test('roll.mjs prints the same brief through a symlink or junction as by its real path (it used to print nothing and exit 0)', async (t) => {
  const link = linkTo(SCRIPTS);
  if (!link) { t.skip('cannot create a symlink or junction here'); return; }
  const direct = await run([SCRIPT, '--seed', 'symlink-check']);
  const viaLink = await run([path.join(link, 'roll.mjs'), '--seed', 'symlink-check']);
  assert.equal(direct.code, 0, direct.err);
  assert.equal(viaLink.code, 0, viaLink.err);
  assert.ok(direct.out.length > 100, 'the brief is not empty');
  assert.equal(viaLink.out, direct.out);
  assert.match(viaLink.err, /^seed "symlink-check": p\d+ g\d+ c\d+ f\d+ t\d+/);
  const help = await run([path.join(link, 'roll.mjs'), '--help']);
  assert.match(help.out, /^Usage: node roll\.mjs \[seed\] \[options\]/);
});

test('roll.mjs: the same seed gives the same brief, other seeds spread over the tables, --json carries the picks', async () => {
  const a = await run([SCRIPT, '--seed', 'alpha', '--json']);
  const b = await run([SCRIPT, '--seed', 'alpha', '--json']);
  assert.equal(a.code, 0, a.err);
  assert.equal(a.out, b.out, 'deterministic');
  const result = JSON.parse(a.out.trim());
  assert.equal(result.ok, true);
  assert.equal(result.seed, 'alpha');
  assert.equal(result.picks.techniques.length, 3);
  assert.equal(new Set(result.picks.techniques.map((x) => x.id)).size, 3, 'distinct techniques');
  assert.ok(result.brief.includes(result.picks.persona.option));
  const briefs = new Set();
  for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6']) briefs.add(JSON.parse((await run([SCRIPT, '--seed', seed, '--json'])).out.trim()).brief);
  assert.ok(briefs.size >= 4, `six seeds gave ${briefs.size} different briefs`);
});

test('roll.mjs: pins, overrides and usage errors', async () => {
  const parsed = R.parseVariants(fs.readFileSync(path.join(SCRIPTS, '..', 'assets', 'variants.md'), 'utf8'));
  for (const name of ['persona', 'genre', 'constraint', 'technique', 'frame']) assert.ok(parsed.tables[name].length >= 3, name);
  const persona = parsed.tables.persona[2].id;
  const tech = parsed.tables.technique[1].id;
  const pinned = R.roll(parsed, { seed: 'x', techniques: 2, pins: [persona, tech], seconds: 20, format: '1x1' });
  assert.equal(pinned.picks.persona.id, persona);
  assert.ok(pinned.picks.techniques.some((x) => x.id === tech));
  assert.equal(pinned.picks.techniques.length, 2);
  assert.equal(pinned.picks.frame.seconds, 20);
  assert.equal(pinned.picks.frame.format, '1x1');
  assert.throws(() => R.roll(parsed, { seed: 'x', pins: ['zz99'] }), /unknown id "zz99"/);
  assert.throws(() => R.roll(parsed, { seed: 'x', techniques: 9 }), /between 1 and 6/);

  const bad = await run([SCRIPT, '--nope']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /roll: unknown flag --nope/);
  assert.match(bad.err, /Usage: node roll\.mjs/);
  const list = await run([SCRIPT, '--list']);
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /^persona \(\d+\)/);
});
