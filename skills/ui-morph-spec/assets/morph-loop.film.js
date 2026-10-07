// film/film.js starting point for a one-shape UI morph loop (ui-morph-spec skill).
// Copy to film/film.js in a project with studio.json { "duration": 16, "loop": true, "bpm": 120 }.
// One container never cuts: every state is the same rounded rect changing size, radius and fill on a
// downbeat, driven by a cursor click; content swaps inside it with swapAlpha; the last state morphs
// back into the first so frame 0 equals frame dur. Replace STATES (names, sizes, content) with the
// approved state list. Everything is a pure function of time and of the format layout L.
import { defineFilm, scene } from '../lib/timeline.js';
import { clamp, loopTrack, loopT, swapAlpha, sp, indicator } from '../lib/motion.js';
import { text, fillRoundRect, strokeRoundRect, ring, lineProgress, cursor, circle, grain, mixColor, parseColor, withAlpha, withTransform } from '../lib/draw.js';

// Sizes in 1080-px units (multiplied by L.u); fill is a brand token name. One entry per downbeat.
const STATES = [
  { name: 'logo', w: 200, h: 200, r: 100, fill: 'accent' },
  { name: 'cta', w: 560, h: 132, r: 66, fill: 'accent' },
  { name: 'email', w: 760, h: 132, r: 28, fill: 'surface' },
  { name: 'loader', w: 168, h: 168, r: 84, fill: 'surface' },
  { name: 'check', w: 184, h: 184, r: 92, fill: 'accent' },
  { name: 'card', w: 660, h: 420, r: 40, fill: 'surface' },
  { name: 'chart', w: 780, h: 500, r: 40, fill: 'surface' },
  { name: 'palette', w: 760, h: 340, r: 32, fill: 'surface' },
];
const COPY = { cta: 'Get started', email: 'hello@acme.dev', card: ['This week', '$12,480', 'paid on time'], palette: ['Search', 'Invoices', 'Clients', 'Reports'] };
const SHAPE = 'default'; // container springs: no overshoot on big surfaces
const CURSOR = 'snappy'; // the cursor leads, a hair of overshoot

