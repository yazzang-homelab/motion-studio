// skills/ui-morph-spec/scripts/statelist.mjs: the state list on the beat grid. Node built-ins only, so every test runs anywhere.
// The regression here: the script decided "am I the main module" with path.resolve() on both sides, so a run through a
// symlink or junction (a symlinked skills install, macOS /tmp) printed no state list and exited 0.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(REPO, 'skills', 'ui-morph-spec', 'scripts');
const SCRIPT = path.join(SCRIPTS, 'statelist.mjs');
const S = await import(pathToFileURL(SCRIPT).href);

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
  const link = path.join(tmp('ms-statelist-link-'), 'link');
  try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch { return null; }
  return link;
}

/** A project folder whose studio.json sets the tempo; --root keeps the run away from any studio.json above the repo. */
function project(cfg = { bpm: 120, beatsPerBar: 4, duration: 16, loop: true }) {
  const root = tmp('ms-statelist-proj-');
  fs.writeFileSync(path.join(root, 'studio.json'), JSON.stringify(cfg));
  return root;
}

const run = (args, cwd = REPO) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => resolve({ code, out, err }));
});

const EIGHT = 'logo,cta,email,loader,check,card,chart,palette';

test('isMain: real paths decide, so a symlink or junction to the script still counts; other files and missing paths do not', (t) => {
  const url = pathToFileURL(SCRIPT).href;
  assert.equal(S.isMain(url, SCRIPT), true);
  assert.equal(S.isMain(url, path.join(SCRIPTS, '..', 'scripts', 'statelist.mjs')), true, 'a path that is not normalized');
  if (process.platform === 'win32') assert.equal(S.isMain(url, SCRIPT.toUpperCase()), true, 'case does not matter on Windows');
  assert.equal(S.isMain(url, path.join(SCRIPTS, 'nothing.mjs')), false);
  assert.equal(S.isMain(url, null), false);
  assert.equal(S.isMain(url, ''), false);
  assert.equal(S.isMain('not a url', SCRIPT), false, 'a bad URL does not throw');
  const link = linkTo(SCRIPTS);
  if (!link) { t.skip('cannot create a symlink or junction here'); return; }
  assert.equal(S.isMain(url, path.join(link, 'statelist.mjs')), true, 'through the link');
});

test('statelist.mjs prints the same state list through a symlink or junction as by its real path (it used to print nothing and exit 0)', async (t) => {
  const link = linkTo(SCRIPTS);
  if (!link) { t.skip('cannot create a symlink or junction here'); return; }
  const root = project();
  const args = ['--states', EIGHT, '--root', root];
  const direct = await run([SCRIPT, ...args]);
  const viaLink = await run([path.join(link, 'statelist.mjs'), ...args]);
  assert.equal(direct.code, 0, direct.err);
  assert.equal(viaLink.code, 0, viaLink.err);
  assert.match(viaLink.out, /^State list on the beat grid · bpm grid · 120 BPM · 4\/4/);
  assert.equal(viaLink.out, direct.out);
  const help = await run([path.join(link, 'statelist.mjs'), '--help']);
  assert.match(help.out, /^Usage: node statelist\.mjs --states/);
});

test('statelist.mjs: states land on downbeats of the bar grid (120 BPM, 4/4: one bar = 2 s), "name:2" holds two bars, the loop seam row is added', async () => {
  const root = project();
  const r = await run([SCRIPT, '--states', 'a:2,b,c', '--root', root, '--json']);
  assert.equal(r.code, 0, r.err);
  const json = JSON.parse(r.out.trim());
  assert.deepEqual(json.states.map((s) => [s.name, s.bar, s.start, s.hold]), [['a', 0, 0, 4], ['b', 2, 4, 2], ['c', 3, 6, 2]]);
  assert.equal(json.duration, 8);
  assert.equal(json.source, 'bpm');
  assert.equal(json.loop, true);
  assert.match(r.err, /warning: 3 states; the pattern works best with 8 to 12/);
  assert.match(r.err, /warning: studio.json duration is 16 s but the states end at 8 s; set "duration": 8/);

  const md = await run([SCRIPT, '--states', EIGHT, '--root', root]);
  assert.equal(md.code, 0, md.err);
  assert.match(md.out, /\| 8 \| palette \| 8\.1 \| 14 \| 2 \|/);
  assert.match(md.out, /\| 9 \| back to logo \(loop seam\) \| 9\.1 \| 16 = 0 \|/);
  assert.match(md.out, /Film length: 16 s \(loop: set studio\.json "loop": true\)/);
  assert.equal(md.err, '', 'a clean 8-state list warns about nothing');
});

