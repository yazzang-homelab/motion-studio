// Critique gate (template/tools/gate.mjs): review-log parsing and the render gate on fixture projects. The end of
// the file holds the browser-free unit tests of the other QA tools: critique-metrics.mjs (pops sampling scale, pop
// detection, loop verdict), doctor.mjs (per-check budgets, filter list, --json), refs.mjs#mp4Durations and deliver.mjs
// (audio length from the container).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.join(HERE, '..', 'skills', 'studio-init', 'template', 'tools');
const GATE = path.join(TOOLS, 'gate.mjs');
const FIX = path.join(HERE, 'fixtures', 'gate');
const { parseReviewLog, checkGate, closedProblemIds } = await import(pathToFileURL(GATE).href);
const fixture = (name) => path.join(FIX, name);
const log = (name) => fs.readFileSync(path.join(FIX, name, 'docs', 'review_log.md'), 'utf8');

test('parseReviewLog: rounds, titles, formats, scores and problems', () => {
  const rounds = parseReviewLog(log('pass'));
  assert.equal(rounds.length, 3);
  assert.deepEqual(rounds.map((r) => r.n), [1, 2, 3]);
  const [r1, , r3] = rounds;
  assert.equal(r1.format, '9x16');
  assert.equal(r1.title, '9x16 — first full pass');
  assert.deepEqual(r1.scores, { hook: 6, readability: 7, motion: 6, variety: 5, composition: 7, brand: 'na', sound: 6 });
  assert.equal(r1.problems.length, 3);
  assert.deepEqual(r1.problems[0], { severity: 'P0', time: 0, timeEnd: null, stamp: '00:00.00', text: 'frame 0 is an empty background (metrics frame0)' });
  assert.equal(r1.problems[1].time, 4.2);
  assert.equal(r1.problems[2].time, 6);
  assert.equal(r1.problems[2].timeEnd, 8);
  assert.equal(r1.fixes, 'none (first round)');
  assert.equal(r3.scores.readability, 9);
  assert.deepEqual(r3.problems.map((p) => p.severity), ['P2', 'P2']);
});

test('parseReviewLog: fenced and commented examples never count', () => {
  assert.deepEqual(parseReviewLog(log('template-only')), []);
  assert.deepEqual(parseReviewLog(''), []);
  assert.deepEqual(parseReviewLog(undefined), []);
});

test('parseReviewLog: lenient formats (markdown bold, list scores, x/10, decimals, bare severities)', () => {
  const [r] = parseReviewLog(log('custom-axes'));
  assert.deepEqual(r.scores, { hook: 7, motion: 6, depth: 6.5, polish: 9 });
  assert.equal(r.format, '16x9');
  assert.deepEqual(r.problems.map((p) => [p.severity, p.time]), [['P1', 12.4], ['P2', 62.5]]);
  assert.equal(r.problems[0].text, 'the camera push stops dead');
  const more = parseReviewLog('## Round 4 - 1x1\r\nSCORES: Sound Sync=8, brand_accuracy=na hook = 9/10\r\nPROBLEMS: none\r\n');
  assert.deepEqual(more[0].scores, { sound: 8, brand: 'na', hook: 9 });
  assert.deepEqual(more[0].problems, []);
});

test('parseReviewLog: unfilled template values are unscored, "[P0|P1|P2]" is no severity', () => {
  const last = parseReviewLog(log('missing-axis')).at(-1);
  assert.deepEqual(last.unscored, ['sound']);
  assert.equal('sound' in last.scores, false);
  assert.equal(last.problems[0].severity, null);
});

test('checkGate: a passing log', () => {
  const r = checkGate(fixture('pass'));
  assert.equal(r.pass, true, r.reasons.join('; '));
  assert.deepEqual(r.reasons, []);
  assert.equal(r.rounds, 3);
  assert.equal(r.last.n, 3);
  assert.equal(r.minRounds, 3);
  assert.equal(r.minScore, 8);
});

test('checkGate: failures name the reason', () => {
  const few = checkGate(fixture('few-rounds'));
  assert.equal(few.pass, false);
  assert.match(few.reasons.join('\n'), /2 scored critique round\(s\) logged; at least 3 required/);

  const low = checkGate(fixture('low-score'));
  assert.equal(low.pass, false);
  assert.deepEqual(low.reasons, ['round 3: below 8: sound=7.5']);

  const p0 = checkGate(fixture('open-p0'));
  assert.equal(p0.pass, false);
  assert.equal(p0.reasons.length, 1);
  assert.match(p0.reasons[0], /round 3: 1 open P0: 1\. \[00:06\.65\] frames differ/);

  const miss = checkGate(fixture('missing-axis'));
  assert.equal(miss.pass, false);
  assert.match(miss.reasons.join('\n'), /round 3: no score for composition, sound \(unfilled: sound\)/);

  const none = checkGate(fixture('template-only'));
  assert.equal(none.pass, false);
  assert.equal(none.rounds, 0);

  const nolog = checkGate(fixture('no-log'));
  assert.equal(nolog.pass, false);
  assert.match(nolog.reasons[0], /docs\/review_log\.md not found/);

  const outside = checkGate(null);
  assert.equal(outside.pass, false);
  assert.match(outside.reasons[0], /not inside a motion-studio project/);
});

// -- open P0 detection is strict by default (qa-tools:F1) ----------------------------------------------------------

