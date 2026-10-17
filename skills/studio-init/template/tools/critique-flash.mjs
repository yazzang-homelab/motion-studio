// Photosensitive-flash metric for tools/critique.mjs (split out of critique-metrics.mjs, which re-exports it): per-frame
// region luminance, hysteresis transitions and the 1-s flash window. Pure: no browser, no files.

const round = (x, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);

// Photosensitive flashes (WCAG 2.3.1 "three flashes or below threshold", general-flash rule, approximated)
//
// A general flash is a pair of opposing changes in relative luminance of ≥ 0.1 where the darker state is below 0.8; more
// than 3 flashes in any 1-s period fail when they cover enough of the visual field (25% of a 10° field, which on a phone
// held at reading distance is most of the screen). Per frame we take the mean relative luminance of 5 regions (the whole
// frame and its 4 quadrants, so a strobe in one corner is not averaged away) and find swings of ≥ 0.1 between turning
// points (hysteresis), so a flash spread over several frames counts as one transition, not as many small steps. A swing
// in a region mean needs area × contrast ≥ 0.1, so the check is conservative for small, very bright strobes. Red flashes
// are not modelled.

export const FLASH = Object.freeze({ delta: 0.1, darkMax: 0.8, maxPerSecond: 3 });
const SRGB_TO_LINEAR = new Float64Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });

/** Mean relative luminance (0–1) of the whole RGBA frame and its quadrants: [all, tl, tr, bl, br]. */
export function regionLuma(buf, w, h) {
  const s = new Float64Array(5);
  const n = new Float64Array(5);
  const hw = w >> 1;
  const hh = h >> 1;
  for (let y = 0; y < h; y++) {
    const q = (y < hh ? 1 : 3);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const L = 0.2126 * SRGB_TO_LINEAR[buf[i]] + 0.7152 * SRGB_TO_LINEAR[buf[i + 1]] + 0.0722 * SRGB_TO_LINEAR[buf[i + 2]];
      const r = q + (x < hw ? 0 : 1);
      s[0] += L; n[0]++;
      s[r] += L; n[r]++;
    }
  }
  return Array.from(s, (v, i) => (n[i] ? v / n[i] : 0));
}

/**
 * Luminance transitions of one series (frame index → luminance, NaN = not sampled): every swing of ≥ delta from the
 * last turning point, in alternating directions, whose darker end is below darkMax. Returns [{ frame, dir: ±1 }].
 */
export function lumaTransitions(series, { delta = FLASH.delta, darkMax = FLASH.darkMax } = {}) {
  const out = [];
  let dir = 0; // direction of the current leg: +1 rising, −1 falling, 0 none yet
  let ext = NaN; // extreme of the current leg (the turning point a reversal is measured from)
  let lo = Infinity; // before the first leg: the range seen so far
  let hi = -Infinity;
  const turn = (k, x, from, d) => {
    if (Math.min(x, from) < darkMax) out.push({ frame: k, dir: d });
    dir = d;
    ext = x;
  };
  for (let k = 0; k < series.length; k++) {
    const x = series[k];
    if (!Number.isFinite(x)) continue;
    if (dir === 0) {
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
      if (x - lo >= delta) turn(k, x, lo, 1);
      else if (hi - x >= delta) turn(k, x, hi, -1);
    } else if (dir * (x - ext) >= 0) ext = x; // the leg goes on: move its extreme
    else if (Math.abs(x - ext) >= delta) turn(k, x, ext, -dir); // reversed by at least delta: a transition
  }
  return out;
}

/**
 * Flash verdict from per-region luminance series (regions[r][k]). For every region, the worst 1-s window: flashes =
 * floor(transitions / 2). Fails when any window holds more than maxPerSecond flashes.
 */
export function flashMetric(regions, fps, { k0 = 0, ...opts } = {}) {
  const names = ['frame', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const max = opts.maxPerSecond ?? FLASH.maxPerSecond;
  const win = Math.max(1, Math.round(fps));
  let worst = { flashes: 0, region: null, from: null, frame: null };
  const spans = [];
  regions.forEach((series, r) => {
    const tr = lumaTransitions(series, opts);
    let open = null;
    for (let i = 0, j = 0; i < tr.length; i++) {
      while (tr[i].frame - tr[j].frame >= win) j++;
      const flashes = Math.floor((i - j + 1) / 2);
      if (flashes > worst.flashes) worst = { flashes, region: names[r], from: round(tr[j].frame / fps), frame: tr[j].frame };
      if (flashes > max) {
        if (open && tr[j].frame <= open.toFrame + win) open.toFrame = tr[i].frame;
        else { open = { region: names[r], fromFrame: tr[j].frame, toFrame: tr[i].frame }; spans.push(open); }
      }
    }
  });
  // One span per stretch of time: overlapping spans of different regions merge and list every region they came from.
  const merged = [];
  for (const s of spans.sort((a, b) => a.fromFrame - b.fromFrame)) {
    const last = merged.at(-1);
    if (last && s.fromFrame <= last.toFrame) {
      last.toFrame = Math.max(last.toFrame, s.toFrame);
      if (!last.regions.includes(s.region)) last.regions.push(s.region);
    } else merged.push({ fromFrame: s.fromFrame, toFrame: s.toFrame, regions: [s.region] });
  }
  const out = merged.map((s) => ({ region: s.regions.join(', '), from: round(s.fromFrame / fps), to: round(s.toFrame / fps), frame: s.fromFrame }));
  return { rule: `≤ ${max} general flashes (luminance swings ≥ ${opts.delta ?? FLASH.delta}, darker < ${opts.darkMax ?? FLASH.darkMax}) in any 1 s, per frame and per quadrant`,
    maxPerSecond: max, worst: worst.flashes, worstAt: worst.from, worstRegion: worst.region, spans: out.filter((s) => s.frame >= k0), pass: worst.flashes <= max };
}
