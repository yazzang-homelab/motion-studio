// Unit tests for the shared tool library (template/tools/studio.mjs) and render.mjs frame timing. No network; the
// ffmpeg checks skip without ffmpeg, the openFilm and render.mjs CLI browser checks skip unless playwright resolves (repo
// devDependency or MOTION_SMOKE_NODE_MODULES) and a Chromium browser launches. Bounded-close tests use a fake playwright.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = process.env.MOTION_TEMPLATE_DIR ? path.resolve(process.env.MOTION_TEMPLATE_DIR) : path.join(REPO, 'skills', 'studio-init', 'template');
const STUDIO = pathToFileURL(path.join(TEMPLATE, 'tools', 'studio.mjs')).href;
const S = await import(STUDIO);

// Every temp directory this file makes is removed when the file is done (after the last test, and on process exit as a
// backstop): the tests used to leave over a thousand ms-* directories behind in the system temp folder.
const made = [];
const tmp = (prefix = 'ms-studio-') => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(dir); return dir; };
const cleanTmp = () => { for (const p of made.splice(0)) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* still in use: the next run's temp cleanup takes it */ } } };
after(cleanTmp);
process.on('exit', cleanTmp);
const writeStudio = (dir, obj) => fs.writeFileSync(path.join(dir, 'studio.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));

// ---------------------------------------------------------------------------------------------------------------
// parseArgs / usage

const SPEC = {
  format: { type: 'list', alias: 'f' },
  fps: { type: 'number' },
  from: { type: 'number' },
  draft: { type: 'boolean' },
  poster: { type: 'boolean', default: true },
  out: { type: 'string', default: 'out' },
  'frames-dir': { type: 'string' },
  at: { type: 'list', of: 'number' },
  video: { type: 'string', optional: true },
  music: { type: 'string' },
};

test('parseArgs: --k v, --k=v, booleans, defaults, positionals', () => {
  const { flags, positionals } = S.parseArgs(['in.wav', '--fps', '30', '--draft', '--out=dist', 'x'], SPEC);
  assert.equal(flags.fps, 30);
  assert.equal(flags.draft, true);
  assert.equal(flags.out, 'dist');
  assert.equal(flags.poster, true, 'default applied');
  assert.equal(flags.help, false);
  assert.equal(flags.format, undefined, 'absent flag without default stays undefined so config can fill it');
  assert.deepEqual(positionals, ['in.wav', 'x']);
});

test('parseArgs: --no-k, lists, aliases, kebab→camel, optional value, negative numbers, --', () => {
  const { flags, positionals } = S.parseArgs(
    ['--no-poster', '-f', '9x16,1x1', '--format', '16x9', '--frames-dir', 'shots', '--at', '0.5,2', '--at=4.2', '--from', '-1', '--no-music', '--video', '--', '--draft'], SPEC);
  assert.equal(flags.poster, false);
  assert.deepEqual(flags.format, ['9x16', '1x1', '16x9']);
  assert.equal(flags['frames-dir'], 'shots');
  assert.equal(flags.framesDir, 'shots');
  assert.deepEqual(flags.at, [0.5, 2, 4.2]);
  assert.equal(flags.from, -1);
  assert.equal(flags.music, null, '--no-<string> means "none"');
  assert.equal(flags.video, true, 'optional string flag given bare');
  assert.deepEqual(positionals, ['--draft']);
  assert.equal(S.parseArgs(['--video', 'a.mp4'], SPEC).flags.video, 'a.mp4');
  assert.equal(S.parseArgs(['--draft=false'], SPEC).flags.draft, false);
});

test('parseArgs: -h/--help set flags.help', () => {
  assert.equal(S.parseArgs(['-h'], SPEC).flags.help, true);
  assert.equal(S.parseArgs(['--fps', '2', '--help'], SPEC).flags.help, true);
});

test('parseArgs: unknown flags and bad values throw UsageError carrying usage text', () => {
  for (const argv of [['--bogus'], ['-z'], ['--fps', 'abc'], ['--fps'], ['--draft=maybe'], ['--at', '1,x'], ['--no-poster=1'], ['-format', '9x16']]) {
    assert.throws(() => S.parseArgs(argv, SPEC, { title: 'Usage: node tools/x.mjs' }), (err) => {
      assert.ok(err instanceof S.UsageError, `${argv.join(' ')} → UsageError`);
      assert.match(err.usage, /Usage: node tools\/x\.mjs/);
      assert.match(err.usage, /--fps <n>/);
      return true;
    });
  }
});

test('usage lists every flag, --no- form for default-true switches, defaults and help', () => {
  const u = S.usage('Usage: node tools/x.mjs', { ...SPEC, fps: { type: 'number', desc: 'Frames per second', default: 60 } }, 'Examples:\n  x');
  assert.match(u, /^Usage: node tools\/x\.mjs/);
  assert.match(u, /--no-poster/);
  assert.match(u, /-f, --format <a,b>/);
  assert.match(u, /Frames per second \(default: 60\)/);
  assert.match(u, /-h, --help/);
  assert.match(u, /Examples:\n {2}x/);
});

test('main maps UsageError → exit 2 with usage, Error → exit 1, number → exit code', () => {
  const script = (body) => `import { main, UsageError } from ${JSON.stringify(STUDIO)};\nmain(async () => { ${body} });\n`;
  const run = (body) => {
    const dir = tmp('ms-main-');
    const file = path.join(dir, 'cli.mjs');
    fs.writeFileSync(file, script(body));
    return spawnSync(process.execPath, [file], { encoding: 'utf8', env: { ...process.env, DEBUG: '' } });
  };
  const u = run("throw new UsageError('bad flag', 'Usage: demo');");
  assert.equal(u.status, 2);
  assert.match(u.stderr, /error: bad flag/);
  assert.match(u.stderr, /Usage: demo/);
  const e = run("throw new Error('it broke');");
  assert.equal(e.status, 1);
  assert.match(e.stderr, /error: it broke/);
  assert.equal(run('return 3;').status, 3);
  assert.equal(run('return undefined;').status, 0);
});

test('wantsJson: --json, --json=<bool>, --no-json (the last wins), nothing after `--`', () => {
  assert.equal(S.wantsJson(['--json']), true);
  assert.equal(S.wantsJson(['a', '--fps', '30', '--json', '--draft']), true);
  assert.equal(S.wantsJson([]), false);
  assert.equal(S.wantsJson(['--json=false']), false);
  assert.equal(S.wantsJson(['--json=1']), true);
  assert.equal(S.wantsJson(['--json', '--no-json']), false);
  assert.equal(S.wantsJson(['--no-json', '--json']), true);
  assert.equal(S.wantsJson(['--', '--json']), false);
  assert.equal(S.wantsJson(['--jsonp']), false);
});

test('main with --json: a failure prints ONE {"ok":false,"error"} line on stdout; stderr and the exit code stay as before', () => {
  const dir = tmp('ms-main-');
  const file = path.join(dir, 'cli.mjs');
  fs.writeFileSync(file, `import { main, UsageError } from ${JSON.stringify(STUDIO)};
main(async () => {
  const mode = process.argv[2];
  if (mode === 'usage') throw new UsageError('bad flag', 'Usage: demo');
  if (mode === 'error') throw new Error('line one\\nline "two"');
  if (mode === 'plain') throw 'a string, not an Error';
  if (mode === 'ok') { process.stdout.write('{"ok":true}\\n'); return 0; }
  return 3;
});
`);
  const run = (...args) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', env: { ...process.env, DEBUG: '' } });
  const line = (r) => { const lines = r.stdout.split('\n').filter(Boolean); assert.equal(lines.length, 1, `one stdout line, got ${JSON.stringify(r.stdout)}`); return JSON.parse(lines[0]); };
  const u = run('usage', '--json');
  assert.equal(u.status, 2);
  assert.deepEqual(line(u), { ok: false, error: 'bad flag' });
  assert.match(u.stderr, /error: bad flag/);
  assert.match(u.stderr, /Usage: demo/, 'the human usage text stays on stderr');
  const e = run('error', '--json');
  assert.equal(e.status, 1);
  assert.deepEqual(line(e), { ok: false, error: 'line one\nline "two"' }, 'newlines and quotes survive as one JSON line');
  assert.match(e.stderr, /error: line one/);
  assert.deepEqual(line(run('plain', '--json')), { ok: false, error: 'a string, not an Error' });
  // Without --json stdout stays empty, as before; a success is untouched.
  assert.equal(run('error').stdout, '');
  assert.equal(run('usage', '--no-json').stdout, '');
  assert.equal(run('ok', '--json').stdout, '{"ok":true}\n');
  assert.equal(run('exit3', '--json').status, 3);
  assert.equal(run('exit3', '--json').stdout, '', 'a returned exit code prints nothing extra');
});

// Every tool that goes through main() answers a failure with the same one-line JSON when --json is on (the README, commands.md
// and CONTRIBUTING promise "one JSON line on stdout").
const JSON_TOOLS = ['render', 'stills', 'sfx', 'mix', 'critique', 'deliver', 'doctor', 'refs', 'fonts', 'beats', 'score', 'voice', 'serve'];
const jsonFailure = async (root, tool, args) => {
  const r = await S.run(process.execPath, [path.join(TEMPLATE, 'tools', `${tool}.mjs`), ...args, '--json'], { cwd: root, timeoutMs: 120000, env: { DEBUG: '' } });
  const lines = r.stdout.split('\n').filter(Boolean);
  return { tool, code: r.code, lines, json: (() => { try { return JSON.parse(lines[0]); } catch { return null; } })(), stderr: r.stderr };
};

test('--json: every tool that runs through main() answers a usage error or a failure with one {"ok":false,"error"} line', async () => {
  const root = tmp('ms-jsonerr-');
  writeStudio(root, { gate: { enabled: false } });
  const bad = await Promise.all(JSON_TOOLS.map((tool) => jsonFailure(root, tool, ['--no-such-flag'])));
  for (const r of bad) {
    assert.equal(r.code, 2, `${r.tool}: exit code (stderr: ${r.stderr.slice(0, 200)})`);
    assert.equal(r.lines.length, 1, `${r.tool}: exactly one stdout line, got ${JSON.stringify(r.lines)}`);
    // deliver.mjs always carries `failed` too (a superset of the envelope): its one failure line is {ok:false, error, failed:[...]},
    // whether a check failed or the run could not start, so a caller reads one shape.
    const expected = { ok: false, error: 'unknown option --no-such-flag', ...(r.tool === 'deliver' ? { failed: ['unknown option --no-such-flag'] } : {}) };
    assert.deepEqual(r.json, expected, r.tool);
    assert.match(r.stderr, /error: unknown option --no-such-flag/, `${r.tool}: the human message stays on stderr`);
  }
  // Runtime failures (exit 1) and other usage errors, each from a different tool.
  const cases = [['voice', ['--dry-run'], 1, /audio\/voice\.json not found/], ['beats', ['audio/nope.wav'], 1, /track not found/], ['sfx', ['--cues', 'nope.json'], 1, /missing .*nope\.json/],
    ['refs', [], 2, /missing command/], ['fonts', ['add'], 2, /add takes exactly one/], ['mix', ['--format', 'nonexist'], 2, /unknown format "nonexist"/],
    ['score', ['--style', 'nonsense'], 2, /--style must be one of/], ['stills', ['--at', 'abc'], 2, /--at expects numbers/]];
  const more = await Promise.all(cases.map(([tool, args]) => jsonFailure(root, tool, args)));
  more.forEach((r, i) => {
    const [tool, , code, re] = cases[i];
    assert.equal(r.code, code, `${tool}: exit code (stderr: ${r.stderr.slice(0, 200)})`);
    assert.equal(r.lines.length, 1, `${tool}: exactly one stdout line, got ${JSON.stringify(r.lines)}`);
    assert.equal(r.json?.ok, false, tool);
    assert.match(r.json?.error ?? '', re, tool);
  });
});

// gate.mjs and lint.mjs have their own small CLI (hooks import them, so they cannot load studio.mjs and main()); they answer
// a failure with the same one-line envelope, the human message on stderr and the exit code unchanged.
test('--json: gate.mjs and lint.mjs answer a usage, config or runtime failure with the same one {"ok":false,"error"} line', async () => {
  const root = tmp('ms-jsonerr-');
  writeStudio(root, {});
  const badCfg = tmp('ms-jsonerr-cfg-');
  writeStudio(badCfg, { fps: 'sixty', audio: { lufs: -3 } });
  const bare = tmp('ms-jsonerr-none-');
  const projectAbove = (() => { for (let d = path.dirname(bare); ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, 'studio.json'))) return true; if (path.dirname(d) === d) return false; } })();
  // The flags exactly as given (jsonFailure always appends --json), to pin the "last json switch wins" rule.
  const raw = async (cwd, tool, args) => {
    const r = await S.run(process.execPath, [path.join(TEMPLATE, 'tools', `${tool}.mjs`), ...args], { cwd, timeoutMs: 120000, env: { DEBUG: '' } });
    const lines = r.stdout.split('\n').filter(Boolean);
    return { tool, code: r.code, lines, stdout: r.stdout, stderr: r.stderr, json: (() => { try { return JSON.parse(lines[0]); } catch { return null; } })() };
  };
  const tools = ['gate', 'lint'];
  const [flag, jsonAfter, jsonOff, cfg, none] = await Promise.all([
    Promise.all(tools.map((tool) => jsonFailure(root, tool, ['--no-such-flag']))),
    Promise.all(tools.map((tool) => raw(root, tool, ['--no-such-flag', '--json']))),
    Promise.all(tools.map((tool) => raw(root, tool, ['--json', '--no-json', '--no-such-flag']))),
    jsonFailure(badCfg, 'gate', []),
    projectAbove ? null : jsonFailure(bare, 'lint', []),
  ]);
  for (const r of [...flag, ...jsonAfter]) {
    assert.equal(r.code, 2, `${r.tool}: exit code (stderr: ${r.stderr.slice(0, 200)})`);
    assert.equal(r.lines.length, 1, `${r.tool}: exactly one stdout line, got ${JSON.stringify(r.lines)}`);
    assert.deepEqual(r.json, { ok: false, error: 'unknown option --no-such-flag' }, r.tool);
    assert.match(r.stderr, /error: unknown option --no-such-flag/, `${r.tool}: the human message stays on stderr`);
    assert.match(r.stderr, /Usage: node tools\/(gate|lint)\.mjs/, `${r.tool}: usage follows on stderr`);
  }
  // --no-json after --json switches the envelope off again; the exit code and the stderr message are the same.
  for (const r of jsonOff) {
    assert.equal(r.code, 2, r.tool);
    assert.equal(r.stdout, '', `${r.tool}: no envelope after --no-json`);
    assert.match(r.stderr, /error: unknown option --no-such-flag/, r.tool);
  }
  // Config failure (exit 1): gate reports every studio.json problem, the file named.
  assert.equal(cfg.code, 1, cfg.stderr);
  assert.equal(cfg.lines.length, 1, JSON.stringify(cfg.lines));
  assert.equal(cfg.json.ok, false);
  assert.match(cfg.json.error, /studio\.json/);
  assert.match(cfg.json.error, /fps must be a number \(got "sixty"\)/);
  assert.match(cfg.json.error, /audio\.lufs must be between -70 and -5 \(got -3\)/);
  assert.match(cfg.stderr, /error: invalid .*studio\.json/);
  // Runtime failure (exit 1): lint with no file arguments outside a project.
  if (none) {
    assert.equal(none.code, 1, none.stderr);
    assert.equal(none.lines.length, 1, JSON.stringify(none.lines));
    assert.deepEqual(none.json, { ok: false, error: 'no studio.json found here or above; pass files or run inside a film project.' });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Config

test('DEFAULTS are frozen and match the documented contract values', () => {
  assert.ok(Object.isFrozen(S.DEFAULTS) && Object.isFrozen(S.DEFAULTS.encode) && Object.isFrozen(S.DEFAULTS.safe['9x16']));
  assert.equal(S.DEFAULTS.fps, 60);
  assert.equal(S.DEFAULTS.encode.crf, 16);
  assert.deepEqual(S.DEFAULTS.formats, ['9x16', '1x1', '16x9']);
  assert.deepEqual(S.DEFAULTS.safe['9x16'], { top: 0.10, bottom: 0.16, left: 0.06, right: 0.08 });
  assert.equal(S.DEFAULTS.audio.lufs, -14);
  assert.deepEqual(Object.keys(S.FORMATS).sort(), ['16x9', '1x1', '4x5', '9x16']);
});

test('loadConfig deep-merges over DEFAULTS, replaces arrays, keeps unknown keys, never mutates DEFAULTS', () => {
  const dir = tmp();
  writeStudio(dir, { title: 'Demo', encode: { crf: 20 }, formats: ['1x1'], primaryFormat: '1x1', audio: { voice: 'audio/v.wav' },
    brand: { colors: { accent: '#00FF88' } }, poster: 2, custom: { keep: [1, 2] }, safe: { '1x1': { top: 0.2, bottom: 0.2, left: 0.1, right: 0.1 } } });
  const cfg = S.loadConfig(dir);
  assert.equal(cfg.title, 'Demo');
  assert.equal(cfg.encode.crf, 20);
  assert.equal(cfg.encode.preset, 'slow', 'sibling keys survive a nested override');
  assert.deepEqual(cfg.formats, ['1x1'], 'arrays replace, not concatenate');
  assert.equal(cfg.audio.voice, 'audio/v.wav');
  assert.equal(cfg.audio.lufs, -14);
  assert.equal(cfg.brand.colors.accent, '#00FF88');
  assert.equal(cfg.brand.colors.bg, '#141413');
  assert.deepEqual(cfg.custom, { keep: [1, 2] });
  assert.equal(cfg.safe['1x1'].top, 0.2);
  assert.equal(cfg.safe['9x16'].bottom, 0.16);
  assert.equal(S.DEFAULTS.encode.crf, 16);
  cfg.encode.crf = 1;
  assert.equal(S.loadConfig(dir).encode.crf, 20, 'each call returns a fresh object');
});

test('loadConfig accepts the shipped template studio.json and an empty object', () => {
  if (fs.existsSync(path.join(TEMPLATE, 'studio.json'))) assert.equal(S.loadConfig(TEMPLATE).primaryFormat, '9x16');
  const dir = tmp();
  writeStudio(dir, {});
  assert.deepEqual(S.loadConfig(dir), JSON.parse(JSON.stringify(S.DEFAULTS)));
});

test('loadConfig reports every validation problem in one readable error', () => {
  const dir = tmp();
  writeStudio(dir, { fps: 'sixty', subframes: 2.5, formats: ['9x16', '2x3'], capture: 'gpu', browser: 'firefox',
    encode: { crf: 99, preset: 'turbo' }, gate: { minRounds: -1 }, audio: { truePeak: 3 }, loop: 'yes' });
  assert.throws(() => S.loadConfig(dir), (err) => {
    for (const re of [/fps must be a number \(got "sixty"\)/, /subframes must be an integer/, /unknown format "2x3"/, /capture must be one of auto, canvas, page/,
      /browser must be auto, chrome, msedge, chromium or an absolute path/, /encode\.crf must be between 0 and 51/, /encode\.preset must be one of/,
      /gate\.minRounds must be between 0 and 100/, /audio\.truePeak must be between -20 and 0/, /loop must be true or false/]) assert.match(err.message, re);
    assert.match(err.message, /studio\.json/);
    return true;
  });
  const d2 = tmp();
  writeStudio(d2, { formats: ['9x16'], primaryFormat: '16x9' });
  assert.throws(() => S.loadConfig(d2), /primaryFormat "16x9" must be one of formats/);
  const d3 = tmp();
  writeStudio(d3, { browser: path.resolve('/opt/chrome/chrome') });
  assert.equal(S.loadConfig(d3).browser, path.resolve('/opt/chrome/chrome'), 'absolute browser path accepted');
});

const LAYOUT = await import(pathToFileURL(path.join(TEMPLATE, 'lib', 'layout.js')).href);
const validate = (patch) => S.validateConfig(S.deepMerge(S.DEFAULTS, patch));

test('validateConfig: safe insets follow layout.js (each side in [0, 0.5), at least 10% per axis), with readable errors', () => {
  // The two configs from the report: `doctor` said "OK studio.json", then every render died inside layout().
  const sums = validate({ safe: { '9x16': { top: 0.1, bottom: 0.16, left: 0.45, right: 0.46 }, '1x1': { top: 0.48, bottom: 0.48, left: 0.05, right: 0.05 } } });
  assert.equal(sums.length, 2, sums.join('\n'));
  assert.equal(sums[0], 'safe.9x16: left + right = 0.91 leaves no room (only 9% of the width; keep at least 10%, so left + right <= 0.9)');
  assert.match(sums[1], /^safe\.1x1: top \+ bottom = 0\.96 leaves no room \(only 4% of the height; keep at least 10%/);
  assert.throws(() => S.loadConfig((() => { const d = tmp(); writeStudio(d, { safe: { '9x16': { left: 0.45, right: 0.46 } } }); return d; })()), /invalid .*studio\.json:\n {2}- safe\.9x16: left \+ right = 0\.91 leaves no room/);
  assert.deepEqual(validate({ safe: { '9x16': { left: 0.45, right: 0.45 } } }), [], 'exactly 10% left is allowed');
  assert.deepEqual(validate({ safe: { '1x1': { top: 0.495 } } }), [], 'the bound is layout()\'s [0, 0.5), not 0.49');
  assert.equal(validate({ safe: { '1x1': { top: 0.5 } } })[0], 'safe.1x1.top must be a fraction in [0, 0.5) (got 0.5)');
  assert.equal(validate({ safe: { '1x1': { left: -0.1 } } })[0], 'safe.1x1.left must be a fraction in [0, 0.5) (got -0.1)');
  assert.equal(validate({ safe: { '1x1': { left: 'wide' } } })[0], 'safe.1x1.left must be a number (got "wide")');
  // Whatever validateConfig accepts, layout() accepts, and the other way round: nothing can pass doctor and crash a render.
  const values = [0, 0.05, 0.3, 0.45, 0.49, 0.495, 0.5, 0.9, -0.1];
  let checked = 0;
  for (const top of values) for (const bottom of values) for (const left of values) for (const right of values) {
    const safe = { top, bottom, left, right };
    let throws = false;
    try { LAYOUT.layout('4x5', safe); } catch { throws = true; }
    assert.equal(validate({ safe: { '4x5': safe } }).length === 0, !throws, JSON.stringify(safe));
    checked++;
  }
  assert.equal(checked, values.length ** 4);
  assert.throws(() => LAYOUT.layout('9x16', { left: 0.45, right: 0.46 }), /^Error: safe\.9x16: left \+ right = 0\.91 leaves no room/);
  assert.deepEqual(LAYOUT.safeProblems('9x16', undefined), []);
});

test('validateConfig: critique.stepped, critique.popIgnore and gate.requireFormats (defaults off; bad values named)', () => {
  assert.equal(S.DEFAULTS.critique.stepped, false);
  assert.deepEqual(S.DEFAULTS.critique.popIgnore, []);
  assert.equal(S.DEFAULTS.gate.requireFormats, false);
  assert.deepEqual(validate({ critique: { stepped: true, popIgnore: [[0, 1.5], [2.25, 3]] }, gate: { requireFormats: true } }), []);
  assert.deepEqual(validate({ critique: { popIgnore: null, stepped: null } }), [], 'null = unset, like allowSilence');
  assert.deepEqual(validate({ critique: { stepped: 'yes' } }), ['critique.stepped must be true or false (got "yes")']);
  assert.deepEqual(validate({ critique: { popIgnore: 'all' } }), ['critique.popIgnore must be an array of [t0, t1] second pairs (got "all")']);
  assert.deepEqual(validate({ critique: { popIgnore: [[3, 1], [1], [-1, 2], [1, 2]] } }).map((e) => e.slice(0, 21)), ['critique.popIgnore[0]', 'critique.popIgnore[1]', 'critique.popIgnore[2]']);
  assert.deepEqual(validate({ gate: { requireFormats: 'true' } }), ['gate.requireFormats must be true or false (got "true")']);
  assert.deepEqual(validate({ critique: { popRatio: -1 } }), ['critique.popRatio must be >= 0 (got -1)'], 'the numeric thresholds are still checked next to the new keys');
});

test('validateConfig: a range error names only the bounds that exist, never -Infinity', () => {
  const errs = validate({ fps: 300, duration: 40000, bpm: 1000, subframes: 65, critique: { staticEps: -1 }, audio: { lufsTolerance: 11 } });
  assert.deepEqual(errs, ['duration must be > 0 and <= 36000 (got 40000)', 'fps must be > 0 and <= 240 (got 300)', 'subframes must be between 1 and 64 (got 65)',
    'bpm must be > 0 and <= 999 (got 1000)', 'audio.lufsTolerance must be > 0 and <= 10 (got 11)', 'critique.staticEps must be >= 0 (got -1)']);
  assert.deepEqual(validate({ poster: 99 }), ['poster must be between 0 and 12 (got 99)']);
  assert.deepEqual(validate({ fps: 0, deliver: { maxBytes: { x: 0 } } }), ['fps must be > 0 and <= 240 (got 0)', 'deliver.maxBytes.x must be > 0 (got 0)']);
  for (const e of validate({ fps: 300, duration: -1, bpm: 0, gate: { minScore: 11 }, encode: { crf: -1 } })) assert.doesNotMatch(e, /Infinity/, e);
});

test('validateConfig: audio.lufs is loudnorm\'s -70..-5 and the message names the range', () => {
  for (const ok of [-70, -23, -14, -9.5, -5]) assert.deepEqual(validate({ audio: { lufs: ok } }), [], `${ok} LUFS is a valid target`);
  for (const bad of [-4.9, -3, 0, 6, -70.1, -100]) assert.deepEqual(validate({ audio: { lufs: bad } }), [`audio.lufs must be between -70 and -5 (got ${bad})`], `${bad} LUFS`);
  for (const bad of ['-14', null, NaN]) assert.match(validate({ audio: { lufs: bad } })[0] ?? '', /^audio\.lufs must be a number/, String(bad));
  assert.deepEqual(validate({}), [], 'the default target is inside the range');
  // loadConfig turns it into the one readable error every tool shows, the same wording mix.mjs uses for --lufs.
  const dir = tmp();
  writeStudio(dir, { audio: { lufs: -3 } });
  assert.throws(() => S.loadConfig(dir), /invalid .*studio\.json:\n {2}- audio\.lufs must be between -70 and -5 \(got -3\)$/);
  writeStudio(dir, { audio: { lufs: -5 } });
  assert.equal(S.loadConfig(dir).audio.lufs, -5, 'the upper bound itself loads');
});

// The explicit re-export list in studio.mjs once lacked the browser-policy helpers, so `import { launchGuard } from
// './studio.mjs'` was undefined while the docs said studio.mjs re-exports everything from studio-web.mjs.
test('studio.mjs re-exports every export of studio-web.mjs, the browser policy included (same bindings)', async () => {
  const web = await import(pathToFileURL(path.join(TEMPLATE, 'tools', 'studio-web.mjs')).href);
  const missing = Object.keys(web).filter((name) => !(name in S));
  assert.deepEqual(missing, [], `studio.mjs must also export: ${missing.join(', ')}`);
  for (const name of Object.keys(web)) assert.equal(S[name], web[name], `${name} is the same value in both modules`);
  for (const name of ['classifyBrowser', 'browserAttempts', 'launchLogPath', 'systemBrowserMax', 'readLaunchLog', 'launchGuard', 'recordLaunch',
    'lockoutRefusal', 'systemBrowserWarning', 'guardSystemLaunch', 'launchFailureMessage']) assert.equal(typeof S[name], 'function', `${name} is a function`);
  assert.equal(typeof S.LAUNCH_WINDOW_MS, 'number');
  // The policy answers through studio.mjs as it does through studio-web.mjs (pure calls: no browser is started).
  assert.deepEqual(S.classifyBrowser({ channel: 'chrome', platform: 'win32' }), web.classifyBrowser({ channel: 'chrome', platform: 'win32' }));
  assert.equal(S.classifyBrowser({ channel: 'chrome', platform: 'win32' }).system, true);
  assert.ok(!S.browserAttempts('auto', 'win32', {}, { headless: true }).some((a) => a.system), 'win32 auto never lists an installed Chrome or Edge');
});

test('loadConfig: syntax errors point at line/column, missing file and non-object are explained', () => {
  const dir = tmp();
  writeStudio(dir, '{\n  "fps": 60,\n  "title": oops\n}');
  assert.throws(() => S.loadConfig(dir), /not valid JSON.*line 3/);
  assert.throws(() => S.loadConfig(tmp()), /missing .*studio\.json/);
  const d2 = tmp();
  writeStudio(d2, '[1,2]');
  assert.throws(() => S.loadConfig(d2), /must contain a JSON object/);
  const d3 = tmp();
  writeStudio(d3, '﻿{"title":"bom"}');
  assert.equal(S.loadConfig(d3).title, 'bom', 'UTF-8 BOM tolerated');
});

test('resolveFormats: primary default, all, comma lists, unknown → UsageError', () => {
  const cfg = { ...S.DEFAULTS, formats: ['9x16', '1x1'], primaryFormat: '9x16' };
  assert.deepEqual(S.resolveFormats(cfg, undefined), ['9x16']);
  assert.deepEqual(S.resolveFormats(cfg, ['all']), ['9x16', '1x1']);
  assert.deepEqual(S.resolveFormats(cfg, '16x9,9x16,16x9'), ['16x9', '9x16']);
  assert.throws(() => S.resolveFormats(cfg, ['3x2']), S.UsageError);
});

test('findProjectRoot walks up from nested dirs and files; null outside a project', () => {
  const root = tmp('ms-root-');
  writeStudio(root, {});
  const deep = path.join(root, 'film', 'scenes', 'x');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(root, 'film', 'film.js'), '');
  assert.equal(S.findProjectRoot(deep), root);
  assert.equal(S.findProjectRoot(path.join(root, 'film', 'film.js')), root);
  assert.equal(S.findProjectRoot(path.join(root, 'not-yet', 'made')), root);
  const outside = tmp('ms-noroot-');
  const hit = S.findProjectRoot(outside);
  if (hit !== null) assert.ok(!hit.startsWith(outside), 'an ancestor project may exist on this machine, never the temp dir itself');
  else assert.equal(hit, null);
});

// ---------------------------------------------------------------------------------------------------------------
// Static server

const request = (url, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject);
  req.end();
});

test('startServer: MIME map, no-store, index, 404, dotfiles hidden, traversal 403, host check, 405, Range', async () => {
  const root = tmp('ms-srv-');
  const parent = path.dirname(root);
  fs.writeFileSync(path.join(parent, `${path.basename(root)}-secret.txt`), 'outside');
  made.push(path.join(parent, `${path.basename(root)}-secret.txt`));
  const files = { 'index.html': '<!doctype html>', 'a.js': 'x', 'b.mjs': 'x', 'c.json': '{}', 'd.css': 'x', 'e.png': 'x', 'f.jpg': 'x', 'g.svg': '<svg/>',
    'h.woff2': 'x', 'i.woff': 'x', 'j.ttf': 'x', 'k.otf': 'x', 'l.wav': 'x', 'm.mp3': 'x', 'n.mp4': '0123456789', 'o.webm': 'x', 'p.txt': 'x', 'q.bin': 'x', '.env': 'KEY=1' };
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(root, f), body);
  fs.mkdirSync(path.join(root, 'sub', '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub', 'index.html'), 'sub');
  fs.writeFileSync(path.join(root, 'sub', '.git', 'config'), 'x');
  fs.writeFileSync(path.join(root, 'sp ace #1.txt'), 'odd name');
  const srv = await S.startServer(root);
  try {
    assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const mime = { 'a.js': 'text/javascript', 'b.mjs': 'text/javascript', 'c.json': 'application/json', 'd.css': 'text/css', 'e.png': 'image/png',
      'f.jpg': 'image/jpeg', 'g.svg': 'image/svg+xml', 'h.woff2': 'font/woff2', 'i.woff': 'font/woff', 'j.ttf': 'font/ttf', 'k.otf': 'font/otf',
      'l.wav': 'audio/wav', 'm.mp3': 'audio/mpeg', 'n.mp4': 'video/mp4', 'o.webm': 'video/webm', 'p.txt': 'text/plain', 'index.html': 'text/html', 'q.bin': 'application/octet-stream' };
    for (const [f, type] of Object.entries(mime)) {
      const r = await request(`${srv.url}/${f}`);
      assert.equal(r.status, 200, f);
      assert.ok(r.headers['content-type'].startsWith(type), `${f} → ${r.headers['content-type']}`);
      assert.equal(r.headers['cache-control'], 'no-store');
    }
    assert.equal((await request(`${srv.url}/`)).body.toString(), '<!doctype html>');
    assert.equal((await request(`${srv.url}/sub/`)).body.toString(), 'sub');
    assert.equal((await request(`${srv.url}/${encodeURIComponent('sp ace #1.txt')}`)).body.toString(), 'odd name');
    const miss = await request(`${srv.url}/nope.js`);
    assert.equal(miss.status, 404);
    assert.match(miss.headers['content-type'], /^text\/plain/);
    assert.equal((await request(`${srv.url}/.env`)).status, 404, '.env never served');
    assert.equal((await request(`${srv.url}/sub/.git/config`)).status, 404);
    const secret = `${path.basename(root)}-secret.txt`;
    for (const p of [`/..%2f${secret}`, `/sub/..%2f..%2f${secret}`, `/..%5c${secret}`]) {
      const r = await request(srv.url + p);
      assert.ok(r.status === 403 || (process.platform !== 'win32' && r.status === 404 && p.includes('%5c')), `${p} → ${r.status}`);
      assert.notEqual(r.body.toString(), 'outside');
    }
    assert.equal((await request(`${srv.url}/../${secret}`)).status, 404, 'raw ../ is normalized by the URL parser to the root');
    assert.equal((await request(`${srv.url}/a%00.js`)).status, 400);
    assert.equal((await request(`${srv.url}/a.js`, { headers: { Host: 'evil.example:80' } })).status, 403);
    assert.equal((await request(`${srv.url.replace('127.0.0.1', 'localhost')}/a.js`, { headers: { Host: `localhost:${srv.port}` } })).status, 200);
    assert.equal((await request(`${srv.url}/a.js`, { method: 'POST' })).status, 405);
    const head = await request(`${srv.url}/n.mp4`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], '10');
    assert.equal(head.body.length, 0);
    const part = await request(`${srv.url}/n.mp4`, { headers: { Range: 'bytes=2-5' } });
    assert.equal(part.status, 206);
    assert.equal(part.body.toString(), '2345');
    assert.equal(part.headers['content-range'], 'bytes 2-5/10');
    assert.equal((await request(`${srv.url}/n.mp4`, { headers: { Range: 'bytes=50-60' } })).status, 416);
  } finally {
    await srv.close();
  }
  await assert.rejects(request(`${srv.url}/a.js`), 'closed server refuses connections');
});