const scratch = [];
after(() => { for (const d of scratch) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const AXES8 = 'SCORES: hook=8 readability=8 motion=8 variety=8 composition=8 brand=8 sound=8';
const roundText = (n, body, fixes = 'x') => `## Round ${n} — 9x16 — t\n${AXES8}\n${body}\nFIXES: ${fixes}\n\n`;
/** Gate status of a 3-round log whose first two rounds are clean and whose last round has the given body. */
function gateOf(body, fixes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-gate-'));
  scratch.push(root);
  fs.mkdirSync(path.join(root, 'docs'));
  const clean = 'PROBLEMS:\n1. [P2] [00:01.00] spacing';
  fs.writeFileSync(path.join(root, 'docs', 'review_log.md'), '# Review log\n\n' + roundText(1, clean) + roundText(2, clean) + roundText(3, body, fixes));
  return checkGate(root, { gate: { enabled: true, minScore: 8, minRounds: 3 } });
}
const P0_FORMS = {
  'bold **P0**': '1. **P0** [00:01.00] text overlaps the chart',
  'bold bracket **[P0]**': '1. **[P0]** [00:01.00] text overlaps the chart',
  '(P0)': '1. (P0) [00:01.00] text overlaps the chart',
  'Severity: P0': '1. Severity: P0 — [00:01.00] text overlaps the chart',
  'trailing (P0)': '1. [00:01.00] text overlaps the chart (P0)',
  'P0 after the time': '1. [00:01.00] P0 text overlaps the chart',
  'lower case': '1. [p0] [00:01.00] text overlaps the chart',
  '[BLOCKER]': '1. [BLOCKER] [00:01.00] text overlaps the chart',
  'no space after the number': '1.[P0] [00:01.00] text overlaps the chart',
  'bullet': '- [00:01.00] text overlaps the chart P0',
  'table row': '| # | Severity | Time | Problem |\n|---|---|---|---|\n| 1 | P0 | 00:01.00 | text overlaps the chart |',
  'continuation line': '1. [00:01.00] text overlaps the chart\n   [P0] really broken',
  'bare line, no list marker': '[P0] [00:01.00] text overlaps the chart',
};

test('checkGate: a P0 written in any common form is an open P0 (fail closed)', () => {
  for (const [name, body] of Object.entries(P0_FORMS)) {
    const r = gateOf('PROBLEMS:\n' + body);
    assert.equal(r.pass, false, name);
    assert.match(r.reasons.join('\n'), /round 3: 1 open P0/, name);
    assert.equal(r.last.problems.filter((p) => p.severity === 'P0').length, 1, name);
  }
  // the text is cleaned of the tag and keeps the timestamp
  const [p] = parseReviewLog(roundText(3, 'PROBLEMS:\n1. **[P0]** [00:01.00] text overlaps')).at(-1).problems;
  assert.deepEqual(p, { severity: 'P0', time: 1, timeEnd: null, stamp: '00:01.00', text: 'text overlaps' });
});

test('checkGate: problem section names and headings are recognised (PROBLEM:, ISSUES:, Open problems:, ### Problems)', () => {
  for (const head of ['PROBLEM:', 'ISSUES:', 'Open problems:', 'OPEN ISSUES:', '**Problems:**', '### Problems', '## Open problems', '- PROBLEMS:']) {
    const r = gateOf(head + '\n1. [P0] [00:01.00] text overlaps the chart');
    assert.equal(r.pass, false, head);
    assert.match(r.reasons.join('\n'), /1 open P0/, head);
  }
  const inline = gateOf('PROBLEMS: 1. [P0] [00:01.00] text overlaps the chart');
  assert.equal(inline.pass, false);
});

test('checkGate: a P0 outside PROBLEMS (notes, loose text, an unknown label) fails the gate instead of being dropped', () => {
  const notes = gateOf('PROBLEMS: none\nNOTES: P0 from round 2 is still visible at 00:03');
  assert.equal(notes.pass, false);
  assert.match(notes.reasons.join('\n'), /round 3: P0 mentioned outside PROBLEMS \(line \d+: "P0 from round 2 is still visible at 00:03"\)/);
  const loose = gateOf('Blockers:\n- [P0] [00:01.00] the swap tears');
  assert.equal(loose.pass, false, 'an unknown label above a P0 item');
  assert.match(loose.reasons.join('\n'), /P0 mentioned outside PROBLEMS|open P0/);
  // the round heading is free text and the FIXES block may talk about P0
  const ok = gateOf('PROBLEMS:\n1. [P2] [00:01.00] spacing', 'the P0 from round 2 (frame 0) is gone');
  assert.equal(ok.pass, true, ok.reasons.join('; '));
  const titled = parseReviewLog('## Round 1 — 9x16 — P0 hunt\n' + AXES8 + '\n');
  assert.deepEqual(titled[0].stray, []);
});

test('checkGate: placeholders and "no P0" statements are no P0', () => {
  const noP0 = gateOf('PROBLEMS:\n1. [P1] [00:01.00] weak hook, no P0 left');
  assert.equal(noP0.pass, true, noP0.reasons.join('; '));
  assert.equal(noP0.last.problems[0].severity, 'P1');
  for (const body of ['PROBLEMS: none', 'PROBLEMS:\nnone', 'PROBLEMS: none\nNOTES: no P0 remain, P0: 0', 'PROBLEMS:\n1. [P0|P1|P2] [mm:ss.cc] <what is wrong>', 'PROBLEMS:\n1. [P0 | P1 | P2] [mm:ss.cc] <what>', 'PROBLEMS:\n1. [P2] [00:01.00] 0 open P0']) {
    const r = gateOf(body);
    assert.equal(r.pass, true, body + ' -> ' + r.reasons.join('; '));
  }
  // a single-digit-minute time after the tag is a time, not "P0: 0"
  assert.equal(gateOf('PROBLEMS:\n1. P0: 0:12 text overlaps').pass, false);
});

test('checkGate: a P0 closes only through a FIXES line that names it and says fixed / resolved / wontfix', () => {
  const two = 'PROBLEMS:\n1. [P0] [00:01.00] text overlaps the chart\n2. [P0] [00:04.00] frame 0 is empty\n3. [P1] [00:05.00] slow';
  const open = gateOf(two, 'moved the label; frame 0 now has the headline');
  assert.equal(open.pass, false);
  assert.match(open.reasons.join('\n'), /2 open P0/);
  assert.match(open.reasons.join('\n'), /FIXES line "1\. fixed: \.\.\." or "wontfix"/);
  const half = gateOf(two, '1. fixed: label moved to the next state');
  assert.equal(half.pass, false);
  assert.match(half.reasons.join('\n'), /1 open P0: 2\. \[00:04\.00\] frame 0 is empty/);
  assert.equal(half.p0.closed, 1);
  const both = gateOf(two, '#1 fixed: label moved\n2) resolved: headline at frame 0');
  assert.equal(both.pass, true, both.reasons.join('; '));
  assert.deepEqual(both.p0, { open: 0, closed: 2 });
  assert.equal(gateOf(two, '1. fixed; 2. wontfix').pass, true);
  // negations and planned fixes close nothing
  for (const fixes of ['1. not fixed yet; 2. not resolved', 'will fix 1 and 2', 'fixed', '1. fix planned, 2. unfixed', 'both fixed']) {
    assert.equal(gateOf(two, fixes).pass, false, fixes);
  }
  const ids = closedProblemIds("1. fixed: a\n2. not fixed\n#3 resolved; 4) wontfix, 5. won't fix\nproblem 6: Fixed\n7 fix planned");
  assert.deepEqual([...ids].sort(), [1, 3, 4, 5, 6]);
});

test('checkGate: gate.enabled=false passes; custom axes and thresholds from studio.json or cfg', () => {
  const off = checkGate(fixture('disabled'));
  assert.equal(off.pass, true);
  assert.equal(off.enabled, false);
  assert.match(off.reasons[0], /gate disabled/);

  assert.equal(checkGate(fixture('custom-axes')).pass, true);
  // an explicit cfg wins over studio.json
  const strict = checkGate(fixture('custom-axes'), { gate: { enabled: true, minScore: 8, minRounds: 1, axes: ['hook', 'motion', 'depth'] } });
  assert.equal(strict.pass, false);
  assert.match(strict.reasons[0], /below 8: hook=7 motion=6 depth=6\.5/);
  // cfg with the defaults applies the 7 standard axes
  const std = checkGate(fixture('custom-axes'), { gate: { enabled: true, minScore: 6, minRounds: 1 } });
  assert.match(std.reasons.join('\n'), /no score for readability, variety, composition, brand, sound/);
});

test('checkGate: na passes only on gate.naAllowed axes (default brand), and only the last round counts', () => {
  // brand=na in every round of the passing log: allowed by default
  const ok = checkGate(fixture('pass'));
  assert.equal(ok.pass, true, ok.reasons.join('; '));
  assert.deepEqual(ok.naAllowed, ['brand']);

  // sound=na in the last round fails even with every numeric score ≥ 9
  const na = checkGate(fixture('na-sound'));
  assert.equal(na.pass, false);
  assert.equal(na.reasons.length, 1, na.reasons.join('; '));
  assert.match(na.reasons[0], /^round 3: na not allowed for sound \(gate\.naAllowed: brand\); score 1-10 \(a film that ships with audio needs a sound score/);

  // the project may allow more (a silent film), aliases normalise, duplicates collapse
  const g = (extra) => ({ gate: { enabled: true, minScore: 8, minRounds: 3, ...extra } });
  const silent = checkGate(fixture('na-sound'), g({ naAllowed: ['brand', 'Sound Sync', 'sound'] }));
  assert.equal(silent.pass, true, silent.reasons.join('; '));
  assert.deepEqual(silent.naAllowed, ['brand', 'sound']);

  // an empty list allows no na at all; several axes are named in one reason
  const none = checkGate(fixture('na-sound'), g({ naAllowed: [] }));
  assert.deepEqual(none.reasons, ['round 3: na not allowed for brand, sound (gate.naAllowed: none); score 1-10 (a film that ships with audio needs a sound score: review the mixed render with critique --video)']);
  const noBrand = checkGate(fixture('pass'), g({ naAllowed: [] }));
  assert.deepEqual(noBrand.reasons, ['round 3: na not allowed for brand (gate.naAllowed: none); score 1-10']);

  // a malformed list falls back to the default instead of allowing everything
  for (const bad of ['sound', [1, 2], null, { sound: true }]) {
    const r = checkGate(fixture('na-sound'), g({ naAllowed: bad }));
    assert.equal(r.pass, false, JSON.stringify(bad));
    assert.deepEqual(r.naAllowed, ['brand']);
  }

  // studio.json without naAllowed (and a cfg without gate.naAllowed) uses the default
  assert.deepEqual(checkGate(fixture('custom-axes')).naAllowed, ['brand']);
});

test('gate.naAllowed default is the same in gate.mjs, tools/studio.mjs DEFAULTS and the template studio.json', async () => {
  const tools = path.dirname(GATE);
  const S = await import(pathToFileURL(path.join(tools, 'studio.mjs')).href);
  const template = JSON.parse(fs.readFileSync(path.join(tools, '..', 'studio.json'), 'utf8'));
  assert.deepEqual(S.DEFAULTS.gate.naAllowed, ['brand']);
  assert.deepEqual(template.gate.naAllowed, ['brand']);
  assert.deepEqual(checkGate(fixture('pass'), JSON.parse(JSON.stringify(S.DEFAULTS))).naAllowed, ['brand']);
});

const cli = (dir, args = []) => spawnSync(process.execPath, [GATE, ...args], { cwd: fixture(dir), encoding: 'utf8' });

test('CLI: exit 0 pass / 1 fail, one JSON line, usage errors', () => {
  const ok = cli('pass');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /gate: PASS/);
  const bad = cli('open-p0', ['--json']);
  assert.equal(bad.status, 1);
  const lines = bad.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const j = JSON.parse(lines[0]);
  assert.equal(j.pass, false);
  assert.equal(j.rounds, 3);
  assert.equal(j.last.problems[0].severity, 'P0');
  assert.deepEqual(j.naAllowed, ['brand']);
  const na = cli('na-sound');
  assert.equal(na.status, 1);
  assert.match(na.stdout, /na allowed: brand/);
  assert.match(na.stdout, /- round 3: na not allowed for sound/);
  assert.equal(cli('pass', ['--help']).status, 0);
  const unknown = cli('pass', ['--frobnicate']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /error: unknown option --frobnicate/);
  assert.equal(unknown.stdout, '', 'no envelope without --json');
});

// A usage, config or runtime failure with --json prints exactly one {"ok":false,"error"} line (the human message stays on
// stderr, the exit code is unchanged), so a script that parses stdout never reads an empty string from a failed run.
const cliAsync = (cwd, args = []) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [GATE, ...args], { cwd, windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
  child.on('error', reject);
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

test('CLI --json failures: one {"ok":false,"error"} line for a bad flag, a stray argument and an invalid studio.json', async () => {
  const oneLine = (r) => {
    const lines = r.stdout.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `stdout: ${JSON.stringify(r.stdout)}`);
    return JSON.parse(lines[0]);
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-gatecfg-'));
  scratch.push(dir);
  fs.writeFileSync(path.join(dir, 'studio.json'), JSON.stringify({ fps: 'sixty', gate: { minRounds: -1 } }));
  // Node start-up is slow on some machines, so the cases run side by side.
  const [flag, stray, human, offAfterOn, onAfterOff, bad, badHuman] = await Promise.all([
    cliAsync(fixture('pass'), ['--frobnicate', '--json']), cliAsync(fixture('pass'), ['docs', '--json']), cliAsync(fixture('pass'), ['--json', '--no-json']),
    cliAsync(fixture('pass'), ['--json', '--no-json', '--frobnicate']), cliAsync(fixture('pass'), ['--json=false', '--json=true']),
    cliAsync(dir, ['--json']), cliAsync(dir),
  ]);
  assert.equal(flag.status, 2);
  assert.deepEqual(oneLine(flag), { ok: false, error: 'unknown option --frobnicate' });
  assert.match(flag.stderr, /error: unknown option --frobnicate[\s\S]*Usage: node tools\/gate\.mjs/);
  assert.equal(stray.status, 2);
  assert.deepEqual(oneLine(stray), { ok: false, error: 'unexpected argument docs' });
  // --json=<bool> and --no-json follow the same rule as every other tool: the last switch wins.
  assert.equal(human.status, 0);
  assert.match(human.stdout, /^gate: PASS/, '--no-json after --json gives the human report');
  assert.equal(offAfterOn.stdout, '');
  assert.equal(offAfterOn.status, 2);
  assert.equal(oneLine(onAfterOff).pass, true, '--json=true after --json=false');
  // studio.json that fails validation: exit 1, the error names the file and every problem.
  assert.equal(bad.status, 1, bad.stderr);
  const j = oneLine(bad);
  assert.equal(j.ok, false);
  assert.match(j.error, /studio\.json/);
  assert.match(j.error, /fps must be a number/);
  assert.match(j.error, /gate\.minRounds must be between 0 and 100/);
  assert.match(bad.stderr, /error: invalid .*studio\.json/);
  assert.equal(badHuman.status, 1);
  assert.equal(badHuman.stdout, '', 'without --json a config failure prints nothing on stdout');
});

// A bare `--` ends the options (like parseArgs in studio.mjs, and like lint.mjs); the gate takes no arguments, so anything
// after it is an "unexpected argument" and the --json switches before it still decide the envelope.
test('CLI: a bare -- ends the options; arguments after it are usage errors, and only --json before it counts', async () => {
  const [bare, extra, jsonAfterDashes, jsonBefore] = await Promise.all([
    cliAsync(fixture('pass'), ['--']), cliAsync(fixture('pass'), ['--', 'docs']), cliAsync(fixture('pass'), ['--', '--json']),
    cliAsync(fixture('pass'), ['--json', '--', '--frobnicate']),
  ]);
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.stdout, /^gate: PASS/);
  assert.equal(extra.status, 2);
  assert.equal(extra.stdout, '');
  assert.match(extra.stderr, /error: unexpected argument docs/);
  assert.equal(jsonAfterDashes.status, 2, '`-- --json`: --json is an argument here, not a switch');
  assert.equal(jsonAfterDashes.stdout, '', 'so no envelope');
  assert.match(jsonAfterDashes.stderr, /error: unexpected argument --json/);
  assert.equal(jsonBefore.status, 2);
  assert.deepEqual(JSON.parse(jsonBefore.stdout.trim()), { ok: false, error: 'unexpected argument --frobnicate' });
});

test('CLI usage documents the open-P0 rule', () => {
  const help = cli('pass', ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Open P0 rule \(strict by default\)/);
  assert.match(help.stdout, /any occurrence of the token P0/);
  assert.match(help.stdout, /fixed,\s+resolved or wontfix/);
});

test('importing gate.mjs has no side effects (the hook imports it)', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(GATE).href)}); console.log(process.exitCode ?? 'unset');`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'unset');
});

// The hooks import gate.mjs on every Bash call: static imports are node built-ins only, and studio.mjs (config validation and
// the whole browser stack) is loaded lazily by the CLI, never at import.
test('gate.mjs statically imports only node built-ins; studio.mjs is loaded lazily by the CLI, once', () => {
  const src = fs.readFileSync(GATE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const specs = [...src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(specs.sort(), ['node:fs', 'node:path', 'node:url']);
  assert.equal([...src.matchAll(/studio\.mjs/g)].length, 1, 'studio.mjs is named once outside comments');
  assert.match(src, /await import\(pathToFileURL\(path\.join\(.*'studio\.mjs'\)\)\.href\)/, 'and that mention is the dynamic import inside cli()');
});

// ---------------------------------------------------------------------------------------------------------------
// Browser-free unit tests of the other QA tools. Live critique runs need Chrome and are exercised by hand and by the
// smoke test; the metric maths, the doctor budgets and deliver's audio length are covered here.

const TEMPLATE = process.env.MOTION_TEMPLATE_DIR ? path.resolve(process.env.MOTION_TEMPLATE_DIR) : path.join(HERE, '..', 'skills', 'studio-init', 'template');
const T_TOOLS = path.join(TEMPLATE, 'tools');
const imp = (name) => import(pathToFileURL(path.join(T_TOOLS, name)).href);
const lines = (file) => fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '').split(/\r?\n/).length;

test('QA tools import cleanly (a missing export between them breaks the critique step)', async () => {
  for (const n of ['critique.mjs', 'critique-metrics.mjs', 'refs.mjs', 'deliver.mjs', 'doctor.mjs', 'gate.mjs', 'lint.mjs']) await imp(n);
  const refs = await imp('refs.mjs');
  for (const name of ['probeMedia', 'streamStats', 'mp4Durations', 'measureLoudness', 'readFrames', 'meanAbsDiff', 'VIDEO_NOISE']) assert.ok(name in refs, `refs.mjs exports ${name}`);
});

test('critique.mjs is a driver over sibling modules, and every critique / refs / stills / deliver file stays under 600 lines', async () => {
  const siblings = fs.readdirSync(T_TOOLS).filter((n) => /^(critique.*|refs.*|stills|deliver)\.mjs$/.test(n));
  for (const n of ['critique.mjs', 'critique-metrics.mjs', 'critique-live.mjs', 'critique-video.mjs', 'critique-report.mjs', 'critique-fonts.mjs', 'critique-sheets.mjs', 'refs.mjs', 'refs-pixels.mjs', 'refs-silence.mjs', 'stills.mjs', 'deliver.mjs']) assert.ok(siblings.includes(n), `${n} exists`);
  for (const n of siblings) assert.ok(lines(path.join(T_TOOLS, n)) < 600, `${n} has ${lines(path.join(T_TOOLS, n))} lines`);
  const driver = fs.readFileSync(path.join(T_TOOLS, 'critique.mjs'), 'utf8');
  assert.match(driver, /from '\.\/critique-metrics\.mjs'/);
  assert.doesNotMatch(driver, /class Analyzer|function frameStats|function loopVerdict/, 'the metric maths lives in critique-metrics.mjs');
  // the split modules import cleanly and refs.mjs keeps exporting what moved out of it (critique and deliver import it from there)
  for (const n of siblings) await imp(n);
  const refs = await imp('refs.mjs');
  for (const name of ['encodePNG', 'decodePNG', 'imageStats', 'palette', 'SILENCE', 'parseSilence', 'detectSilence', 'allowedSilence', 'judgeSilence', 'silenceLabel', 'audioGaps', 'makeSheetPages']) assert.ok(name in refs, `refs.mjs exports ${name}`);
});

// -- critique-metrics.mjs ------------------------------------------------------------------------------------------

test('pixelScale: the pop series is sampled at >= 0.5 of the logical width (glyph snapping on a small CPU canvas)', async () => {
  const { pixelScale, PIXEL_SCALE_MIN } = await imp('critique-metrics.mjs');
  assert.equal(PIXEL_SCALE_MIN, 0.5);
  assert.equal(pixelScale(1080), 0.5); // 9x16 and 1x1 (320/1080 = 0.296 before)
  assert.equal(pixelScale(1920), 0.5); // 16x9 (0.167 before)
  assert.ok(Math.abs(pixelScale(540) - 320 / 540) < 1e-12); // small logical widths keep the old 320 px page
  assert.equal(pixelScale(320), 1);
  assert.equal(pixelScale(100), 1); // never upscaled
  for (const w of [1080, 1920, 1440, 4096, 640]) assert.ok(pixelScale(w) >= 0.5 && pixelScale(w) <= 1, String(w));
});

/** 40x40 RGBA frames: a 2x2 dot creeping right one pixel per 3 frames; optional planted flicker / jump / glitch. */
function synthFrames(N, { flickerAt = -1, blockFrom = -1, glitchAt = -1 } = {}) {
  const W = 40; const H = 40;
  const frames = [];
  for (let k = 0; k < N; k++) {
    const b = Buffer.alloc(W * H * 4);
    for (let i = 0; i < b.length; i += 4) { b[i] = 20; b[i + 1] = 20; b[i + 2] = 19; b[i + 3] = 255; }
    const rect = (x0, y0, w, h, v) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = (y * W + x) * 4; b[i] = v; b[i + 1] = v; b[i + 2] = v; } };
    rect(2 + Math.floor(k / 3), 4, 2, 2, 240); // the smooth mover
    if (k === flickerAt) rect(10, 20, 20, 20, 240); // one frame only
    if (blockFrom >= 0 && k >= blockFrom) rect(10, 30, 10, 10, 200); // appears and stays: a hard jump
    if (k === glitchAt) rect(30, 30, 1, 4, 240); // one thin column for one frame: mean diff far below 1
    frames.push(b);
  }
  return { frames, W, H };
}

async function analyze(opts, { shots = [], cues = [] } = {}) {
  const { Analyzer, CRIT_DEFAULTS } = await imp('critique-metrics.mjs');
  const N = 100;
  const { frames, W, H } = synthFrames(N, opts);
  const an = new Analyzer({ fps: 30, frames: N, crit: CRIT_DEFAULTS });
  frames.forEach((buf, k) => an.push(buf, k, W, H));
  return an.finish({ shots, cues, beats: [] });
}

test('Analyzer pops: smooth motion is clean, a planted flicker and a planted jump are both found', async () => {
  const clean = await analyze({});
  assert.deepEqual(clean.pops.list, []);
  assert.deepEqual(clean.pops.cuts, []);
  const px = await analyze({ flickerAt: 40, blockFrom: 70 });
  const flicker = px.pops.list.find((p) => p.kind === 'flicker');
  const jump = px.pops.list.find((p) => p.kind === 'jump');
  assert.equal(flicker?.frame, 40);
  assert.ok(flicker.ratio > 10, `flicker ratio ${flicker.ratio}`);
  assert.equal(jump?.frame, 70);
  assert.ok(jump.ratio > 3);
  assert.equal(px.pops.list.length, 2);
  assert.ok(px.pops.list.every((p) => p.atShotBoundary === false));
});

test('Analyzer pops: a step under 1 level of mean difference is no pop, and a jump on a shot boundary is a cut', async () => {
  const tiny = await analyze({ glitchAt: 52 }); // between two steps of the mover (frames 51 and 54): 0.55 levels in, 0.55 out
  assert.deepEqual(tiny.pops.list, [], 'sub-pixel steps (glyph snapping) are not pops');
  const cut = await analyze({ blockFrom: 70 }, { shots: [{ name: 'a', from: 0, to: 70 / 30 }, { name: 'b', from: 70 / 30, to: 100 / 30 }] });
  assert.deepEqual(cut.pops.list, []);
  assert.equal(cut.pops.cuts.length, 1);
  assert.equal(cut.pops.cuts[0].frame, 70);
});

test('loopClosure: hash(0) vs hash(dur, { wrap: false }), with feature detection of the unwrapped hash', async () => {
  const { loopClosure } = await imp('critique-metrics.mjs');
  // honoured: t = dur and t = 1.5 dur clamp to the same frame
  assert.deepEqual(loopClosure({ h0: 'aa', hEnd: 'aa', hBeyond: 'aa' }), { unwrapped: true, hashEqual: true });
  assert.deepEqual(loopClosure({ h0: 'aa', hEnd: 'bb', hBeyond: 'bb' }), { unwrapped: true, hashEqual: false });
  // ignored: both wrap (dur -> frame 0, 1.5 dur -> the frame at 0.5 dur), so the options object proves nothing
  assert.deepEqual(loopClosure({ h0: 'aa', hEnd: 'aa', hBeyond: 'cc' }), { unwrapped: false, hashEqual: null });
  assert.deepEqual(loopClosure({ h0: 'aa' }), { unwrapped: false, hashEqual: null });
  assert.deepEqual(loopClosure({ h0: 'aa', hEnd: null, hBeyond: null }), { unwrapped: false, hashEqual: null });
});

test('loopVerdict: continuity ratio plus closure (equal hash, or an invisible difference)', async () => {
  const { loopVerdict, LOOP_RATIO, CRIT_DEFAULTS } = await imp('critique-metrics.mjs');
  assert.equal(LOOP_RATIO, 1.5);
  const ok = { seamDiff: 0.5, prevDiff: 0.4 };
  const closes = { unwrapped: true, hashEqual: true, endDiff: 0 };
  const v = loopVerdict(ok, closes, CRIT_DEFAULTS);
  assert.deepEqual([v.pass, v.continuity, v.closes, v.unwrapped, v.hashEqual], [true, true, true, true, true]);
  assert.equal(v.invariant, 'hash(0) === hash(dur, { wrap: false })');
  assert.equal(v.ratio, 1.25);
  // a jump across the seam: ratio 18
  const jump = loopVerdict({ seamDiff: 9, prevDiff: 0.5 }, closes, CRIT_DEFAULTS);
  assert.deepEqual([jump.pass, jump.continuity, jump.closes], [false, false, true]);
  // hashes differ by rounding only (a spring settled to 1e-4): passes on the mean difference
  assert.equal(loopVerdict(ok, { unwrapped: true, hashEqual: false, endDiff: 0.03 }, CRIT_DEFAULTS).pass, true);
  // hashes differ visibly: the loop does not close even though the seam step is smooth
  const open = loopVerdict(ok, { unwrapped: true, hashEqual: false, endDiff: 17.2 }, CRIT_DEFAULTS);
  assert.deepEqual([open.pass, open.continuity, open.closes, open.endDiff], [false, true, false, 17.2]);
  // no unwrapped hash (video mode, DOM film, older runtime): continuity only
  const video = loopVerdict(ok, null, CRIT_DEFAULTS);
  assert.deepEqual([video.pass, video.unwrapped, video.hashEqual, video.invariant], [true, false, null, null]);
  // a static seam (both steps zero) is continuous
  assert.equal(loopVerdict({ seamDiff: 0, prevDiff: 0 }, closes, CRIT_DEFAULTS).continuity, true);
  assert.equal(loopVerdict({ seamDiff: 0.2, prevDiff: 0 }, null, CRIT_DEFAULTS).continuity, true);
  assert.equal(loopVerdict({ seamDiff: 2, prevDiff: 0 }, null, CRIT_DEFAULTS).continuity, false);
});

// -- frame 0 and border metrics on synthetic frames (qa-tools:F8, F9) -----------------------------------------------

const SIZES_ML = { '9x16': [160, 284], '1x1': [160, 160], '16x9': [160, 90] };
function paint(w, h, fn) {
  const b = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = fn(x, y, w, h); const i = (y * w + x) * 4; b[i] = c[0]; b[i + 1] = c[1]; b[i + 2] = c[2]; b[i + 3] = 255; }
  return b;
}
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const SCENES = {
  solid: (c) => () => c,
  vgrad: (a, b) => (x, y, w, h) => mix(a, b, y / (h - 1)),
  diag: (a, b) => (x, y, w, h) => mix(a, b, (x / w + y / h) / 2),
  // lib/draw.js vignette(): radial gradient from 0.35 of the half-diagonal (clear) to the corner (strength), over a flat colour
  vignette: (bg, strength) => (x, y, w, h) => {
    const rad = Math.hypot(w, h) / 2;
    const t = Math.min(1, Math.max(0, (Math.hypot(x - w / 2, y - h / 2) - rad * 0.35) / (rad * 0.65)));
    return bg.map((v) => Math.round(v * (1 - t * strength)));
  },
  dot: (base, c, r = 0.09) => (x, y, w, h) => (Math.hypot(x - w * 0.3, y - h * 0.4) < w * r ? c : base(x, y, w, h)),
  card: (bg, c, m) => (x, y, w, h) => (x >= w * m && x < w - w * m && y >= h * m && y < h - h * m ? c : bg),
  stroke: (bg, c, t) => (x, y, w, h) => (x < t || y < t || x >= w - t || y >= h - t ? c : bg),
  block: (bg, c) => (x, y, w, h) => (x > w * 0.2 && x < w * 0.8 && y > h * 0.3 && y < h * 0.7 ? c : bg),
};

test('frame 0: gradients and vignettes with nothing drawn are empty (P0); a shape, text-sized content or a low-contrast block is not', async () => {
  const { Analyzer, CRIT_DEFAULTS, findings } = await imp('critique-metrics.mjs');
  const frame0 = (w, h, fn) => {
    const an = new Analyzer({ fps: 30, frames: 30, crit: CRIT_DEFAULTS });
    const buf = paint(w, h, fn);
    for (let k = 0; k < 30; k++) an.push(buf, k, w, h);
    return an.finish({ shots: [], cues: [], beats: [] });
  };
  const empty = {
    'solid dark': SCENES.solid([20, 20, 19]),
    'black-white gradient': SCENES.vgrad([0, 0, 0], [255, 255, 255]),
    'navy-purple diagonal': SCENES.diag([10, 20, 60], [110, 40, 130]),
    'light vignette 0.35': SCENES.vignette([245, 240, 232], 0.35),
    'brand-orange vignette': SCENES.vignette([217, 119, 87], 0.35),
  };
  const filled = {
    'dot on a gradient': SCENES.dot(SCENES.diag([10, 20, 60], [110, 40, 130]), [255, 255, 255]),
    'dot on solid': SCENES.dot(SCENES.solid([20, 20, 19]), [240, 238, 230]),
    'low-contrast block': SCENES.block([20, 20, 19], [60, 60, 59]),
  };
  for (const [fmt, [w, h]] of Object.entries(SIZES_ML)) {
    for (const [name, fn] of Object.entries(empty)) {
      const r = frame0(w, h, fn);
      assert.equal(r.frame0.pass, false, `${name} ${fmt}: content ${r.frame0.content}`);
      assert.ok(r.frame0.content < 0.005, `${name} ${fmt}: ${r.frame0.content}`);
    }
    for (const [name, fn] of Object.entries(filled)) {
      const r = frame0(w, h, fn);
      assert.equal(r.frame0.pass, true, `${name} ${fmt}: content ${r.frame0.content}`);
    }
  }
  // the finding a gradient opener now gets
  const r = frame0(160, 284, SCENES.vgrad([0, 0, 0], [255, 255, 255]));
  const f = findings({ film: { duration: 1, fps: 30 }, px: r, determinism: { skipped: true }, audio: { skipped: true }, loop: { enabled: false }, sync: { cues: 0, impactShare: null, offGrid: [], shotChanges: 0, shotChangesOnDownbeat: 0 } }, CRIT_DEFAULTS);
  assert.ok(f.some((x) => x.severity === 'P0' && x.metric === 'frame0' && /frame 0 is nearly empty/.test(x.text)));
});

test('borders: a thin stroke along the edges is found; the engine vignette, a gradient and a wide margin around a card are not', async () => {
  const { frameStats } = await imp('critique-metrics.mjs');
  const sides = (w, h, fn) => frameStats(paint(w, h, fn), w, h, 0.08);
  for (const [fmt, [w, h]] of Object.entries(SIZES_ML)) {
    for (const [name, fn] of Object.entries({
      'orange 2 px frame on dark': SCENES.stroke([20, 20, 19], [217, 119, 87], 2),
      'dark 1 px frame on light': SCENES.stroke([245, 240, 232], [20, 20, 19], 1),
    })) {
      const s = sides(w, h, fn);
      assert.equal(s.border, true, `${name} ${fmt}: ${JSON.stringify(s.sides)}`);
    }
    for (const [name, fn] of Object.entries({
      'light vignette 0.35': SCENES.vignette([240, 238, 230], 0.35),
      'light vignette 0.2': SCENES.vignette([240, 238, 230], 0.2),
      'orange vignette 0.35': SCENES.vignette([217, 119, 87], 0.35),
      'black-white gradient': SCENES.vgrad([0, 0, 0], [255, 255, 255]),
      'card on a coloured backdrop (7% margin)': SCENES.card([217, 119, 87], [250, 250, 250], 0.07),
    })) {
      const s = sides(w, h, fn);
      assert.equal(s.border, false, `${name} ${fmt}: ${JSON.stringify(s.sides)}`);
      assert.deepEqual(Object.values(s.sides).filter(Boolean), [], `${name} ${fmt} trips a side`);
    }
  }
});

test('findings: a loop that neither flows nor closes is one P0 naming both reasons, and pops rank below it', async () => {
  const { findings, loopVerdict, CRIT_DEFAULTS } = await imp('critique-metrics.mjs');
  const px = await analyze({ flickerAt: 40, blockFrom: 70 });
  const r = {
    film: { duration: 12, fps: 30 }, px, determinism: { skipped: true }, audio: { skipped: true },
    loop: loopVerdict({ seamDiff: 17.264, prevDiff: 0.067 }, { unwrapped: true, hashEqual: false, endDiff: 17.242 }, CRIT_DEFAULTS),
    sync: { cues: 0, impactShare: null, offGrid: [], shotChanges: 0, shotChangesOnDownbeat: 0 },
  };
  const f = findings(r, CRIT_DEFAULTS);
  const loop = f.filter((x) => x.metric === 'loop');
  assert.equal(loop.length, 1);
  assert.equal(loop[0].severity, 'P0');
  assert.match(loop[0].text, /loop seam jumps: last→first diff 17\.264 vs 0\.067/);
  assert.match(loop[0].text, /loop does not close: frame t=dur \(unwrapped\) ≠ frame 0/);
  assert.equal(loop[0].t, 12);
  assert.ok(f.some((x) => x.metric === 'pops' && x.severity === 'P1' && /single-frame pop at frame 40/.test(x.text)));
  assert.ok(f.some((x) => x.metric === 'pops' && x.severity === 'P2' && /hard jump at frame 70/.test(x.text)));
  const rank = f.map((x) => ({ P0: 0, P1: 1, P2: 2 })[x.severity]);
  assert.deepEqual(rank, [...rank].sort((a, b) => a - b));
});

// -- doctor.mjs ----------------------------------------------------------------------------------------------------

test('doctor FILTERS covers every filter mix.mjs builds a graph with (apad + atrim included)', async () => {
  const { FILTERS, TIMEOUTS } = await imp('doctor.mjs');
  for (const f of ['loudnorm', 'ebur128', 'alimiter', 'sidechaincompress', 'amix', 'tmix', 'scale', 'apad', 'atrim']) assert.ok(FILTERS.includes(f), f);
  assert.ok(Object.isFrozen(FILTERS) && Object.isFrozen(TIMEOUTS));
  for (const k of ['playwright', 'browser', 'ffmpeg', 'python']) assert.ok(TIMEOUTS[k] > 0 && TIMEOUTS[k] <= 90000, k);
  const mix = fs.readFileSync(path.join(T_TOOLS, 'mix.mjs'), 'utf8');
  for (const f of ['apad', 'atrim', 'loudnorm', 'alimiter', 'sidechaincompress', 'amix', 'ebur128']) assert.match(mix, new RegExp(`\\b${f}\\b`), `mix.mjs uses ${f}`);
});

test('withTimeout: value, timeout marker, late value to onLate, rejection', async () => {
  const { withTimeout } = await imp('doctor.mjs');
  assert.equal(await withTimeout(async () => 7, 500), 7);
  const late = [];
  assert.equal(await withTimeout(() => new Promise((r) => setTimeout(() => r('late'), 120)), 30, { onLate: (v) => late.push(v) }), withTimeout.TIMED_OUT);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(late, ['late']);
  const early = [];
  assert.equal(await withTimeout(async () => 'fast', 500, { onLate: (v) => early.push(v) }), 'fast');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(early, []);
  await assert.rejects(withTimeout(async () => { throw new Error('boom'); }, 500), /boom/);
});

const filterTable = (names) => ` Filters:\n  T.. = Timeline support\n ... = Slice threading\n ------\n${names.map((n) => ` T.C ${n.padEnd(17)} A->A       fake ${n}`).join('\n')}\n`;
/** Injectable doctor probes: every call takes `delay` ms; ids in `hang` never answer. `log` collects side effects. */
function fakeProbes(filters, { delay = 0, hang = [], log = [] } = {}) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const answer = (id, v) => (hang.includes(id) ? new Promise(() => {}) : wait(delay).then(() => v));
  return {
    playwright: () => answer('playwright', '1.63.0'),
    // The bundled headless shell: on Windows an installed Chrome/Edge is a WARN row (test/studio.test.mjs covers that).
    browser: () => answer('browser', { via: 'chromium-headless-shell', version: '153.0', risk: null, browser: { close: async () => { log.push('browser closed'); } } }),
    logonGuard: () => ({ count: 0, max: 4, allowed: 3, blocked: false, refuse: false, override: false, waitMs: 0, file: '/fake/system-browser-launches.json' }),
    resolve: (fn) => Object.assign(answer(fn === 'resolveFfmpeg' ? 'ffmpeg' : 'python', fn === 'resolveFfmpeg' ? '/fake/ffmpeg' : '/fake/python'), { stop: () => log.push(`stop ${fn}`) }),
    run: async (cmd, args) => {
      await wait(delay);
      if (args.includes('-version')) return { code: 0, stdout: 'ffmpeg version 6.1.1 Copyright (c) 2000 --enable-gpl\n', stderr: '', timedOut: false };
      if (args.includes('-filters')) return { code: 0, stdout: filterTable(filters), stderr: '', timedOut: false };
      return { code: 0, stdout: '3.12.1 librosa 0.10.2', stderr: '', timedOut: false };
    },
  };
}

test('doctor checks: all green with fast probes, and a missing filter is named', async () => {
  const { checks, failedChecks, FILTERS } = await imp('doctor.mjs');
  const list = await checks(TEMPLATE, { probes: fakeProbes(FILTERS), cleanups: [] });
  const by = Object.fromEntries(list.map((c) => [c.id, c]));
  for (const id of ['node', 'project', 'config', 'playwright', 'browser', 'ffmpeg', 'filters', 'python', 'fonts']) assert.equal(by[id].status, 'ok', `${id}: ${by[id].detail}`);
  assert.equal(by.filters.detail, FILTERS.join(' '));
  assert.deepEqual(failedChecks(list), []);
  assert.deepEqual(list.map((c) => c.id), ['node', 'routeB', 'project', 'config', 'playwright', 'browser', ...(process.platform === 'win32' ? ['windows-logon-guard'] : []), 'ffmpeg', 'filters', 'python', 'fonts', 'keys']);
  const noApad = await checks(TEMPLATE, { probes: fakeProbes(FILTERS.filter((f) => f !== 'apad' && f !== 'atrim')), cleanups: [] });
  const f = noApad.find((c) => c.id === 'filters');
  assert.equal(f.status, 'fail');
  assert.equal(f.detail, 'missing: apad, atrim');
  assert.ok(f.fix);
});

test('doctor checks: a fonts.json entry that leaves the project (drive, UNC, ..) or has no usable src fails the fonts row without crashing', async () => {
  const { checks, FILTERS } = await imp('doctor.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-doctorfonts-'));
  scratch.push(root);
  fs.mkdirSync(path.join(root, 'assets', 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'studio.json'), '{}');
  fs.writeFileSync(path.join(root, 'assets', 'fonts', 'ok.woff2'), 'x');
  const entries = [{ family: 'Fine', src: 'assets/fonts/ok.woff2' }, { family: 'Drive', src: 'V:/victim.txt' }, { family: 'Share', src: '//srv/share/x.woff2' }, { family: 'Up', src: '../../x.woff2' }, { family: 'Num', src: 42 }];
  fs.writeFileSync(path.join(root, 'assets', 'fonts', 'fonts.json'), JSON.stringify(entries));
  const list = await checks(root, { probes: fakeProbes(FILTERS), cleanups: [] });
  const fonts = list.find((c) => c.id === 'fonts');
  assert.equal(fonts.status, 'fail');
  assert.match(fonts.detail, /V:\/victim\.txt is outside the project: keep fonts under assets\/fonts\//);
  assert.match(fonts.detail, /\/\/srv\/share\/x\.woff2 is outside the project/);
  assert.match(fonts.detail, /\.\.\/\.\.\/x\.woff2 is outside the project/);
  assert.match(fonts.detail, /missing \(no src\)/, 'a non-string src is reported, not thrown');
  assert.doesNotMatch(fonts.detail, /Fine|ok\.woff2/, 'the bundled font is fine');
  assert.ok(fonts.fix);
});

test('doctor checks: independent checks run concurrently', async () => {
  const { checks, FILTERS } = await imp('doctor.mjs');
  const delay = 300; // every probe takes 300 ms: three chains of two steps = ~600 ms concurrent, ~1800 ms in series
  const t0 = Date.now();
  const list = await checks(TEMPLATE, { probes: fakeProbes(FILTERS, { delay }), cleanups: [] });
  const ms = Date.now() - t0;
  assert.ok(list.every((c) => c.status !== 'timeout' && c.status !== 'fail'), JSON.stringify(list.filter((c) => c.status === 'fail')));
  assert.ok(ms < 1400, `checks took ${ms} ms; independent checks must overlap`);
});

test('doctor checks: a hanging check becomes a "timeout" row after its own budget while the rest still answers', async () => {
  const { checks, failedChecks, FILTERS } = await imp('doctor.mjs');
  const log = [];
  const t0 = Date.now();
  const list = await checks(TEMPLATE, { probes: fakeProbes(FILTERS, { hang: ['browser', 'ffmpeg', 'python'], log }), timeouts: { browser: 150, ffmpeg: 200, python: 250 }, cleanups: [] });
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `took ${ms} ms`);
  const by = Object.fromEntries(list.map((c) => [c.id, c]));
  assert.equal(by.playwright.status, 'ok');
  assert.equal(by.browser.status, 'timeout');
  assert.match(by.browser.detail, /launching headless Chrome\/Edge\/Chromium gave no answer within \d+ s/);
  assert.equal(by.ffmpeg.status, 'timeout');
  assert.equal(by.filters.status, 'timeout');
  assert.equal(by.python.status, 'timeout');
  assert.equal(by.fonts.status, 'ok');
  assert.ok(log.includes('stop resolveFfmpeg') && log.includes('stop resolvePython'), 'the hung resolver workers are stopped');
  // required checks that timed out fail the doctor; the optional Python one does not
  assert.deepEqual(failedChecks(list).map((c) => c.id).sort(), ['browser', 'ffmpeg', 'filters']);
  assert.equal(by.python.required, false);
  for (const c of list.filter((x) => x.status === 'timeout')) assert.ok(c.fix, `${c.id} has a fix hint`);
});

test('doctor checks: Playwright that never loads times out and the browser row says why', async () => {
  const { checks, FILTERS } = await imp('doctor.mjs');
  const list = await checks(TEMPLATE, { probes: fakeProbes(FILTERS, { hang: ['playwright'] }), timeouts: { playwright: 100 }, cleanups: [] });
  const by = Object.fromEntries(list.map((c) => [c.id, c]));
  assert.equal(by.playwright.status, 'timeout');
  assert.equal(by.browser.status, 'timeout');
  assert.match(by.browser.detail, /Playwright did not load/);
  assert.equal(by.ffmpeg.status, 'ok');
});

test('doctor checks: a browser that launches after its budget is closed, not leaked', async () => {
  const { checks, FILTERS } = await imp('doctor.mjs');
  const log = [];
  const probes = { ...fakeProbes(FILTERS, { log }), browser: () => new Promise((r) => setTimeout(() => r({ via: 'chrome', version: '154', browser: { close: async () => { log.push('late browser closed'); } } }), 200)) };
  const list = await checks(TEMPLATE, { probes, timeouts: { browser: 80 }, cleanups: [] });
  assert.equal(list.find((c) => c.id === 'browser').status, 'timeout');
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(log.filter((x) => x === 'late browser closed'), ['late browser closed']);
});

test('doctor CLI: --json always arrives as one line within its own time budgets, even without a project', { timeout: 200000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-doctor-'));
  scratch.push(dir); // removed by the after() hook even when an assertion below fails
  const t0 = Date.now();
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(T_TOOLS, 'doctor.mjs'), '--json'], { cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  const ms = Date.now() - t0;
  // doctor's own worst case is playwright 30 s + browser 60 s + 5 s exit grace = 95 s; under a loaded machine (4 test files at once, ~2 s per child process) it needs more headroom than that.
  assert.ok(ms < 150000, `doctor took ${ms} ms`);
  const out = r.stdout.trim().split('\n');
  assert.equal(out.length, 1, r.stdout + r.stderr);
  const j = JSON.parse(out[0]);
  assert.equal(j.ok, r.code === 0);
  assert.equal(j.root, null);
  assert.equal(j.checks.find((c) => c.id === 'project').status, 'fail');
  assert.equal(r.code, 1, 'no project = a required check failed');
  for (const c of j.checks) assert.ok(['ok', 'fail', 'warn', 'info', 'timeout'].includes(c.status), `${c.id}: ${c.status}`);
  const f = j.checks.find((c) => c.id === 'filters');
  if (f.status === 'ok') assert.match(f.detail, /\bapad\b.*\batrim\b/);
});

// -- refs.mjs#mp4Durations + deliver.mjs ---------------------------------------------------------------------------

const REPO = path.join(HERE, '..');
function findFfmpeg() {
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  try { const p = createRequire(path.join(REPO, 'package.json'))('ffmpeg-static'); if (typeof p === 'string') candidates.push(p); } catch { /* not installed */ }
  for (const c of candidates) if (spawnSync(c, ['-hide_banner', '-version'], { timeout: 30000, windowsHide: true }).status === 0) return c;
  return null;
}
const FFMPEG = findFfmpeg();
const NO_FFMPEG = FFMPEG ? false : 'ffmpeg not found (set FFMPEG_PATH or npm install ffmpeg-static at the repo root)';
if (FFMPEG) process.env.FFMPEG_PATH = FFMPEG;

const spawnP = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts });
  let stdout = ''; let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('error', reject);
  p.on('close', (code) => resolve({ code, stdout, stderr }));
});
/** A tiny h264 + AAC mp4: `v` seconds of `size` (default 72x128) @ 24 fps video and `a` seconds of a 440 Hz tone (mono in, stereo out). */
async function makeMp4(file, { v = 2, a = 2, size = '72x128' } = {}) {
  const r = await spawnP(FFMPEG, ['-hide_banner', '-y', '-f', 'lavfi', '-i', `color=c=0x141413:s=${size}:r=24:d=${v}`, '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${a}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', file]);
  if (r.code !== 0) throw new Error(`ffmpeg failed:\n${r.stderr.slice(-1500)}`);
}

test('mp4Durations: the container length of the AAC track is exact (the edit list trims priming and padding)', { skip: NO_FFMPEG }, async () => {
  const { mp4Durations } = await imp('refs.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-mp4-'));
  try {
    const file = path.join(dir, 'a.mp4');
    await makeMp4(file, { v: 2, a: 2 });
    const d = mp4Durations(file);
    assert.ok(d, 'moov parsed');
    assert.ok(Math.abs(d.video.duration - 2) < 0.001, `video ${d.video.duration}`);
    assert.ok(Math.abs(d.audio.duration - 2) < 0.001, `audio ${d.audio.duration}: 96000 samples at 48 kHz, not the whole AAC frames the encoder wrote`);
    assert.ok(d.audio.mediaDuration >= d.audio.duration - 1e-9, 'the media duration keeps the AAC frames the edit list trims');
    // a shorter audio track is reported as shorter
    const short = path.join(dir, 'short.mp4');
    await makeMp4(short, { v: 2, a: 1.5 });
    const s = mp4Durations(short);
    assert.ok(Math.abs(s.audio.duration - 1.5) < 0.001 && Math.abs(s.video.duration - 2) < 0.001, JSON.stringify(s.audio));
    // not media: null, never a throw
    const junk = path.join(dir, 'junk.mp4');
    fs.writeFileSync(junk, Buffer.from('not an mp4 file at all, just text'));
    assert.equal(mp4Durations(junk), null);
    assert.equal(mp4Durations(path.join(dir, 'missing.mp4')), null);
    const cut = path.join(dir, 'cut.mp4');
    fs.writeFileSync(cut, fs.readFileSync(file).subarray(0, 40));
    assert.equal(mp4Durations(cut), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

async function deliverProject(audioSeconds) {
  const { measureLoudness } = await imp('refs.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-deliver-'));
  scratch.push(root); // removed by the after() hook even when a step below throws
  fs.mkdirSync(path.join(root, 'out', '9x16'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const file = path.join(root, 'out', '9x16', 'final.mp4');
  await makeMp4(file, { v: 2, a: audioSeconds, size: '1080x1920' }); // deliver expects the full-size master of the format
  const L = await measureLoudness(root, file);
  fs.writeFileSync(path.join(root, 'studio.json'), JSON.stringify({
    title: 'Deliver Test', duration: 2, fps: 24, formats: ['9x16'], primaryFormat: '9x16', gate: { enabled: false },
    audio: { lufs: Math.round(L.I * 10) / 10, lufsTolerance: 0.5, truePeak: 0 },
  }));
  fs.writeFileSync(path.join(root, 'out', '9x16', 'render.json'), JSON.stringify({ format: '9x16', fps: 24, frames: 48, width: 1080, height: 1920, scale: 1, final: true }));
  fs.writeFileSync(path.join(root, 'out', '9x16', 'poster.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(root, 'studio.json'), old, old); // the config predates the render: no "sources newer" warning
  const r = await spawnP(process.execPath, [path.join(T_TOOLS, 'deliver.mjs'), '--json'], { cwd: root, env: { ...process.env, FFMPEG_PATH: FFMPEG } });
  return { root, r, manifest: JSON.parse(fs.readFileSync(path.join(root, 'out', 'deliver', 'manifest.json'), 'utf8')) };
}

test('deliver: audio length comes from the container, so a full-length AAC track passes and a short one fails', { skip: NO_FFMPEG, timeout: 900000 }, async () => {
  const [good, short] = await Promise.all([deliverProject(2), deliverProject(1.5)]);
  try {
    const gf = good.manifest.formats[0];
    const gc = Object.fromEntries(gf.checks.map((c) => [c.id, c]));
    assert.equal(good.r.code, 0, good.r.stdout + good.r.stderr);
    assert.equal(gf.audioLength.from, 'container');
    assert.ok(Math.abs(gf.audioLength.seconds - 2) < 0.001, `audio ${gf.audioLength.seconds} s`);
    assert.equal(gc['audio length'].pass, true);
    assert.equal(gc['audio length'].value, gf.audioLength.seconds);
    assert.match(gc['audio length'].note, /container duration/);
    assert.equal(good.manifest.pass, true);
    assert.ok(fs.existsSync(path.join(good.root, 'out', 'deliver', 'deliver-test_9x16.mp4')));
    assert.ok(fs.existsSync(path.join(good.root, 'docs', 'production.json')));
    const sf = short.manifest.formats[0];
    const sc = Object.fromEntries(sf.checks.map((c) => [c.id, c]));
    assert.equal(short.r.code, 1, short.r.stdout + short.r.stderr);
    assert.equal(sc['audio length'].pass, false);
    assert.ok(Math.abs(sf.audioLength.seconds - 1.5) < 0.001, `audio ${sf.audioLength.seconds} s`);
    assert.equal(short.manifest.pass, false);
    assert.equal(fs.existsSync(path.join(short.root, 'out', 'deliver', 'deliver-test_9x16.mp4')), false, 'a failing delivery copies nothing');
    assert.match(JSON.parse(short.r.stdout.trim().split('\n').pop()).failed.join('\n'), /audio length/);
  } finally {
    for (const p of [good, short]) fs.rmSync(p.root, { recursive: true, force: true });
  }
});

// -- critique.mjs --video keeps the live evidence (skill-executability:F1) -------------------------------------------

/** A project with a final.mp4 and, optionally, live-film evidence from an earlier `critique` run. */
async function critiqueProject({ live }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-critique-'));
  scratch.push(root);
  fs.mkdirSync(path.join(root, 'out', '9x16'), { recursive: true });
  fs.writeFileSync(path.join(root, 'studio.json'), JSON.stringify({ title: 'Critique Video', duration: 2, fps: 24, formats: ['9x16'], primaryFormat: '9x16', gate: { enabled: false } }));
  await makeMp4(path.join(root, 'out', '9x16', 'final.mp4'), { v: 2, a: 2 });
  if (live) {
    const dir = path.join(root, 'out', 'review', '9x16');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify({ mode: 'live', sentinel: 'LIVE-METRICS' }));
    fs.writeFileSync(path.join(dir, 'metrics.md'), 'LIVE-MD');
    fs.writeFileSync(path.join(dir, 'contact.png'), 'LIVE-CONTACT');
  }
  // No browser: the labelled sheets fall back to an ffmpeg tile, and the run needs nothing but ffmpeg.
  const env = { ...process.env, FFMPEG_PATH: FFMPEG, MOTION_CHROME_PATH: path.join(root, 'no-such-browser.exe') };
  const r = await spawnP(process.execPath, [path.join(T_TOOLS, 'critique.mjs'), '--format', '9x16', '--video', '--json'], { cwd: root, env });
  return { root, r };
}

test('reviewDir: the live film writes to out/review/<fmt>/, a rendered mp4 to out/review/<fmt>/video/', async () => {
  const { reviewDir } = await imp('critique.mjs');
  assert.equal(reviewDir('/p', '9x16', false), path.join('/p', 'out', 'review', '9x16'));
  assert.equal(reviewDir('/p', '9x16', true), path.join('/p', 'out', 'review', '9x16', 'video'));
});

test('critique --video writes its evidence to out/review/<fmt>/video/ and never touches the live film evidence', { skip: NO_FFMPEG, timeout: 900000 }, async () => {
  const [withLive, without] = await Promise.all([critiqueProject({ live: true }), critiqueProject({ live: false })]);
  const live = path.join(withLive.root, 'out', 'review', '9x16');
  assert.equal(withLive.r.code, 0, withLive.r.stderr);
  // the live files are byte for byte what they were
  assert.equal(fs.readFileSync(path.join(live, 'contact.png'), 'utf8'), 'LIVE-CONTACT');
  assert.equal(fs.readFileSync(path.join(live, 'metrics.md'), 'utf8'), 'LIVE-MD');
  assert.equal(JSON.parse(fs.readFileSync(path.join(live, 'metrics.json'), 'utf8')).sentinel, 'LIVE-METRICS');
  // the video evidence sits next to it
  const video = path.join(live, 'video');
  const m = JSON.parse(fs.readFileSync(path.join(video, 'metrics.json'), 'utf8'));
  assert.equal(m.mode, 'video');
  assert.equal(m.dir, 'out/review/9x16/video');
  for (const f of ['contact.png', 'shots.png', 'phone.png', 'strip.png', 'metrics.md']) assert.ok(fs.existsSync(path.join(video, f)), `video/${f}`);
  assert.ok(fs.statSync(path.join(video, 'contact.png')).size > 100 && fs.readFileSync(path.join(video, 'contact.png'))[1] === 0x50, 'a real PNG');
  // the JSON result and the printed report say where each lives
  const j = JSON.parse(withLive.r.stdout.trim().split('\n').pop());
  assert.equal(j.dir, 'out/review/9x16/video');
  assert.equal(j.other.dir, 'out/review/9x16');
  assert.equal(j.other.mode, 'live');
  const md = fs.readFileSync(path.join(video, 'metrics.md'), 'utf8');
  assert.match(md, /## Evidence \(out\/review\/9x16\/video\/\)/);
  assert.match(md, /Live-film evidence from an earlier run: out\/review\/9x16\/ \(metrics\.json \d{4}-/);
  assert.match(md, /- text overlapping during swaps: video\/contact\.png \+ video\/strip\.png around every state change/, 'the hunt list names the video files');
  assert.match(md, /- readability \(video\/phone\.png, 360 px\)/, 'so does the rubric');
  // without earlier live evidence the report says so and nothing is invented
  const jn = JSON.parse(without.r.stdout.trim().split('\n').pop());
  assert.equal(without.r.code, 0, without.r.stderr);
  assert.equal(jn.other, null);
  assert.match(fs.readFileSync(path.join(without.root, 'out', 'review', '9x16', 'video', 'metrics.md'), 'utf8'), /No live-film evidence yet: run node tools\/critique\.mjs \(without --video\)/);
  assert.equal(fs.existsSync(path.join(without.root, 'out', 'review', '9x16', 'metrics.json')), false, 'a video run must not create live evidence');
});

// -- refs.mjs: clips without a Duration line, and clips too short to measure (qa-tools:F10) --------------------------------

/** A silent h264 clip of `segments` solid-colour segments of `seconds` each (hard cuts between them): 160x90 @ 10 fps. */
async function makeClip(file, { segments = 3, seconds = 1, size = '160x90' } = {}) {
  const colors = ['red', 'blue', 'green', 'yellow', 'white'];
  const inputs = Array.from({ length: segments }, (_, i) => ['-f', 'lavfi', '-i', `color=c=${colors[i % colors.length]}:s=${size}:r=10:d=${seconds}`]).flat();
  const chain = `${Array.from({ length: segments }, (_, i) => `[${i}]`).join('')}concat=n=${segments}:v=1:a=0,format=yuv420p`;
  const r = await spawnP(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', chain, '-c:v', 'libx264', '-preset', 'ultrafast', file]);
  if (r.code !== 0) throw new Error(`ffmpeg failed:\n${r.stderr.slice(-1500)}`);
}

/** The same clip remuxed to matroska on a pipe: the muxer cannot seek back, so the file carries no Duration (a recorder's webm). */
function streamCopy(src, dest) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-c', 'copy', '-f', 'matroska', 'pipe:1'], { maxBuffer: 1 << 26, windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg remux failed: ${String(r.stderr).slice(-500)}`);
  fs.writeFileSync(dest, r.stdout);
}

