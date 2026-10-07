// Samples for selftest.mjs. Every regex / tool_used grader needs at least one passing and one failing sample, so a
// grader that silently matches everything (or nothing) is caught before anyone pays for a run.
// SAMPLES: { case, grader, label, pass, text | calls }.  WORKSPACE_CHECKS: expectations after each scaffold runs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LOG = readFileSync(fileURLToPath(new URL('../critique-writes-log/fixtures/review_log.md', import.meta.url)), 'utf8');

const ROUND2_GOOD = `
## Round 2 — 9x16 — hook resized, card on spring, lockup moved
SCORES: hook=7 readability=6 motion=6 variety=4 composition=5 brand=6 sound=na
PROBLEMS:
1. [P0] [00:04.00] three identical near-empty stills from 00:04.00 to 00:05.00: a dead stretch where nothing happens
2. [P1] [00:02.00] centered DRIFTNOTE title on a purple-blue gradient, the banned default look; 00:02.50 is washed out
3. [P1] [00:03.00] CAPTURE and ORGANIZE overlap during the word swap
4. [P2] [00:03.50] corner labels (V1.0, 2026, BETA, #01) plus a frame border
FIXES: fill 4.0-5.0 s with the sync state, drop the gradient card, stagger the word swap, remove the corner labels
`;
const ROUND2_SYCOPHANT = `
## Round 2 — 9x16 — looks great
SCORES: hook=9 readability=8 motion=9 variety=8 composition=8 brand=10 sound=na
PROBLEMS:
1. [P2] maybe tighten the ending a little
FIXES: none needed
`;
const ROUND2_BOLD = `
## Round 2 — 9x16
**SCORES:** hook=7 readability=6 motion=6 variety=4 composition=5 brand=6 sound=na
PROBLEMS:
1. [P1] [00:03.00] overlapping words
`;
const ROUND2_MISSING_AXIS = `
## Round 2 — 9x16
SCORES: hook=7 readability=6 motion=6 variety=4 composition=5 brand=6
PROBLEMS:
1. [P1] [00:03.00] overlapping words
`;
const ROUND2_COLON_STYLE = `
## Round 2 — 9x16
SCORES: hook: 7, readability: 6, motion: 6, variety: 4, composition: 5, brand: 6, sound: na
PROBLEMS:
1. [P1] [00:03.00] overlapping words
`;
const ROUND2_NO_TIMES = `
## Round 2 — 9x16
SCORES: hook=7 readability=6 motion=6 variety=4 composition=5 brand=6 sound=na
PROBLEMS:
1. [P1] the words overlap in the middle
2. [P2] the ending feels flat
`;
const ROUND1_EDITED = LOG.replace('hook=6 readability=5', 'hook=8 readability=8');

const GOOD_SPARKLE = `
// Glints around the lockup in the last 2 s; each glint is seeded by its index so seek(t) stays pure.
function drawSparkles(g, lt, c) {
  for (let i = 0; i < 14; i++) {
    const r = rngFor('sparkle', i);
    const x = c.W * (0.3 + 0.4 * r()), y = c.H * (0.45 + 0.1 * r()), phase = r() * 2;
    const tw = Math.max(0, Math.sin((lt - phase) * 6.283));
    g.globalAlpha = tw; g.fillRect(x, y, 3 * c.u, 3 * c.u);
  }
}
`;
const RANDOM_SPARKLE = `
function drawSparkles(g, lt, c) {
  for (let i = 0; i < 14; i++) { const x = Math.random() * c.W; g.fillRect(x, c.H / 2, 3, 3); }
}
`;
const PAD = '\n' + '// padding line to push the seeded helper far away from the effect code\n'.repeat(40);

const REAL_CLIP_SIDECAR = `{
  "format": "9x16",
  "file": "clip_0.00-2.00.mp4",
  "title": "Untitled Film",
  "width": 1080,
  "height": 1920,
  "fps": 60,
  "sub": 4,
  "shutter": 0.5,
  "frames": 120,
  "from": 0,
  "to": 2,
  "duration": 2,
  "workers": 4,
  "via": "chrome",
  "capture": "canvas",
  "final": false,
  "createdBy": "motion-studio"
}
`;

