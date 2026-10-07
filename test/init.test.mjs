// skills/studio-init/scripts/init.mjs: scaffold into os.tmpdir(), merge mode, --force, flags, errors.
// Most cases call the script's runInit() in process (node start-up costs about 2 s per spawn on machines with
// on-access scanning); a few spawn the real CLI: --help, a usage error with --json, a fresh scaffold, --install.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const INIT = path.join(REPO, 'skills', 'studio-init', 'scripts', 'init.mjs');
const TEMPLATE = path.join(REPO, 'skills', 'studio-init', 'template');
const IS_WIN = process.platform === 'win32';

const NO_TEMPLATE = fs.existsSync(path.join(TEMPLATE, 'studio.json')) && fs.existsSync(path.join(TEMPLATE, 'package.json'))
  ? false
  : 'skills/studio-init/template (studio.json + package.json) is not written yet';

// Importing init.mjs normally runs the CLI; this switch (set only around the import) turns that off.
process.env.MOTION_STUDIO_INIT_AS_LIBRARY = '1';
const { runInit, redactUrl } = await import(pathToFileURL(INIT).href);
delete process.env.MOTION_STUDIO_INIT_AS_LIBRARY;

let BASE;

// Temp tree cleanup that a locked file (antivirus, a just-exited child) cannot turn into a failure.
function removeTree(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ }
}
before(() => {
  BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-init-'));
  // Also on abnormal termination (a crashed test, an unhandled rejection): synchronous, so it runs at exit.
  process.once('exit', () => removeTree(BASE));
});
after(() => removeTree(BASE));

// Children run a few at a time: process creation is serialized on machines with on-access scanning
// (about 2 s per node start), so a burst of spawns only makes each one slower. MS_TEST_PARALLEL overrides.
const CPUS = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
const MAX_CHILDREN = Math.max(1, Number(process.env.MS_TEST_PARALLEL) || Math.min(4, Math.max(2, Math.floor(CPUS / 4))));
let active = 0;
const waiting = [];
async function slot(fn) {
  if (active >= MAX_CHILDREN) await new Promise((r) => waiting.push(r)); else active++;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next(); else active--;
  }
}

function templateFiles(dir = TEMPLATE, prefix = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!['node_modules', 'out', '.git'].includes(e.name)) out.push(...templateFiles(path.join(dir, e.name), rel)); } else if (e.isFile() && !['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(e.name)) out.push(rel);
  }
  return out.sort();
}

// The JSON result line, when stdout ends with one.
function lastJSON(stdout) {
  const last = stdout.trim().split('\n').pop();
  if (last && last.startsWith('{')) { try { return JSON.parse(last); } catch { return null; } }
  return null;
}

// In process: same {code, stdout, stderr, json} as a spawn. Relative <dir> arguments would resolve against the
// test runner's cwd, so pass absolute paths (or "@name" = BASE/name).
async function init(args) {
  const out = [];
  const err = [];
  const code = await runInit(args.map((a) => (a.startsWith('@') ? path.join(BASE, a.slice(1)) : a)), {
    out: { write: (s) => out.push(s) },
    err: { write: (s) => err.push(s) },
  });
  const stdout = out.join('');
  return { code, stdout, stderr: err.join(''), json: lastJSON(stdout) };
}

// The real CLI in a child process.
function initSpawn(args, opts = {}) {
  return slot(() => initSpawnNow(args, opts));
}

function initSpawnNow(args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INIT, ...args], { cwd: BASE, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, json: lastJSON(stdout) }));
  });
}

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const readJSON = (...p) => JSON.parse(read(...p));

