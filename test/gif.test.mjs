// tools/gif.mjs: the GIF frame-rate rule (whole centiseconds), the GIF timing parser and, with ffmpeg, the CLI on a real
// cut (frame count, identical delays, exact length, loop flag, size limit, a non-storable fps snapped with a warning).
// Skips the CLI part cleanly without ffmpeg: FFMPEG_PATH, or ffmpeg-static resolvable from the repo root package.json.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = process.env.MOTION_TEMPLATE_DIR ? path.resolve(process.env.MOTION_TEMPLATE_DIR) : path.join(REPO, 'skills', 'studio-init', 'template');
const G = await import(pathToFileURL(path.join(TEMPLATE, 'tools', 'gif.mjs')).href);

function findFfmpeg() {
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  try { candidates.push(createRequire(path.join(REPO, 'package.json'))('ffmpeg-static')); } catch { /* not installed */ }
  candidates.push('ffmpeg');
  for (const c of candidates) if (c && spawnSync(c, ['-hide_banner', '-version'], { stdio: 'ignore' }).status === 0) return c;
  return null;
}
const FFMPEG = findFfmpeg();
const SKIP = FFMPEG ? false : 'ffmpeg not found (set FFMPEG_PATH or npm install ffmpeg-static at the repo root)';

test('gifRate: snaps to 100/n fps with n ≥ 2 whole centiseconds', () => {
  assert.deepEqual(G.gifRate(25), { fps: 25, cs: 4, exact: true });
  assert.deepEqual(G.gifRate(50), { fps: 50, cs: 2, exact: true });
  assert.deepEqual(G.gifRate(24), { fps: 25, cs: 4, exact: false }, '24 fps (4.17 cs) cannot be stored');
  assert.deepEqual(G.gifRate(60), { fps: 50, cs: 2, exact: false }, 'browsers slow < 2 cs delays to 10 cs');
  assert.equal(G.gifRate(30).cs, 3);
  assert.equal(G.gifRate(12).cs, 8);
  assert.throws(() => G.gifRate(0), /--fps/);
});

// A hand-built 1x1 GIF89a: global table of 2 colours, NETSCAPE loop forever, two frames of 7 and 9 cs, a comment block.
function tinyGif({ loop = 0, delays = [7, 9] } = {}) {
  const parts = [Buffer.from('GIF89a', 'latin1'), Buffer.from([1, 0, 1, 0, 0x80, 0, 0]), Buffer.from([0, 0, 0, 255, 255, 255])];
  if (loop !== null) parts.push(Buffer.from([0x21, 0xff, 11]), Buffer.from('NETSCAPE2.0', 'latin1'), Buffer.from([3, 1, loop & 255, loop >> 8, 0]));
  parts.push(Buffer.from([0x21, 0xfe, 3]), Buffer.from('hey', 'latin1'), Buffer.from([0]));
  for (const d of delays) {
    parts.push(Buffer.from([0x21, 0xf9, 4, 0, d & 255, d >> 8, 0, 0]));
    parts.push(Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]), Buffer.from([2, 2, 0x44, 0x01, 0]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

test('gifTiming: frames, per-frame delays, total length and the loop extension', () => {
  const t = G.gifTiming(tinyGif());
  assert.deepEqual({ w: t.width, h: t.height, frames: t.frames, delays: t.delays, total: t.totalCs, loop: t.loop }, { w: 1, h: 1, frames: 2, delays: [7, 9], total: 16, loop: 0 });
  assert.equal(G.gifTiming(tinyGif({ loop: null })).loop, null, 'no NETSCAPE block: plays once');
  assert.equal(G.gifTiming(tinyGif({ loop: 3 })).loop, 3);
  assert.throws(() => G.gifTiming(Buffer.from('PNG...')), /not a GIF/);
});

describe('gif.mjs CLI on a real cut', { skip: SKIP, timeout: 600000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-gif-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'studio.json'), 'utf8'));
  Object.assign(cfg, { title: 'Gif Test', duration: 2, fps: 60, loop: true, formats: ['1x1'], primaryFormat: '1x1' });
  fs.writeFileSync(path.join(dir, 'studio.json'), JSON.stringify(cfg, null, 2));
  fs.mkdirSync(path.join(dir, 'out', '1x1'), { recursive: true });
  const made = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=240x240:r=60:d=2', '-pix_fmt', 'yuv420p', path.join(dir, 'out', '1x1', 'silent.mp4')]);
  const cli = (...args) => spawnSync(process.execPath, [path.join(TEMPLATE, 'tools', 'gif.mjs'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, FFMPEG_PATH: FFMPEG } });

  test('default: 25 fps, 4 cs on every frame, exact 2 s, loops forever', () => {
    assert.equal(made.status, 0, String(made.stderr));
    const r = cli('--json');
    assert.equal(r.status, 0, r.stderr);
    const res = JSON.parse(r.stdout).results[0];
    assert.equal(res.frames, 50);
    assert.equal(res.delayCs, 4);
    assert.ok(res.checks.every((c) => c.pass), JSON.stringify(res.checks));
    const t = G.gifTiming(fs.readFileSync(path.join(dir, res.file)));
    assert.equal(t.totalCs, 200);
    assert.equal(t.loop, 0);
  });

  test('--fps 24 is snapped to 25 with a warning; --once drops the loop; --max-bytes fails with exit 1', () => {
    const r = cli('--fps', '24', '--once', '--max-bytes', '1000', '--json');
    assert.equal(r.status, 1);
    const res = JSON.parse(r.stdout).results[0];
    assert.equal(res.fps, 25);
    assert.match(res.warnings.join(' '), /not storable/);
    assert.equal(res.checks.find((c) => c.id === 'loop').pass, true);
    assert.equal(res.checks.find((c) => c.id === 'size').pass, false);
  });

  test('bad flags are usage errors (exit 2)', () => {
    assert.equal(cli('--colors', '1').status, 2);
    assert.equal(cli('--dither', 'noise').status, 2);
  });
});