const call = (tool, input) => ({ tool, input });
const skill = (name) => [call('Skill', { skill: name })];
const skillFired = (c, name, other) => [
  { case: c, grader: 'skill-fired', label: 'namespaced call', pass: true, calls: skill(`motion-studio:${name}`) },
  { case: c, grader: 'skill-fired', label: 'bare call', pass: true, calls: skill(name) },
  { case: c, grader: 'skill-fired', label: 'another skill', pass: false, calls: skill(`motion-studio:${other}`) },
  { case: c, grader: 'skill-fired', label: 'no call', pass: false, calls: [] },
];

export const SAMPLES = [
  // ---- trigger-motion-reel
  ...skillFired('trigger-motion-reel', 'motion-reel', 'product-reel'),
  { case: 'trigger-motion-reel', grader: 'review-before-render', label: 'contact sheet checkpoint', pass: true,
    text: 'Before the full render I will show you a contact sheet with one frame per beat and fix what we find.' },
  { case: 'trigger-motion-reel', grader: 'review-before-render', label: 'straight to mp4', pass: false,
    text: 'Send me your logo and I will export the MP4 tonight.' },

  // ---- trigger-showreel
  ...skillFired('trigger-showreel', 'showreel', 'motion-reel'),
  { case: 'trigger-showreel', grader: 'variation-axes', label: 'names the axes', pass: true,
    text: 'Variant 1 changes the persona: a niche branding studio. Variant 2 swaps the genre for a story.' },
  { case: 'trigger-showreel', grader: 'variation-axes', label: 'adjective swaps', pass: false,
    text: 'Try: make a bold 15-second video. Or: make an epic 15-second video. Or: make a wild one.' },

  // ---- springs-closed-form
  ...skillFired('springs-closed-form', 'springs', 'seek-engine'),
  { case: 'springs-closed-form', grader: 'closed-form-code', label: 'exp + cos', pass: true,
    text: '```js\nconst x = 1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + (z * w0 / wd) * Math.sin(wd * t));\n```' },
  { case: 'springs-closed-form', grader: 'closed-form-code', label: 'smoothstep only', pass: false,
    text: '```js\nconst ease = (t) => t * t * (3 - 2 * t);\n```' },
  { case: 'springs-closed-form', grader: 'no-timers', label: 'prose mention without a call', pass: true,
    text: 'No requestAnimationFrame loop or setTimeout is involved; spring(t) is closed-form.' },
  { case: 'springs-closed-form', grader: 'no-timers', label: 'prose mention with parentheses', pass: true,
    text: 'It is a pure function: no `requestAnimationFrame()`, no `setTimeout()`.\n\n```js\nexport const s = (t) => 1 - Math.exp(-t);\n```' },
  { case: 'springs-closed-form', grader: 'no-timers', label: 'code comment mention', pass: true,
    text: '```js\n// never setTimeout() here\nconst x = spring(t); /* not Date.now() */\n```' },
  { case: 'springs-closed-form', grader: 'no-timers', label: 'rAF loop in code', pass: false,
    text: 'Preview loop:\n\n```javascript\nfunction tick() {\n  step();\n  requestAnimationFrame(tick);\n}\n```' },
  { case: 'springs-closed-form', grader: 'no-timers', label: 'Date.now clock in second block', pass: false,
    text: '```js\nconst a = 1;\n```\n\nThen:\n\n```js\nconst t = (Date.now() - start) / 1000;\n```' },
  { case: 'springs-closed-form', grader: 'no-timers', label: 'prose between blocks', pass: true,
    text: '```js\nconst a = 1;\n```\nAvoid setInterval() entirely.\n```js\nconst b = 2;\n```' },

  // ---- ui-morph-spec-xml
  ...skillFired('ui-morph-spec-xml', 'ui-morph-spec', 'springs'),
  { case: 'ui-morph-spec-xml', grader: 'six-sections', label: 'all six', pass: true,
    text: '<inputs>a</inputs>\n<direction>b</direction>\n<structure>c</structure>\n<build>d</build>\n<gotchas>e</gotchas>\n<start>f</start>' },
  { case: 'ui-morph-spec-xml', grader: 'six-sections', label: 'no gotchas', pass: false,
    text: '<inputs>a</inputs>\n<direction>b</direction>\n<structure>c</structure>\n<build>d</build>\n<start>f</start>' },
  { case: 'ui-morph-spec-xml', grader: 'six-sections', label: 'tags only named in prose', pass: false,
    text: 'Use <inputs>, <direction>, <structure>, <build>, <gotchas> and <start> sections.' },

  // ---- director-brief-sections
  ...skillFired('director-brief-sections', 'director-brief', 'critique-loop'),
  { case: 'director-brief-sections', grader: 'skeleton-sections', label: 'full skeleton', pass: true,
    text: '## The film in one line\n...\n## Character bible\n...\n## Beat sheet\n...\n## Workflow, with gates\n...\n## Critique loop\n...\n## Deliverables\n...' },
  { case: 'director-brief-sections', grader: 'skeleton-sections', label: 'plugin template headings', pass: true,
    text: '### A2. The film in one line\n### A3. Delivery\n### A7. Character or hero bible\n### A8. Beat sheet\n### B1. Gates, in order\n### B3. Critique loop' },
  { case: 'director-brief-sections', grader: 'skeleton-sections', label: 'no character bible', pass: false,
    text: '## Logline\n## Beat sheet\n## Gates\n## Critique loop\n## Deliverables\n## Characters: a fox' },
  { case: 'director-brief-sections', grader: 'skeleton-sections', label: 'no beat sheet', pass: false,
    text: '## Logline\n...\n## Character bible\n...\n## Workflow gates\n...\n## Critique loop\n...\n## Deliverables\n...' },
  { case: 'director-brief-sections', grader: 'keys-in-env', label: 'key by name', pass: true,
    text: 'The ElevenLabs key is ELEVENLABS_API_KEY in .env; never paste it.' },
  { case: 'director-brief-sections', grader: 'keys-in-env', label: 'no env file', pass: false,
    text: 'API key: paste it here. Also see .envrc for direnv.' },

  // ---- route-b-remotion-license
  ...skillFired('route-b-remotion-license', 'seek-engine', 'studio-init'),
  { case: 'route-b-remotion-license', grader: 'names-company-license', label: 'company license', pass: true,
    text: 'At 12 people you need a Remotion Company License; the free license stops at 3 employees.' },
  { case: 'route-b-remotion-license', grader: 'names-company-license', label: 'claims free', pass: false,
    text: 'Remotion is open source and free to use, so just run npx create-video.' },

  // ---- critique-writes-log
  ...skillFired('critique-writes-log', 'critique-loop', 'springs'),
  { case: 'critique-writes-log', grader: 'looked-at-sheet', label: 'read the png', pass: true,
    calls: [call('Read', { file_path: '/tmp/claude-eval-x/home/cwd/out/review/9x16/contact.png' })] },
  { case: 'critique-writes-log', grader: 'looked-at-sheet', label: 'windows path', pass: true,
    calls: [call('Read', { file_path: 'C:\\Temp\\ws\\out\\review\\9x16\\contact.png' })] },
  { case: 'critique-writes-log', grader: 'looked-at-sheet', label: 'only read the log', pass: false,
    calls: [call('Read', { file_path: 'docs/review_log.md' })] },
  { case: 'critique-writes-log', grader: 'round-2-logged', label: 'appended', pass: true, text: LOG + ROUND2_GOOD },
  { case: 'critique-writes-log', grader: 'round-2-logged', label: 'untouched', pass: false, text: LOG },
  { case: 'critique-writes-log', grader: 'scores-all-axes', label: 'seven axes', pass: true, text: LOG + ROUND2_GOOD },
  { case: 'critique-writes-log', grader: 'scores-all-axes', label: 'bold keyword', pass: false, text: LOG + ROUND2_BOLD },
  { case: 'critique-writes-log', grader: 'scores-all-axes', label: 'missing sound', pass: false, text: LOG + ROUND2_MISSING_AXIS },
  { case: 'critique-writes-log', grader: 'scores-all-axes', label: 'colon style', pass: false, text: LOG + ROUND2_COLON_STYLE },
  { case: 'critique-writes-log', grader: 'scores-all-axes', label: 'untouched (round 1 only)', pass: false, text: LOG },
  { case: 'critique-writes-log', grader: 'problems-timestamped', label: 'timestamped', pass: true, text: LOG + ROUND2_GOOD },
  { case: 'critique-writes-log', grader: 'problems-timestamped', label: 'no timestamps', pass: false, text: LOG + ROUND2_NO_TIMES },
  { case: 'critique-writes-log', grader: 'harsh-scores', label: 'low scores', pass: true, text: LOG + ROUND2_GOOD },
  { case: 'critique-writes-log', grader: 'harsh-scores', label: 'all 8 or more', pass: false, text: LOG + ROUND2_SYCOPHANT },
  { case: 'critique-writes-log', grader: 'harsh-scores', label: 'round 1 lows do not count', pass: false, text: LOG },
  { case: 'critique-writes-log', grader: 'flags-dead-beats', label: 'dead stretch', pass: true, text: LOG + ROUND2_GOOD },
  { case: 'critique-writes-log', grader: 'flags-dead-beats', label: 'not mentioned', pass: false, text: LOG + ROUND2_BOLD },
  { case: 'critique-writes-log', grader: 'flags-banned-look', label: 'gradient', pass: true, text: LOG + ROUND2_GOOD },
  { case: 'critique-writes-log', grader: 'flags-banned-look', label: 'not mentioned', pass: false, text: LOG + ROUND2_NO_TIMES },
  { case: 'critique-writes-log', grader: 'round-1-kept', label: 'append only', pass: true, text: LOG + ROUND2_GOOD },
  { case: 'critique-writes-log', grader: 'round-1-kept', label: 'round 1 rewritten', pass: false, text: ROUND1_EDITED + ROUND2_GOOD },
  { case: 'critique-writes-log', grader: 'round-1-kept', label: 'CRLF file', pass: true, text: (LOG + ROUND2_GOOD).replace(/\n/g, '\r\n') },

  // ---- trigger-product-reel-assets
  ...skillFired('trigger-product-reel-assets', 'product-reel', 'motion-reel'),
  { case: 'trigger-product-reel-assets', grader: 'browser-capture', label: 'capture script', pass: true,
    text: 'I will run `node skills/product-reel/scripts/capture.mjs https://example.com --root . --full-page`; it writes assets/brand/screens/ and assets/manifest.json.' },
  { case: 'trigger-product-reel-assets', grader: 'browser-capture', label: 'headless browser', pass: true,
    text: 'A headless Chrome session (Playwright) takes desktop and mobile screenshots and reads the CSS colors.' },
  { case: 'trigger-product-reel-assets', grader: 'browser-capture', label: 'asks the user to send files', pass: false,
    text: 'I cannot open websites. Please send me your screenshots, the logo file and your hex colors.' },
  { case: 'trigger-product-reel-assets', grader: 'browser-capture', label: 'designs its own brand', pass: false,
    text: 'I will design a clean wordmark and pick a modern blue palette (#1E3A8A, #3B82F6) for the video.' },

  // ---- critic-agent-dispatch (Agent input keys per the tool reference: description, prompt, subagent_type, model)
  { case: 'critic-agent-dispatch', grader: 'critic-dispatched', label: 'plugin agent, namespaced', pass: true,
    calls: [call('Agent', { description: 'Critique round 2', prompt: 'Review out/review/9x16/contact.png (review-only).', subagent_type: 'motion-studio:motion-critic' })] },
  { case: 'critic-agent-dispatch', grader: 'critic-dispatched', label: 'bare agent name', pass: true,
    calls: [call('Agent', { description: 'Critique', prompt: 'Review the stills.', subagent_type: 'motion-critic' })] },
  { case: 'critic-agent-dispatch', grader: 'critic-dispatched', label: 'agent field under another key name', pass: true,
    calls: [call('Agent', { prompt: 'Review the stills.', agentType: 'motion-studio:motion-critic' })] },
  { case: 'critic-agent-dispatch', grader: 'critic-dispatched', label: 'general-purpose told to act as the critic', pass: false,
    calls: [call('Agent', { description: 'Critique', prompt: 'Act as the motion-critic and review the stills.', subagent_type: 'general-purpose' })] },
  { case: 'critic-agent-dispatch', grader: 'critic-dispatched', label: 'another plugin agent', pass: false,
    calls: [call('Agent', { description: 'Shot list', prompt: 'Plan the shots.', subagent_type: 'motion-studio:motion-director' })] },
  { case: 'critic-agent-dispatch', grader: 'critic-dispatched', label: 'only the skill fired', pass: false, calls: skill('motion-studio:critique-loop') },
  { case: 'critic-agent-dispatch', grader: 'critic-dispatched', label: 'no call', pass: false, calls: [] },
  { case: 'critic-agent-dispatch', grader: 'round-2-scored', label: 'seven axes', pass: true, text: LOG + ROUND2_GOOD },
  { case: 'critic-agent-dispatch', grader: 'round-2-scored', label: 'untouched (round 1 only)', pass: false, text: LOG },
  { case: 'critic-agent-dispatch', grader: 'round-2-scored', label: 'missing sound', pass: false, text: LOG + ROUND2_MISSING_AXIS },
  { case: 'critic-agent-dispatch', grader: 'round-2-scored', label: 'bold keyword', pass: false, text: LOG + ROUND2_BOLD },
  { case: 'critic-agent-dispatch', grader: 'round-1-kept', label: 'append only', pass: true, text: LOG + ROUND2_GOOD },
  { case: 'critic-agent-dispatch', grader: 'round-1-kept', label: 'round 1 rewritten', pass: false, text: ROUND1_EDITED + ROUND2_GOOD },

  // ---- determinism-edit
  { case: 'determinism-edit', grader: 'no-clock-or-random', label: 'seeded sparkle', pass: true, text: GOOD_SPARKLE },
  { case: 'determinism-edit', grader: 'no-clock-or-random', label: 'Math.random in code', pass: false, text: RANDOM_SPARKLE },
  { case: 'determinism-edit', grader: 'no-clock-or-random', label: 'line comment mention', pass: true,
    text: 'const a = 1; // glints are seeded: never Math.random() or Date.now() here\n' },
  { case: 'determinism-edit', grader: 'no-clock-or-random', label: 'jsdoc mention', pass: true,
    text: '/**\n * Never call Math.random() or setTimeout() in film code.\n */\nexport const x = 1;\n' },
  { case: 'determinism-edit', grader: 'no-clock-or-random', label: 'inline block comment', pass: true,
    text: 'const y = 2; /* not performance.now() */\n' },
  { case: 'determinism-edit', grader: 'no-clock-or-random', label: 'new Date', pass: false, text: 'const born = new Date().getTime();\n' },
  { case: 'determinism-edit', grader: 'no-clock-or-random', label: 'clock before a comment', pass: false,
    text: 'const t0 = performance.now(); // preview only\n' },
  { case: 'determinism-edit', grader: 'no-clock-or-random', label: 'timer', pass: false, text: '  setInterval(() => twinkle++, 16);\n' },
  { case: 'determinism-edit', grader: 'effect-added', label: 'sparkle code', pass: true, text: GOOD_SPARKLE },
  { case: 'determinism-edit', grader: 'effect-added', label: 'no effect', pass: false, text: 'export default defineFilm(() => ({ scenes: [] }));' },
  { case: 'determinism-edit', grader: 'seeded-rng-near-effect', label: 'rngFor per glint', pass: true, text: GOOD_SPARKLE },
  { case: 'determinism-edit', grader: 'seeded-rng-near-effect', label: 'seeded helper far away', pass: false,
    text: `import { rngFor } from '../lib/rng.js';${PAD}function drawSparkles(g, t) { g.fillRect(Math.sin(t) * 9, 0, 2, 2); }` },

  // ---- neg-unrelated
  { case: 'neg-unrelated', grader: 'no-motion-skill', label: 'no skill', pass: true, calls: [] },
  { case: 'neg-unrelated', grader: 'no-motion-skill', label: 'unrelated skill', pass: true, calls: skill('frontend-design') },
  { case: 'neg-unrelated', grader: 'no-motion-skill', label: 'springs fired', pass: false, calls: skill('motion-studio:springs') },
  { case: 'neg-unrelated', grader: 'no-motion-skill', label: 'bare motion skill', pass: false, calls: skill('seek-engine') },
  { case: 'neg-unrelated', grader: 'answers-with-css', label: 'keyframes', pass: true,
    text: '```css\n.spinner { animation: spin 0.8s linear infinite; }\n@keyframes spin { to { transform: rotate(360deg); } }\n```' },
  { case: 'neg-unrelated', grader: 'answers-with-css', label: 'library advice', pass: false, text: 'Install react-spinners and use <ClipLoader />.' },

  // ---- render-smoke (REAL_CLIP_SIDECAR is the sidecar tools/render.mjs wrote for `--format 9x16 --to 2 --draft`)
  { case: 'render-smoke', grader: 'clip-sidecar', label: 'real 0-2 s sidecar', pass: true, text: REAL_CLIP_SIDECAR },
  { case: 'render-smoke', grader: 'clip-sidecar', label: 'compact json', pass: true,
    text: '{"format":"9x16","frames":60,"from":0,"to":2.0,"createdBy":"motion-studio"}' },
  { case: 'render-smoke', grader: 'clip-sidecar', label: 'not written by motion-studio', pass: false,
    text: '{"format":"9x16","frames":120,"from":0,"to":2}' },
  { case: 'render-smoke', grader: 'clip-sidecar', label: 'wrong window', pass: false,
    text: REAL_CLIP_SIDECAR.replace('"to": 2,', '"to": 12,') },
  { case: 'render-smoke', grader: 'clip-sidecar', label: 'wrong format', pass: false,
    text: REAL_CLIP_SIDECAR.replace('"format": "9x16"', '"format": "16x9"') },
  { case: 'render-smoke', grader: 'clip-sidecar', label: 'no frames', pass: false,
    text: REAL_CLIP_SIDECAR.replace('"frames": 120', '"frames": 0') },
  { case: 'render-smoke', grader: 'reports-path', label: 'clip path', pass: true, text: 'Rendered to out/9x16/clip_0.00-2.00.mp4 (2.0 s).' },
  { case: 'render-smoke', grader: 'reports-path', label: 'full render path', pass: true, text: 'Rendered to out/9x16/silent.mp4.' },
  { case: 'render-smoke', grader: 'reports-path', label: 'windows path', pass: true, text: 'File: out\\9x16\\clip_0.00-2.00.mp4' },
  { case: 'render-smoke', grader: 'reports-path', label: 'wrong file', pass: false, text: 'Rendered to out/final.mp4.' },
];