describe('init.mjs usage', { concurrency: true }, () => {
  test('--help prints usage on stdout, exit 0 (spawned)', async () => {
    const r = await initSpawn(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage: node init\.mjs <dir>/);
    assert.match(r.stdout, /--force/);
    assert.match(r.stdout, /resets template scripts in package\.json, never dependency versions/);
    assert.equal((await init(['--help'])).stdout, r.stdout, 'in-process runInit prints the same text');
  });

  for (const [label, args, pattern] of [
    ['missing <dir>', [], /missing <dir>/],
    ['unknown flag', ['@x', '--bogus'], /unknown flag: --bogus/],
    ['two dirs', ['@a', '@b'], /expected one <dir>/],
    ['flag without value', ['@x', '--title'], /--title needs a value/],
    ['bad number', ['@x', '--fps', 'fast'], /--fps must be a number/],
    ['fps out of range', ['@x', '--fps', '0'], /--fps must be an integer/],
    ['unknown format', ['@x', '--formats', '9x16,3x2'], /unknown format\(s\) 3x2/],
    ['bad brand url', ['@x', '--brand-url', 'not a url'], /--brand-url is not a URL/],
    ['boolean with value', ['@x', '--force=maybe'], /--force takes no value/],
  ]) {
    test(`usage error: ${label} → exit 2 + usage`, async () => {
      const r = await init(args);
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, pattern);
      assert.match(r.stderr, /Usage: node init\.mjs/);
      assert.equal(fs.existsSync(path.join(BASE, 'x')), false, 'nothing is written on a usage error');
    });
  }

  test('--json on a usage error prints {ok:false} (spawned)', async () => {
    const r = await initSpawn(['--json', '--bogus']);
    assert.equal(r.code, 2);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.usage, true);
    assert.match(r.stderr, /Usage: node init\.mjs/);
  });
});

