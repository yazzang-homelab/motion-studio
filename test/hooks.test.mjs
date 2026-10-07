// Plugin hooks. The end-to-end contract (JSON on stdin, exit code + stdout/stderr, exactly as Claude Code
// drives a hook) is checked by spawning the real hooks/*.mjs a few times per hook; the decision logic of each
// hook is exercised in-process through its hooks/lib/*-handler.mjs `handle()`, because node start-up costs
// about 2 s per spawn on machines with on-access scanning and process creation is serialized there.
// Hooks that need the template's lint.mjs / gate.mjs skip (with a reason) when those modules are absent.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { normPath, findProjectRoot, relInside, parseInput, resolvePath } from '../hooks/lib/common.mjs';
import { detectFinalRenders, parseScript, hasFinalFlag, tokenize } from '../hooks/lib/shell.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOOKS = path.join(REPO, 'hooks');
const FIX = path.join(REPO, 'test', 'fixtures', 'hooks');
const TOOLS = path.join(REPO, 'skills', 'studio-init', 'template', 'tools');
const IS_WIN = process.platform === 'win32';

async function probe(file, exportName) {
  try {
    const mod = await import(pathToFileURL(path.join(TOOLS, file)).href);
    return typeof mod[exportName] === 'function' ? false : `template tools/${file} has no ${exportName}() yet`;
  } catch (err) {
    return `template tools/${file} not importable yet (${err.code || err.message})`;
  }
}
const NO_LINT = await probe('lint.mjs', 'lintSource');
const NO_GATE = await probe('gate.mjs', 'checkGate');

let BASE;
let ROOT;
let OUTSIDE;

const fwd = (p) => p.replace(/\\/g, '/');
const bs = (p) => fwd(p).replace(/\//g, '\\');

// Temp tree cleanup that a locked file (antivirus, a just-exited child) cannot turn into a failure.
function removeTree(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ }
}

function copyDir(src, dest, rename = (n) => n) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.isDirectory() ? e.name : rename(e.name));
    if (e.isDirectory()) copyDir(s, d, rename); else fs.copyFileSync(s, d);
  }
}

// Fixture sources that would be loadable JS keep a .txt suffix on disk (see the hygiene test below);
// a copied project gets the real names back (film/film.js.txt → film/film.js).
const LIVE_NAME = (n) => n.replace(/\.((?:c|m)?js)\.txt$/, '.$1');

function makeProject(name, { log = null, studio = null } = {}) {
  const dir = path.join(BASE, name);
  copyDir(path.join(FIX, 'project'), dir, LIVE_NAME);
  if (log) {
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.copyFileSync(path.join(FIX, log), path.join(dir, 'docs', 'review_log.md'));
  }
  if (studio) {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'studio.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'studio.json'), JSON.stringify({ ...cfg, ...studio }, null, 2));
  }
  return dir;
}

function subst(v, root) {
  if (typeof v === 'string') {
    return v.replaceAll('{{ROOT_BS}}', bs(root)).replaceAll('{{ROOT}}', fwd(root))
      .replaceAll('{{OUTSIDE_BS}}', bs(OUTSIDE)).replaceAll('{{OUTSIDE}}', fwd(OUTSIDE));
  }
  if (Array.isArray(v)) return v.map((x) => subst(x, root));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x, root)]));
  return v;
}

function fixture(name, root = ROOT) {
  return subst(JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8')), root);
}

function hookEnv(extra = {}) {
  const env = { ...process.env };
  delete env.MOTION_STUDIO_HOOKS;
  delete env.MOTION_STUDIO_HOOKS_DEBUG;
  return { ...env, ...extra };
}

// Spawned children run only a few at a time. On machines with on-access scanning process creation is
// serialized, so a burst of spawns just makes every one of them slower; with a real multi-core machine a
// small pool still overlaps start-up. MS_TEST_PARALLEL overrides.
const CPUS = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
const MAX_CHILDREN = Math.max(1, Number(process.env.MS_TEST_PARALLEL) || Math.min(4, Math.max(2, Math.floor(CPUS / 4))));
let active = 0;
const waiting = [];
async function slot(fn) {
  // A finishing child hands its slot straight to the next waiter, so `active` never overshoots.
  if (active >= MAX_CHILDREN) await new Promise((r) => waiting.push(r)); else active++;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next(); else active--;
  }
}

// End to end: spawn the hook script like Claude Code does.
function run(script, input, opts = {}) {
  return slot(() => runNow(script, input, opts));
}