test('refs analyze: a container without a Duration is measured from its packets (length, cuts and shot lengths stay right)', { skip: NO_FFMPEG, timeout: 900000 }, async () => {
  const { analyzeVideo, probeMedia, summaryMarkdown } = await imp('refs.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-refs-'));
  scratch.push(dir);
  const mp4 = path.join(dir, 'three.mp4');
  const mkv = path.join(dir, 'three_na.mkv');
  await makeClip(mp4, { segments: 3, seconds: 1 });
  streamCopy(mp4, mkv);
  assert.equal((await probeMedia(dir, mkv)).duration, null, 'the fixture really has no Duration line');
  const ref = await analyzeVideo(dir, mp4);
  const na = await analyzeVideo(dir, mkv);
  assert.equal(ref.durationFrom, 'container');
  assert.equal(na.durationFrom, 'packets');
  for (const a of [ref, na]) {
    assert.ok(Math.abs(a.duration - 3) < 0.15, `duration ${a.duration}`);
    assert.deepEqual(a.cuts, [1, 2]);
    assert.equal(a.shots.count, 3);
    assert.ok(Math.abs(a.shots.mean - 1) < 0.1, `mean shot ${a.shots.mean}`);
    assert.equal(a.motion.perSecond.length, 3);
  }
  assert.match(summaryMarkdown(na), /Length 3 s \(the container has no Duration; measured from packets\)/);
  assert.match(summaryMarkdown(na), /Shot length: mean 1 s .* over 3 shot\(s\)/);
  assert.doesNotMatch(summaryMarkdown(ref), /no Duration/);
});