test('startServer: explicit port in use rejects with EADDRINUSE', async () => {
  const a = await S.startServer(tmp());
  try {
    await assert.rejects(S.startServer(tmp(), { port: a.port }), (err) => err.code === 'EADDRINUSE' && /already in use/.test(err.message));
  } finally { await a.close(); }
});

test('startServer: an ephemeral port that Chrome refuses (ERR_UNSAFE_PORT) is given back and another one is drawn', async () => {
  const W = await import(pathToFileURL(path.join(TEMPLATE, 'tools', 'studio-web.mjs')).href);
  for (const p of [6000, 6667, 10080, 2049, 5060]) assert.equal(W.isChromeUnsafePort(p), true, `${p} is on Chromium's restricted list`);
  for (const p of [80, 3000, 8080, 8123, 9222, 49152, 65535]) assert.equal(W.isChromeUnsafePort(p), false, `${p} is fine`);
  // The OS picks ephemeral ports: make the first three draws land on refused ports, then let the real one through.
  const refused = [10080, 6000, 6667];
  const asked = [];
  const createServer = http.createServer;
  http.createServer = (...args) => {
    const server = createServer(...args);
    const address = server.address.bind(server);
    server.address = () => { const a = address(); if (a && typeof a === 'object' && refused.length) { asked.push(a.port); return { ...a, port: refused.shift() }; } return a; };
    return server;
  };
  let srv;
  try { srv = await S.startServer(tmp()); } finally { http.createServer = createServer; }
  try {
    assert.equal(refused.length, 0, 'three ports were refused before the fourth was accepted');
    assert.equal(asked.length, 3);
    assert.equal(W.isChromeUnsafePort(srv.port), false);
    assert.equal(srv.port > 0 && srv.url === `http://127.0.0.1:${srv.port}`, true);
    const res = await fetch(`${srv.url}/nope`);
    assert.equal(res.status, 404, 'the accepted port really serves');
  } finally { await srv.close(); }
});