function runNow(script, input, { env = {}, raw = null, hooksDir = HOOKS } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const child = spawn(process.execPath, [path.join(hooksDir, script)], { env: hookEnv(env), cwd: BASE, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${script} timed out`)); }, 60000);
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      let json = null;
      if (stdout.trim()) { try { json = JSON.parse(stdout); } catch { json = 'unparsable'; } }
      resolve({ code, stdout, stderr, json, ms });
    });
    child.stdin.on('error', () => {}); // a hook may exit before reading everything
    child.stdin.end(raw ?? JSON.stringify(input));
  });
}

// In process: the hook's decision logic, mapped to the same {code, stdout, stderr, json} a spawn would give
// (runHook prints result.json on stdout, result.stderr on stderr, exits 2 for code 2, and swallows throws).
const ENTRY_HANDLER = {
  'post-edit-lint.mjs': 'lint-handler.mjs',
  'pre-bash-gate.mjs': 'gate-handler.mjs',
  'role-guard.mjs': 'role-handler.mjs',
  'session-start.mjs': 'session-handler.mjs',
};
const handlerCache = new Map();
function handlerOf(script, hooksDir = HOOKS) {
  const file = path.join(hooksDir, 'lib', ENTRY_HANDLER[script]);
  if (!handlerCache.has(file)) handlerCache.set(file, import(pathToFileURL(file).href).then((m) => m.handle));
  return handlerCache.get(file);
}
async function call(script, input, { hooksDir = HOOKS } = {}) {
  const handle = await handlerOf(script, hooksDir);
  let res = null;
  try { res = await handle(input); } catch { res = null; }
  const json = res && res.json ? res.json : null;
  return { code: res && res.code === 2 ? 2 : 0, stdout: json ? `${JSON.stringify(json)}\n` : '', stderr: res && res.stderr ? res.stderr : '', json, ms: 0 };
}

function assertSilent(r, label = '') {
  assert.equal(r.code, 0, `${label} exit code (stderr: ${r.stderr})`);
  assert.equal(r.stdout, '', `${label} stdout must be empty`);
}

function assertDeny(r, pattern) {
  assert.equal(r.code, 0, `deny is exit 0 + JSON (stderr: ${r.stderr})`);
  assert.ok(r.json && r.json.hookSpecificOutput, `expected deny JSON, got: ${r.stdout}`);
  const o = r.json.hookSpecificOutput;
  assert.equal(o.hookEventName, 'PreToolUse');
  assert.equal(o.permissionDecision, 'deny');
  assert.equal(typeof o.permissionDecisionReason, 'string');
  if (pattern) assert.match(o.permissionDecisionReason, pattern);
}

before(() => {
  BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-hooks-'));
  // Also on abnormal termination (a crashed test, an unhandled rejection): synchronous, so it runs at exit.
  process.once('exit', () => removeTree(BASE));
  ROOT = makeProject('film-project');
  OUTSIDE = path.join(BASE, 'outside');
  fs.mkdirSync(path.join(OUTSIDE, 'film'), { recursive: true });
});
after(() => removeTree(BASE));

// ---------------------------------------------------------------------------------------------
describe('hooks.json', () => {
  test('wraps events in "hooks", uses exec form, and every script exists', async () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8'));
    assert.equal(typeof cfg.description, 'string');
    assert.ok(cfg.hooks && typeof cfg.hooks === 'object');
    for (const k of Object.keys(cfg)) assert.ok(['description', 'hooks'].includes(k), `unexpected top-level key ${k}`);
    const want = {
      PostToolUse: { 'Write|Edit|MultiEdit': 'post-edit-lint.mjs' },
      PreToolUse: { 'Bash|PowerShell': 'pre-bash-gate.mjs', 'Write|Edit|MultiEdit': 'role-guard.mjs' },
      SessionStart: { 'startup|resume|clear|compact': 'session-start.mjs' },
    };
    assert.deepEqual(Object.keys(cfg.hooks).sort(), Object.keys(want).sort());
    for (const [event, groups] of Object.entries(cfg.hooks)) {
      for (const g of groups) {
        assert.ok(g.matcher in want[event], `${event} matcher ${g.matcher}`);
        for (const h of g.hooks) {
          assert.equal(h.type, 'command');
          assert.equal(h.command, 'node');
          assert.ok(Array.isArray(h.args) && h.args.length === 1);
          assert.equal(h.args[0], `\${CLAUDE_PLUGIN_ROOT}/hooks/${want[event][g.matcher]}`);
          assert.ok(fs.existsSync(path.join(HOOKS, want[event][g.matcher])));
          assert.ok(h.timeout > 0 && h.timeout <= 30);
        }
      }
    }
  });

  test('every entry script only wires its handler module to runHook()', async () => {
    for (const [script, handler] of Object.entries(ENTRY_HANDLER)) {
      const src = fs.readFileSync(path.join(HOOKS, script), 'utf8');
      assert.match(src, new RegExp(`from '\\./lib/${handler.replace('.', '\\.')}'`), `${script} imports lib/${handler}`);
      assert.match(src, /\nrunHook\(handle\);\n$/, `${script} ends with runHook(handle)`);
      const mod = await import(pathToFileURL(path.join(HOOKS, 'lib', handler)).href);
      assert.equal(typeof mod.handle, 'function', `lib/${handler} exports handle()`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('test fixtures', () => {
  test('no loadable JS below test/ except test/*.test.mjs', async () => {
    // Node 20's `node --test test/` executes every .js/.mjs/.cjs below the directory (and a bare
    // `node --test` matches **/test/**/*.js), so a fixture with such a name would run as a test file.
    const TEST = path.join(REPO, 'test');
    const loadable = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(?:c|m)?js$/i.test(e.name) && !(dir === TEST && e.name.endsWith('.test.mjs'))) loadable.push(fwd(path.relative(REPO, p)));
      }
    };
    walk(TEST);
    assert.deepEqual(loadable, [], 'store fixtures as <name>.js.txt and restore the name when copying them');
  });

  test('the hook fixture project stays a studio project and copies with its real file names', async () => {
    const src = path.join(FIX, 'project');
    assert.equal(findProjectRoot(path.join(src, 'film', 'scenes', 'ch01.js')), normPath(src), 'studio.json + film/ dir');
    assert.ok(fs.existsSync(path.join(src, 'film', 'film.js.txt')));
    assert.ok(fs.statSync(path.join(ROOT, 'film', 'film.js')).isFile(), 'makeProject restores film/film.js');
    assert.ok(!fs.existsSync(path.join(ROOT, 'film', 'film.js.txt')));
    assert.deepEqual(['a.js.txt', 'b.mjs.txt', 'c.cjs.txt', 'notes.txt', 'x.js'].map(LIVE_NAME), ['a.js', 'b.mjs', 'c.cjs', 'notes.txt', 'x.js']);
  });
});

// ---------------------------------------------------------------------------------------------
describe('hooks/lib/common.mjs', () => {
  test('normPath converts separators, drive case, dot segments', async () => {
    assert.equal(normPath('C:\\Users\\me\\film\\..\\lib\\x.js'), 'C:/Users/me/lib/x.js');
    assert.equal(normPath('c:\\proj\\'), 'C:/proj');
    assert.equal(normPath('C:'), 'C:/');
    assert.equal(normPath('/home/me//film/./a.js'), '/home/me/film/a.js');
    assert.equal(normPath('\\\\server\\share\\film'), '//server/share/film');
    assert.equal(normPath('film/../../x'), '../x');
    assert.equal(normPath(''), null);
    assert.equal(normPath(42), null);
    if (IS_WIN) {
      assert.equal(normPath('/c/Users/me'), 'C:/Users/me');
      assert.equal(normPath('/cygdrive/d/x'), 'D:/x');
    } else {
      assert.equal(normPath('/c/Users/me'), '/c/Users/me');
    }
  });

  test('resolvePath and relInside', async () => {
    assert.equal(resolvePath('C:/proj', 'film\\a.js'), 'C:/proj/film/a.js');
    assert.equal(resolvePath(null, 'film/a.js'), null);
    assert.equal(relInside('C:/proj', 'C:/proj/film/a.js'), 'film/a.js');
    assert.equal(relInside('C:/proj', 'C:/project/a.js'), null);
    assert.equal(relInside('C:/proj', 'C:/proj'), '');
    if (IS_WIN) assert.equal(relInside('C:/Proj', 'c:\\proj\\Film\\a.js'), 'Film/a.js');
  });

  test('parseInput accepts only JSON objects', async () => {
    assert.deepEqual(parseInput('\uFEFF {"a":1} '), { a: 1 });
    for (const bad of ['', '   ', '[1,2]', '"str"', 'null', '{"a":', 'not json']) assert.equal(parseInput(bad), null, bad);
  });

  test('findProjectRoot walks up from files and needs studio.json + film/tools/index.html', async () => {
    assert.equal(findProjectRoot(path.join(ROOT, 'film', 'scenes', 'not-yet.js')), fwd(ROOT).replace(/^[a-z]:/, (d) => d.toUpperCase()));
    assert.equal(findProjectRoot(bs(path.join(ROOT, 'film', 'film.js'))), normPath(ROOT));
    assert.equal(findProjectRoot(path.join(OUTSIDE, 'film', 'x.js')), null);
    const bare = path.join(BASE, 'bare');
    fs.mkdirSync(bare, { recursive: true });
    fs.writeFileSync(path.join(bare, 'studio.json'), '{}');
    assert.equal(findProjectRoot(bare), null, 'studio.json alone is not a studio project');
    assert.equal(findProjectRoot('relative/path'), null);
  });
});

// ---------------------------------------------------------------------------------------------
describe('hooks/lib/shell.mjs final-render detection', () => {
  const P = 'C:/proj/film1';
  const findRoot = (d) => (d && fwd(d).toLowerCase().startsWith(P.toLowerCase()) ? P : null);
  const readScripts = () => ({ render: 'node tools/render.mjs', 'render:all': 'node tools/render.mjs --format all', ship: 'npm run render:all -- --final', stills: 'node tools/stills.mjs --beats' });
  const W = (s) => s.replace(/\|/g, '\\'); // write Windows paths with "|" for readability
  const detect = (cmd, dialect, cwd) => detectFinalRenders(cmd, { dialect, cwd, findRoot, readScripts, home: 'C:/home/me', env: { FILMDIR: P } }).length > 0;
  const cases = [
    // [dialect, cwd, command, final?]
    ['bash', P, 'npm run render:final', true],
    ['bash', P, 'npm run build', true],
    ['bash', P, 'npm run render', false],
    ['bash', P, 'npm run render -- --final', true],
    ['bash', P, 'npm run render --final', false], // npm eats --final as its own config flag
    ['bash', P, 'npm run ship', true], // resolved through package.json scripts
    ['bash', P, 'npm run stills', false],
    ['bash', P, 'node tools/render.mjs --format all --final', true],
    ['bash', P, 'node tools/render.mjs --draft', false],
    ['bash', P, 'node tools/render.mjs --final=false', false],
    ['bash', P, 'node tools/render.mjs --final --no-final', false],
    ['bash', P, 'FOO=1 node --max-old-space-size=4096 ./tools/render.mjs --final=true 2>&1 | tee log.txt', true],
    ['bash', P, 'node --check tools/render.mjs --final', false],
    ['bash', P, 'node -e "1" tools/render.mjs --final', false],
    ['bash', 'C:/other', 'cd /c/proj/film1 && npm run build', IS_WIN],
    ['bash', 'C:/other', W('cd "C:|proj|film1" && node tools/render.mjs --final'), true],
    ['bash', 'C:/other', '(cd C:/proj/film1 && npm run stills) && npm run build', false], // subshell cd does not leak
    ['bash', 'C:/other', 'cd "$FILMDIR" && npm run build', true],
    ['bash', 'C:/other', 'npm --prefix C:/proj/film1 run build', true],
    ['bash', 'C:/other', 'bash -c "cd C:/proj/film1 && npm run render:final"', true],
    ['bash', 'C:/other', 'node C:/proj/film1/tools/render.mjs --final', true],
    ['bash', P, 'if npm run build; then echo ok; fi', true],
    ['bash', P, 'for f in a b; do node tools/render.mjs --final; done', true],
    ['bash', P, 'npx cross-env DEBUG=1 node tools/render.mjs --final', true],
    ['bash', P, 'npm exec -- node tools/render.mjs --final', true],
    ['bash', P, 'timeout 600 npm run build', true],
    ['bash', P, 'yarn build', true],
    ['bash', P, 'pnpm run render:final', true],
    ['bash', P, 'bun run build', true],
    ['bash', P, 'bun build ./x.ts', false],
    ['bash', P, 'node --run build', true],
    ['bash', P, 'echo $(npm run build)', true],
    ['bash', P, 'echo "npm run build"', false],
    ['bash', P, 'git commit -m "node tools/render.mjs --final"', false],
    ['bash', P, "cat <<'EOF' > notes.md\nnpm run build\nEOF\necho done", false],
    ['bash', P, 'ls && npm test', false],
    ['bash', 'C:/elsewhere', 'npm run build', false],
    ['powershell', 'C:/other', W("Set-Location 'C:|proj|film1'; npm run build"), true],
    ['powershell', 'C:/other', W('Set-Location -Path C:|proj|film1; npm run build'), true],
    ['powershell', 'C:/other', W('cd C:|proj|film1; node tools|render.mjs --final'), true],
    ['powershell', P, W('& "C:|Program Files|nodejs|node.exe" .|tools|render.mjs --format all --final'), true],
    ['powershell', 'C:/other', W('Push-Location C:|proj|film1; npm run render; Pop-Location; npm run build'), false],
    ['powershell', 'C:/other', W('Push-Location C:|proj|film1; npm run build; Pop-Location'), true],
    ['powershell', 'C:/other', W('cmd /c "cd /d C:|proj|film1 && npm run build"'), true],
    ['powershell', 'C:/other', `powershell -NoProfile -EncodedCommand ${Buffer.from(W('cd C:|proj|film1; npm run build'), 'utf16le').toString('base64')}`, true],
    ['powershell', 'C:/other', 'Set-Location $env:FILMDIR; npm run build', true],
    ['powershell', P, 'npm run render:final | Out-File log.txt', true],
    ['powershell', P, 'npm run build 2>$null', true],
    ['powershell', P, 'if ($true) { npm run build }', true],
    ['powershell', P, "$s = @'\nnpm run build\n'@\nWrite-Output $s", false],
    ['powershell', P, "Write-Output 'npm run build'", false],

    // PowerShell assignments: the captured-output idiom must not hide the command (plugin-shell:F2)
    ['powershell', P, '$out = npm run build 2>&1; $out | Select-Object -Last 20', true],
    ['powershell', P, '$out = npm run build 2>&1', true],
    ['powershell', P, '$r = npm run render:final', true],
    ['powershell', P, '$r = node tools/render.mjs --format all --final 2>&1 | Out-String', true],
    ['powershell', P, '$null = npm run build', true],
    ['powershell', P, '$out=npm run build', true],
    ['powershell', P, '$out += npm run build', true],
    ['powershell', P, '[string]$out = npm run build', true],
    ['powershell', P, '[string[]]$out = npm run build', true],
    ['powershell', P, '$env:FILMDIR = npm run build', true], // a variable that exists in the environment is not expanded
    ['powershell', P, '$script:out = npm run build', true],
    ['powershell', P, '${my out} = npm run build', true],
    ['powershell', P, '$o.Text = npm run build', true],
    ['powershell', P, '$a = 1; $b = npm run build', true],
    ['powershell', P, '$a = $b = npm run build', true],
    ['powershell', P, '$x = & node tools/render.mjs --final', true],
    ['powershell', P, W('$x = & "C:|Program Files|nodejs|node.exe" .|tools|render.mjs --final'), true],
    ['powershell', P, '[void](npm run build)', true],
    ['powershell', P, '[void]$(npm run build)', true],
    ['powershell', P, '$out = $(npm run build)', true],
    ['powershell', P, '$out = (npm run build)', true],
    ['powershell', P, '$out = @(npm run build)', true],
    ['powershell', P, '$out = "$(npm run build)"', true],
    ['powershell', P, '$out = npm run build; if ($LASTEXITCODE -ne 0) { exit 1 }', true],
    ['powershell', P, '$out = npm run build *>&1 | Tee-Object build.log', true],
    ['powershell', P, '$out = npm run build 2>&1\n$out | Select-Object -Last 20', true],
    ['powershell', P, 'try {\n  $out = npm run build\n} catch { throw }', true],
    ['powershell', P, '$log = "build.log"\nGet-Content $log | Select-String "npm run build"', false],
    ['powershell', P, 'for ($i = 0; $i -lt 2; $i++) { $r = npm run build }', true],
    ['powershell', P, '1..2 | ForEach-Object { $r = npm run build }', true],
    ['powershell', 'C:/other', W('Set-Location C:|proj|film1; $out = npm run build 2>&1'), true],
    ['powershell', P, "pwsh -NoProfile -Command '$out = npm run build 2>&1'", true],
    ['powershell', P, '$out = Invoke-Expression "npm run build"', true],
    ['powershell', P, 'iex "node tools/render.mjs --final"', true],
    ['powershell', P, 'Start-Process npm -ArgumentList "run build" -Wait', true],
    ['powershell', P, 'Start-Process -FilePath node -ArgumentList "tools/render.mjs","--final" -Wait -NoNewWindow', true],
    ['powershell', 'C:/other', W('Start-Process npm -ArgumentList "run","build" -WorkingDirectory C:|proj|film1'), true],
    // ... and strings, echoes and drafts that only mention a final render stay allowed
    ['powershell', P, '$msg = "node tools/render.mjs --final"', false],
    ['powershell', P, "$msg = 'npm run build'", false],
    ['powershell', P, '$out = npm run render', false],
    ['powershell', P, '$out = node tools/render.mjs --draft 2>&1', false],
    ['powershell', P, '$out = npm run stills; $out | Select-String "npm run build"', false],
    ['powershell', P, 'Write-Output $x = npm run build', false], // assignment-looking words after a command are arguments
    ['powershell', P, '$log = Get-Content notes.md | Select-String "npm run build"', false],
    ['powershell', P, 'Get-Content notes.md | Select-String "render --final" > hits.txt', false],
    ['powershell', P, 'Start-Process notepad -ArgumentList "npm run build"', false],
    ['powershell', P, 'Invoke-Expression "Write-Output npm run build"', false],
    ['powershell', P, '[Console]::WriteLine("node tools/render.mjs --final")', false],
    ['powershell', P, '$x = 5', false],
    ['powershell', P, 'git commit -m "node tools/render.mjs --final" 2>&1', false],
    ['powershell', P, 'Select-String -Pattern "npm run build" README.md', false],

    // Pipelines and redirections around the command
    ['bash', P, 'npm run build > log.txt 2>&1', true],
    ['bash', P, 'npm run build &> log.txt', true],
    ['bash', P, '2>&1 npm run build | tee build.log', true],
    ['bash', P, '> out.txt node tools/render.mjs --final', true],
    ['bash', P, '{ npm run build; } 2>&1 | tee log.txt', true],
    ['bash', P, 'out=$(npm run build 2>&1); echo "$out" | tail -n 5', true],
    ['bash', P, 'set -o pipefail; npm run build | tee log.txt', true],
    ['bash', P, 'eval "npm run build"', true],
    ['bash', P, 'eval echo npm run build', false],
    ['bash', P, 'echo "npm run build" > run.sh', false],
    ['bash', P, 'cat README.md | grep "render --final"', false],
    ['bash', P, 'grep -rn "npm run build" docs | head -n 5', false],
    ['bash', P, 'git commit -m "npm run build" 2>&1 | tail -n 2', false],
    ['powershell', P, 'npm run build > $null 2>&1', true],
    ['powershell', P, 'npm run build *> build.log', true],
  ];
  for (const [dialect, cwd, cmd, want] of cases) {
    test(`${want ? 'FINAL' : 'draft'} ${dialect}: ${cmd.replace(/\n/g, '\\n').slice(0, 80)}`, async () => {
      assert.equal(detect(cmd, dialect, cwd), want);
    });
  }

  // npm reads --prefix / -C / --workspace anywhere before a lone "--" (plugin-shell:F3): the directory a
  // script runs in must follow it, whether the option comes before or after the script name.
  const parent = 'C:/proj';
  const prefixCases = [
    // [cwd, command, final?]
    [parent, 'npm --prefix film1 run build', true],
    [parent, 'npm run build --prefix film1', true],
    [parent, 'npm run build --prefix=film1', true],
    [parent, 'npm run render:final -C film1', true],
    [parent, 'npm run --prefix film1 render:final', true],
    [parent, 'npm run ship --prefix film1', true], // through a package.json script
    [parent, 'npm run build -w film1', true],
    [parent, 'npm run build --workspace film1', true],
    [parent, 'npm run build --workspace=film1', true],
    [parent, 'npm -w film1 run build', true],
    [parent, 'npm run -w film1 build', true],
    [parent, 'npm run build -w plainapp -w film1', true],
    [parent, 'npm exec --prefix film1 -- node tools/render.mjs --final', true],
    [parent, 'npm exec -w film1 -- node tools/render.mjs --final', true],
    [parent, 'pnpm --dir film1 run build', true],
    [parent, 'pnpm run build --dir film1', true],
    [parent, 'yarn --cwd film1 build', true],
    [parent, 'bun --cwd film1 run build', true],
    [parent, 'npm run build --prefix plainapp', false], // another app
    [parent, 'npm run render:final -w plainapp', false],
    [parent, 'npm run build', false],
    [P, 'npm run build --prefix ../plainapp', false], // inside the film, building something else
    [P, 'npm run build -C ../plainapp', false],
    [P, 'npm run --prefix ../plainapp build', false],
    [P, 'npm --prefix ../plainapp run build', false],
    [P, 'npm run --prefix . render:final', true],
    [P, 'npm run build --prefix .', true],
    [P, 'npm run build -- --prefix ../plainapp', true], // after "--" it is the script's own argument
    [P, 'npm run --loglevel silent build', true], // an option value is not the script name
    [P, 'npm run build --loglevel silent', true],
    [P, 'npm run --if-present build', true],
    [P, 'npm -f run build', true], // -f is npm's boolean --force
    [P, 'pnpm -w run build', true], // -w is pnpm's boolean --workspace-root
    [P, 'pnpm -F pkg run build', true],
    [P, 'pnpm render --final', true], // pnpm passes the flag on to the script
    [P, 'npm test --prefix .', false],
    [P, 'npm install --prefix film1', false],
  ];
  for (const [cwd, cmd, want] of prefixCases) {
    test(`${want ? 'FINAL' : 'draft'} bash (cwd ${cwd === parent ? 'parent' : 'film'}): ${cmd}`, async () => {
      assert.equal(detect(cmd, 'bash', cwd), want);
    });
  }

  test('a hostile long command is parsed in linear time', async () => {
    const t0 = Date.now();
    for (const src of [`$x${' '.repeat(100000)}= npm run build`, '[a'.repeat(50000), `${'$a.b.c '.repeat(20000)}`, `$${'a'.repeat(100000)} = npm run build`]) {
      detect(src, 'powershell', P);
    }
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  });

  test('tokenizer: PowerShell assignment prefix is one asg token, bash is untouched', async () => {
    const kinds = (src, dialect) => tokenize(src, { dialect, env: { FILMDIR: 'C:/proj' } }).tokens.map((t) => `${t.t}:${t.v}`);
    assert.deepEqual(kinds('$out = npm run build', 'powershell'), ['asg:$out =', 'w:npm', 'w:run', 'w:build']);
    assert.deepEqual(kinds('[string]$o+=npm', 'powershell'), ['asg:[string]$o+=', 'w:npm']);
    assert.deepEqual(kinds('$env:FILMDIR = x', 'powershell'), ['asg:$env:FILMDIR =', 'w:x']);
    assert.deepEqual(kinds('Write-Output $a -eq $b', 'powershell'), ['w:Write-Output', 'w:$a', 'w:-eq', 'w:$b'], 'comparisons are not assignments');
    assert.deepEqual(kinds('$a == $b', 'powershell'), ['w:$a', 'w:==', 'w:$b']);
    assert.deepEqual(kinds('x = 1', 'powershell'), ['w:x', 'w:=', 'w:1']);
    assert.deepEqual(kinds('$out = 1', 'bash'), ['w:$out', 'w:=', 'w:1'], 'no asg token outside PowerShell');
  });

  test('parseScript: an assignment prefix is dropped at command position and kept as an argument elsewhere', async () => {
    const argvs = (src) => parseScript(src, { dialect: 'powershell', cwd: 'C:/p' }).map((c) => c.argv.join(' '));
    assert.deepEqual(argvs('$out = npm run build 2>&1; $out | Select-Object -Last 20'), ['npm run build', '$out', 'Select-Object -Last 20']);
    assert.deepEqual(argvs('$a = $b = & node x.mjs'), ['node x.mjs']);
    assert.deepEqual(argvs('Write-Output $x = 5'), ['Write-Output $x = 5']);
  });

  test('parseScript tracks cd targets per command', async () => {
    const cmds = parseScript('cd film && node a.mjs; cd .. && node b.mjs', { dialect: 'bash', cwd: 'C:/p' });
    const at = Object.fromEntries(cmds.map((c) => [c.argv.join(' '), c.cwd]));
    assert.equal(at['node a.mjs'], 'C:/p/film');
    assert.equal(at['node b.mjs'], 'C:/p');
  });

  test('hasFinalFlag: last flag wins', async () => {
    assert.equal(hasFinalFlag(['--format', 'all', '--final']), true);
    assert.equal(hasFinalFlag(['--final', '--no-final']), false);
    assert.equal(hasFinalFlag(['--final=0']), false);
    assert.equal(hasFinalFlag(['--finale']), false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('all hooks: robustness', { concurrency: true }, () => {
  const scripts = Object.keys(ENTRY_HANDLER);
  for (const s of scripts) {
    test(`${s}: malformed stdin → exit 0, no output (spawned)`, async () => {
      assertSilent(await run(s, null, { raw: fs.readFileSync(path.join(FIX, 'malformed.txt'), 'utf8') }), 'malformed');
    });
    test(`${s}: odd but valid JSON shapes → no output (in process)`, async () => {
      for (const odd of [{}, { tool_input: null, cwd: 7 }, { tool_input: 'x', tool_response: 5, cwd: [] }, { tool_input: { command: 42, file_path: {} }, agent_type: {} }]) {
        assertSilent(await call(s, odd), JSON.stringify(odd));
      }
    });
  }

  test('empty and non-object stdin → exit 0, no output (spawned)', async () => {
    assertSilent(await run('pre-bash-gate.mjs', null, { raw: '' }), 'empty');
    assertSilent(await run('session-start.mjs', null, { raw: '[1,2,3]' }), 'array');
  });

  test('MOTION_STUDIO_HOOKS=off silences every hook (spawned)', async () => {
    fs.writeFileSync(path.join(ROOT, 'film', 'scenes', 'ch01_bad.js'), 'export const jitter = () => Math.random();\n');
    const off = { MOTION_STUDIO_HOOKS: 'off' };
    assertSilent(await run('post-edit-lint.mjs', fixture('post-write-bad.json'), { env: off }), 'lint');
    assertSilent(await run('pre-bash-gate.mjs', fixture('pre-bash-final.json'), { env: off }), 'gate');
    assertSilent(await run('role-guard.mjs', fixture('role-guard-deny.json'), { env: off }), 'role');
    assertSilent(await run('session-start.mjs', fixture('session-start.json'), { env: off }), 'session');
  });

  test('fail open when the template modules cannot be imported', async () => {
    // A copy of hooks/ without the skills/ tree next to it: every template import fails.
    const lone = path.join(BASE, 'lone-plugin', 'hooks');
    copyDir(HOOKS, lone);
    fs.writeFileSync(path.join(ROOT, 'film', 'scenes', 'ch01_bad.js'), 'export const jitter = () => Math.random();\n');
    assertSilent(await call('post-edit-lint.mjs', fixture('post-write-bad.json'), { hooksDir: lone }), 'lint');
    assertSilent(await call('pre-bash-gate.mjs', fixture('pre-bash-final.json'), { hooksDir: lone }), 'gate');
    const s = await call('session-start.mjs', fixture('session-start.json'), { hooksDir: lone });
    assert.equal(s.code, 0);
    assert.match(s.json.hookSpecificOutput.additionalContext, /status unavailable/);
    // The same through a real process, so the entry script's own wiring is covered too.
    assertSilent(await run('pre-bash-gate.mjs', fixture('pre-bash-final.json'), { hooksDir: lone }), 'gate (spawned)');
  });
});

// ---------------------------------------------------------------------------------------------
describe('post-edit-lint.mjs', { skip: NO_LINT }, () => {
  test('lint error in a Windows-backslash path → exit 2 with a short stderr report (spawned)', async () => {
    fs.writeFileSync(path.join(ROOT, 'film', 'scenes', 'ch01_bad.js'), 'export const jitter = () => Math.random();\n');
    const r = await run('post-edit-lint.mjs', fixture('post-write-bad.json'));
    assert.equal(r.code, 2, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /film\/scenes\/ch01_bad\.js:1:\d+ no-math-random/);
    assert.match(r.stderr, /Fix: /);
    assert.ok(r.stderr.trim().split('\n').length <= 20);
  });

  test('many errors stay within 20 stderr lines', async () => {
    const body = Array.from({ length: 40 }, (_, i) => `export const a${i} = Math.random() + Date.now();`).join('\n');
    fs.writeFileSync(path.join(ROOT, 'film', 'scenes', 'ch01_bad.js'), `${body}\n`);
    const r = await call('post-edit-lint.mjs', fixture('post-write-bad.json'));
    assert.equal(r.code, 2);
    const lines = r.stderr.trim().split('\n');
    assert.ok(lines.length <= 20, `got ${lines.length} lines`);
    assert.match(r.stderr, /\+\d+ more/);
  });

  test('warnings only → exit 0 + PostToolUse additionalContext JSON (spawned)', async () => {
    fs.writeFileSync(path.join(ROOT, 'film', 'overlay.css'), '.chip { transition: opacity 0.2s; }\n');
    const r = await run('post-edit-lint.mjs', fixture('post-edit-warn.json'));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(r.json.hookSpecificOutput.additionalContext, /no-css-transition/);
    assert.match(r.json.hookSpecificOutput.additionalContext, /film\/overlay\.css/);
  });

  test('clean file → silent', async () => {
    assertSilent(await call('post-edit-lint.mjs', fixture('post-edit-clean.json')));
  });

  test('index.html inline script is linted; tools/ and docs/ are not', async () => {
    fs.writeFileSync(path.join(ROOT, 'index.html'), '<!doctype html><script type="module">const r = Math.random();</script>\n');
    const idx = fixture('post-edit-clean.json');
    idx.tool_input.file_path = bs(path.join(ROOT, 'index.html'));
    assert.equal((await call('post-edit-lint.mjs', idx)).code, 2);
    fs.rmSync(path.join(ROOT, 'index.html'));
    for (const rel of ['tools/extra.mjs', 'docs/notes.md', 'film/notes.md']) {
      const file = path.join(ROOT, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'Math.random();\n');
      const inp = fixture('post-edit-clean.json');
      inp.tool_input.file_path = bs(file);
      assertSilent(await call('post-edit-lint.mjs', inp), rel);
    }
  });

  test('outside a studio project → silent', async () => {
    fs.writeFileSync(path.join(OUTSIDE, 'film', 'bad.js'), 'Math.random();\n');
    assertSilent(await call('post-edit-lint.mjs', fixture('post-write-outside.json')));
  });

  test('deleted file → silent', async () => {
    const inp = fixture('post-write-bad.json');
    inp.tool_input.file_path = bs(path.join(ROOT, 'film', 'scenes', 'gone.js'));
    inp.tool_response = {};
    assertSilent(await call('post-edit-lint.mjs', inp));
  });
});

// ---------------------------------------------------------------------------------------------
describe('pre-bash-gate.mjs', { skip: NO_GATE, concurrency: true }, () => {
  let failing;
  let passing;
  let disabled;
  let plain;
  before(() => {
    failing = makeProject('gate-fail', { log: 'review_log.fail.md' });
    passing = makeProject('gate-pass', { log: 'review_log.pass.md' });
    disabled = makeProject('gate-off', { log: 'review_log.fail.md', studio: { gate: { enabled: false } } });
    plain = path.join(BASE, 'plainapp'); // a sibling project that is not a film
    fs.mkdirSync(plain, { recursive: true });
    fs.writeFileSync(path.join(plain, 'package.json'), JSON.stringify({ name: 'plainapp', scripts: { build: 'echo hi', 'render:final': 'echo hi' } }));
  });

  test('npm run render:final with a failing log → deny JSON with reasons and how to proceed (spawned)', async () => {
    const r = await run('pre-bash-gate.mjs', fixture('pre-bash-final.json', failing));
    assertDeny(r, /final render blocked/);
    const why = r.json.hookSpecificOutput.permissionDecisionReason;
    assert.match(why, /1\/3 critique rounds/);
    assert.match(why, /P0/);
    assert.match(why, /critique-loop/);
    assert.match(why, /"enabled": false/);
  });

  test('no review log at all → deny', async () => {
    assertDeny(await call('pre-bash-gate.mjs', fixture('pre-bash-final.json', ROOT)), /review_log/);
  });

  test('cd chain from outside the project → deny', async () => {
    assertDeny(await call('pre-bash-gate.mjs', fixture('pre-bash-cd-chain.json', failing)));
  });

  test('PowerShell Set-Location with backslash paths → deny (spawned)', async () => {
    assertDeny(await run('pre-bash-gate.mjs', fixture('pre-powershell-final.json', failing)));
  });

  test('PowerShell tool: a captured build ($out = npm run build 2>&1) is gated like a bare one (spawned)', async () => {
    const inp = fixture('pre-powershell-final.json', failing);
    inp.cwd = bs(failing);
    inp.tool_input.command = '$out = npm run build 2>&1; $out | Select-Object -Last 20';
    assertDeny(await run('pre-bash-gate.mjs', inp), /final render blocked/);
    for (const cmd of ['$r = npm run render:final', '$r = node tools/render.mjs --format all --final 2>&1 | Out-String', '$null = npm run build', '$out=npm run build']) {
      inp.tool_input.command = cmd;
      assertDeny(await call('pre-bash-gate.mjs', inp), /final render blocked/);
    }
    for (const cmd of ['$out = npm run stills', '$msg = "npm run build"', '$out = node tools/render.mjs --draft 2>&1']) {
      inp.tool_input.command = cmd;
      assertSilent(await call('pre-bash-gate.mjs', inp), cmd);
    }
  });

  test('npm --prefix / -C after the script name picks the project that really runs (spawned)', async () => {
    const inp = fixture('pre-bash-final.json', failing);
    // From the parent directory: the film's final render is gated however the prefix is spelled.
    inp.cwd = fwd(BASE);
    inp.tool_input.command = `npm run render:final --prefix ${path.basename(failing)}`;
    assertDeny(await run('pre-bash-gate.mjs', inp), /final render blocked/);
    for (const cmd of [`npm run build -C ${path.basename(failing)}`, `npm run --prefix=${path.basename(failing)} build`, `npm run build --workspace ${path.basename(failing)}`]) {
      inp.tool_input.command = cmd;
      assertDeny(await call('pre-bash-gate.mjs', inp), /final render blocked/);
    }
    // From inside the film: building another app is not the film's final render.
    inp.cwd = fwd(failing);
    inp.tool_input.command = 'npm run build --prefix ../plainapp';
    assertSilent(await run('pre-bash-gate.mjs', inp), 'other app (spawned)');
    for (const cmd of ['npm run build -C ../plainapp', 'npm run --prefix ../plainapp render:final', 'npm --prefix ../plainapp run build']) {
      inp.tool_input.command = cmd;
      assertSilent(await call('pre-bash-gate.mjs', inp), cmd);
    }
    // From the other app's directory a sibling film is still reachable through the prefix.
    inp.cwd = fwd(plain);
    inp.tool_input.command = `npm run build --prefix ../${path.basename(failing)}`;
    assertDeny(await call('pre-bash-gate.mjs', inp), /final render blocked/);
  });

  test('Windows backslash cwd + npm run build → deny', async () => {
    const inp = fixture('pre-bash-final.json', failing);
    inp.cwd = bs(path.join(failing, 'film'));
    inp.tool_input.command = 'npm run build';
    assertDeny(await call('pre-bash-gate.mjs', inp));
  });

  test('custom package script that renders --final → deny', async () => {
    const inp = fixture('pre-bash-final.json', failing);
    inp.tool_input.command = 'npm run ship';
    assertDeny(await call('pre-bash-gate.mjs', inp), /npm run ship/);
  });

  test('drafts and stills are never gated', async () => {
    assertSilent(await call('pre-bash-gate.mjs', fixture('pre-bash-draft.json', failing)));
    const inp = fixture('pre-bash-final.json', failing);
    for (const cmd of ['node tools/render.mjs --format all', 'npm run animatic', 'node tools/gate.mjs', 'echo "npm run build"']) {
      inp.tool_input.command = cmd;
      assertSilent(await call('pre-bash-gate.mjs', inp), cmd);
    }
  });

  test('passing gate → silent (normal permission flow)', async () => {
    assertSilent(await run('pre-bash-gate.mjs', fixture('pre-bash-final.json', passing)));
    assertSilent(await call('pre-bash-gate.mjs', fixture('pre-powershell-final.json', passing)));
  });

  test('gate.enabled=false → silent', async () => {
    assertSilent(await call('pre-bash-gate.mjs', fixture('pre-bash-final.json', disabled)));
  });

  test('outside a studio project → silent', async () => {
    const inp = fixture('pre-bash-final.json', failing);
    inp.cwd = fwd(OUTSIDE);
    inp.tool_input.command = 'npm run build && node tools/render.mjs --final';
    assertSilent(await call('pre-bash-gate.mjs', inp));
  });

  test('non-shell tools are ignored', async () => {
    const inp = fixture('pre-bash-final.json', failing);
    inp.tool_name = 'Write';
    assertSilent(await call('pre-bash-gate.mjs', inp));
  });

  test('adds well under a second on top of bare node startup (spawned)', async () => {
    // Compare with `node -e 0` on the same machine: process startup alone can exceed a second
    // on machines with on-access scanning, and the hook budget is about the hook's own work.
    const bare = [];
    const hook = [];
    for (let i = 0; i < 2; i++) {
      const t0 = process.hrtime.bigint();
      spawnSync(process.execPath, ['-e', '0'], { input: '{}', env: hookEnv() });
      bare.push(Number(process.hrtime.bigint() - t0) / 1e6);
      hook.push((await run('pre-bash-gate.mjs', fixture('pre-bash-final.json', failing))).ms);
      hook.push((await run('post-edit-lint.mjs', fixture('post-edit-clean.json'))).ms);
    }
    const overhead = Math.min(...hook) - Math.min(...bare);
    assert.ok(overhead < 1000, `hook overhead ${overhead.toFixed(0)} ms (bare node ${Math.min(...bare).toFixed(0)} ms)`);
  });
});

// ---------------------------------------------------------------------------------------------
describe('role-guard.mjs', { concurrency: true }, () => {
  const as = (agent, file, extra = {}) => ({ ...fixture('role-guard-allow.json'), agent_type: agent, tool_input: { file_path: file, content: 'x' }, ...extra });
  const inRoot = (...parts) => bs(path.join(ROOT, ...parts));
  const guard = (input) => call('role-guard.mjs', input);

  test('chapter-animator writing film/film.js → deny (spawned)', async () => {
    assertDeny(await run('role-guard.mjs', fixture('role-guard-deny.json')), /film\/scenes\/\*\*.*film\/film\.js/s);
  });

  test('chapter-animator writing film/scenes/** or out/check/** → allow (silent)', async () => {
    assertSilent(await run('role-guard.mjs', fixture('role-guard-allow.json')));
    assertSilent(await guard(as('motion-studio:chapter-animator', inRoot('out', 'check', 'ch02', 'strip.png'))));
  });

  test('chapter-animator: film/scenes/shared_* is read-only, its own chapter files stay writable', async () => {
    const shared = /shared_\* files are shared by every chapter and read-only/;
    assertDeny(await guard(as('motion-studio:chapter-animator', inRoot('film', 'scenes', 'shared_hero.js'))), shared);
    assertDeny(await guard(as('chapter-animator', fwd(path.join(ROOT, 'film', 'scenes', 'shared_ui.mjs')), { tool_name: 'Edit' })), shared);
    // Traversal is resolved before matching: a chapter path that lands on a shared file is still denied.
    assertDeny(await guard(as('motion-studio:chapter-animator', `${inRoot('film', 'scenes', 'ch03_intro.js')}\\..\\shared_hero.js`)), shared);
    if (IS_WIN || process.platform === 'darwin') {
      assertDeny(await guard(as('motion-studio:chapter-animator', inRoot('film', 'scenes', 'Shared_Hero.JS'))), shared);
    }
    assertSilent(await guard(as('motion-studio:chapter-animator', inRoot('film', 'scenes', 'ch03_intro.js'))), 'own chapter');
    assertSilent(await guard(as('motion-studio:chapter-animator', inRoot('film', 'scenes', 'ch03_shared_glow.js'))), 'chapter file named *shared*');
    // The lane description in other denials names the carve-out, so the agent knows it up front.
    assertDeny(await guard(as('motion-studio:chapter-animator', inRoot('lib', 'draw.js'))), /film\/scenes\/\*\*, out\/check\/\*\* \(except film\/scenes\/shared_\*\)/);
    // Only the chapter lane has the carve-out; the main session keeps editing shared files.
    const main = as('motion-studio:chapter-animator', inRoot('film', 'scenes', 'shared_hero.js'));
    delete main.agent_type;
    assertSilent(await guard(main), 'main session');
  });

  test('path traversal out of the lane → deny', async () => {
    assertDeny(await guard(as('motion-studio:chapter-animator', `${inRoot('film', 'scenes')}\\..\\film.js`)));
    assertDeny(await guard(as('motion-studio:chapter-animator', inRoot('film', 'scenes-old', 'x.js'))));
    assertDeny(await guard(as('motion-studio:chapter-animator', inRoot('film', 'scenes'))));
  });

  test('symlinked folder inside the lane cannot reach outside it', async (t) => {
    const link = path.join(ROOT, 'film', 'scenes', 'libs');
    try {
      fs.symlinkSync(path.join(ROOT, 'film'), link, IS_WIN ? 'junction' : 'dir');
    } catch (err) {
      t.skip(`cannot create a symlink here (${err.code})`);
      return;
    }
    try {
      assertDeny(await guard(as('motion-studio:chapter-animator', bs(path.join(link, 'film.js')))));
    } finally {
      fs.rmSync(link, { recursive: false, force: true });
    }
  });

  test('motion-critic: only docs/review_log.md and out/review/**', async () => {
    assertSilent(await guard(as('motion-studio:motion-critic', inRoot('docs', 'review_log.md'))));
    assertSilent(await guard(as('motion-studio:motion-critic', inRoot('out', 'review', '9x16', 'notes.md'))));
    assertDeny(await guard(as('motion-studio:motion-critic', inRoot('film', 'film.js'))), /docs\/review_log\.md/);
    assertDeny(await guard(as('motion-studio:motion-critic', inRoot('docs', 'shotlist.md'))));
  });

  test('style-analyst, asset-scout, motion-director lanes', async () => {
    assertSilent(await guard(as('motion-studio:style-analyst', inRoot('docs', 'style_guide.md'))));
    assertSilent(await guard(as('motion-studio:style-analyst', inRoot('refs', 'frames', '001.png'))));
    assertDeny(await guard(as('motion-studio:style-analyst', inRoot('docs', 'review_log.md'))));
    assertSilent(await guard(as('motion-studio:asset-scout', inRoot('assets', 'brand', 'logo.png'))));
    assertDeny(await guard(as('motion-studio:asset-scout', inRoot('lib', 'draw.js'))));
    assertSilent(await guard(as('motion-studio:motion-director', inRoot('docs', 'STORYBOARD.md'))));
    assertDeny(await guard(as('motion-studio:motion-director', inRoot('film', 'film.js'))));
  });

  test('forward-slash, MultiEdit and Edit inputs are handled the same', async () => {
    assertDeny(await guard(as('motion-studio:chapter-animator', fwd(path.join(ROOT, 'lib', 'motion.js')), { tool_name: 'MultiEdit' })));
    assertDeny(await guard(as('motion-studio:chapter-animator', fwd(path.join(ROOT, 'studio.json')), { tool_name: 'Edit' })));
  });

  test('outside the project while the session is in it → deny; fully outside → silent', async () => {
    assertDeny(await guard(as('motion-studio:chapter-animator', bs(path.join(OUTSIDE, 'x.js')))), /outside it/);
    assertSilent(await guard(as('motion-studio:chapter-animator', bs(path.join(OUTSIDE, 'x.js')), { cwd: fwd(OUTSIDE) })));
  });

  test('scratchpad writes are allowed', async () => {
    const scratch = path.join(BASE, 'scratch');
    assertSilent(await guard(as('motion-studio:chapter-animator', bs(path.join(scratch, 'probe.mjs')), { scratchpad_dir: bs(scratch) })));
  });

  test('main session, unrestricted and unknown agents → silent', async () => {
    const main = fixture('role-guard-deny.json');
    delete main.agent_type;
    delete main.agent_id;
    assertSilent(await guard(main), 'main session');
    for (const agent of ['Explore', 'general-purpose', 'motion-studio:render-engineer', 'motion-studio:sound-designer', 'my-chapter-animator']) {
      assertSilent(await guard(as(agent, inRoot('film', 'film.js'))), agent);
    }
    // A project-level agent with the same name gets the same lane.
    assertDeny(await guard(as('chapter-animator', inRoot('film', 'film.js'))));
  });
});

// ---------------------------------------------------------------------------------------------
describe('session-start.mjs', { concurrency: true }, () => {
  const start = (input) => call('session-start.mjs', input);

  test('inside a project → SessionStart additionalContext (<= 1,200 chars) (spawned)', async () => {
    const r = await run('session-start.mjs', fixture('session-start.json'));
    assert.equal(r.code, 0, r.stderr);
    const o = r.json.hookSpecificOutput;
    assert.equal(o.hookEventName, 'SessionStart');
    assert.ok(o.additionalContext.length <= 1200);
    assert.match(o.additionalContext, /"Hook Fixture Film"/);
    assert.match(o.additionalContext, /9x16 \(primary\), 1x1/);
    assert.match(o.additionalContext, /4 s at 30 fps, 120 BPM/);
    assert.match(o.additionalContext, /Next: npm install/);
  });

  test('gate status, finals and next command reflect the project state', { skip: NO_GATE }, async () => {
    const dir = makeProject('session-pass', { log: 'review_log.pass.md' });
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'out', '9x16'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'out', '9x16', 'final.mp4'), '');
    const r = await start(fixture('session-start.json', dir));
    const text = r.json.hookSpecificOutput.additionalContext;
    assert.match(text, /Critique gate: PASS; 3\/3 rounds/);
    assert.match(text, /hook=8 readability=9/);
    assert.match(text, /Finals on disk: 9x16; missing 1x1/);
    assert.match(text, /Next: npm run build/);

    const fail = makeProject('session-fail', { log: 'review_log.fail.md' });
    fs.mkdirSync(path.join(fail, 'node_modules'), { recursive: true });
    const f = (await start(fixture('session-start.json', fail))).json.hookSpecificOutput.additionalContext;
    assert.match(f, /not passed; 1\/3 rounds/);
    assert.match(f, /1 open P0/);
    assert.match(f, /log round 2/);
  });

  test('from a subdirectory with a Windows-style cwd', async () => {
    const inp = fixture('session-start.json');
    inp.cwd = bs(path.join(ROOT, 'film', 'scenes'));
    const r = await start(inp);
    assert.match(r.json.hookSpecificOutput.additionalContext, /Hook Fixture Film/);
  });

  test('very long title still fits the budget', async () => {
    const dir = makeProject('session-long', { studio: { title: 'T'.repeat(5000), formats: ['9x16', '1x1', '16x9', '4x5'] } });
    const r = await start(fixture('session-start.json', dir));
    assert.ok(r.json.hookSpecificOutput.additionalContext.length <= 1200);
  });

  test('invalid studio.json is reported, not fatal', async () => {
    const dir = makeProject('session-bad');
    fs.writeFileSync(path.join(dir, 'studio.json'), '{ "title": "Broken", ');
    const r = await start(fixture('session-start.json', dir));
    assert.equal(r.code, 0);
    assert.match(r.json.hookSpecificOutput.additionalContext, /studio\.json problem/);
  });

  test('outside a studio project → no output', async () => {
    const inp = fixture('session-start.json');
    inp.cwd = fwd(OUTSIDE);
    assertSilent(await start(inp));
  });
});