test('refs: a single frame, a still image and a clip shorter than --every fail with a reason (an image analyzes as an image) instead of writing null stats', { skip: NO_FFMPEG, timeout: 900000 }, async () => {
  const { analyzeVideo, analyzeImages, extractFrames } = await imp('refs.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-refs-'));
  scratch.push(dir);
  const mp4 = path.join(dir, 'three.mp4');
  await makeClip(mp4, { segments: 3, seconds: 1 });
  const one = path.join(dir, 'one.mp4');
  const png = path.join(dir, 'still.png');
  const tiny = path.join(dir, 'tiny.mp4');
  for (const [args, dest] of [[['-i', mp4, '-frames:v', '1', '-pix_fmt', 'yuv420p'], one], [['-i', mp4, '-frames:v', '1'], png], [['-i', mp4, '-t', '0.2', '-pix_fmt', 'yuv420p'], tiny]]) {
    const r = await spawnP(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args, dest]);
    assert.equal(r.code, 0, r.stderr);
  }
  await assert.rejects(analyzeVideo(dir, one), (err) => err.name === 'UsageError' && /too few to measure cuts, motion or shot length/.test(err.message));
  await assert.rejects(analyzeVideo(dir, png), /too few to measure|no video stream/);
  await assert.rejects(extractFrames(dir, {}, tiny, { every: 0.5, out: path.join(dir, 'fr') }),
    (err) => err.name === 'UsageError' && /no frame was sampled from .*tiny\.mp4 \(0\.2 s long\) at --every 0.5.*--every 0\.1/.test(err.message));
  // an image file is a one-image set; a normal clip still extracts
  const still = await analyzeImages(dir, png);
  assert.equal(still.kind, 'images');
  assert.equal(still.count, 1);
  assert.ok(Number.isFinite(still.brightness.mean) && still.palette.length > 0);
  const ok = await extractFrames(dir, {}, mp4, { every: 0.5, out: path.join(dir, 'frames') });
  assert.ok(ok.count >= 5, `extracted ${ok.count}`);
  // the CLI: a lone image analyzes as an image and writes analysis.json; a too-short clip exits 2 with the reason
  const cliRun = (args) => spawnSync(process.execPath, [path.join(T_TOOLS, 'refs.mjs'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, FFMPEG_PATH: FFMPEG } });
  const a = cliRun(['analyze', png, '--out', path.join(dir, 'a.json'), '--json']);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(JSON.parse(a.stdout.trim().split('\n').pop()).kind, 'images');
  const bad = cliRun(['extract', tiny, '--out', path.join(dir, 'fr2')]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /no frame was sampled/);
});