test('startServer: dot-files stay hidden behind symlinks, 8.3 short names, backslashes and stream suffixes', async (t) => {
  const root = tmp('ms-dot-');
  fs.writeFileSync(path.join(root, '.env'), 'ELEVENLABS_API_KEY=secret');
  fs.writeFileSync(path.join(root, '.env.example'), 'ELEVENLABS_API_KEY=');
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'config'), '[remote "origin"] url = https://tok@example.com/x.git');
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib', 'runtime.js'), 'export {}');
  fs.writeFileSync(path.join(root, 'studio.json'), '{}');
  const hidden = [];
  // An alias made on purpose (or by accident): a symlink or junction to a dot-file, served under a plain name.
  try { fs.symlinkSync(path.join(root, '.env'), path.join(root, 'visible.txt')); hidden.push('/visible.txt'); } catch { /* no privilege to symlink a file here */ }
  try { fs.symlinkSync(path.join(root, '.git'), path.join(root, 'repo'), 'junction'); hidden.push('/repo/config'); } catch { /* no links at all */ }
  if (process.platform === 'win32') {
    // NTFS 8.3 short names (on by default for the system volume): `dir /x` prints ENV~1 for .env and GIT~1 for .git.
    const dir = spawnSync('cmd', ['/d', '/c', 'dir', '/x', '/a'], { cwd: root, encoding: 'utf8' }).stdout ?? '';
    const short = (name) => new RegExp(`(\\S+~\\d\\S*)\\s+${name.replace('.', '\\.')}\\s*$`, 'mi').exec(dir)?.[1];
    if (short('.env')) hidden.push(`/${short('.env')}`, `/${short('.env').toLowerCase()}`);
    if (short('.env.example')) hidden.push(`/${short('.env.example')}`);
    if (short('.git')) hidden.push(`/${short('.git')}/config`, `/${short('.git')}/CONFIG`);
    if (!short('.env')) t.diagnostic('8.3 short names are off on this volume: the short-name cases were not exercised');
  }
  const srv = await S.startServer(root);
  try {
    const get = async (p) => request(srv.url + p);
    for (const p of ['/.env', '/%2eenv', '/.ENV', '/.env.example', '/.git/config']) assert.equal((await get(p)).status, 404, p);
    for (const p of hidden) {
      const r = await get(p);
      assert.equal(r.status, 404, `${p} must not serve a dot-file (got ${r.status}: ${r.body.toString().slice(0, 40)})`);
    }
    assert.equal((await get('/lib/runtime.js')).status, 200);
    assert.equal((await get('/studio.json')).status, 200);
    assert.equal((await get('/lib/')).status, 404, 'a directory without index.html');
    if (process.platform === 'win32') {
      // Windows takes `\` for a separator and `name:stream` for an NTFS alternate data stream: neither is a URL path here.
      assert.equal((await get('/lib%5Cruntime.js')).status, 404);
      assert.equal((await get('/studio.json::%24DATA')).status, 404);
      assert.equal((await get('/.env::%24DATA')).status, 404);
      assert.equal((await get(`/..%5c${path.basename(root)}-x`)).status, 403, 'traversal keeps its own answer');
    }
    if (!hidden.length) t.diagnostic('no symlink or short-name alias could be created here: only the literal names were exercised');
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

test('sha256 of strings and buffers (FIPS 180-2 vectors)', () => {
  assert.equal(S.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(S.sha256(Buffer.from('abc')), S.sha256('abc'));
  assert.equal(S.sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('fmtTime formats mm:ss.cc with rounding, hours, negatives and non-finite input', () => {
  assert.equal(S.fmtTime(4.2), '00:04.20');
  assert.equal(S.fmtTime(0), '00:00.00');
  assert.equal(S.fmtTime(4.199999), '00:04.20');
  assert.equal(S.fmtTime(59.999), '01:00.00');
  assert.equal(S.fmtTime(75.5), '01:15.50');
  assert.equal(S.fmtTime(3723.45), '1:02:03.45');
  assert.equal(S.fmtTime(-1.5), '-00:01.50');
  assert.equal(S.fmtTime(NaN), '--:--.--');
  assert.equal(S.fmtTime(undefined), '--:--.--');
});

test('loadEnv / parseEnv: export, quotes, escapes, inline comments, CRLF, BOM; never touches process.env', () => {
  const dir = tmp('ms-env-');
  const text = '﻿# comment\r\nELEVENLABS_API_KEY=sk_live_123\r\nexport FAL_KEY = "fal key"  \n' +
    "SINGLE='a #not comment'\nINLINE=value # trailing comment\nHASH=abc#def\nEMPTY=\nESC=\"line1\\nline2 \\\"q\\\"\"\n" +
    'bad line\n=novalue\n1BAD=x\nDOTTED.KEY=ok\nDUP=1\nDUP=2\n';
  fs.writeFileSync(path.join(dir, '.env'), text);
  // Compare a digest so a failure never prints the environment (it can hold tokens).
  const envDigest = () => S.sha256(JSON.stringify(Object.entries({ ...process.env }).sort()));
  const before = envDigest();
  const env = S.loadEnv(dir);
  assert.deepEqual(env, {
    ELEVENLABS_API_KEY: 'sk_live_123', FAL_KEY: 'fal key', SINGLE: 'a #not comment', INLINE: 'value', HASH: 'abc#def', EMPTY: '',
    ESC: 'line1\nline2 "q"', 'DOTTED.KEY': 'ok', DUP: '2',
  });
  assert.equal(envDigest(), before, 'process.env untouched');
  assert.deepEqual(S.loadEnv(tmp()), {}, 'missing .env → {}');
});

test('slug, outDir, even, mimeType, dataUrlToBuffer', () => {
  assert.equal(S.slug('Make It Move — Launch Reel!'), 'make-it-move-launch-reel');
  assert.equal(S.slug('Crème brûlée'), 'creme-brulee');
  assert.equal(S.slug('모션 스튜디오'), '모션-스튜디오');
  assert.equal(S.slug('!!!'), 'film');
  assert.equal(S.outDir('/p', '9x16', 'poster.png'), path.join('/p', 'out', '9x16', 'poster.png'));
  assert.equal(S.even(269.5), 270);
  assert.equal(S.even(271), 272);
  assert.equal(S.even(0.2), 2);
  assert.equal(S.mimeType('X.WOFF2'), 'font/woff2');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(S.dataUrlToBuffer(`data:image/png;base64,${png.toString('base64')}`), png);
  assert.throws(() => S.dataUrlToBuffer('data:,'), /no PNG/);
});

test('writeFileAtomic / writeJSON / readJSON / ensureDir', () => {
  const dir = tmp('ms-io-');
  const p = path.join(dir, 'a', 'b', 'x.json');
  S.writeJSON(p, { a: 1 });
  assert.equal(fs.readFileSync(p, 'utf8'), '{\n  "a": 1\n}\n');
  S.writeJSON(p, { a: 2 });
  assert.deepEqual(S.readJSON(p), { a: 2 });
  assert.deepEqual(fs.readdirSync(path.dirname(p)), ['x.json'], 'no temp files left behind');
  assert.equal(S.readJSON(path.join(dir, 'missing.json'), null), null);
  assert.throws(() => S.readJSON(path.join(dir, 'missing.json')), /missing/);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{"a":');
  assert.throws(() => S.readJSON(path.join(dir, 'bad.json'), null), /not valid JSON/, 'corrupt files are never masked by the fallback');
  assert.equal(S.ensureDir(path.join(dir, 'q', 'r')), path.join(dir, 'q', 'r'));
  assert.ok(fs.statSync(path.join(dir, 'q', 'r')).isDirectory());
});

test('run never throws: non-zero exit, missing binary, stdin input, timeout, buffer encoding', async () => {
  const r = await S.run(process.execPath, ['-e', 'process.stderr.write("oops"); process.stdout.write("out"); process.exit(3)']);
  assert.equal(r.code, 3);
  assert.equal(r.stdout, 'out');
  assert.equal(r.stderr, 'oops');
  const missing = await S.run('definitely-not-a-binary-motion-studio', ['-v']);
  assert.equal(missing.code, null);
  assert.ok(missing.error);
  const echo = await S.run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'piped' });
  assert.equal(echo.stdout, 'piped');
  const buf = await S.run(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0,255,1]))'], { encoding: 'buffer' });
  assert.deepEqual([...buf.stdout], [0, 255, 1]);
  const slow = await S.run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  let seen = '';
  await S.run(process.execPath, ['-e', 'process.stderr.write("live")'], { onStderr: (d) => { seen += d; } });
  assert.equal(seen, 'live');
  const env = await S.run(process.execPath, ['-e', 'process.stdout.write(String(process.env.MS_TEST_VAR) + ":" + Boolean(process.env.PATH || process.env.Path))'], { env: { MS_TEST_VAR: 'yes' } });
  assert.equal(env.stdout, 'yes:true', 'env is merged over process.env');
});

let ffmpegBin = null;
try { ffmpegBin = S.resolveFfmpeg(TEMPLATE); } catch { ffmpegBin = null; }

test('resolveFfmpeg honours FFMPEG_PATH', { skip: !ffmpegBin && 'ffmpeg not available' }, () => {
  const saved = process.env.FFMPEG_PATH;
  try {
    process.env.FFMPEG_PATH = ffmpegBin;
    assert.equal(S.resolveFfmpeg(tmp('ms-ff-')), ffmpegBin);
  } finally {
    if (saved === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = saved;
  }
});

test('ffmpeg() throws with stderr tail; ffmpegSink encodes and surfaces a dead ffmpeg as a rejection', { skip: !ffmpegBin && 'ffmpeg not available' }, async () => {
  const root = tmp('ms-ffs-');
  const saved = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = ffmpegBin;
  try {
    const v = await S.ffmpeg(root, ['-version']);
    assert.match(v.stdout, /ffmpeg version/);
    await assert.rejects(S.ffmpeg(root, ['-f', 'lavfi', '-i', 'nullsrc', '-vf', 'nosuchfilter', '-f', 'null', '-']), /No such filter|nosuchfilter/);
    const raw = await S.ffmpeg(root, ['-f', 'lavfi', '-i', 'color=c=red:s=4x2:d=0.04:r=25', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    assert.ok(Buffer.isBuffer(raw.stdout) && raw.stdout.length === 4 * 2 * 3, 'binary stdout comes back as a Buffer');
    const out = path.join(root, 'o.nut');
    const sink = S.ffmpegSink(root, ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '4x2', '-r', '10', '-i', '-', '-c:v', 'rawvideo', out]);
    for (let i = 0; i < 5; i++) await sink.write(Buffer.alloc(24, i * 40));
    await sink.end();
    assert.ok(fs.statSync(out).size > 0);
    const bad = S.ffmpegSink(root, ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '4x2', '-i', '-', '-vf', 'nosuchfilter', path.join(root, 'x.nut')]);
    await assert.rejects((async () => { for (let i = 0; i < 200; i++) await bad.write(Buffer.alloc(65536)); await bad.end(); })(), /ffmpeg exited with/);
    const killed = S.ffmpegSink(root, ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '4x2', '-i', '-', path.join(root, 'k.nut')]);
    killed.kill();
    await assert.rejects(killed.closed, /stopped/);
  } finally {
    if (saved === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = saved;
  }
});

test('isMainModule is false for an imported module', () => {
  assert.equal(S.isMainModule(STUDIO), false);
});

// ---------------------------------------------------------------------------------------------------------------
// Bounded teardown and prompt CLI exit

test('main: a returned exit code ends the process within ~1 s despite a leaked handle; undefined keeps it running', () => {
  const run = (body) => {
    const dir = tmp('ms-exit-');
    const file = path.join(dir, 'cli.mjs');
    fs.writeFileSync(file, `import { main } from ${JSON.stringify(STUDIO)};\nmain(async () => { ${body} });\n`);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 60000, env: { ...process.env, DEBUG: '' } });
    return { ...r, ms: Date.now() - t0 };
  };
  // A handle that would hold the loop for 60 s (like a browser still shutting down after its bounded close).
  const leak = 'setTimeout(() => process.stdout.write("late"), 60000);';
  const done = run(`${leak} process.stdout.write('{"ok":true}' + "\\n"); return 4;`);
  assert.equal(done.status, 4);
  assert.equal(done.stdout, '{"ok":true}\n', 'result line flushed, late write never happens');
  assert.ok(done.ms < 30000, `exited after ${done.ms} ms`);
  const failed = run(`${leak} throw new Error('boom');`);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /error: boom/);
  assert.ok(failed.ms < 30000, `failed CLI exited after ${failed.ms} ms`);
  const serving = run('setTimeout(() => process.stdout.write("still serving"), 1500); return undefined;');
  assert.equal(serving.status, 0);
  assert.equal(serving.stdout, 'still serving', 'a CLI that returns undefined (serve.mjs) is never cut short');
});