export default defineFilm((ctx) => {
  const { grid, dur } = ctx;
  const n = STATES.length;
  const LOOP_FRAMES = Math.round(dur * ctx.fps); // anything keyed to c.frame (grain) must wrap with the loop, or t = dur differs from frame 0
  const col = (ctx.brand && ctx.brand.colors) || {};
  const fonts = (ctx.brand && ctx.brand.fonts) || {};
  const UI = fonts.ui || 'Inter';
  const BG = col.bg || '#141413';
  const FG = col.fg || '#F0EEE6';
  const ACCENT = col.accent || '#D97757';
  const MUTED = col.muted || '#6C6B73';
  const TOKENS = { accent: ACCENT, surface: mixColor(BG, FG, 0.92), fg: FG };
  const INK = BG; // text drawn on light surfaces

  // State i starts on downbeat i. A measured beats.json moves every key with the music.
  const T = STATES.map((_, i) => grid.bar(i));
  const LOOP = grid.bar(n);
  if (Math.abs(LOOP - dur) > 1 / ctx.fps) {
    throw new Error(`morph loop: ${n} states end at ${LOOP.toFixed(3)} s but studio.json duration is ${dur} s; set duration to ${LOOP.toFixed(3)}`);
  }

  // Loop keys: keys[0] is the value just before the seam (the last state), then one change per downbeat
  // starting with the change at t = 0 back into the first state. First value == last value closes the loop.
  const loopKeys = (value) => [[0, value(n - 1)], ...STATES.map((_, i) => [T[i], value(i)])];
  const val = (t, value, spring = SHAPE) => loopTrack(t, loopKeys(value), dur, spring);
  const rgbOf = (i) => parseColor(TOKENS[STATES[i].fill]);
  const fillAt = (t) => {
    const [r, g, b] = [0, 1, 2].map((ch) => clamp(val(t, (i) => rgbOf(i)[ch]), 0, 255));
    return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
  };

  // Circular distance in time, so presses and swaps behave the same across the seam.
  const near = (t, at) => { const d = Math.abs(loopT(t - at, dur)); return Math.min(d, dur - d); };
  const pressed = (t) => Math.max(0, ...T.map((c) => 1 - near(t, c) / 0.12));

  function draw(g, lt, c) {
    const { L } = c;
    const u = L.u;
    const t = loopT(c.t, dur);
    const [cx, cy] = L.pos(0.5, 0.5);
    const fit = Math.min(1, (L.S.w * 0.92) / (780 * u)); // keep the widest state inside the safe rect
    const k = u * fit;
    const w = val(t, (i) => STATES[i].w) * k;
    const h = val(t, (i) => STATES[i].h) * k;
    const r = Math.min(val(t, (i) => STATES[i].r) * k, w / 2, h / 2);
    const x = cx - w / 2;
    const y = cy - h / 2;
    const press = pressed(t);
    // Camera: zoom so every state fills a similar share of the frame (small states get pushed in).
    const zoomOf = (i) => clamp(Math.min((L.S.w * 0.8) / (STATES[i].w * k), (L.S.h * 0.5) / (STATES[i].h * k)), 0.85, 2.2);
    const cam = val(t, zoomOf);
    const toScreen = ([px, py]) => [cx + (px - cx) * cam, cy + (py - cy) * cam];

    g.fillStyle = BG;
    g.fillRect(0, 0, c.W, c.H);
    // The press squashes container and content together, so text never drifts off its box.
    withTransform(g, { x: cx, y: cy, ox: cx, oy: cy, s: cam * (1 - 0.035 * press) }, () => {
      fillRoundRect(g, x, y, w, h, r, fillAt(t));
      withAlpha(g, val(t, (i) => (STATES[i].fill === 'surface' ? 1 : 0)), () => strokeRoundRect(g, x, y, w, h, r, mixColor(BG, FG, 0.7), (2 * u) / cam));
      // Content: each state's content enters after its morph starts and leaves before the next one.
      STATES.forEach((s, i) => {
        const a = swapAlpha(t, T[i], i + 1 < n ? T[i + 1] : LOOP);
        const beatAt = (b) => grid.beat(i * grid.beatsPerBar + b) - T[i]; // local time of beat b in this state's bar
        withAlpha(g, a, () => content[s.name](g, { t, lt: t - T[i], x, y, w, h, cx, cy, k, u, beatAt }));
      });
    });

    // The cursor clicks the current element on the downbeat (which starts the next state), then settles
    // onto the new element one beat later and waits there for the next click. Positions live in shape space.
    const clickPoint = (i) => [cx + STATES[i].w * k * 0.28, cy + STATES[i].h * k * 0.22];
    const moveAt = (i) => grid.beat(i * grid.beatsPerBar + 1); // beat 2 of state i's bar
    const moveKeys = (axis) => [[0, clickPoint(n - 1)[axis]], ...STATES.map((_, i) => [moveAt(i), clickPoint(i)[axis]])];
    const [sx, sy] = toScreen([loopTrack(t, moveKeys(0), dur, CURSOR), loopTrack(t, moveKeys(1), dur, CURSOR)]);
    cursor(g, sx, sy, { scale: 1.3 * u, pressed: press, fill: FG, stroke: BG });

    grain(g, c.W, c.H, c.frame % LOOP_FRAMES, { amount: 0.035, seed: 7 });
  }

  // Content painters. p-values come from springs started at the state's downbeat.
  const content = {
    logo(g, s) {
      const q = sp(s.lt - 0.1, 'heavy');
      circle(g, s.cx, s.cy, 34 * s.k * q, BG);
    },
    cta(g, s) {
      text(g, COPY.cta, s.cx, s.cy, { size: 46 * s.k, family: UI, weight: 600, color: BG, align: 'center', baseline: 'middle' });
    },
    email(g, s) {
      const chars = Math.floor(clamp((s.lt - 0.25) / 1.2) * COPY.email.length);
      const shown = COPY.email.slice(0, chars);
      const tx = s.x + 44 * s.k;
      const wText = text(g, shown || ' ', tx, s.cy, { size: 42 * s.k, family: UI, weight: 500, color: INK, baseline: 'middle' });
      const caret = 0.5 + 0.5 * Math.cos(2 * Math.PI * 2 * s.lt); // a smooth pulse: a hard blink can register as a pop
      withAlpha(g, caret, () => { g.fillStyle = ACCENT; g.fillRect(tx + wText + 6 * s.k, s.cy - 24 * s.k, 4 * s.k, 48 * s.k); });
    },
    loader(g, s) {
      ring(g, s.cx, s.cy, 48 * s.k, clamp((s.lt - 0.1) / 1.6), { width: 10 * s.k, color: ACCENT, start: -Math.PI / 2 + s.lt * 5 });
    },
    check(g, s) {
      const p = sp(s.lt - 0.12, 'snappy');
      lineProgress(g, [[s.cx - 36 * s.k, s.cy + 2 * s.k], [s.cx - 8 * s.k, s.cy + 30 * s.k], [s.cx + 40 * s.k, s.cy - 28 * s.k]], p, { width: 14 * s.k, color: BG });
    },
    card(g, s) {
      const [title, value, note] = COPY.card;
      const pad = 48 * s.k;
      text(g, title, s.x + pad, s.y + pad + 30 * s.k, { size: 34 * s.k, family: UI, weight: 500, color: MUTED });
      const q = sp(s.lt - 0.35, 'snappy');
      const shown = `$${Math.round(12480 * q).toLocaleString('en-US')}`;
      text(g, q > 0.999 ? value : shown, s.x + pad, s.cy + 40 * s.k, { size: 104 * s.k, family: UI, weight: 700, color: INK });
      text(g, note, s.x + pad, s.y + s.h - pad, { size: 32 * s.k, family: UI, weight: 500, color: ACCENT });
    },
    chart(g, s) {
      const pad = 56 * s.k;
      const pts = [0.62, 0.55, 0.7, 0.42, 0.5, 0.28, 0.34, 0.16].map((v, i, arr) => [s.x + pad + (i / (arr.length - 1)) * (s.w - 2 * pad), s.y + pad + v * (s.h - 2 * pad)]);
      lineProgress(g, pts, sp(s.lt - 0.15, { k: 60, d: 16 }), { width: 8 * s.k, color: ACCENT });
      const tip = sp(s.lt - 1.0, 'snappy'); // tooltip on hover, one beat after the line lands
      withAlpha(g, tip, () => {
        const [hx, hy] = pts[5];
        circle(g, hx, hy, 12 * s.k, ACCENT);
        fillRoundRect(g, hx - 90 * s.k, hy - 96 * s.k, 180 * s.k, 64 * s.k, 16 * s.k, INK);
        text(g, '+18%', hx, hy - 64 * s.k, { size: 32 * s.k, family: UI, weight: 600, color: FG, align: 'center', baseline: 'middle' });
      });
    },
    palette(g, s) {
      const [query, ...rows] = COPY.palette;
      const pad = 40 * s.k;
      text(g, `⌘K  ${query}`, s.x + pad, s.y + pad + 22 * s.k, { size: 36 * s.k, family: UI, weight: 500, color: MUTED, baseline: 'middle' });
      const rowH = 64 * s.k;
      const rowY = (j) => s.y + pad + 70 * s.k + j * rowH;
      // Highlight moves down one row per beat; its edges ride different springs so it stretches.
      const hl = indicator(s.lt, [[0, rowY(0)], [s.beatAt(1), rowY(1)], [s.beatAt(2), rowY(2)]], { width: rowH - 8 * s.k });
      withAlpha(g, sp(s.lt - 0.2, 'snappy'), () => fillRoundRect(g, s.x + pad * 0.6, hl.left, s.w - pad * 1.2, hl.right - hl.left, 14 * s.k, mixColor(TOKENS.surface, ACCENT, 0.18)));
      rows.forEach((label, j) => {
        withAlpha(g, sp(s.lt - 0.1 - j * 0.06, 'snappy'), () => {
          text(g, label, s.x + pad, rowY(j) + rowH / 2 - 4 * s.k, { size: 34 * s.k, family: UI, weight: 500, color: INK, baseline: 'middle' });
        });
      });
    },
  };

  // One scene per state so shot labels, stills and critique read the state names; all share one draw.
  const scenes = STATES.map((s, i) => scene(T[i], i + 1 < n ? T[i + 1] : LOOP, s.name, draw));

  // Sound on the grid: a click on every downbeat press, a soft swoosh under each morph, detail hits on beats.
  const cues = [
    ...T.map((t) => ({ t, type: 'click', gain: 0.9 })),
    ...T.map((t) => ({ t, type: 'swoosh', gain: 0.35 })),
    { t: T[2] + grid.beat(1) - grid.beat(0), type: 'type', gain: 0.5 },
    { t: T[2] + grid.beat(2) - grid.beat(0), type: 'type', gain: 0.5 },
    { t: T[4], type: 'chime', gain: 0.6 },
    { t: T[5] + grid.beat(1) - grid.beat(0), type: 'pop', gain: 0.6 },
    { t: T[6] + grid.beat(2) - grid.beat(0), type: 'tick', gain: 0.6 },
    { t: T[7] + grid.beat(1) - grid.beat(0), type: 'tick', gain: 0.5 },
  ];

  return { background: BG, scenes, cues };
});
