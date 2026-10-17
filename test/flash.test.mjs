// Tests for the photosensitive-flash metric in tools/critique-metrics.mjs (WCAG 2.3.1 general-flash approximation):
// region luminance, hysteresis transitions and the 1-s flash window, plus the Analyzer wiring and the P0 finding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regionLuma, lumaTransitions, flashMetric, FLASH, Analyzer, CRIT_DEFAULTS } from '../skills/studio-init/template/tools/critique-metrics.mjs';

const fps = 60;
const frames = (sec) => Math.round(sec * fps);
// square-wave luminance strobe between a and b at `hz` full cycles per second (a cycle = 2 transitions = 1 flash)
const strobe = (hz, sec, a = 0.05, b = 0.9) => Array.from({ length: frames(sec) }, (_, k) => (Math.floor((k / fps) * hz * 2) % 2 ? b : a));

function solid(w, h, rgb, quad = null) {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const inQuad = quad === null || (quad === 'tl' && x < w / 2 && y < h / 2);
    const c = inQuad ? rgb : [20, 20, 20];
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
  }
  return buf;
}

test('regionLuma: relative luminance of the frame and each quadrant (sRGB decoded)', () => {
  const white = regionLuma(solid(8, 8, [255, 255, 255]), 8, 8);
  white.forEach((v) => assert.ok(Math.abs(v - 1) < 1e-9));
  const black = regionLuma(solid(8, 8, [0, 0, 0]), 8, 8);
  black.forEach((v) => assert.equal(v, 0));
  const mid = regionLuma(solid(8, 8, [128, 128, 128]), 8, 8)[0];
  assert.ok(Math.abs(mid - 0.2158) < 1e-3, `sRGB 128 is ~21.6% luminance, got ${mid}`);
  const q = regionLuma(solid(8, 8, [255, 255, 255], 'tl'), 8, 8);
  assert.ok(q[1] > 0.99 && q[2] < 0.01 && q[3] < 0.01 && q[4] < 0.01);
  assert.ok(Math.abs(q[0] - (q[1] + q[2] + q[3] + q[4]) / 4) < 1e-9);
});

test('lumaTransitions: one transition per swing, however many frames the swing takes; small wobble ignored', () => {
  const ramp = [0, 0.03, 0.06, 0.09, 0.12, 0.15, 0.5, 0.5, 0.2, 0.0];
  const tr = lumaTransitions(ramp);
  assert.deepEqual(tr.map((x) => x.dir), [1, -1]);
  assert.equal(tr[0].frame, 4, 'the rise counts once it reaches delta');
  assert.deepEqual(lumaTransitions([0.4, 0.45, 0.41, 0.47, 0.42]), [], 'wobble under 0.1 is not a flash');
  assert.deepEqual(lumaTransitions([0.85, 0.99, 0.85, 0.99, 0.85]), [], 'both states above 0.8: the darker is not dark enough');
  assert.deepEqual(lumaTransitions([0.1, NaN, 0.9, NaN, 0.1]).map((x) => x.frame), [2, 4], 'unsampled frames are skipped');
});

test('flashMetric: a 7 Hz strobe fails, 2 Hz and 3 Hz pass, a slow fade passes', () => {
  const fail = flashMetric([strobe(7, 3)], fps);
  assert.equal(fail.pass, false);
  assert.ok(fail.worst >= 6, `7 Hz should show ~7 flashes per second, got ${fail.worst}`);
  assert.ok(fail.spans.length >= 1 && fail.spans[0].from < 0.2);
  assert.equal(flashMetric([strobe(2, 3)], fps).pass, true);
  assert.equal(flashMetric([strobe(3, 3)], fps).worst <= FLASH.maxPerSecond, true);
  const fade = Array.from({ length: frames(4) }, (_, k) => 0.5 + 0.45 * Math.sin((2 * Math.PI * k) / fps / 2)); // 0.5 Hz breathing
  assert.equal(flashMetric([fade], fps).pass, true);
});

test('flashMetric: a strobe in one quadrant is caught even when the whole-frame mean barely moves', () => {
  const flat = Array(frames(2)).fill(0.2);
  const quad = strobe(8, 2, 0.02, 0.3); // swing 0.28 in the quadrant, 0.07 in the whole-frame mean
  const whole = quad.map((v) => 0.75 * 0.2 + 0.25 * v); // the quadrant is a quarter of the frame
  assert.equal(flashMetric([whole], fps).pass, true, 'the whole-frame mean alone misses it');
  const r = flashMetric([whole, quad, flat, flat, flat], fps);
  assert.equal(r.pass, false);
  assert.equal(r.worstRegion, 'top-left');
});

test('Analyzer: streamed frames carry luminance into finish().flash; a strobe film is a P0-worthy fail', () => {
  const N = frames(2);
  const an = new Analyzer({ fps, frames: N, crit: CRIT_DEFAULTS });
  const white = solid(16, 16, [250, 250, 250]);
  const black = solid(16, 16, [5, 5, 5]);
  for (let k = 0; k < N; k++) an.push(Math.floor(k / 5) % 2 ? white : black, k, 16, 16); // 6 Hz
  const px = an.finish({ shots: [{ name: 's', from: 0, to: 2 }], cues: [], beats: [] });
  assert.equal(px.flash.pass, false);
  assert.ok(px.flash.worst > 3);
  const quiet = new Analyzer({ fps, frames: N, crit: CRIT_DEFAULTS });
  quiet.ingest({ d: {}, bridge: {}, samples: [], last: black, count: N, w: 16, h: 16 });
  quiet.f0 = black;
  assert.equal(quiet.finish({ shots: [], cues: [], beats: [] }).flash.skipped, true, 'no luminance → skipped, never a failure');
});

test('flashMetric: a strobe seen by several regions is one span naming every region', () => {
  const s = strobe(7, 2);
  const r = flashMetric([s, s, s, s, s], fps);
  assert.equal(r.spans.length, 1);
  assert.equal(r.spans[0].region, 'frame, top-left, top-right, bottom-left, bottom-right');
});