test('settleWithin resolves true when the promise settles, false when abandoned; never rejects', async () => {
  assert.equal(await S.settleWithin(Promise.resolve(1), 1000), true);
  assert.equal(await S.settleWithin(Promise.reject(new Error('x')), 1000), true);
  assert.equal(await S.settleWithin('not a promise', 1000), true);
  const t0 = Date.now();
  assert.equal(await S.settleWithin(new Promise(() => {}), 50), false);
  assert.ok(Date.now() - t0 < 5000);
});

test('boundClose: browser.close() is bounded, idempotent and calls the real close once', async () => {
  let calls = 0;
  const hung = S.boundClose({ close: () => { calls++; return new Promise(() => {}); } }, 50);
  const t0 = Date.now();
  const first = hung.close();
  assert.equal(hung.close(), first, 'a second close() returns the same bounded promise');
  assert.equal(await first, false, 'abandoned after the timeout');
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(calls, 1);
  let opts = null;
  const quick = S.boundClose({ close: async (o) => { opts = o; } }, 5000);
  assert.equal(await quick.close({ reason: 'done' }), true);
  assert.deepEqual(opts, { reason: 'done' }, 'options are passed through');
  const failing = S.boundClose({ close: async () => { throw new Error('already closed'); } }, 5000);
  assert.equal(await failing.close(), true, 'a rejected close never throws');
  // A hung close kills the browser process (pid read at launch) and then waits briefly for the close to finish.
  const proc = () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
    return { child, exited: new Promise((resolve) => child.once('exit', () => resolve())) };
  };
  const a = proc();
  const wedged = S.boundClose({ close: () => a.exited, isConnected: () => true }, 100, { pid: a.child.pid });
  const t1 = Date.now();
  assert.equal(await wedged.close(), false);
  const closeMs = Date.now() - t1;
  // boundClose only waits 3 s for the close after the kill; the OS may take longer to report the exit on a saturated machine.
  await Promise.race([a.exited, new Promise((resolve) => setTimeout(resolve, 20000))]);
  assert.ok(a.child.exitCode !== null || a.child.signalCode !== null, 'the browser process was killed');
  assert.ok(closeMs < 10000, `the bounded close took ${closeMs} ms`);
  const b = proc();
  try {
    const gone = S.boundClose({ close: () => new Promise(() => {}), isConnected: () => false }, 50, { pid: b.child.pid });
    assert.equal(await gone.close(), false);
    assert.equal(b.child.exitCode, null, 'a disconnected browser pid is never killed (it may have been reused)');
  } finally { b.child.kill(); await b.exited; }
  const saved = process.env.MOTION_CLOSE_TIMEOUT_MS;
  try {
    delete process.env.MOTION_CLOSE_TIMEOUT_MS;
    assert.equal(S.closeTimeoutMs(), 8000);
    process.env.MOTION_CLOSE_TIMEOUT_MS = '1500';
    assert.equal(S.closeTimeoutMs(), 1500);
  } finally {
    if (saved === undefined) delete process.env.MOTION_CLOSE_TIMEOUT_MS; else process.env.MOTION_CLOSE_TIMEOUT_MS = saved;
  }
});