test('statelist.mjs: measured beats, --bpm and --out; usage errors exit 2', async () => {
  const root = project({ bpm: 90, beatsPerBar: 4, duration: 8, loop: false });
  fs.mkdirSync(path.join(root, 'audio'));
  // beats every 0.5 s (120 BPM) starting at 1.0 s, measured downbeats every 2 s
  fs.writeFileSync(path.join(root, 'audio', 'beats.json'), JSON.stringify({ source: 'librosa', bpm: 120, beatsPerBar: 4, offset: 1, beats: Array.from({ length: 16 }, (_, i) => 1 + i * 0.5), downbeats: [1, 3, 5, 7] }));
  const measured = await run([SCRIPT, '--states', 'a,b,c', '--root', root, '--json', '--no-loop']);
  const m = JSON.parse(measured.out.trim());
  assert.equal(measured.code, 0, measured.err);
  assert.equal(m.source, 'measured');
  assert.deepEqual(m.states.map((s) => s.start), [1, 3, 5], 'states follow the measured downbeats');
  const ignored = JSON.parse((await run([SCRIPT, '--states', 'a,b', '--root', root, '--beats', 'none', '--json', '--no-loop'])).out.trim());
  assert.equal(ignored.source, 'bpm');
  assert.equal(ignored.bpm, 90);
  assert.equal(ignored.states[0].start, 0);
  assert.ok(Math.abs(ignored.states[1].start - 240 / 90) < 1e-9, '90 BPM: one bar = 2.667 s');
  const out = path.join(root, 'list.md');
  const written = await run([SCRIPT, '--states', 'a,b', '--root', root, '--beats', 'none', '--out', out]);
  assert.equal(written.code, 0, written.err);
  assert.equal(fs.readFileSync(out, 'utf8'), written.out, 'the file holds the printed table');

  for (const [args, re] of [[[], /give --states or --file/], [['--states', 'a', '--nope'], /unknown flag --nope/], [['--states', 'a:1.5'], /bars must be a positive whole number/], [['stray'], /unexpected argument "stray"/]]) {
    const bad = await run([SCRIPT, ...args, '--root', root]);
    assert.equal(bad.code, 2, `${args.join(' ')}: ${bad.err}`);
    assert.match(bad.err, re);
    assert.match(bad.err, /Usage: node statelist\.mjs/);
  }
});

test('statelist.mjs helpers: parseStates, makeBar and buildStateList', () => {
  assert.deepEqual(S.parseStates('a, b:3\n# comment\nc', 2), [{ name: 'a', bars: 2 }, { name: 'b', bars: 3 }, { name: 'c', bars: 2 }]);
  assert.throws(() => S.parseStates('a:0', 1), /positive whole number/);
  const bar = S.makeBar({ bpm: 120, beatsPerBar: 4 });
  assert.equal(bar(0), 0);
  assert.equal(bar(3), 6);
  const list = S.buildStateList({ states: [{ name: 'x', bars: 1 }, { name: 'y', bars: 2 }], bar, startBar: 1, loop: false });
  assert.deepEqual(list.rows.map((r) => [r.name, r.start, r.end]), [['x', 2, 4], ['y', 4, 8]]);
  assert.equal(list.end, 8);
  assert.equal(list.endBar, 4);
});