describe('init.mjs scaffold', { skip: NO_TEMPLATE }, () => {
  test('new directory: copies every template file byte for byte (spawned)', async () => {
    const dir = path.join(BASE, 'fresh', 'film');
    const r = await initSpawn([dir, '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.mode, 'new');
    const files = templateFiles();
    assert.deepEqual([...r.json.created].sort(), files);
    for (const rel of files) {
      assert.ok(fs.readFileSync(path.join(dir, ...rel.split('/'))).equals(fs.readFileSync(path.join(TEMPLATE, ...rel.split('/')))), rel);
    }
    for (const must of ['studio.json', 'package.json']) assert.ok(files.includes(must), `template has ${must}`);
    assert.match(r.stderr, /Next:/);
    assert.match(r.stderr, /npm install/);
    assert.match(r.stderr, /npx playwright install chromium/);
    assert.match(r.stderr, /npm run doctor/);
    assert.match(r.stderr, /npm run preview/);
    assert.ok(!files.some((f) => f.startsWith('node_modules/') || f.startsWith('out/')));
  });

  test('flags patch studio.json and keep every other key', async () => {
    const dir = path.join(BASE, 'flags');
    const r = await init([dir, '--title', 'Launch Reel', '--duration', '8.5', '--fps', '30', '--bpm', '128',
      '--formats', '1x1,16x9', '--loop', '--brand-url', 'https://example.com/app', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const cfg = readJSON(dir, 'studio.json');
    const tpl = readJSON(TEMPLATE, 'studio.json');
    assert.equal(cfg.title, 'Launch Reel');
    assert.equal(cfg.duration, 8.5);
    assert.equal(cfg.fps, 30);
    assert.equal(cfg.bpm, 128);
    assert.deepEqual(cfg.formats, ['1x1', '16x9']);
    assert.equal(cfg.primaryFormat, '1x1', 'primary moves into the chosen formats');
    assert.equal(cfg.loop, true);
    assert.equal(cfg.brand.url, 'https://example.com/app');
    for (const k of Object.keys(tpl)) assert.ok(k in cfg, `kept ${k}`);
    if (tpl.brand && tpl.brand.colors) assert.deepEqual(cfg.brand.colors, tpl.brand.colors);
    assert.deepEqual(r.json.studio, { title: 'Launch Reel', duration: 8.5, fps: 30, bpm: 128, loop: true, formats: ['1x1', '16x9'], primaryFormat: '1x1', 'brand.url': 'https://example.com/app' });
    assert.ok(!read(dir, 'studio.json').includes('\r'), 'LF line endings');

    const again = await init([dir, '--no-loop', '--formats', 'all', '--json']);
    assert.equal(again.code, 0, again.stderr);
    const cfg2 = readJSON(dir, 'studio.json');
    assert.equal(cfg2.loop, false);
    assert.deepEqual(cfg2.formats, ['9x16', '1x1', '16x9', '4x5']);
    assert.equal(cfg2.primaryFormat, '1x1', 'primary kept when still listed');
    assert.equal(cfg2.title, 'Launch Reel', 'earlier patch survives');
  });

  test('merge mode (existing dir): adds missing files, keeps user edits, lists skipped', async () => {
    const dir = path.join(BASE, 'merge');
    assert.equal((await init([dir])).code, 0);
    const filmJs = path.join(dir, 'film', 'film.js');
    const userFilm = '// my film\nexport default null;\n';
    fs.mkdirSync(path.dirname(filmJs), { recursive: true });
    fs.writeFileSync(filmJs, userFilm);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
    const files = templateFiles();
    const victim = files.find((f) => f.startsWith('lib/')) ?? files.find((f) => f !== 'studio.json' && f !== 'package.json');
    fs.rmSync(path.join(dir, ...victim.split('/')));

    const r = await init([dir, '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.mode, 'merge');
    assert.equal(read(filmJs), userFilm, 'film/film.js untouched');
    assert.equal(read(dir, 'notes.txt'), 'mine');
    assert.ok(fs.existsSync(path.join(dir, ...victim.split('/'))), `${victim} restored`);
    assert.deepEqual(r.json.created, [victim]);
    if (files.includes('film/film.js')) {
      assert.ok(r.json.skipped.includes('film/film.js'));
      assert.match(r.stderr, /skipped, already present/);
    }
    assert.equal(r.json.overwritten.length, 0);
  });

  test('--force overwrites template files but never studio.json, film/** or docs/**', async () => {
    const dir = path.join(BASE, 'force');
    assert.equal((await init([dir, '--title', 'Keep Me'])).code, 0);
    const files = templateFiles();
    const tool = files.find((f) => f.startsWith('tools/') || f.startsWith('lib/'));
    assert.ok(tool, 'template has tools/ or lib/ files');
    fs.writeFileSync(path.join(dir, ...tool.split('/')), '// stale copy\n');
    const userFilm = '// my film\n';
    fs.writeFileSync(path.join(dir, 'film', 'film.js'), userFilm);
    fs.mkdirSync(path.join(dir, 'film', 'scenes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'film', 'scenes', 'ch01_intro.js'), '// chapter 1\n');
    const docs = files.find((f) => f.startsWith('docs/'));
    if (docs) fs.writeFileSync(path.join(dir, ...docs.split('/')), '# my notes\n');

    const r = await init([dir, '--force', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.mode, 'force');
    assert.ok(r.json.overwritten.includes(tool));
    assert.ok(fs.readFileSync(path.join(dir, ...tool.split('/'))).equals(fs.readFileSync(path.join(TEMPLATE, ...tool.split('/')))), `${tool} refreshed`);
    assert.equal(readJSON(dir, 'studio.json').title, 'Keep Me', 'studio.json kept');
    assert.equal(read(dir, 'film', 'film.js'), userFilm, 'film/film.js kept');
    assert.equal(read(dir, 'film', 'scenes', 'ch01_intro.js'), '// chapter 1\n');
    assert.ok(r.json.kept.includes('film/film.js'));
    if (docs) {
      assert.equal(read(dir, ...docs.split('/')), '# my notes\n', `${docs} kept`);
      assert.ok(r.json.kept.includes(docs));
    }

    // Flags still patch studio.json under --force.
    const r2 = await init([dir, '--force', '--bpm', '100', '--json']);
    assert.equal(r2.code, 0, r2.stderr);
    const cfg = readJSON(dir, 'studio.json');
    assert.equal(cfg.bpm, 100);
    assert.equal(cfg.title, 'Keep Me');
  });

  test('an npm-init package.json is merged: type=module, scripts and deps added, user fields kept', async () => {
    const dir = path.join(BASE, 'npm-init');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'my-film', version: '1.0.0', main: 'index.js', type: 'commonjs',
      scripts: { test: 'echo "Error: no test specified" && exit 1', render: 'my-own-render' },
      dependencies: { lodash: '^4.17.21' },
    }, null, 2));
    fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\n');
    const r = await init([dir, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const pkg = readJSON(dir, 'package.json');
    const tpl = readJSON(TEMPLATE, 'package.json');
    assert.equal(pkg.name, 'my-film');
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.dependencies.lodash, '^4.17.21');
    assert.equal(pkg.scripts.test, 'echo "Error: no test specified" && exit 1');
    assert.equal(pkg.scripts.render, 'my-own-render', 'merge mode keeps a user script of the same name');
    for (const k of Object.keys(tpl.scripts ?? {})) assert.ok(k in pkg.scripts, `script ${k}`);
    for (const k of Object.keys(tpl.devDependencies ?? {})) assert.equal(pkg.devDependencies[k], tpl.devDependencies[k]);
    assert.ok(r.json.merged.some((m) => m.startsWith('package.json')));
    const ignore = read(dir, '.gitignore');
    assert.match(ignore, /^dist\/$/m);
    if (fs.existsSync(path.join(TEMPLATE, '.gitignore'))) assert.match(ignore, /^node_modules\/$/m);

    const forced = await init([dir, '--force', '--json']);
    assert.equal(forced.code, 0, forced.stderr);
    const pkg2 = readJSON(dir, 'package.json');
    if (tpl.scripts && tpl.scripts.render) assert.equal(pkg2.scripts.render, tpl.scripts.render, '--force restores tool scripts');
    assert.equal(pkg2.name, 'my-film');
    assert.equal(pkg2.dependencies.lodash, '^4.17.21');
  });

  test('merge mode lists the scripts and versions it kept, with your value and the template value', async () => {
    const tpl = readJSON(TEMPLATE, 'package.json');
    const dir = path.join(BASE, 'merge-kept');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'mine', version: '3.2.1',
      scripts: { render: 'echo custom', lint: 'eslint .', mine: 'echo hi' },
      devDependencies: { playwright: '^99.0.0', typescript: '^5' },
      optionalDependencies: { 'ffmpeg-static': '^1.0.0' }, // older than the template: still not touched
    }, null, 2));
    const r = await init([dir, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const pkg = readJSON(dir, 'package.json');
    assert.equal(pkg.scripts.render, 'echo custom');
    assert.equal(pkg.scripts.lint, 'eslint .');
    assert.equal(pkg.scripts.mine, 'echo hi');
    assert.equal(pkg.devDependencies.playwright, '^99.0.0');
    assert.equal(pkg.optionalDependencies['ffmpeg-static'], '^1.0.0');
    assert.ok(pkg.scripts.preview, 'missing template scripts are still added');

    const kept = Object.fromEntries(r.json.packageKept.map((k) => [k.field, k]));
    assert.deepEqual(Object.keys(kept).sort(), ['devDependencies.playwright', 'optionalDependencies.ffmpeg-static', 'scripts.lint', 'scripts.render']);
    assert.deepEqual(kept['scripts.render'], { field: 'scripts.render', yours: 'echo custom', template: tpl.scripts.render });
    assert.deepEqual(kept['scripts.lint'], { field: 'scripts.lint', yours: 'eslint .', template: tpl.scripts.lint });
    assert.deepEqual(kept['devDependencies.playwright'], { field: 'devDependencies.playwright', yours: '^99.0.0', template: tpl.devDependencies.playwright });
    assert.deepEqual(r.json.packageReset, []);
    assert.doesNotMatch(r.json.merged.join(' '), /scripts\.(?:render|lint)(?=[,)])|playwright|ffmpeg/, 'kept entries are not reported as merged');

    assert.match(r.stderr, /kept your package\.json values, which differ from the template \(4\)/);
    assert.ok(r.stderr.includes(`scripts.render: yours "echo custom", template ${JSON.stringify(tpl.scripts.render)}`), r.stderr);
    assert.ok(r.stderr.includes('scripts.lint: yours "eslint .", template'), r.stderr);
    assert.match(r.stderr, /those names run YOUR command/);
    assert.match(r.stderr, /--force resets template scripts/);

    // Same input, second run: the kept list is repeated, so the difference stays visible.
    const again = await init([dir, '--json']);
    assert.equal(again.json.packageKept.length, 4);
    assert.deepEqual(readJSON(dir, 'package.json'), pkg, 'nothing rewritten');
  });

  test('--force resets only template scripts that differ and never touches dependency versions', async () => {
    const tpl = readJSON(TEMPLATE, 'package.json');
    const dir = path.join(BASE, 'force-deps');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'mine', version: '3.2.1', description: 'keep me',
      scripts: { render: 'node tools/render.mjs --workers 8', lint: tpl.scripts.lint, mine: 'echo hi' },
      devDependencies: { playwright: '^99.0.0', typescript: '^5' },
    }, null, 2));
    const r = await init([dir, '--force', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const pkg = readJSON(dir, 'package.json');
    assert.equal(pkg.scripts.render, tpl.scripts.render, 'a differing template script is reset');
    assert.equal(pkg.scripts.lint, tpl.scripts.lint);
    assert.equal(pkg.scripts.mine, 'echo hi', 'other scripts stay');
    assert.equal(pkg.devDependencies.playwright, '^99.0.0', 'a pinned / newer version is never replaced by the template range');
    assert.equal(pkg.devDependencies.typescript, '^5');
    assert.equal(pkg.optionalDependencies['ffmpeg-static'], tpl.optionalDependencies['ffmpeg-static'], 'a missing dependency is still added');
    assert.equal(pkg.name, 'mine');
    assert.equal(pkg.version, '3.2.1');
    assert.equal(pkg.description, 'keep me');

    assert.deepEqual(r.json.packageReset, [{ field: 'scripts.render', was: 'node tools/render.mjs --workers 8', now: tpl.scripts.render }]);
    assert.deepEqual(r.json.packageKept.map((k) => k.field), ['devDependencies.playwright']);
    const merged = r.json.merged.find((m) => m.startsWith('package.json'));
    assert.match(merged, /scripts\.render/);
    assert.doesNotMatch(merged, /devDependencies\.playwright/, 'the version is not reported as changed');
    assert.match(r.stderr, /reset by --force to the template command \(1\)/);
    assert.ok(r.stderr.includes('scripts.render: was "node tools/render.mjs --workers 8", now'), r.stderr);
    assert.match(r.stderr, /devDependencies\.playwright: yours "\^99\.0\.0", template/);

    const again = await init([dir, '--force', '--json']);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(again.json.packageReset, [], 'a second --force has nothing left to reset');
    assert.ok(!again.json.merged.some((m) => m.startsWith('package.json')));
    assert.equal(readJSON(dir, 'package.json').devDependencies.playwright, '^99.0.0');
  });

  test('a package.json whose scripts / dependencies are not objects is left alone with a warning', async () => {
    const dir = path.join(BASE, 'odd-package');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'odd', scripts: 'nope', devDependencies: ['x'] }));
    const r = await init([dir, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const pkg = readJSON(dir, 'package.json');
    assert.equal(pkg.scripts, 'nope');
    assert.deepEqual(pkg.devDependencies, ['x']);
    assert.ok(r.json.warnings.some((w) => /"scripts" is not an object/.test(w)), JSON.stringify(r.json.warnings));
    assert.ok(r.json.warnings.some((w) => /"devDependencies" is not an object/.test(w)));
  });

  test('--install runs npm in the new project (fake npm on PATH)', async () => {
    const bin = path.join(BASE, 'fake-bin');
    fs.mkdirSync(bin, { recursive: true });
    if (IS_WIN) {
      fs.writeFileSync(path.join(bin, 'npm.cmd'), '@echo off\r\necho fake npm %* 1>&2\r\necho ok> installed.txt\r\nexit /b 0\r\n');
    } else {
      fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "fake npm $*" >&2\necho ok > installed.txt\n');
      fs.chmodSync(path.join(bin, 'npm'), 0o755);
    }
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    const env = { [key]: `${bin}${path.delimiter}${process.env[key] ?? ''}` };
    const dir = path.join(BASE, 'install');
    const r = await initSpawn([dir, '--install', '--json'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.installed, true);
    assert.ok(fs.existsSync(path.join(dir, 'installed.txt')), 'npm ran with cwd = the project');
    assert.match(r.stderr, /fake npm install/);
    assert.ok(!r.json.next.includes('npm install'));

    const failBin = path.join(BASE, 'fail-bin');
    fs.mkdirSync(failBin, { recursive: true });
    if (IS_WIN) fs.writeFileSync(path.join(failBin, 'npm.cmd'), '@echo off\r\nexit /b 3\r\n');
    else { fs.writeFileSync(path.join(failBin, 'npm'), '#!/bin/sh\nexit 3\n'); fs.chmodSync(path.join(failBin, 'npm'), 0o755); }
    const bad = await initSpawn([path.join(BASE, 'install-fail'), '--install', '--json'], { env: { [key]: `${failBin}${path.delimiter}${process.env[key] ?? ''}` } });
    assert.equal(bad.code, 1);
    assert.equal(bad.json.installed, false);
    assert.match(bad.stderr, /npm install FAILED/);
  });

  test('refuses a file target, the template itself and a plugin root', async () => {
    const file = path.join(BASE, 'a-file');
    fs.writeFileSync(file, 'x');
    const r1 = await init([file]);
    assert.equal(r1.code, 1);
    assert.match(r1.stderr, /not a directory/);

    const r2 = await init([path.join(TEMPLATE, 'film')]);
    assert.equal(r2.code, 1);
    assert.match(r2.stderr, /template itself/);

    const plugin = path.join(BASE, 'some-plugin');
    fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"x"}');
    const r3 = await init([plugin]);
    assert.equal(r3.code, 1);
    assert.match(r3.stderr, /plugin root/);
    assert.equal(fs.existsSync(path.join(plugin, 'studio.json')), false);
  });

  test('invalid existing studio.json + flags → exit 1, file left as is', async () => {
    const dir = path.join(BASE, 'broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'studio.json'), '{ "title": ');
    const r = await init([dir, '--title', 'X']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /studio\.json is not valid JSON/);
    assert.equal(read(dir, 'studio.json'), '{ "title": ');
  });
});

// --brand-url ends up in studio.json (committed, pasted into reports): no login may reach the file, stdout or stderr.
describe('init.mjs --brand-url credentials', { concurrency: true }, () => {
  const PW = 'hunter2'; // distinctive values: none of them may appear anywhere
  const TOK = 'S3cr3tT0k3n';
  const LEAK = new RegExp(`${PW}|${TOK}|alice`);
  const NAMES = ['token', 'key', 'secret', 'password', 'auth', 'sig', 'session', 'api_key', 'access_token', 'apiKey', 'X-Amz-Signature', 'TOKEN', 'access-token', 'sessionid', 'jwt', 'client_secret', 'passwd'];
  const BENIGN = ['utm_source', 'ref', 'keyword', 'author', 'id', 'page', 'monkey', 'design', 'lang', 'q', 'sort', 'v', 'version', 'tab'];

  test('redactUrl removes every secret-looking parameter name and keeps the rest, byte for byte', () => {
    for (const name of NAMES) {
      const r = redactUrl(`https://example.com/p?a=1&${name}=${TOK}&b=2`);
      assert.equal(r.url, 'https://example.com/p?a=1&b=2', name);
      assert.deepEqual(r.removed, [`query:${name}`], name);
    }
    for (const name of BENIGN) {
      const url = `https://example.com/p?a=1&${name}=v&b=2`;
      assert.deepEqual(redactUrl(url), { url, removed: [] }, `${name} is not a secret: the URL comes back exactly as given`);
    }
    // Every secret-looking parameter goes, wherever it sits, in any spelling; nothing dangles.
    assert.equal(redactUrl(`https://example.com/?token=${TOK}`).url, 'https://example.com/', 'no dangling "?"');
    assert.equal(redactUrl(`https://example.com/x?to%6Ben=${TOK}&ref=a`).url, 'https://example.com/x?ref=a', 'a percent-encoded name is decoded first');
    assert.deepEqual(redactUrl('https://example.com/x?token&ref=a'), { url: 'https://example.com/x?ref=a', removed: ['query:(no value)'] });
    assert.equal(redactUrl(`https://example.com/x?token=${TOK}&KEY=${TOK}&Secret=${TOK}&ref=a`).url, 'https://example.com/x?ref=a');
    // Fragment parameters (OAuth implicit flow) are parameters; a plain anchor is not.
    assert.deepEqual(redactUrl(`https://example.com/#access_token=${TOK}&state=xyz`), { url: 'https://example.com/#state=xyz', removed: ['fragment:access_token'] });
    assert.equal(redactUrl(`https://example.com/#token=${TOK}`).url, 'https://example.com/');
    assert.deepEqual(redactUrl('https://example.com/docs#pricing'), { url: 'https://example.com/docs#pricing', removed: [] });
    // A single-page-app route keeps its path and loses only the secrets of its own query; a "?" inside a token value is no route.
    assert.deepEqual(redactUrl(`https://app.example.com/#/reset?token=${TOK}&lang=en`), { url: 'https://app.example.com/#/reset?lang=en', removed: ['fragment:token'] });
    assert.deepEqual(redactUrl(`https://app.example.com/#/reset?token=${TOK}`), { url: 'https://app.example.com/#/reset', removed: ['fragment:token'] });
    assert.deepEqual(redactUrl('https://app.example.com/#/pricing?plan=pro'), { url: 'https://app.example.com/#/pricing?plan=pro', removed: [] });
    assert.deepEqual(redactUrl(`https://example.com/#access_token=${TOK}?x&state=1`), { url: 'https://example.com/#state=1', removed: ['fragment:access_token'] });
    // The older ";" separator between query parameters counts like "&", and the separators that stay are kept as typed.
    assert.deepEqual(redactUrl(`https://example.com/p?a=1;token=${TOK};b=2`), { url: 'https://example.com/p?a=1;b=2', removed: ['query:token'] });
    assert.deepEqual(redactUrl(`https://example.com/p?token=${TOK};a=1&b=2`), { url: 'https://example.com/p?a=1&b=2', removed: ['query:token'] });
    assert.deepEqual(redactUrl(`https://example.com/p?a=1&b=2;key=${TOK}`), { url: 'https://example.com/p?a=1&b=2', removed: ['query:key'] });
    // userinfo and ;matrix parameters go; port and path stay.
    assert.deepEqual(redactUrl(`https://alice:${PW}@example.com:8443/x/y`), { url: 'https://example.com:8443/x/y', removed: ['userinfo'] });
    assert.deepEqual(redactUrl('https://alice@example.com'), { url: 'https://example.com/', removed: ['userinfo'] });
    assert.deepEqual(redactUrl(`https://example.com/app;jsessionid=${TOK}/x;v=2`), { url: 'https://example.com/app/x;v=2', removed: ['path:jsessionid'] });
    // Nothing to remove: exactly the input (trimmed), and a second pass changes nothing.
    assert.deepEqual(redactUrl('  https://example.com/app?a=1&b=2#x  '), { url: 'https://example.com/app?a=1&b=2#x', removed: [] });
    const once = redactUrl(`https://alice:${PW}@example.com/a?token=${TOK}&ref=1#access_token=${TOK}`);
    assert.deepEqual(redactUrl(once.url), { url: once.url, removed: [] });
    assert.deepEqual(once.removed, ['userinfo', 'query:token', 'fragment:access_token']);
    assert.doesNotMatch(JSON.stringify(once), LEAK, 'the result never contains a removed value');
    assert.throws(() => redactUrl('not a url'), TypeError);
  });

  test('the URL written to studio.json has no userinfo and no secret parameter; stdout, stderr and the file never contain them', { skip: NO_TEMPLATE }, async () => {
    const dir = path.join(BASE, 'brand-secret');
    const url = `https://alice:${PW}@example.com/app;jsessionid=${TOK}?ref=launch&token=${TOK}&api_key=${TOK}&utm_source=x&keyword=reel#pricing`;
    const r = await init([dir, '--brand-url', url, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const cfg = readJSON(dir, 'studio.json');
    assert.equal(cfg.brand.url, 'https://example.com/app?ref=launch&utm_source=x&keyword=reel#pricing');
    assert.equal(r.json.studio['brand.url'], cfg.brand.url);
    assert.deepEqual(r.json.redacted, ['userinfo', 'path:jsessionid', 'query:token', 'query:api_key']);
    assert.match(r.stderr, /note: --brand-url carried credentials; removed before writing studio\.json: userinfo, path:jsessionid, query:token, query:api_key/);
    assert.deepEqual(cfg.brand.colors, readJSON(TEMPLATE, 'studio.json').brand.colors, 'the rest of brand is untouched');
    for (const [where, text] of [['stdout', r.stdout], ['stderr', r.stderr], ['studio.json', read(dir, 'studio.json')]]) assert.doesNotMatch(text, LEAK, where);

    // A plain URL is stored exactly as typed, with no note; a later run on the same project replaces the stored value.
    const plain = await init([dir, '--brand-url', 'https://example.com/plain?a=1', '--json']);
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(readJSON(dir, 'studio.json').brand.url, 'https://example.com/plain?a=1');
    assert.deepEqual(plain.json.redacted, []);
    assert.doesNotMatch(plain.stderr, /note: --brand-url/);
    const again = await init([dir, '--brand-url', `https://example.com/x?password=${PW}`, '--json']);
    assert.equal(readJSON(dir, 'studio.json').brand.url, 'https://example.com/x');
    assert.deepEqual(again.json.redacted, ['query:password']);
    assert.doesNotMatch(again.stdout + again.stderr, new RegExp(PW));
  });

  test('a rejected --brand-url or an unknown flag never echoes the value (usage errors, exit 2, nothing written)', async () => {
    const dir = path.join(BASE, 'brand-rejected');
    for (const [args, pattern] of [
      [['--brand-url', `not a url token=${PW}`], /--brand-url is not a URL/],
      [['--brand-url', `ftp://alice:${PW}@example.com/?token=${TOK}`], /--brand-url must be http\(s\)/],
      [[`--brand-urls=https://alice:${PW}@example.com/?token=${TOK}`], /unknown flag: --brand-urls$/m],
      [[`--brand-url=alice:${PW}@example.com?token=${TOK}`], /--brand-url must be http\(s\)/], // parses as a scheme "alice:"
    ]) {
      const r = await init([dir, ...args, '--json']);
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, pattern);
      assert.equal(r.json?.ok, false);
      assert.doesNotMatch(r.stdout + r.stderr, LEAK, JSON.stringify(args));
    }
    assert.equal(fs.existsSync(dir), false, 'nothing is written on a usage error');
  });

  test('the failure line follows the last --json switch: --json=true prints it, --json then --no-json does not (nothing after -- counts)', async () => {
    const dir = path.join(BASE, 'json-switch');
    const on = await init([dir, '--bogus', '--json=true']);
    assert.equal(on.code, 2);
    assert.deepEqual(on.json, { ok: false, error: 'unknown flag: --bogus', usage: true });
    const off = await init([dir, '--bogus', '--json', '--no-json']);
    assert.equal(off.code, 2);
    assert.equal(off.stdout, '', 'a later --no-json switches the failure line off');
    const after = await init([dir, '--bogus', '--', '--json']);
    assert.equal(after.stdout, '', 'a --json after -- is an argument, not a switch');
    assert.equal(fs.existsSync(dir), false);
  });
});