test('launchBrowser: browser and context closes are bounded and idempotent; a CLI with hung closes still exits promptly', () => {
  // A fake `playwright` (no real browser): FAKE_HANG=1 makes every close() hang forever, like a wedged Chrome on Windows.
  const root = tmp('ms-fakepw-');
  writeStudio(root, {});
  const pw = path.join(root, 'node_modules', 'playwright');
  fs.mkdirSync(pw, { recursive: true });
  fs.writeFileSync(path.join(pw, 'package.json'), '{"name":"playwright","version":"0.0.0","main":"index.js"}');
  fs.writeFileSync(path.join(pw, 'index.js'), `
const hang = () => process.env.FAKE_HANG ? new Promise(() => {}) : Promise.resolve();
exports.chromium = { async launch() { return {
  version: () => 'fake 1.0', isConnected: () => true, close: hang,
  newBrowserCDPSession: async () => ({ send: async () => ({ processInfo: [] }), detach: async () => {} }),
  async newContext() { return { close: hang }; },
}; } };`);
  fs.writeFileSync(path.join(root, 'cli.mjs'), `import { main, launchBrowser, loadConfig } from ${JSON.stringify(STUDIO)};
main(async () => {
  const { browser } = await launchBrowser(${JSON.stringify(root)}, loadConfig(${JSON.stringify(root)}));
  setInterval(() => {}, 1000); // a leaked handle that would keep the process alive forever
  const context = await browser.newContext();
  const t0 = Date.now();
  const first = context.close();
  const again = context.close();
  const results = { context: await first, contextAgain: await again, sameCall: first === again, browser: await browser.close() };
  process.stdout.write(JSON.stringify({ ...results, browserAgain: await browser.close(), ms: Date.now() - t0 }) + '\\n');
  return 0;
});
`);
  try {
    const cli = (extra) => {
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [path.join(root, 'cli.mjs')], { cwd: root, encoding: 'utf8', timeout: 60000,
        env: { ...process.env, DEBUG: '', MOTION_CLOSE_TIMEOUT_MS: '300', MOTION_CHROME_PATH: '', ...extra } });
      return { ...r, wall: Date.now() - t0, json: JSON.parse(r.stdout.trim().split('\n').at(-1) || 'null') };
    };
    const quick = cli({});
    assert.equal(quick.status, 0, quick.stderr);
    assert.deepEqual([quick.json.context, quick.json.contextAgain, quick.json.browser, quick.json.browserAgain], [true, true, true, true]);
    assert.equal(quick.json.sameCall, true, 'a second context.close() returns the same promise');
    const hung = cli({ FAKE_HANG: '1' });
    assert.equal(hung.status, 0, hung.stderr);
    assert.deepEqual([hung.json.context, hung.json.contextAgain, hung.json.browser, hung.json.browserAgain], [false, false, false, false], 'abandoned after the timeout');
    assert.ok(hung.json.ms >= 250 && hung.json.ms < 8000, `two bounded closes took ${hung.json.ms} ms`);
    assert.match(hung.stderr, /note: the browser did not close within 0\.3 s/);
    assert.ok(hung.wall < 30000, `the CLI exited after ${hung.wall} ms despite hung closes and a leaked handle`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('isBenignConsoleError: only 404s of optional resources, matched on the location URL', () => {
  const nf = 'Failed to load resource: the server responded with a status of 404 (Not Found)';
  const base = 'http://127.0.0.1:5173';
  for (const p of ['/audio/beats.json', '/assets/fonts/fonts.json', '/favicon.ico', '/audio/beats.json?v=2'])
    assert.equal(S.isBenignConsoleError(nf, base + p), true, p);
  assert.equal(S.isBenignConsoleError(nf, `${base}/film/film.js`), false, 'a missing import is a real error');
  assert.equal(S.isBenignConsoleError(nf, `${base}/studio.json`), false, 'studio.json is required');
  assert.equal(S.isBenignConsoleError(nf, `${base}/audio/beats.json.bak`), false);
  assert.equal(S.isBenignConsoleError('Failed to load resource: the server responded with a status of 500 (Internal Server Error)', `${base}/audio/beats.json`), false,
    'a broken optional file is still an error');
  assert.equal(S.isBenignConsoleError('Uncaught TypeError: x is undefined', `${base}/audio/beats.json`), false);
  assert.equal(S.isBenignConsoleError(nf, ''), false);
  assert.ok(Object.isFrozen(S.OPTIONAL_RESOURCES));
});

// ---------------------------------------------------------------------------------------------------------------
// render.mjs frame timing (a clip's frames are the full render's frames, bit for bit)

const R = await import(pathToFileURL(path.join(TEMPLATE, 'tools', 'render.mjs')).href);

test('render frameTime: clip frame k equals full-render frame (from·fps + k) exactly', () => {
  // from + k/fps drifts by one ulp for ~24% of frames (0.0333… + 5/30 = 0.19999999999999998, not 0.2).
  assert.equal(R.frameTime(1 / 30, 5, 30), 0.2);
  assert.equal(R.frameTime(0.5, 1, 12), 7 / 12);
  for (const fps of [12, 24, 30, 60]) {
    for (let F = 0; F <= 3 * fps; F++) {
      const from = Math.round((F / fps) * fps) / fps;
      for (let k = 0; k < fps; k++) assert.equal(R.frameTime(from, k, fps), (F + k) / fps, `fps ${fps} from frame ${F} + ${k}`);
    }
  }
});

test('runPipeline captures the absolute frame times in order and writes them in order', async () => {
  const seen = [];
  const film = {
    errors: { page: [] },
    context: { close: async () => {} },
    page: { evaluate: async (fn, o) => { seen.push(o.t); return `data:image/png;base64,${Buffer.from(`frame t=${o.t}`.padEnd(48, '.')).toString('base64')}`; } },
  };
  const written = [];
  const sink = { write: async (b) => { written.push(b.toString().replace(/\.+$/, '')); }, end: async () => {}, kill() {} };
  const hashes = [];
  const fps = 30;
  await R.runPipeline({ pool: R.filmPool(film, []), meta: { capture: 'canvas', fps }, fps, sub: 1, shutter: 0.5, from: 1 / 30, startFrame: 3, count: 12, sink, hashes });
  const want = Array.from({ length: 12 }, (_, i) => (1 + 3 + i) / fps);
  assert.deepEqual(seen, want);
  assert.deepEqual(written, want.map((t) => `frame t=${t}`));
  assert.equal(hashes.length, 12);
});

test('runPipeline (page capture) tells the film which subframe of which output frame each screenshot is', async () => {
  const calls = [];
  const film = {
    errors: { page: [] },
    context: { close: async () => {} },
    page: { evaluate: async (fn, o) => { calls.push(o); }, screenshot: async () => Buffer.from('png') },
  };
  const written = [];
  const sink = { write: async (b) => { written.push(b); }, end: async () => {}, kill() {} };
  const fps = 30;
  await R.runPipeline({ pool: R.filmPool(film, []), meta: { capture: 'page', fps }, fps, sub: 3, shutter: 0.5, from: 0, count: 2, sink, hashes: [] });
  assert.equal(calls.length, 6, '2 frames x 3 subframes');
  calls.forEach((c, i) => {
    const k = Math.floor(i / 3);
    const j = i % 3;
    assert.deepEqual(c.b, { frameT: k / fps, sub: j, subs: 3 }, `screenshot ${i}`);
    assert.ok(Math.abs(c.tt - (k / fps + (((j + 0.5) / 3 - 0.5) * 0.5) / fps)) < 1e-12, `subframe time ${i}`);
  });
  assert.equal(written.length, 6);
});

test('frameRange: a range is partial only when it leaves out frames of the film (29.97 fps, 1.3 s at 24 fps, ...)', () => {
  const r = (duration, fps, from, to) => { const x = R.frameRange(duration, fps, from, to); return [x.frames, x.partial, x.from, x.to]; };
  // The reported cases: neither is a whole number of frames in seconds, both are full renders.
  assert.deepEqual(r(2, 29.97), [60, false, 0, 60 / 29.97]);
  assert.deepEqual(r(1.3, 24), [31, false, 0, 31 / 24]);
  assert.deepEqual(r(7.3, 24), [175, false, 0, 175 / 24]);
  assert.deepEqual(r(12, 60), [720, false, 0, 12]);
  assert.deepEqual(r(2, 12), [24, false, 0, 2]);
  // The whole film spelled out, or a --to past the end, is still the whole film.
  assert.equal(R.frameRange(1.3, 24, 0, 1.3).partial, false);
  assert.equal(R.frameRange(1.3, 24, 0, 99).partial, false);
  assert.equal(R.frameRange(2, 29.97, 0, 2).partial, false);
  assert.equal(R.frameRange(2, 29.97, undefined, 2.002).partial, false);
  // Explicit ranges are partial and land on the frame grid.
  assert.deepEqual(r(2, 12, 0.5, 1), [6, true, 0.5, 1]);
  assert.deepEqual(r(1.3, 24, 1, undefined), [7, true, 24 / 24, 31 / 24]);
  assert.deepEqual(r(12, 60, 0, 5), [300, true, 0, 5]);
  assert.equal(R.frameRange(1.3, 24, 0, 1.25).partial, true, 'one frame short of the end is a clip');
  assert.equal(R.frameRange(2, 12, 0.02, undefined).partial, false, 'a --from that snaps to frame 0 leaves nothing out');
  assert.equal(R.frameRange(2, 12, 0.5, 0.5).frames, 0, 'an empty range reports zero frames (render turns it into a usage error)');
  assert.equal(R.frameRange(2, 12).total, 24);
});

const publishFixture = () => {
  const dir = tmp('ms-publish-');
  const out = path.join(dir, 'out', '16x9');
  const staging = path.join(out, '.staging');
  fs.mkdirSync(staging, { recursive: true });
  const put = (base, name, text) => { fs.writeFileSync(path.join(base, name), text); return path.join(base, name); };
  for (const n of ['silent.mp4', 'render.json', 'poster.png', 'frames.sha256']) put(out, n, `old ${n}`);
  for (const n of ['silent.mp4', 'render.json']) put(staging, n, `new ${n}`);
  const plan = [
    { to: path.join(out, 'render.json'), from: path.join(staging, 'render.json') },
    { to: path.join(out, 'frames.sha256'), from: null },
    { to: path.join(out, 'poster.png'), from: null },
    { to: path.join(out, 'silent.mp4'), from: path.join(staging, 'silent.mp4') },
  ];
  const read = (base) => Object.fromEntries(fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => [e.name, fs.readFileSync(path.join(base, e.name), 'utf8')]));
  return { out, staging, plan, backupDir: path.join(staging, '.previous'), read };
};
const busy = (code = 'EBUSY') => Object.assign(new Error(`${code}: resource busy or locked, rename`), { code });

test('publishFiles: the new set replaces the old one, stale poster and hash list are removed, the picture goes in last', () => {
  const { out, staging, plan, backupDir, read } = publishFixture();
  const order = [];
  R.publishFiles(plan, { backupDir, waitMs: 0, rename: (a, b) => { order.push(path.basename(b)); fs.renameSync(a, b); } });
  assert.deepEqual(read(out), { 'silent.mp4': 'new silent.mp4', 'render.json': 'new render.json' }, 'no old poster.png or frames.sha256 is left beside the new video');
  assert.deepEqual(read(staging), {}, 'staged files moved out');
  assert.deepEqual(order.slice(-2), ['render.json', 'silent.mp4'], 'the mp4 is published last');
});

test('publishFiles: when the previous silent.mp4 is held open nothing changes, the staged render survives, the error names the file', () => {
  for (const at of ['old-mp4', 'new-mp4', 'old-poster']) {
    const { out, staging, plan, backupDir, read } = publishFixture();
    const before = read(out);
    const rename = (a, b) => {
      // moving the old video away (old-mp4), moving a new one in (new-mp4), or the old poster away (old-poster) fails
      if (at === 'old-mp4' && a === path.join(out, 'silent.mp4')) throw busy();
      if (at === 'new-mp4' && a === path.join(staging, 'silent.mp4') && b === path.join(out, 'silent.mp4')) throw busy('EPERM');
      if (at === 'old-poster' && a === path.join(out, 'poster.png')) throw busy();
      fs.renameSync(a, b);
    };
    let waited = 0;
    assert.throws(() => R.publishFiles(plan, { backupDir, waitMs: 60, onWait: () => { waited++; }, rename }), (err) => {
      assert.ok(['EBUSY', 'EPERM'].includes(err.code), at);
      assert.equal(err.file, path.join(out, at === 'old-poster' ? 'poster.png' : 'silent.mp4'), at);
      assert.match(err.message, /^cannot (replace|write) .*: E(BUSY|PERM): .*\(another program has it open/, at);
      return true;
    }, at);
    assert.deepEqual(read(out), before, `${at}: every previous output is exactly as it was (no new video next to the old render.json)`);
    assert.deepEqual(read(staging), { 'silent.mp4': 'new silent.mp4', 'render.json': 'new render.json' }, `${at}: the finished render is still in staging`);
    assert.ok(at === 'new-mp4' ? waited === 0 : waited === 1, `${at}: onWait ran ${waited}x`);
  }
});

test('publishFiles: a sharing violation that ends within the wait is retried, and only a lock error is retried', () => {
  const { out, plan, backupDir, read } = publishFixture();
  let fails = 2;
  R.publishFiles(plan, { backupDir, waitMs: 5000, rename: (a, b) => { if (a === path.join(out, 'silent.mp4') && fails-- > 0) throw busy('EPERM'); fs.renameSync(a, b); } });
  assert.equal(read(out)['silent.mp4'], 'new silent.mp4');
  const other = publishFixture();
  let calls = 0;
  assert.throws(() => R.publishFiles(other.plan, { backupDir: other.backupDir, waitMs: 5000, rename: () => { calls++; throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }); } }), /cannot replace .*ENOSPC/);
  assert.equal(calls, 1, 'a disk error is not retried');
});

test('lockedFiles: existing files that can be replaced are not reported', () => {
  const dir = tmp('ms-locked-');
  const f = path.join(dir, 'silent.mp4');
  fs.writeFileSync(f, 'x');
  assert.deepEqual(R.lockedFiles([f, path.join(dir, 'missing.mp4')]), []);
  const saved = process.env.MOTION_PUBLISH_WAIT_MS;
  try {
    delete process.env.MOTION_PUBLISH_WAIT_MS;
    assert.equal(R.publishWaitMs(), 30000);
    process.env.MOTION_PUBLISH_WAIT_MS = '1200';
    assert.equal(R.publishWaitMs(), 1200);
    process.env.MOTION_PUBLISH_WAIT_MS = 'soon';
    assert.equal(R.publishWaitMs(), 30000);
  } finally {
    if (saved === undefined) delete process.env.MOTION_PUBLISH_WAIT_MS; else process.env.MOTION_PUBLISH_WAIT_MS = saved;
  }
});

// Windows only: a real sharing violation. A PowerShell child holds the file open for reading without delete sharing, which
// is what a video player or image viewer does; a rename over it then fails with EBUSY/EPERM.
const holdOpen = (file) => new Promise((resolve, reject) => {
  const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `$f = [IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null; $f.Close()`],
  { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  ps.once('error', reject);
  ps.stdout.once('data', () => resolve({ release: () => new Promise((done) => { ps.once('exit', done); ps.stdin.end('\n'); }), ps }));
  ps.once('exit', () => reject(new Error('the lock holder exited early')));
});

test('publishFiles against a file another program really holds open (Windows)', { skip: process.platform !== 'win32' && 'needs Windows file sharing semantics', timeout: 120000 }, async () => {
  const { out, staging, plan, backupDir, read } = publishFixture();
  const before = read(out);
  const lock = await holdOpen(path.join(out, 'silent.mp4'));
  try {
    assert.deepEqual(R.lockedFiles([path.join(out, 'silent.mp4'), path.join(out, 'render.json')]), [path.join(out, 'silent.mp4')], 'the pre-flight names the locked file');
    const t0 = Date.now();
    assert.throws(() => R.publishFiles(plan, { backupDir, waitMs: 800 }), (err) => err.file === path.join(out, 'silent.mp4') && /another program has it open/.test(err.message));
    assert.ok(Date.now() - t0 >= 700, 'it waited for the lock before giving up');
    assert.deepEqual(read(out), before, 'nothing was replaced');
    assert.deepEqual(read(staging), { 'silent.mp4': 'new silent.mp4', 'render.json': 'new render.json' });
  } finally { await lock.release(); }
  R.publishFiles(plan, { backupDir, waitMs: 800 });
  assert.deepEqual(read(out), { 'silent.mp4': 'new silent.mp4', 'render.json': 'new render.json' }, 'once the lock is gone the same staged files publish');
});

// ---------------------------------------------------------------------------------------------------------------
// waitReady: the report must not depend on which event Chrome delivers first

const W = await import(pathToFileURL(path.join(TEMPLATE, 'tools', 'studio-web.mjs')).href);

/** A stand-in for a Playwright page whose `window` is a plain object driven by timers (delays in ms; null = never). */
async function bootScenario({ studioAt = 0, rejectAt = null, pageErrorAt = null, studioError = null, reason = 'Error: nope\n    at boot (film.js:1:1)', pageText = 'Error: nope\n    at boot (film.js:1:1)' }) {
  const win = { __studio: undefined, stopped: false };
  const errors = { page: [], console: [] };
  let sawPageError;
  const pageError = new Promise((resolve) => { sawPageError = resolve; });
  const saved = globalThis.window;
  globalThis.window = win;
  const timers = [];
  const at = (ms, fn) => { if (ms !== null) timers.push(setTimeout(fn, ms)); };
  at(studioAt, () => {
    let reject;
    const ready = new Promise((_, r) => { reject = r; });
    ready.catch(() => {}); // like the fixture page: nobody handles it
    win.__studio = { ready, error: null };
    at(rejectAt === null ? null : Math.max(0, rejectAt - studioAt), () => { win.__studio.error = studioError ?? reason; reject(Object.assign(new Error('x'), { stack: reason })); });
  });
  at(pageErrorAt, () => { errors.page.push(pageText); sawPageError(); });
  const page = {
    waitForFunction: (fn, _arg, { timeout }) => new Promise((resolve, rej) => {
      const t0 = Date.now();
      const poll = () => {
        if (win.stopped) return;
        let v = false;
        try { v = fn(); } catch { /* not there yet */ }
        if (v) resolve();
        else if (Date.now() - t0 > timeout) rej(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
        else setTimeout(poll, 5);
      };
      poll();
    }),
    evaluate: async (fn, arg) => fn(arg),
  };
  try {
    await W.waitReady(page, errors, { timeoutMs: 3000, pageError });
    return { message: null };
  } catch (err) {
    return { message: err.message, detail: err.detail };
  } finally {
    win.stopped = true;
    for (const id of timers) clearTimeout(id);
    globalThis.window = saved;
  }
}

test('waitReady: a rejected __studio.ready is reported the same way whether or not (and whenever) the pageerror arrives', async () => {
  const want = '__studio.ready rejected: Error: nope';
  const cases = [
    { name: 'rejects first, pageerror just after', rejectAt: 5, pageErrorAt: 8 },
    { name: 'pageerror first, rejects within the grace', rejectAt: 60, pageErrorAt: 5 },
    { name: 'pageerror first, rejects after the grace', rejectAt: 250, pageErrorAt: 5 },
    { name: 'both at once', rejectAt: 0, pageErrorAt: 0 },
    { name: 'no pageerror at all', rejectAt: 20, pageErrorAt: null },
    { name: 'created late', studioAt: 40, rejectAt: 45, pageErrorAt: 20 },
  ];
  for (const c of cases) {
    const r = await bootScenario(c);
    assert.equal(r.message, want, `${c.name}: ${r.message}`);
  }
  // A shuffled run: the message is identical for every interleaving.
  const seen = new Set();
  let seed = 7;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = 0; i < 14; i++) {
    const rejectAt = Math.floor(rnd() * 40);
    const pageErrorAt = Math.floor(rnd() * 40);
    seen.add((await bootScenario({ rejectAt, pageErrorAt })).message);
  }
  assert.deepEqual([...seen], [want], 'one message for every ordering');
});

test('waitReady: __studio.error is added when it says something else, a page error alone is "the page threw while booting"', async () => {
  const other = await bootScenario({ rejectAt: 5, pageErrorAt: 8, reason: 'Error: setup failed\n    at s (a.js:1:1)', studioError: 'Error: the real cause\n    at s (a.js:2:2)' });
  assert.equal(other.message, '__studio.ready rejected: Error: setup failed (__studio.error: Error: the real cause)');
  assert.deepEqual(other.detail, ['at s (a.js:1:1)']);
  // The film threw before window.__studio existed.
  const early = await bootScenario({ studioAt: null, pageErrorAt: 5, pageText: 'Error: film exploded at import\n    at film.js:1:1' });
  assert.equal(early.message, 'the page threw while booting: Error: film exploded at import');
  // __studio exists, is still working, and an unrelated page error fires: reported as the page error, with __studio.error if set.
  const pending = await bootScenario({ pageErrorAt: 5, pageText: 'TypeError: x is not a function' });
  assert.equal(pending.message, 'the page threw while booting: TypeError: x is not a function');
  // ready never settles and nothing throws: a timeout naming the limit.
  const hang = await bootScenario({});
  assert.match(hang.message, /^__studio\.ready did not resolve within 3 s/);
});

// ---------------------------------------------------------------------------------------------------------------
// openFilm against a real browser (runs when playwright resolves and a Chromium browser launches; else skips)

function findNodeModules() {
  const env = process.env.MOTION_SMOKE_NODE_MODULES;
  if (env) return fs.existsSync(path.join(env, 'playwright')) || fs.existsSync(path.join(env, 'playwright-core')) ? path.resolve(env) : null;
  for (const base of [path.join(REPO, 'package.json'), path.join(TEMPLATE, 'package.json')]) {
    for (const name of ['playwright', 'playwright-core']) {
      try { return path.dirname(path.dirname(createRequire(base).resolve(`${name}/package.json`))); } catch { /* next */ }
    }
  }
  return null;
}

const FIXTURE_PAGE = `<!doctype html><meta charset="utf-8"><link rel="icon" href="/favicon.ico"><canvas id="stage" width="64" height="36"></canvas>
<script type="module">
const kase = new URLSearchParams(location.search).get('case');
const meta = { width: 64, height: 36, fps: 30, duration: 1, capture: 'canvas' };
if (kase === 'throw') throw new Error('film exploded at import');
if (kase === 'ok') {
  await Promise.all(['audio/beats.json', 'assets/fonts/fonts.json'].map((u) => fetch(u, { cache: 'no-store' })));
  console.error('real problem the film reported');
  window.__studio = { version: 1, ready: Promise.resolve(), error: null, meta };
}
if (kase === 'reject') {
  const err = new Error('brand font "Nope" is not bundled');
  window.__studio = { version: 1, error: String(err.stack), meta, ready: Promise.reject(err) };
}
if (kase === 'reject-other') {
  window.__studio = { version: 1, error: 'Error: the real cause\\n    at setup (film.js:3:9)', meta, ready: Promise.reject(new Error('setup failed')) };
}
if (kase === 'hang') window.__studio = { version: 1, error: null, meta, ready: new Promise(() => {}) };
if (kase === 'missing-import') { // like index.html importing a film file that is not there: a 404, no pageerror
  const s = document.createElement('script');
  s.type = 'module';
  s.textContent = "import film from './film/nope.js'; window.__studio = { ready: Promise.resolve(), meta: {} };";
  document.head.append(s);
}
</script>`;

test('openFilm: benign 404s ignored, real errors kept, readable ready failures, fast boot failures', { timeout: 240000 }, async (t) => {
  const nm = findNodeModules();
  if (!nm) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  const root = tmp('ms-film-');
  writeStudio(root, {});
  fs.writeFileSync(path.join(root, 'index.html'), FIXTURE_PAGE);
  const link = path.join(root, 'node_modules');
  try { fs.symlinkSync(nm, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* resolved via the template instead */ }
  const srv = await S.startServer(root);
  let browser = null;
  try {
    try { ({ browser } = await S.launchBrowser(root, S.loadConfig(root))); } catch (err) { t.skip(`no browser: ${String(err.message).split('\n')[0]}`); return; }
    const open = (kase, extra = {}) => S.openFilm(browser, srv.url, { query: { case: kase }, ...extra });
    const failure = async (kase, extra) => { const t0 = Date.now(); try { await open(kase, extra); } catch (err) { return { message: err.message, ms: Date.now() - t0 }; } assert.fail(`${kase} should fail`); };

    const ok = await open('ok');
    try {
      assert.deepEqual(ok.errors.page, []);
      assert.equal(ok.errors.console.length, 1, ok.errors.console.join('\n'));
      assert.match(ok.errors.console[0], /real problem the film reported/);
      assert.equal(ok.meta.width, 64);
    } finally { await ok.context.close(); }

    // The fixture's ready promise is rejected and nobody handles it, so the page reports BOTH a rejected __studio.ready and
    // a pageerror. Which event reaches the tool first is up to Chrome; the message must not depend on it (it used to say
    // "the page threw while booting" on some runs), so the same cause is opened several times.
    for (let run = 1; run <= 5; run++) {
      const rej = await failure('reject');
      assert.match(rej.message, /__studio\.ready rejected: Error: brand font "Nope" is not bundled/, `run ${run}: ${rej.message}`);
      assert.doesNotMatch(rej.message, /the page threw while booting/, `run ${run}: one format, whatever the event order`);
      assert.doesNotMatch(rej.message, /__studio\.error:/, `run ${run}: the same text is not repeated`);
    }
    for (let run = 1; run <= 3; run++) {
      const other = await failure('reject-other');
      assert.match(other.message, /__studio\.ready rejected: Error: setup failed \(__studio\.error: Error: the real cause\)/, `run ${run}: ${other.message}`);
    }

    const threw = await failure('throw');
    assert.match(threw.message, /the page threw while booting: Error: film exploded at import/);
    assert.ok(threw.ms < 15000, `page errors fail fast (${threw.ms} ms)`);
    const missing = await failure('missing-import');
    assert.match(missing.message, /window\.__studio was never created/);
    assert.match(missing.message, /nope\.js/, 'the 404 of the import is reported');
    assert.ok(missing.ms < 15000, `a 404'd import fails before the 15 s limit (${missing.ms} ms)`);
    const hang = await failure('hang', { timeoutMs: 2500 });
    assert.match(hang.message, /__studio\.ready did not resolve within 3 s/);
  } finally {
    if (browser) await browser.close();
    await srv.close();
    try { if (fs.lstatSync(link).isSymbolicLink()) { try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); } } } catch { /* no link */ }
    // Retries are longer than they were: behind real-time antivirus the unsigned headless shell can outlive its tool by several
    // seconds (the browser inherits the project as its working directory), and a fresh file can stay locked while it is scanned;
    // either makes rmdir fail with EBUSY.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 });
    assert.ok(fs.existsSync(nm), 'shared node_modules untouched');
  }
});

// ---------------------------------------------------------------------------------------------------------------
// render.mjs CLI end to end on a tiny canvas film: the exact combination once reported as
// {"ok":false,"error":"films is not defined"} (partial range + --hash + --format all), plus the chunked path and teardown time.

const TINY_FILM = `<!doctype html><meta charset="utf-8"><canvas id="c"></canvas>
<script type="module">
const q = new URLSearchParams(location.search);
const [W, H] = { '9x16': [1080, 1920], '1x1': [1080, 1080], '16x9': [1920, 1080] }[q.get('format') || '9x16'];
const scale = Number(q.get('scale') || 1);
const even = (n) => Math.max(2, 2 * Math.round(n / 2));
const meta = { width: even(W * scale), height: even(H * scale), logicalWidth: W, logicalHeight: H, fps: 12, duration: 2, capture: 'canvas' };
const c = document.getElementById('c');
c.width = meta.width; c.height = meta.height;
const g = c.getContext('2d');
const paint = (t) => {
  g.fillStyle = 'rgb(' + Math.round(40 + 100 * t) + ',' + Math.round(80 + 60 * Math.sin(t * 3)) + ',120)';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#fff';
  g.fillRect(Math.round(t * c.width / 3), 4, 6, 6);
};
window.seek = (t) => { paint(t); return true; };
window.__studio = { version: 1, error: null, meta, ready: Promise.resolve(), frame: (o) => { paint(o.t); return c.toDataURL('image/png'); } };
</script>`;