// -- doctor's Python row is true (doctor x beats.mjs) ---------------------------------------------------------------------

test('doctor: a broken MOTION_PYTHON pin is a warning naming the pin, and beats.mjs really falls back to its JS engine', { skip: NO_FFMPEG, timeout: 900000 }, async () => {
  const { checks, failedChecks, FILTERS } = await imp('doctor.mjs');
  const pin = 'MOTION_PYTHON=Z:\\no\\python.exe is not usable: no such file or command';
  const base = fakeProbes(FILTERS);
  const failing = (message) => ({ ...base, resolve: (fn, root) => (fn === 'resolvePython' ? Object.assign((async () => { throw new Error(message); })(), { stop() {} }) : base.resolve(fn, root)) });
  const list = await checks(TEMPLATE, { probes: failing(pin), cleanups: [] });
  const py = list.find((c) => c.id === 'python');
  assert.equal(py.status, 'warn');
  assert.equal(py.detail, `${pin}; beats.mjs --engine auto (default) uses its JS engine, --engine librosa stops`);
  assert.match(py.fix, /point MOTION_PYTHON at a working Python that has librosa, or unset it/);
  assert.deepEqual(failedChecks(list), [], 'Python is optional');
  // no pin, just no interpreter: the generic wording and the install hint
  const none = await checks(TEMPLATE, { probes: failing('python not found'), cleanups: [] });
  assert.match(none.find((c) => c.id === 'python').detail, /^no usable Python: python not found; beats\.mjs --engine auto/);

  // the promise itself: the same broken pin, run through the real beats.mjs
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-beats-'));
  scratch.push(dir);
  fs.writeFileSync(path.join(dir, 'studio.json'), '{}');
  fs.mkdirSync(path.join(dir, 'audio'));
  const wav = path.join(dir, 'audio', 'beeps.wav');
  const made = await spawnP(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=1000:beep_factor=4:duration=4:sample_rate=22050', '-ac', '1', wav]);
  assert.equal(made.code, 0, made.stderr);
  const env = { ...process.env, FFMPEG_PATH: FFMPEG, MOTION_PYTHON: path.join(dir, 'no-such-python.exe') };
  const auto = await spawnP(process.execPath, [path.join(T_TOOLS, 'beats.mjs'), wav, '--out', path.join(dir, 'audio', 'beats.json'), '--json'], { cwd: dir, env });
  assert.equal(auto.code, 0, auto.stderr);
  assert.equal(JSON.parse(auto.stdout.trim().split('\n').pop()).source, 'js');
  assert.match(auto.stderr, /MOTION_PYTHON=.* is not usable.* — using the JS engine/);
  const strict = await spawnP(process.execPath, [path.join(T_TOOLS, 'beats.mjs'), wav, '--engine', 'librosa', '--no-cache', '--out', path.join(dir, 'audio', 'strict.json')], { cwd: dir, env });
  assert.equal(strict.code, 1);
  assert.match(strict.stderr, /is not usable/);
});

// -- gate.requireFormats: one passing round per format in studio.json "formats" (feedback row 13) ---------------------------

const fmtRound = (n, fmt, { scores = AXES8, body = 'PROBLEMS:\n1. [P2] [00:01.00] spacing', fixes = 'x' } = {}) => `## Round ${n} — ${fmt} — t\n${scores}\n${body}\nFIXES: ${fixes}\n\n`;
function formatsProject(rounds, studio = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-gatefmt-'));
  scratch.push(root);
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'studio.json'), JSON.stringify({ formats: ['9x16', '1x1', '16x9'], gate: { minRounds: 3 }, ...studio }));
  fs.writeFileSync(path.join(root, 'docs', 'review_log.md'), '# Review log\n\n' + rounds.join(''));
  return root;
}
const threeNine = [fmtRound(1, '9x16'), fmtRound(2, '9x16'), fmtRound(3, '9x16')];