export const WORKSPACE_CHECKS = {
  'critique-writes-log': {
    files: ['studio.json', 'docs/review_log.md', 'out/review/9x16/contact.png'],
    untouched: { 'round-2-logged': false, 'scores-all-axes': false, 'problems-timestamped': false, 'harsh-scores': false,
      'flags-dead-beats': false, 'flags-banned-look': false, 'round-1-kept': true },
    // The fixture's indented format block must not count as a round for the shipped gate.
    gateUntouched: { file: 'docs/review_log.md', rounds: 1, lastAxes: 7, lastTimed: true },
    simulations: [
      { label: 'good round 2', append: { 'docs/review_log.md': ROUND2_GOOD },
        expect: { 'round-2-logged': true, 'scores-all-axes': true, 'problems-timestamped': true, 'harsh-scores': true,
          'flags-dead-beats': true, 'flags-banned-look': true, 'round-1-kept': true },
        gate: { file: 'docs/review_log.md', rounds: 2, lastAxes: 7, lastTimed: true } },
      { label: 'sycophantic round 2', append: { 'docs/review_log.md': ROUND2_SYCOPHANT },
        expect: { 'round-2-logged': true, 'harsh-scores': false, 'problems-timestamped': false, 'round-1-kept': true },
        gate: { file: 'docs/review_log.md', rounds: 2, lastAxes: 7, lastTimed: false } },
      { label: 'round 2 missing an axis', append: { 'docs/review_log.md': ROUND2_MISSING_AXIS },
        expect: { 'round-2-logged': true, 'scores-all-axes': false }, gate: { file: 'docs/review_log.md', rounds: 2, lastAxes: 6 } },
      { label: 'log rewritten', write: { 'docs/review_log.md': ROUND1_EDITED + ROUND2_GOOD }, expect: { 'round-1-kept': false } },
    ],
  },
  'critic-agent-dispatch': {
    files: ['studio.json', 'docs/review_log.md', 'out/review/9x16/contact.png', 'film'],
    // The plugin hooks must see a studio project, so the critic's write passes through role-guard's lane.
    studioProject: true,
    untouched: { 'round-2-scored': false, 'round-1-kept': true },
    gateUntouched: { file: 'docs/review_log.md', rounds: 1, lastAxes: 7 },
    simulations: [
      { label: 'critic appended round 2', append: { 'docs/review_log.md': ROUND2_GOOD },
        expect: { 'round-2-scored': true, 'round-1-kept': true }, gate: { file: 'docs/review_log.md', rounds: 2, lastAxes: 7 } },
      { label: 'round 2 missing an axis', append: { 'docs/review_log.md': ROUND2_MISSING_AXIS },
        expect: { 'round-2-scored': false, 'round-1-kept': true } },
      { label: 'log rewritten', write: { 'docs/review_log.md': ROUND1_EDITED + ROUND2_GOOD }, expect: { 'round-1-kept': false } },
    ],
  },
  'determinism-edit': {
    files: ['studio.json', 'CLAUDE.md', 'film/film.js', 'lib/rng.js', 'lib/motion.js'],
    // The case leans on the post-edit lint hook, which only fires inside a studio project.
    studioProject: true,
    untouched: { 'no-clock-or-random': true, 'effect-added': false, 'seeded-rng-near-effect': false },
    lintUntouched: 0,
    simulations: [
      { label: 'seeded sparkle', append: { 'film/film.js': GOOD_SPARKLE }, lint: 0,
        expect: { 'no-clock-or-random': true, 'effect-added': true, 'seeded-rng-near-effect': true } },
      { label: 'Math.random sparkle', append: { 'film/film.js': RANDOM_SPARKLE }, lint: 1,
        expect: { 'no-clock-or-random': false, 'effect-added': true } },
    ],
  },
  'render-smoke': {
    heavy: true,
    files: ['studio.json', 'film/film.js', 'tools/render.mjs'],
    untouched: { 'made-mp4': false, 'clip-sidecar': false },
    simulations: [
      { label: 'real 2 s draft render', skipOn: ['win32'], node: ['tools/render.mjs', '--format', '9x16', '--to', '2', '--draft'],
        reply: 'Done: out/9x16/clip_0.00-2.00.mp4',
        expect: { 'made-mp4': true, 'clip-sidecar': true, 'reports-path': true } },
    ],
  },
};