test('render.mjs CLI: partial range + --hash + --format all (three formats), chunked resume digest, bounded teardown', { timeout: 600000 }, async (t) => {
  const nm = findNodeModules();
  if (!nm) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  if (!ffmpegBin) { t.skip('ffmpeg not available'); return; }
  const root = tmp('ms-render-');
  writeStudio(root, { title: 'Tiny', duration: 2, fps: 12, subframes: 1, formats: ['9x16', '1x1', '16x9'], primaryFormat: '9x16', gate: { enabled: false } });
  fs.writeFileSync(path.join(root, 'index.html'), TINY_FILM);
  const link = path.join(root, 'node_modules');
  try { fs.symlinkSync(nm, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* resolved via the template instead */ }
  try {
    try { const { browser } = await S.launchBrowser(root, S.loadConfig(root)); await browser.close(); } catch (err) { t.skip(`no browser: ${String(err.message).split('\n')[0]}`); return; }
    const render = (args) => new Promise((resolve) => {
      const t0 = Date.now();
      let wrote = null;
      let stdout = '';
      let stderr = '';
      const child = spawn(process.execPath, [path.join(TEMPLATE, 'tools', 'render.mjs'), ...args], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        env: { ...process.env, DEBUG: '', NODE_PATH: nm, MOTION_CLOSE_TIMEOUT_MS: '3000' },
      });
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; if (/\] wrote /.test(String(d))) wrote = Date.now(); });
      child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0, teardownMs: wrote === null ? null : Date.now() - wrote }));
    });
    const lastJson = (r) => JSON.parse(r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).at(-1));
    const clip = (fmt, ext) => path.join(root, 'out', fmt, `clip_0.50-1.00.${ext}`);
    const common = ['--from', '0.5', '--to', '1', '--hash', '--scale', '0.1', '--draft', '--json'];

    const all = await render(['--format', 'all', '--workers', '1', ...common]);
    assert.equal(all.code, 0, all.stderr);
    const json = lastJson(all);
    assert.equal(json.ok, true, JSON.stringify(json));
    assert.deepEqual(json.formats.map((f) => [f.format, f.partial, f.frames, f.fps]), [['9x16', true, 6, 12], ['1x1', true, 6, 12], ['16x9', true, 6, 12]]);
    const digests = {};
    for (const f of json.formats) {
      for (const ext of ['mp4', 'json', 'sha256']) assert.ok(fs.statSync(clip(f.format, ext)).size > 0, `${f.format} clip .${ext}`);
      assert.ok(!fs.existsSync(path.join(root, 'out', f.format, 'silent.mp4')), 'a partial range never touches silent.mp4');
      assert.ok(!fs.existsSync(path.join(root, 'out', f.format, '.staging')), 'staging removed');
      const lines = fs.readFileSync(clip(f.format, 'sha256'), 'utf8').trim().split('\n').map((l) => l.split(' '));
      assert.equal(lines.length, 6);
      lines.forEach(([i, time, hash], k) => {
        assert.equal(Number(i), k);
        assert.equal(time, R.frameTime(0.5, k, 12).toFixed(6), 'clip frame k is film frame 6 + k');
        assert.match(hash, /^[0-9a-f]{64}$/);
      });
      digests[f.format] = f.framesDigest;
      assert.equal(f.framesDigest, S.sha256(lines.map((l) => l[2]).join('\n')));
      assert.equal(S.readJSON(clip(f.format, 'json')).hash, 'clip_0.50-1.00.sha256');
    }
    assert.equal(new Set(Object.values(digests)).size, 3, 'each format has its own pixels');
    t.diagnostic(`3 formats, 1 worker: ${all.ms} ms, last "wrote" line to process exit ${all.teardownMs} ms`);
    assert.ok(all.teardownMs !== null && all.teardownMs < 30000, `teardown took ${all.teardownMs} ms (close bound 3 s)`);

    // The chunked path (segments + concat) with a partial range and hashes gives the same frames, on two workers.
    const chunked = await render(['--format', '9x16', '--workers', '2', '--chunk', '0.25', ...common]);
    assert.equal(chunked.code, 0, chunked.stderr);
    const cj = lastJson(chunked);
    assert.equal(cj.ok, true, JSON.stringify(cj));
    assert.equal(cj.formats[0].framesDigest, digests['9x16'], 'chunked + 2 workers = same frame hashes');
    assert.equal(S.readJSON(clip('9x16', 'json')).chunk, 0.25);

    // A failure still reports on stdout as one JSON line and exits 1.
    fs.writeFileSync(path.join(root, 'index.html'), TINY_FILM.replace("window.__studio = {", "throw new Error('film exploded'); window.__studio = {"));
    const broken = await render(['--format', '9x16', '--json', '--scale', '0.1', '--draft']);
    assert.equal(broken.code, 1);
    const bj = lastJson(broken);
    assert.equal(bj.ok, false);
    assert.match(bj.error, /film exploded/);
  } finally {
    try { if (fs.lstatSync(link).isSymbolicLink()) { try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); } } } catch { /* no link */ }
    // Retries are longer than they were: behind real-time antivirus the unsigned headless shell can outlive its tool by several
    // seconds (the browser inherits the project as its working directory), and a fresh file can stay locked while it is scanned;
    // either makes rmdir fail with EBUSY.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 });
    assert.ok(fs.existsSync(nm), 'shared node_modules untouched');
  }
});

// A throw-away project around TINY_FILM (12 fps meta, 2 s by default) with the shared node_modules linked in.
async function withTinyProject(t, { studio, film = TINY_FILM, needFfmpeg = true }, body) {
  const nm = findNodeModules();
  if (!nm) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  if (needFfmpeg && !ffmpegBin) { t.skip('ffmpeg not available'); return; }
  const root = tmp('ms-tiny-');
  writeStudio(root, studio);
  fs.writeFileSync(path.join(root, 'index.html'), film);
  const link = path.join(root, 'node_modules');
  try { fs.symlinkSync(nm, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* resolved via the template instead */ }
  try {
    try { const { browser } = await S.launchBrowser(root, S.loadConfig(root)); await browser.close(); } catch (err) { t.skip(`no browser: ${String(err.message).split('\n')[0]}`); return; }
    const tool = (name, args, env = {}) => new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const child = spawn(process.execPath, [path.join(TEMPLATE, 'tools', `${name}.mjs`), ...args], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, DEBUG: '', NODE_PATH: nm, MOTION_CLOSE_TIMEOUT_MS: '3000', ...env },
      });
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => resolve({ code, stdout, stderr, json: (() => { try { return JSON.parse(stdout.trim().split('\n').filter((l) => l.startsWith('{')).at(-1)); } catch { return null; } })() }));
    });
    await body({ root, tool });
  } finally {
    try { if (fs.lstatSync(link).isSymbolicLink()) { try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); } } } catch { /* no link */ }
    // Retries are longer than they were: behind real-time antivirus the unsigned headless shell can outlive its tool by several
    // seconds (the browser inherits the project as its working directory), and a fresh file can stay locked while it is scanned;
    // either makes rmdir fail with EBUSY.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 });
    assert.ok(fs.existsSync(nm), 'shared node_modules untouched');
  }
}
const listOut = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };

test('render.mjs CLI: 1.3 s at 24 fps is a full render (silent.mp4, render.json, poster, --final ok); --no-poster removes the old poster', { timeout: 600000 }, async (t) => {
  const film = TINY_FILM.replace('fps: 12, duration: 2,', 'fps: 24, duration: 1.3,');
  await withTinyProject(t, { film, studio: { title: 'Frac', duration: 1.3, fps: 24, subframes: 1, formats: ['1x1'], primaryFormat: '1x1', gate: { enabled: false } } }, async ({ root, tool }) => {
    const fmtDir = path.join(root, 'out', '1x1');
    const first = await tool('render', ['--scale', '0.1', '--draft', '--hash', '--json']);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.json.ok, true, first.stdout);
    assert.deepEqual([first.json.formats[0].partial, first.json.formats[0].frames], [false, 31], 'no --from/--to: the whole film');
    assert.deepEqual(listOut(fmtDir), ['frames.sha256', 'poster.png', 'render.json', 'silent.mp4'], 'no clip_*.mp4 and no leftover .staging');
    const sidecar = S.readJSON(path.join(fmtDir, 'render.json'));
    assert.deepEqual([sidecar.frames, sidecar.fps, sidecar.from, sidecar.final, sidecar.poster, sidecar.hash], [31, 24, 0, false, 'poster.png', 'frames.sha256']);
    assert.equal(sidecar.to, 31 / 24);
    assert.equal(fs.readFileSync(path.join(fmtDir, 'frames.sha256'), 'utf8').trim().split('\n').length, 31);

    // The exact command that used to fail with "--final renders the whole film; drop --from/--to" (neither flag was given).
    const final = await tool('render', ['--final', '--json']);
    assert.equal(final.code, 0, final.stderr + final.stdout);
    assert.equal(S.readJSON(path.join(fmtDir, 'render.json')).final, true);
    assert.deepEqual(listOut(fmtDir), ['poster.png', 'render.json', 'silent.mp4'], 'the final has no hash list unless --hash: the earlier one is not left beside it');

    // A real range is still a check clip and never touches the full film's files.
    const clip = await tool('render', ['--from', '0.5', '--to', '1', '--scale', '0.1', '--draft', '--json']);
    assert.equal(clip.code, 0, clip.stderr);
    assert.equal(clip.json.formats[0].partial, true);
    assert.deepEqual(listOut(fmtDir), ['clip_0.50-1.00.json', 'clip_0.50-1.00.mp4', 'poster.png', 'render.json', 'silent.mp4']);
    assert.equal(S.readJSON(path.join(fmtDir, 'render.json')).final, true, 'render.json still describes the full film');

    // --no-poster on a re-render: the previous cut's poster must not stay beside the new video.
    const noPoster = await tool('render', ['--scale', '0.1', '--draft', '--no-poster', '--json']);
    assert.equal(noPoster.code, 0, noPoster.stderr);
    const after = S.readJSON(path.join(fmtDir, 'render.json'));
    assert.deepEqual([after.poster, after.posterTime, after.final], [null, null, false]);
    assert.deepEqual(listOut(fmtDir), ['clip_0.50-1.00.json', 'clip_0.50-1.00.mp4', 'render.json', 'silent.mp4'], 'poster.png of the old render is gone');
  });
});