test('gate.requireFormats=false (default): only the last round counts, the format in its heading is not looked at', () => {
  const root = formatsProject(threeNine);
  const r = checkGate(root);
  assert.equal(r.pass, true, r.reasons.join('\n'));
  assert.equal(r.requireFormats, false);
  assert.deepEqual(r.formats, { required: false });
  const explicit = checkGate(root, { gate: { minRounds: 3, requireFormats: false }, formats: ['9x16', '1x1'] });
  assert.equal(explicit.pass, true);
  // the format token of the last round may even be a format the film does not list
  assert.equal(checkGate(formatsProject([fmtRound(1, '4x5'), fmtRound(2, '4x5'), fmtRound(3, '4x5')])).pass, true);
});

test('gate.requireFormats=true: every format in studio.json formats needs a logged round that passes; missing formats are named', () => {
  const root = formatsProject(threeNine, { gate: { minRounds: 3, requireFormats: true } });
  const r = checkGate(root);
  assert.equal(r.pass, false);
  assert.equal(r.requireFormats, true);
  assert.deepEqual(r.reasons.map((x) => x.replace(/ \(gate\.requireFormats.*$/, '')), ['format 1x1: no logged round', 'format 16x9: no logged round']);
  assert.match(r.reasons[0], /needs a round headed "## Round <n> — 1x1 — \.\.\." for every format in studio\.json formats: 9x16, 1x1, 16x9/);
  assert.deepEqual(r.formats.covered['9x16'], { rounds: [1, 2, 3], passing: [1, 2, 3], latest: 3 });
  assert.deepEqual(r.formats.covered['1x1'], { rounds: [], passing: [], latest: null });
  // log a passing round per extra format (any position; heading format is case-insensitive) -> pass
  const ok = formatsProject([fmtRound(1, '1x1'), fmtRound(2, '16X9'), ...threeNine.map((_, i) => fmtRound(3 + i, '9x16'))], { gate: { minRounds: 3, requireFormats: true } });
  const pass = checkGate(ok);
  assert.equal(pass.pass, true, pass.reasons.join('\n'));
  assert.deepEqual(pass.formats.covered['16x9'], { rounds: [2], passing: [2], latest: 2 });
  assert.equal(pass.rounds, 5);
});

test('gate.requireFormats=true: the latest round of a format must pass on its own (low score, open P0, na outside naAllowed); a later passing round fixes it', () => {
  const cfg = { gate: { minRounds: 3, requireFormats: true } };
  const low = fmtRound(1, '1x1', { scores: 'SCORES: hook=8 readability=7 motion=8 variety=8 composition=8 brand=8 sound=8' });
  const p0 = fmtRound(2, '16x9', { body: 'PROBLEMS:\n1. [P0] [00:00.00] frame 0 empty', fixes: 'none' });
  const root = formatsProject([low, p0, ...threeNine.map((_, i) => fmtRound(3 + i, '9x16'))], cfg);
  const r = checkGate(root);
  assert.equal(r.pass, false);
  assert.match(r.reasons[0], /^format 1x1: latest round 1 does not pass \(round 1: below 8: readability=7\)/);
  assert.match(r.reasons[1], /^format 16x9: latest round 2 does not pass \(round 2: 1 open P0: 1\. \[00:00\.00\] frame 0 empty/);
  assert.deepEqual(r.formats.covered['1x1'], { rounds: [1], passing: [], latest: 1 });
  const noSound = fmtRound(1, '1x1', { scores: 'SCORES: hook=8 readability=8 motion=8 variety=8 composition=8 brand=8 sound=na' });
  assert.match(checkGate(formatsProject([noSound, fmtRound(2, '16x9'), ...threeNine], cfg)).reasons.join('\n'), /format 1x1: latest round 1 does not pass \(round 1: na not allowed for sound/);
  // the P0 round is closed in its own FIXES -> counts; a second round for 1x1 that passes -> counts
  const closed = fmtRound(2, '16x9', { body: 'PROBLEMS:\n1. [P0] [00:00.00] frame 0 empty', fixes: '1. fixed: headline on frame 0' });
  const fixed = formatsProject([low, fmtRound(2, '1x1'), closed.replace('Round 2', 'Round 3'), ...threeNine.map((_, i) => fmtRound(4 + i, '9x16'))], cfg);
  const pass = checkGate(fixed);
  assert.equal(pass.pass, true, pass.reasons.join('\n'));
  assert.deepEqual(pass.formats.covered['1x1'], { rounds: [1, 2], passing: [2], latest: 2 }, 'the failing round stays listed, the later passing one counts');
});

test('gate.requireFormats: the last round is still judged first, formats come from cfg or studio.json, and the CLI reports them', () => {
  const cfg = { gate: { minRounds: 3, requireFormats: true } };
  const badLast = formatsProject([fmtRound(1, '1x1'), fmtRound(2, '16x9'), fmtRound(3, '9x16'), fmtRound(4, '9x16', { scores: 'SCORES: hook=5 readability=8 motion=8 variety=8 composition=8 brand=8 sound=8' })], cfg);
  const r = checkGate(badLast);
  assert.deepEqual(r.reasons, ['round 4: below 8: hook=5'], 'every format is covered; the last round alone fails');
  // an explicit cfg.formats wins over studio.json
  const rounds = [fmtRound(1, '9x16'), fmtRound(2, '9x16'), fmtRound(3, '9x16')];
  assert.equal(checkGate(formatsProject(rounds, cfg), { ...cfg, formats: ['9x16'] }).pass, true);
  assert.equal(checkGate(formatsProject(rounds, cfg), { ...cfg, formats: ['9x16', '1x1'] }).pass, false);
  // a gate that is disabled passes whatever requireFormats says; a gate.requireFormats typo ("yes") is not "true"
  assert.equal(checkGate(formatsProject(rounds, { gate: { enabled: false, requireFormats: true } })).pass, true);
  assert.equal(checkGate(formatsProject(rounds, { gate: { minRounds: 3, requireFormats: 'yes' } })).pass, true);
  // CLI: text and json
  const root = formatsProject(rounds, cfg);
  const cli = spawnSync(process.execPath, [GATE, '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(cli.status, 1);
  const j = JSON.parse(cli.stdout.trim());
  assert.equal(j.requireFormats, true);
  assert.deepEqual(j.formats.list, ['9x16', '1x1', '16x9']);
  const text = spawnSync(process.execPath, [GATE], { cwd: root, encoding: 'utf8' }).stdout;
  assert.match(text, /formats \(gate\.requireFormats\): 9x16 ok \(round 1, 2, 3\) · 1x1 no round · 16x9 no round/);
});

test('gate.requireFormats=true: a later FAILING round of a format is not covered by an earlier pass (F2)', () => {
  const hook3 = 'SCORES: hook=3 readability=9 motion=9 variety=9 composition=9 brand=9 sound=9';
  const all9 = 'SCORES: hook=9 readability=9 motion=9 variety=9 composition=9 brand=9 sound=9';
  const root = formatsProject([
    fmtRound(1, '9x16', { scores: all9 }), fmtRound(2, '1x1', { scores: all9 }),
    fmtRound(3, '9x16', { scores: hook3 }), fmtRound(4, '1x1', { scores: all9 }),
  ], { formats: ['9x16', '1x1'], gate: { minRounds: 3, requireFormats: true } });
  const r = checkGate(root);
  assert.equal(r.pass, false, 'the 9x16 regression in round 3 must fail the gate');
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0], /^format 9x16: latest round 3 does not pass \(round 3: below 8: hook=3\)/);
  assert.deepEqual(r.formats.covered['9x16'], { rounds: [1, 3], passing: [1], latest: 3 });
  // once 9x16 is logged again and passes, the gate passes
  const fixed = formatsProject([
    fmtRound(1, '9x16', { scores: all9 }), fmtRound(2, '1x1', { scores: all9 }),
    fmtRound(3, '9x16', { scores: hook3 }), fmtRound(4, '9x16', { scores: all9 }), fmtRound(5, '1x1', { scores: all9 }),
  ], { formats: ['9x16', '1x1'], gate: { minRounds: 3, requireFormats: true } });
  assert.equal(checkGate(fixed).pass, true, checkGate(fixed).reasons.join(' | '));
});