test('render.mjs CLI: a previous silent.mp4 held open by a player fails the publish, keeps the finished render and changes nothing (Windows)', { skip: process.platform !== 'win32' && 'needs Windows file sharing semantics', timeout: 600000 }, async (t) => {
  await withTinyProject(t, { studio: { title: 'Lock', duration: 2, fps: 12, subframes: 1, formats: ['1x1'], primaryFormat: '1x1', gate: { enabled: false } } }, async ({ root, tool }) => {
    const fmtDir = path.join(root, 'out', '1x1');
    const base = ['--scale', '0.1', '--draft', '--json'];
    assert.equal((await tool('render', base)).code, 0);
    const snap = () => Object.fromEntries(['silent.mp4', 'render.json', 'poster.png'].map((n) => [n, fs.readFileSync(path.join(fmtDir, n)).toString('base64')]));
    const before = snap();
    const lock = await holdOpen(path.join(fmtDir, 'silent.mp4'));
    let failed;
    try {
      failed = await tool('render', [...base, '--fps', '6'], { MOTION_PUBLISH_WAIT_MS: '1500' });
    } finally { await lock.release(); }
    assert.equal(failed.code, 1, failed.stderr);
    assert.equal(failed.json.ok, false);
    assert.match(failed.json.error, /cannot replace .*silent\.mp4: E[A-Z]+: .*another program has it open/);
    assert.match(failed.json.error, /finished render is kept in out.1x1..staging/);
    assert.match(failed.stderr, /warning: out.1x1.silent\.mp4 is open in another program/, 'warned before spending the render');
    assert.deepEqual(snap(), before, 'silent.mp4, render.json and poster.png are all still the previous render');
    const kept = listOut(path.join(fmtDir, '.staging')).filter((n) => !n.startsWith('.'));
    assert.deepEqual(kept, ['poster.png', 'render.json', 'silent.mp4'], 'the finished render survived');
    assert.equal(S.readJSON(path.join(fmtDir, '.staging', 'render.json')).fps, 6);
    // With the lock gone the next render publishes and clears the kept files.
    const again = await tool('render', [...base, '--fps', '6']);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(S.readJSON(path.join(fmtDir, 'render.json')).fps, 6);
    assert.deepEqual(listOut(fmtDir), ['poster.png', 'render.json', 'silent.mp4']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// stills.mjs: contact sheets that stay readable (paged), a time range

const St = await import(pathToFileURL(path.join(TEMPLATE, 'tools', 'stills.mjs')).href);
const fakePng = (w, h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

test('stills: pngSize reads the IHDR, rowsPerSheet fits whole rows under the height cap', () => {
  assert.deepEqual(St.pngSize(fakePng(270, 480)), { w: 270, h: 480 });
  assert.deepEqual(St.pngSize(fakePng(270, 480).toString('base64')), { w: 270, h: 480 });
  assert.equal(St.pngSize(Buffer.from('not a png at all, just text')), null);
  const tall = Array.from({ length: 120 }, (_, i) => ({ png: fakePng(1080, 1920), label: `t${i}` }));
  assert.equal(St.rowsPerSheet(tall, { width: 270, maxHeight: 1800, title: 'x' }), 3, '9:16 tiles: 480 + caption + gap per row');
  assert.equal(Math.ceil(120 / (3 * 6)), 7, 'a 120-tile 9:16 sheet becomes 7 pages of at most 1800 px instead of one 10 000 px image');
  assert.equal(St.rowsPerSheet(tall, { width: 270, maxHeight: 2400, title: 'x' }), 4);
  assert.equal(St.rowsPerSheet(tall, { width: 270, maxHeight: 0 }), Infinity, '0 keeps one tall sheet');
  assert.equal(St.rowsPerSheet(tall, { width: 270, maxHeight: 100 }), 1, 'always at least one row');
  const wide = Array.from({ length: 30 }, () => ({ png: fakePng(1920, 1080), label: 'x' }));
  assert.equal(St.rowsPerSheet(wide, { width: 270, maxHeight: 1800, title: 'x' }), 9);
  assert.equal(St.rowsPerSheet(wide.map((w) => ({ ...w, label: '' })), { width: 270, maxHeight: 1800 }), 11, 'no captions, no title: more rows');
});

// One naming rule for every sheet tool (stills.mjs, critique.mjs, refs.mjs extract): page 1 IS <name>.png (contact.png always
// exists), page n >= 2 is <name>-n.png. An earlier version wrote page 1 as <name>-1.png: a run removes that too.
test('stills: sheetFile names page 1 <name>.png and page n <name>-n.png', () => {
  assert.equal(St.sheetFile(path.join('x', 'contact.png'), 1), path.join('x', 'contact.png'));
  assert.equal(St.sheetFile(path.join('x', 'contact.png'), 2), path.join('x', 'contact-2.png'));
  assert.equal(St.sheetFile('sheet.v2.png', 12), 'sheet.v2-12.png');
  assert.equal(St.sheetFile('sheet.png', 0), 'sheet.png');
});

test('stills: clearStaleSheets removes the pages a run no longer writes (and the old -1 page), and only those', () => {
  const dir = tmp('ms-sheets-');
  for (const n of ['sheet.png', 'sheet-1.png', 'sheet-2.png', 'sheet-3.png', 'sheet-10.png', 'sheet-x.png', 'sheet-1.jpg', 'other-4.png', 'my.sheet-2.png']) fs.writeFileSync(path.join(dir, n), n);
  const out = path.join(dir, 'sheet.png');
  St.clearStaleSheets(out, 2);
  assert.deepEqual(listOut(dir), ['my.sheet-2.png', 'other-4.png', 'sheet-1.jpg', 'sheet-2.png', 'sheet-x.png', 'sheet.png'], 'two pages: sheet.png and sheet-2.png stay; sheet-1 (old naming), sheet-3 and up are gone');
  St.clearStaleSheets(out, 1);
  assert.deepEqual(listOut(dir), ['my.sheet-2.png', 'other-4.png', 'sheet-1.jpg', 'sheet-x.png', 'sheet.png'], 'one sheet: every sheet-N.png is gone, sheet.png stays');
  St.clearStaleSheets(out, 0);
  assert.deepEqual(listOut(dir), ['my.sheet-2.png', 'other-4.png', 'sheet-1.jpg', 'sheet-x.png', 'sheet.png'], 'no pages written: pages are cleared, the base file is the caller\'s to remove');
  St.clearStaleSheets(path.join(dir, 'missing', 'x.png'), 1); // a folder that does not exist is fine
});

test('stills: fitCols keeps a sheet under 1990 px wide; contactSheetPages defaults to 1800 px pages', () => {
  assert.equal(St.SHEET_MAX_SIDE, 1990);
  assert.equal(St.PAGE_HEIGHT, 1800);
  assert.equal(St.fitCols(6, 270), 6, '6 x 270 px = 1670 px wide');
  assert.equal(St.fitCols(5, 360), 5, '5 x 360 px = 1844 px wide');
  assert.equal(St.fitCols(6, 360), 5, '6 x 360 px would be 2200 px: one column fewer');
  assert.equal(St.fitCols(4, 1200), 1, 'a tile wider than the page still gets a row of its own');
  assert.equal(St.fitCols(0, 270), 1);
  assert.equal(St.fitCols(6, 100), 6);
  for (const [cols, width] of [[6, 270], [6, 360], [12, 100], [3, 500], [8, 240]]) {
    const c = St.fitCols(cols, width);
    assert.ok(20 + c * width + (c - 1) * 6 <= 1990 || c === 1, `${cols} x ${width} -> ${c} columns`);
  }
});

test('stills: writeSheet writes the sheet; a sheet open in a viewer gets the new one beside it, not lost (Windows)', { timeout: 120000 }, async (t) => {
  const dir = tmp('ms-sheetlock-');
  const f = path.join(dir, 'contact.png');
  assert.equal(St.writeSheet(f, Buffer.from('one')), f);
  assert.deepEqual(listOut(dir), ['contact.png'], 'no temp file left');
  if (process.platform !== 'win32') { t.diagnostic('the sharing-violation half needs Windows'); return; }
  const lock = await holdOpen(f);
  try {
    const got = St.writeSheet(f, Buffer.from('two'));
    assert.equal(got, path.join(dir, 'contact.new.png'));
    assert.equal(fs.readFileSync(f, 'utf8'), 'one', 'the sheet in the viewer is untouched');
    assert.equal(fs.readFileSync(got, 'utf8'), 'two');
    assert.deepEqual(listOut(dir), ['contact.new.png', 'contact.png'], 'no temp file left');
  } finally { await lock.release(); }
  assert.equal(St.writeSheet(f, Buffer.from('three')), f, 'once released the sheet is replaced in place');
  assert.equal(fs.readFileSync(f, 'utf8'), 'three');
});

test('stills.mjs CLI: a long sheet is split into pages of whole rows, --page-height 0 restores one sheet, --from/--to keep a chapter', { timeout: 600000 }, async (t) => {
  await withTinyProject(t, { needFfmpeg: false, studio: { title: 'Sheets', duration: 2, fps: 12, subframes: 1, formats: ['9x16'], primaryFormat: '9x16', gate: { enabled: false } } }, async ({ root, tool }) => {
    const dir = path.join(root, 'out', 's');
    const height = (file) => St.pngSize(fs.readFileSync(file)).h;
    const args = ['--every', '0.1', '--width', '100', '--cols', '4', '--out', 'out/s/sheet.png', '--json'];
    const paged = await tool('stills', [...args, '--page-height', '300']);
    assert.equal(paged.code, 0, paged.stderr);
    const [r] = paged.json.formats;
    assert.equal(r.stills.length, 20);
    assert.equal(r.pages, 5, '20 tiles, 4 per row, one row per 300 px page');
    // The one naming rule (also critique.mjs): page 1 keeps the --out name, page n >= 2 is <name>-n.png.
    assert.deepEqual(r.contacts.map((f) => path.basename(f)), ['sheet.png', 'sheet-2.png', 'sheet-3.png', 'sheet-4.png', 'sheet-5.png']);
    assert.equal(r.contact, r.contacts[0], '`contact` is the first page');
    assert.equal(path.basename(r.contact), 'sheet.png');
    assert.deepEqual(listOut(dir), ['sheet-2.png', 'sheet-3.png', 'sheet-4.png', 'sheet-5.png', 'sheet.png']);
    for (const f of r.contacts) assert.ok(height(f) <= 300, `${path.basename(f)} is ${height(f)} px tall`);

    // One tall sheet again: the old pages are removed, the single file is written.
    const single = await tool('stills', [...args, '--page-height', '0']);
    assert.equal(single.code, 0, single.stderr);
    assert.equal(single.json.formats[0].pages, 1);
    assert.deepEqual(listOut(dir), ['sheet.png'], 'stale sheet-N.png pages are gone');
    assert.ok(height(path.join(dir, 'sheet.png')) > 300);

    // A time range (one chapter) split into two pages: only those times; sheet.png is page 1 now, page 2 is added.
    const range = await tool('stills', ['--every', '0.1', '--from', '0.5', '--to', '0.9', '--width', '100', '--cols', '4', '--out', 'out/s/sheet.png', '--page-height', '300', '--json']);
    assert.equal(range.code, 0, range.stderr);
    assert.deepEqual(range.json.formats[0].stills.map((s) => s.t), [0.5, 0.6, 0.7, 0.8, 0.9].map((x) => Math.round(x * 12) / 12), 'only the times inside the range, snapped to the frame grid');
    assert.equal(range.json.formats[0].pages, 2, '5 tiles, 4 per row, one row per page');
    assert.deepEqual(listOut(dir), ['sheet-2.png', 'sheet.png'], 'page 1 replaced sheet.png of the single-sheet run, page 2 is new');
    assert.ok(height(path.join(dir, 'sheet.png')) <= 300 && height(path.join(dir, 'sheet-2.png')) <= 300);
    // Default limits: 10 tiles of 400 px cannot sit 6 to a row (2430 px wide): 4 columns, and 3 rows of 9:16 tiles (about 740 px
    // each) do not fit the default 1800 px page height: 2 pages, none wider than 1990 px or taller than 1800 px.
    const wide = await tool('stills', ['--every', '0.2', '--width', '400', '--cols', '6', '--out', 'out/s/wide.png', '--json']);
    assert.equal(wide.code, 0, wide.stderr);
    const w = wide.json.formats[0];
    assert.equal(w.stills.length, 10);
    assert.equal(w.cols, 4, '6 x 400 px would be 2430 px wide: 4 columns');
    assert.deepEqual(w.contacts.map((f) => path.basename(f)), ['wide.png', 'wide-2.png']);
    for (const f of w.contacts) { const size = St.pngSize(fs.readFileSync(f)); assert.ok(size.w <= 1990 && size.h <= 1800, `${path.basename(f)} is ${size.w}x${size.h}`); }
    assert.match((await tool('stills', ['--from', '2', '--to', '1', '--json'])).json.error, /--to must be greater than --from/);
    assert.match((await tool('stills', ['--page-height', '50', '--json'])).json.error, /--page-height must be 0/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// resolvePython: MOTION_PYTHON is a pin, never a hint

const withEnv = (patch, fn) => {
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
/** A stand-in for spawnSync: answer(cmd, args) is the result; every call is recorded. */
const fakeSpawn = (answer) => {
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, timeout: opts.timeout }); return answer(cmd, args); };
  spawn.calls = calls;
  return spawn;
};
const answers = (stdout) => ({ status: 0, stdout, stderr: '' });
const spawnError = (code) => ({ error: Object.assign(new Error(`spawnSync x ${code}`), { code }), status: null, stdout: null, stderr: null });
const PROBE_ARGS = ['-c', 'import sys; sys.stdout.write(sys.executable)'];
const escapeRe = (s) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

test('resolvePython: a MOTION_PYTHON that does not answer throws "MOTION_PYTHON=<path> is not usable: <reason>" and no other interpreter is tried', () => {
  const pin = path.join(os.tmpdir(), 'ms-pinned', 'python');
  const cases = [
    ['missing file', () => spawnError('ENOENT'), /: no such file or command$/],
    ['non-zero exit shows the last stderr line', () => ({ status: 3, stdout: '', stderr: 'Traceback (most recent call last):\n  File "x"\nModuleNotFoundError: No module named encodings\n' }), /: exited with 3: ModuleNotFoundError: No module named encodings$/],
    ['killed by a signal', () => ({ status: null, signal: 'SIGSEGV', stdout: '', stderr: '' }), /: exited with SIGSEGV$/],
    ['no answer in time', () => spawnError('ETIMEDOUT'), /: no answer within 60 s$/],
    ['not a Python (prints nothing)', () => answers(' \n'), /: it printed no interpreter path/],
    ['spawn refuses the value', () => { throw new TypeError('The argument \'file\' must be a string\nmore'); }, /: The argument 'file' must be a string$/],
    ['another error code', () => spawnError('EACCES'), /: spawnSync x EACCES$/],
  ];
  withEnv({ MOTION_PYTHON: pin }, () => {
    for (const [name, answer, re] of cases) {
      // every other interpreter "works": a silent fall-through would return it
      const spawn = fakeSpawn((cmd) => (cmd === pin ? answer() : answers('/usr/bin/python3')));
      assert.throws(() => S.resolvePython(tmp('ms-py-'), { spawn }), (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith(`MOTION_PYTHON=${pin} is not usable: `), `${name}: ${err.message}`);
        assert.match(err.message, re, name);
        return true;
      }, name);
      assert.deepEqual(spawn.calls.map((c) => c.cmd), [pin], `${name}: python3, python, py and .venv are not tried`);
    }
  });
});

test('resolvePython: a working pin is used as is and gets 60 s to answer `import sys`; discovered candidates keep 20 s', () => {
  const pin = path.join(os.tmpdir(), 'ms-pinned', 'python3.12');
  withEnv({ MOTION_PYTHON: pin }, () => {
    const spawn = fakeSpawn(() => answers('C:\\Python312\\python.exe\r\n'));
    assert.equal(S.resolvePython(tmp('ms-py-'), { spawn }), 'C:\\Python312\\python.exe');
    assert.deepEqual(spawn.calls, [{ cmd: pin, args: PROBE_ARGS, timeout: 60000 }], 'the probe imports sys only (no librosa or numba) and waits 60 s');
  });
  const root = tmp('ms-py-');
  const venv = process.platform === 'win32' ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python');
  fs.mkdirSync(path.dirname(venv), { recursive: true });
  fs.writeFileSync(venv, '');
  withEnv({ MOTION_PYTHON: undefined }, () => {
    const spawn = fakeSpawn((cmd) => (cmd === 'python' ? answers('/usr/bin/python\n') : spawnError('ENOENT')));
    assert.equal(S.resolvePython(root, { spawn }), '/usr/bin/python');
    assert.deepEqual(spawn.calls.map((c) => c.cmd), [venv, 'python3', 'python'], 'order: .venv, python3, python (then py -3)');
    assert.deepEqual([...new Set(spawn.calls.map((c) => c.timeout))], [20000]);
    const none = fakeSpawn(() => spawnError('ENOENT'));
    assert.equal(S.resolvePython(tmp('ms-py-'), { spawn: none }), null, 'nothing found is null, not an error');
    assert.deepEqual(none.calls.map((c) => [c.cmd, ...c.args.slice(0, -2)].join(' ')), ['python3', 'python', 'py -3']);
  });
  withEnv({ MOTION_PYTHON: '' }, () => {
    const spawn = fakeSpawn(() => answers('/usr/bin/python3'));
    assert.equal(S.resolvePython(tmp('ms-py-'), { spawn }), '/usr/bin/python3');
    assert.equal(spawn.calls[0].cmd, 'python3', 'an empty MOTION_PYTHON is no pin');
  });
});

test('resolvePython: the answer, a failure included, is cached per project and pin', () => {
  const root = tmp('ms-py-');
  withEnv({ MOTION_PYTHON: '/nowhere/python' }, () => {
    const spawn = fakeSpawn(() => spawnError('ENOENT'));
    assert.throws(() => S.resolvePython(root, { spawn }), /MOTION_PYTHON=\/nowhere\/python is not usable/);
    assert.throws(() => S.resolvePython(root, { spawn }), /MOTION_PYTHON=\/nowhere\/python is not usable/);
    assert.equal(spawn.calls.length, 1, 'a 60 s probe is not repeated for every caller');
    withEnv({ MOTION_PYTHON: '/elsewhere/python' }, () => {
      const other = fakeSpawn(() => answers('/elsewhere/python'));
      assert.equal(S.resolvePython(root, { spawn: other }), '/elsewhere/python', 'a different pin is a different question');
      assert.equal(other.calls.length, 1);
    });
  });
});

// A fake Python is a script behind a .cmd (Windows) or a shell shim, spawned by absolute path like a real MOTION_PYTHON.
const canSpawnCmd = process.platform !== 'win32' || (() => {
  try { return spawnSync(path.join(os.tmpdir(), 'ms-none.cmd'), [], { stdio: 'ignore' }).error?.code !== 'EINVAL'; } catch (err) { return err?.code !== 'EINVAL'; } // Node >= 20.12 refuses .cmd without a shell
})();
function fakePython(dir, name, body) {
  const js = path.join(dir, `${name}.js`);
  fs.writeFileSync(js, body);
  if (process.platform === 'win32') {
    const shim = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${js}"\r\n`);
    return { shim, js };
  }
  const shim = path.join(dir, name);
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${js}"\n`);
  fs.chmodSync(shim, 0o755);
  return { shim, js };
}

test('resolvePython with real fake interpreters: a failing pin throws with its stderr, a working one is returned, a missing one is named', { skip: !canSpawnCmd && 'this Node cannot spawn a .cmd without a shell' }, () => {
  const dir = tmp('ms-fakepy-');
  const failing = fakePython(dir, 'broken-python', 'process.stderr.write("Fatal Python error: init_fs_encoding\\n"); process.exit(3);');
  const working = fakePython(dir, 'good-python', 'process.stdout.write(process.argv[1]);');
  withEnv({ MOTION_PYTHON: failing.shim }, () => {
    assert.throws(() => S.resolvePython(tmp('ms-py-')), (err) => {
      assert.equal(err.message, `MOTION_PYTHON=${failing.shim} is not usable: exited with 3: Fatal Python error: init_fs_encoding`);
      return true;
    });
  });
  withEnv({ MOTION_PYTHON: working.shim }, () => assert.equal(S.resolvePython(tmp('ms-py-')), working.js, 'the interpreter prints sys.executable and that is the answer'));
  const missing = path.join(dir, 'no-such-python');
  withEnv({ MOTION_PYTHON: missing }, () => assert.throws(() => S.resolvePython(tmp('ms-py-')), (err) => {
    assert.equal(err.message, `MOTION_PYTHON=${missing} is not usable: no such file or command`);
    return true;
  }));
});

test('resolveFfmpeg: a broken MOTION_PYTHON is listed among the things tried, it does not replace the ffmpeg error', () => {
  // A private copy of tools/ and lib/ in an empty temp tree: no ffmpeg-static above it, an empty PATH, no FFMPEG_PATH.
  const base = tmp('ms-ffpy-');
  for (const d of ['tools', 'lib']) fs.cpSync(path.join(TEMPLATE, d), path.join(base, d), { recursive: true });
  fs.writeFileSync(path.join(base, 'package.json'), '{"type":"module"}'); // lib/*.js are ES modules through this
  const empty = path.join(base, 'empty-path');
  fs.mkdirSync(empty);
  const pin = path.join(base, 'no-such-python');
  const script = `import(${JSON.stringify(pathToFileURL(path.join(base, 'tools', 'studio.mjs')).href)}).then((m) => {
  try { process.stdout.write(JSON.stringify({ found: m.resolveFfmpeg(${JSON.stringify(base)}) })); } catch (e) { process.stdout.write(JSON.stringify({ error: e.message })); }
});`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(path|ffmpeg_path|ffmpeg|motion_python|node_path)$/i.test(k)));
  try {
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000, env: { ...env, PATH: empty, MOTION_PYTHON: pin } });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.found, undefined, 'nothing to find in an empty tree');
    assert.match(out.error, /^ffmpeg not found \(tried: .*ffmpeg on PATH; MOTION_PYTHON=.*no-such-python is not usable: no such file or command\)/);
    assert.match(out.error, /Install one:/, 'the install hint survives');
  } finally { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('doctor: a broken MOTION_PYTHON is reported as "MOTION_PYTHON=<path> is not usable: <reason>", not as "no Python found"', async () => {
  const D = await import(pathToFileURL(path.join(TEMPLATE, 'tools', 'doctor.mjs')).href);
  const pin = path.join(tmp('ms-nopy-'), 'python-nowhere');
  const probes = {
    playwright: async () => '1.63.0',
    browser: async () => ({ via: 'chrome', version: '154', browser: { close: async () => {} } }),
    resolve: (fn, base) => (fn === 'resolvePython' ? D.PROBES.resolve(fn, base) : Object.assign(Promise.resolve('/fake/ffmpeg'), { stop() {} })), // the real worker for Python
    run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
  };
  const saved = process.env.MOTION_PYTHON;
  process.env.MOTION_PYTHON = pin;
  try {
    const list = await D.checks(TEMPLATE, { probes, cleanups: [] });
    const py = list.find((c) => c.id === 'python');
    assert.equal(py.status, 'warn');
    assert.ok(py.detail.includes(`MOTION_PYTHON=${pin} is not usable: no such file or command`), py.detail);
    assert.doesNotMatch(py.detail, /no Python found/);
    assert.equal(py.required, false, 'Python stays optional');
  } finally { if (saved === undefined) delete process.env.MOTION_PYTHON; else process.env.MOTION_PYTHON = saved; }
});

// ---------------------------------------------------------------------------------------------------------------
// validateConfig: gate.naAllowed and the optional audio.* keys

const problems = (patch) => S.validateConfig(S.deepMerge(S.DEFAULTS, patch));

test('validateConfig accepts every documented gate.naAllowed and audio.style / key / mode / seed / voiceId value', () => {
  assert.deepEqual(problems({}), []);
  for (const style of ['pulse', 'piano', 'minimal', 'cinematic']) assert.deepEqual(problems({ audio: { style } }), [], style);
  for (const key of ['A', 'a', 'F#', 'Bb', 'B♭', 'G♯', 'C#m', 'Bbmin', 'Dminor', 'D minor', 'Emaj', 'GM', ' d ']) assert.deepEqual(problems({ audio: { key } }), [], key);
  for (const mode of ['minor', 'major']) assert.deepEqual(problems({ audio: { mode } }), [], mode);
  for (const seed of [0, 1, 42, -7, 2 ** 31]) assert.deepEqual(problems({ audio: { seed } }), [], String(seed));
  assert.deepEqual(problems({ audio: { voiceId: 'JBFqnCBsd6RMkjVDRZzb' } }), []);
  assert.deepEqual(problems({ audio: { style: null, key: null, mode: null, seed: null, voiceId: null } }), [], 'null = unset, like audio.voice');
  for (const naAllowed of [[], ['brand'], ['brand', 'sound'], ['Sound Sync', 'brand_accuracy', 'HOOK'], ['brand', 'brand']]) assert.deepEqual(problems({ gate: { naAllowed } }), [], JSON.stringify(naAllowed));
});

test('validateConfig: gate.naAllowed may name a custom axis, and the default ["brand"] stays valid when gate.axes leaves brand out', () => {
  assert.deepEqual(problems({ gate: { axes: ['hook', 'pacing'], naAllowed: ['pacing'] } }), []);
  assert.deepEqual(problems({ gate: { axes: ['hook', 'motion'] } }), [], 'the merged default naAllowed ["brand"] is not the user\'s mistake');
  assert.deepEqual(problems({ gate: { axes: ['Sound Sync'], naAllowed: ['sound'] } }), []);
  assert.match(problems({ gate: { axes: ['hook', 'pacing'], naAllowed: ['pacng'] } })[0], /unknown axis "pacng" \(valid: hook, readability, motion, variety, composition, brand, sound, pacing\)/);
  assert.deepEqual(problems({ gate: { axes: 'hook', naAllowed: ['brand'] } }), ['gate.axes must be an array of axis names'], 'a malformed axes list is reported once');
});

test('validateConfig rejects a bad gate.naAllowed with the key and the valid axes', () => {
  const valid = '\\(valid: hook, readability, motion, variety, composition, brand, sound\\)';
  assert.match(problems({ gate: { naAllowed: ['brnad'] } })[0], new RegExp(`^gate\\.naAllowed: unknown axis "brnad" ${valid}$`));
  assert.match(problems({ gate: { naAllowed: 'brand' } })[0], new RegExp(`^gate\\.naAllowed must be an array of axis names ${valid} \\(got "brand"\\)$`));
  assert.match(problems({ gate: { naAllowed: null } })[0], /^gate\.naAllowed must be an array of axis names .* \(got null\)$/);
  assert.match(problems({ gate: { naAllowed: { brand: true } } })[0], /^gate\.naAllowed must be an array of axis names/);
  const mixed = problems({ gate: { naAllowed: ['brand', 3, 'sond', null] } });
  assert.equal(mixed.length, 3);
  assert.match(mixed[0], /^gate\.naAllowed\[1\] must be an axis name string \(got 3\)$/);
  assert.match(mixed[1], /^gate\.naAllowed: unknown axis "sond"/);
  assert.match(mixed[2], /^gate\.naAllowed\[3\] must be an axis name string \(got null\)$/);
});

test('validateConfig rejects a bad audio.style / key / mode / seed / voiceId with the key and the accepted values', () => {
  const one = (audio) => { const p = problems({ audio }); assert.equal(p.length, 1, JSON.stringify(p)); return p[0]; };
  assert.equal(one({ style: 'jazz' }), 'audio.style must be one of pulse, piano, minimal, cinematic (got "jazz")');
  assert.equal(one({ style: 'Pulse' }), 'audio.style must be one of pulse, piano, minimal, cinematic (got "Pulse")');
  assert.equal(one({ style: 3 }), 'audio.style must be one of pulse, piano, minimal, cinematic (got 3)');
  for (const key of ['H', 'A##', 'Am7', 'Fsharp', '', 5, true, ['A'], {}])
    assert.match(one({ key }), new RegExp(`^audio\\.key must be a note name A-G with an optional # or b, like A, F# or Bb .* \\(got ${escapeRe(JSON.stringify(key))}\\)$`), JSON.stringify(key));
  assert.equal(one({ mode: 'dorian' }), 'audio.mode must be one of minor, major (got "dorian")');
  assert.equal(one({ mode: 'Minor' }), 'audio.mode must be one of minor, major (got "Minor")');
  for (const seed of [1.5, '7', true, [1], {}, 1e-9]) assert.match(one({ seed }), /^audio\.seed must be an integer \(got /, JSON.stringify(seed));
  assert.equal(one({ voiceId: 12 }), 'audio.voiceId must be a string (got 12)');
  assert.equal(one({ voiceId: ['a'] }), 'audio.voiceId must be a string (got ["a"])');
});

test('validateConfig: unknown keys still pass through, and loadConfig lists every new problem in one error naming studio.json', () => {
  assert.deepEqual(problems({ audio: { future: 1, beatLock: { on: true } }, gate: { note: 'x', weights: [1, 2] }, custom: { keep: true } }), []);
  const dir = tmp();
  writeStudio(dir, { audio: { future: 'kept', style: 'jazz', key: 'H', mode: 'dorian', seed: 1.5, voiceId: 9 }, gate: { naAllowed: ['brnad'] } });
  assert.throws(() => S.loadConfig(dir), (err) => {
    assert.match(err.message, /studio\.json/);
    for (const re of [/audio\.style must be one of pulse, piano, minimal, cinematic \(got "jazz"\)/, /audio\.key must be a note name/, /audio\.mode must be one of minor, major/,
      /audio\.seed must be an integer \(got 1\.5\)/, /audio\.voiceId must be a string \(got 9\)/, /gate\.naAllowed: unknown axis "brnad"/]) assert.match(err.message, re);
    return true;
  });
  const ok = tmp();
  writeStudio(ok, { audio: { future: 'kept', style: 'cinematic', key: 'F#m', mode: 'minor', seed: 7, voiceId: 'abc' }, gate: { naAllowed: ['brand', 'sound'] } });
  const cfg = S.loadConfig(ok);
  assert.equal(cfg.audio.future, 'kept');
  assert.deepEqual([cfg.audio.style, cfg.audio.key, cfg.audio.mode, cfg.audio.seed, cfg.audio.voiceId, cfg.gate.naAllowed], ['cinematic', 'F#m', 'minor', 7, 'abc', ['brand', 'sound']]);
});

test('validateConfig stays in step with what the tools accept: score.mjs STYLES and parseKey, gate.mjs axis aliases', async () => {
  const SC = await import(pathToFileURL(path.join(TEMPLATE, 'tools', 'score.mjs')).href);
  assert.deepEqual(problems({ audio: { style: 'nope' } }).map((m) => m.replace(/^.*must be one of (.*) \(got.*$/, '$1')), [SC.STYLES.join(', ')], 'the accepted styles are exactly score.mjs STYLES');
  for (const style of SC.STYLES) assert.deepEqual(problems({ audio: { style } }), [], style);
  for (const key of ['A', 'a', 'F#', 'Bb', 'B♭', 'G♯', 'C#m', 'Bbmin', 'Dminor', 'D minor', 'Emaj', 'GM', ' d ', 'H', 'A##', 'Am7', 'Fsharp', '', 'AB', '#A', 'Cmm', 'E-']) {
    let parses = true;
    try { SC.parseKey(key); } catch { parses = false; }
    assert.equal(problems({ audio: { key } }).length === 0, parses, `audio.key ${JSON.stringify(key)}: score.mjs ${parses ? 'accepts' : 'rejects'} it`);
  }
  const gate = fs.readFileSync(path.join(TEMPLATE, 'tools', 'gate.mjs'), 'utf8');
  const pairs = [...(/const AXIS_ALIASES = \{([\s\S]*?)\};/.exec(gate)?.[1] ?? '').matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
  assert.ok(pairs.length >= 9, 'found the gate.mjs alias table');
  for (const [alias, axis] of pairs) {
    assert.deepEqual(problems({ gate: { naAllowed: [alias] } }), [], `gate.mjs reads "${alias}" as ${axis}`);
    assert.deepEqual(problems({ gate: { naAllowed: [alias.replace(/-/g, ' ').toUpperCase()] } }), [], `${alias}: case and spaces are normalised as gate.mjs does`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Browser policy in doctor and launchBrowser (the policy itself is tested in test/browser-policy.test.mjs)

test('doctor: the browser row is ok for the bundled browser and WARN for an installed Chrome/Edge on Windows; only win32 gets the windows-logon-guard row', async () => {
  const D = await import(pathToFileURL(path.join(TEMPLATE, 'tools', 'doctor.mjs')).href);
  const win = process.platform === 'win32';
  const RISK = 'windows-blank-password-logon';
  const state = { count: 2, max: 4, allowed: 3, blocked: false, refuse: false, override: false, waitMs: 0, file: 'X:\\motion-studio\\launches.json' };
  const probes = (launched, guard = state) => ({
    playwright: async () => '1.63.0',
    browser: async () => { if (launched instanceof Error) throw launched; return { ...launched, browser: { close: async () => {} } }; },
    logonGuard: async () => guard,
    resolve: () => Object.assign(Promise.resolve('/fake/ffmpeg'), { stop() {} }),
    run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
  });
  const rows = async (launched, guard) => { const list = await D.checks(TEMPLATE, { probes: probes(launched, guard), cleanups: [] }); return { list, browser: list.find((c) => c.id === 'browser'), guard: list.find((c) => c.id === 'windows-logon-guard') }; };

  for (const bundled of [{ via: 'chromium-headless-shell', version: '153.0', risk: null }, { via: 'chromium', version: '153.0', risk: null }, { via: 'executable:C:\\x\\shell.exe', version: '153.0', risk: null }, { via: 'chrome', version: '154.0', risk: null }]) {
    const { browser } = await rows(bundled);
    assert.equal(browser.status, 'ok', `${bundled.via}: ${browser.detail}`);
    assert.equal(browser.fix, '');
    assert.ok(browser.detail.startsWith(`${bundled.via} ${bundled.version}`));
  }
  // launchBrowser reports risk for an installed Chrome/Edge on Windows; a probe that only names the browser counts as installed too
  for (const installed of [{ via: 'chrome', version: '154.0', risk: RISK }, { via: 'msedge', version: '154.0', risk: RISK }, ...(win ? [{ via: 'chrome', version: '154.0' }, { via: 'msedge', version: '154.0' }] : [])]) {
    const { browser } = await rows(installed);
    assert.equal(browser.status, 'warn', `${installed.via} ${JSON.stringify(installed.risk)}`);
    assert.match(browser.detail, /blank password/);
    assert.match(browser.detail, /failed logon/);
    assert.ok(win ? browser.fix.startsWith('npx playwright install chromium-headless-shell') : browser.fix.includes('chromium-headless-shell'), browser.fix);
    assert.equal(browser.required, true, 'still a required check, but a warning does not fail it');
    assert.deepEqual(D.failedChecks([browser]), []);
  }
  if (!win) assert.equal((await rows({ via: 'chrome', version: '154.0' })).browser.status, 'ok', 'the warning is Windows-only');

  // windows-logon-guard: informational, Windows only, right after the browser row
  const { list, guard } = await rows({ via: 'chromium-headless-shell', version: '153.0', risk: null });
  if (win) {
    assert.equal(guard.status, 'info');
    assert.equal(guard.required, false);
    assert.equal(guard.detail, `2 installed-browser launch(es) logged in the last 10 min (limit 4) · ${state.file}`);
    assert.equal(list.findIndex((c) => c.id === 'windows-logon-guard'), list.findIndex((c) => c.id === 'browser') + 1);
    const blocked = (await rows({ via: 'chromium-headless-shell', version: '153.0', risk: null }, { ...state, count: 3, blocked: true, refuse: true, waitMs: 61500 })).guard;
    assert.match(blocked.detail, /3 installed-browser launch\(es\) logged in the last 10 min \(limit 4\); the next one is refused for 62 s/);
    const forced = (await rows({ via: 'chromium-headless-shell', version: '153.0', risk: null }, { ...state, count: 3, blocked: true, override: true })).guard;
    assert.match(forced.detail, /over the limit but allowed \(MOTION_ALLOW_LOCKOUT_RISK\)/);
  } else assert.equal(guard, undefined, 'no such row outside Windows');

  // nothing launches: fail, with the headless shell install first on Windows
  const failed = (await rows(new Error('could not launch a browser: no safe browser found.'))).browser;
  assert.equal(failed.status, 'fail');
  assert.ok(win ? failed.fix.startsWith('npx playwright install chromium-headless-shell') : failed.fix.includes('chromium-headless-shell'), failed.fix);
  assert.equal(typeof D.PROBES.logonGuard, 'function');
});

test('launchBrowser: keeps { browser, via, version }; a MOTION_CHROME_PATH that does not exist still fails as "could not launch a browser … file not found"', async () => {
  const root = tmp('ms-fakepw-policy-');
  writeStudio(root, {});
  const pw = path.join(root, 'node_modules', 'playwright');
  fs.mkdirSync(pw, { recursive: true });
  fs.writeFileSync(path.join(pw, 'package.json'), '{"name":"playwright","version":"0.0.0","main":"index.js"}');
  fs.writeFileSync(path.join(pw, 'index.js'), `
exports.chromium = { async launch(opts) { globalThis.__msPolicyLaunches.push(opts); return {
  version: () => 'fake 1.0', isConnected: () => true, close: async () => {},
  newBrowserCDPSession: async () => ({ send: async () => ({ processInfo: [] }), detach: async () => {} }),
  async newContext() { return { close: async () => {} }; },
}; } };`);
  const keys = ['MOTION_CHROME_PATH', 'MOTION_BROWSER', 'MOTION_LAUNCH_LOG'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  globalThis.__msPolicyLaunches = [];
  try {
    delete process.env.MOTION_CHROME_PATH;
    delete process.env.MOTION_BROWSER;
    process.env.MOTION_LAUNCH_LOG = path.join(tmp(), 'launches.json');
    const r = await S.launchBrowser(root, S.loadConfig(root));
    assert.deepEqual(Object.keys(r).slice(0, 3), ['browser', 'via', 'version']);
    assert.equal(r.version, 'fake 1.0');
    assert.equal(r.via, process.platform === 'win32' ? 'chromium-headless-shell' : 'chrome', "'auto' is the bundled browser on Windows");
    assert.equal(globalThis.__msPolicyLaunches.length, 1);
    process.env.MOTION_CHROME_PATH = path.join(tmp(), 'no-such-browser.exe');
    await assert.rejects(() => S.launchBrowser(root, S.loadConfig(root)), (err) => /^could not launch a browser:/.test(err.message) && /file not found/.test(err.message));
    assert.equal(globalThis.__msPolicyLaunches.length, 1, 'nothing was launched for the missing file');
  } finally {
    delete globalThis.__msPolicyLaunches;
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});
