// Browser policy: which browser the tools start, and why on Windows never an installed Chrome/Edge by default.
//
// An installed Chrome or Edge started with a fresh profile tests the Windows account for a blank password; every launch is a
// failed logon (event 4625) and counts toward the account lockout. So on win32 'auto' means Playwright's bundled headless
// shell only, an installed Chrome/Edge is an explicit opt-in that warns, and a guard refuses too many of them per 10 minutes.
//
// Two implementations carry the same policy block: the template's tools/studio-web.mjs (launchBrowser) and the product-reel
// scripts/capture.mjs (launch). This file keeps them in step, tests the pure policy functions and the launchers against a fake
// playwright (no browser, so nothing here can touch Chrome), and has one real-browser test that skips without the headless shell.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = process.env.MOTION_TEMPLATE_DIR ? path.resolve(process.env.MOTION_TEMPLATE_DIR) : path.join(REPO, 'skills', 'studio-init', 'template');
const WEB_FILE = path.join(TEMPLATE, 'tools', 'studio-web.mjs');
const CAPTURE_FILE = path.join(REPO, 'skills', 'product-reel', 'scripts', 'capture.mjs');
const W = await import(pathToFileURL(WEB_FILE).href);
const C = await import(pathToFileURL(CAPTURE_FILE).href);

const WIN = process.platform === 'win32';
const RISK = 'windows-blank-password-logon';
const INSTALL = 'npx playwright install chromium-headless-shell';
// Paths that are only ever classified (by file name) or handed to a fake playwright; no test here runs them.
const CHROME_EXE = WIN ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/opt/google/chrome/chrome';
const EDGE_EXE = WIN ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : '/opt/microsoft/msedge/msedge';
const SHELL_EXE = WIN ? 'C:\\Users\\x\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1243\\chrome-headless-shell-win64\\chrome-headless-shell.exe'
  : '/home/x/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';

// Every temp dir a test makes is removed when the file is done (a link to a shared node_modules is unlinked first, never followed).
const made = [];
const tmp = (prefix = 'ms-bp-') => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(dir); return dir; };
function dropTree(dir) {
  const link = path.join(dir, 'node_modules');
  try { if (fs.lstatSync(link).isSymbolicLink()) { try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); } } } catch { /* no link */ }
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* still in use: the OS temp cleanup takes it */ }
}
after(() => { for (const dir of made.splice(0)) dropTree(dir); });

const withEnv = async (patch, fn) => {
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
/** Runs fn with process.stderr.write collected instead of printed; resolves { result, stderr }. */
async function withStderr(fn) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); rest.find((r) => typeof r === 'function')?.(); return true; };
  try { return { result: await fn(), stderr: lines.join('') }; } finally { process.stderr.write = write; }
}
/** The browser-choosing env, all cleared, with a temp launch log so nothing here ever writes the real one. */
const policyEnv = (over = {}) => ({ MOTION_CHROME_PATH: undefined, MOTION_BROWSER: undefined, MOTION_ALLOW_LOCKOUT_RISK: undefined,
  MOTION_SYSTEM_BROWSER_MAX: undefined, MOTION_LAUNCH_LOG: path.join(tmp(), 'launches.json'), ...over });

// ---------------------------------------------------------------------------------------------------------------
// classifyBrowser

test('classifyBrowser: installed Chrome/Edge (channel or file name) is a system browser, the bundled ones are not; the risk is win32 only', () => {
  const system = [
    { channel: 'chrome' }, { channel: 'msedge' }, { channel: 'chrome-beta' }, { channel: 'msedge-dev' }, { channel: 'chrome-canary' }, { channel: 'CHROME' },
    { executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }, { executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { executablePath: 'c:\\x\\CHROME.EXE' }, { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' }, { executablePath: 'msedge.exe' }, { executablePath: 'chrome' },
    { executablePath: '/usr/bin/google-chrome' }, { executablePath: '/usr/bin/google-chrome-stable' }, { executablePath: '/opt/google/chrome/chrome' },
    { executablePath: '/usr/bin/microsoft-edge' }, { executablePath: '/usr/bin/microsoft-edge-stable' }, { executablePath: '/opt/microsoft/msedge/msedge' },
    { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }, { executablePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    // Conservative: judged by file name only, so Playwright's full bundled Chromium (…\chromium-1243\chrome-win64\chrome.exe) counts as installed too.
    { executablePath: 'C:\\Users\\x\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe' },
  ];
  for (const b of system) {
    const win = W.classifyBrowser({ ...b, platform: 'win32' });
    assert.deepEqual(win, { system: true, risk: RISK }, JSON.stringify(b));
    for (const platform of ['linux', 'darwin']) assert.deepEqual(W.classifyBrowser({ ...b, platform }), { system: true, risk: null }, `${JSON.stringify(b)} on ${platform}: the check is Windows-only`);
  }
  const safe = [
    {}, { channel: undefined, executablePath: undefined }, { channel: 'chromium' }, { channel: '' }, { executablePath: '' },
    { executablePath: SHELL_EXE }, { executablePath: 'C:\\x\\chrome-headless-shell.exe' }, { executablePath: '/x/headless_shell' }, { executablePath: '/x/chrome-headless-shell-linux64/chrome-headless-shell' },
    { executablePath: '/usr/bin/chromium' }, { executablePath: '/usr/bin/chromium-browser' }, { executablePath: 'C:\\x\\Chromium\\chromium.exe' },
    { executablePath: 'C:\\tools\\firefox.exe' }, { executablePath: 'C:\\x\\no-such-browser.exe' }, { executablePath: 'C:\\x\\chrome.exe.bak' },
  ];
  for (const b of safe) for (const platform of ['win32', 'linux', 'darwin']) assert.deepEqual(W.classifyBrowser({ ...b, platform }), { system: false, risk: null }, `${JSON.stringify(b)} on ${platform}`);
  assert.deepEqual(W.classifyBrowser(), { system: false, risk: null }, 'no argument = the bundled browser');
  assert.equal(W.classifyBrowser({ channel: 'chrome' }).risk, WIN ? RISK : null, 'platform defaults to the running one');
});

// ---------------------------------------------------------------------------------------------------------------
// browserAttempts (pure)

const vias = (list) => list.map((a) => a.via);

test('browserAttempts: on win32 "auto" is the bundled browser only, whatever the config says or fails to say', () => {
  const envs = [{}, { MOTION_CHROME_PATH: '' }, { MOTION_BROWSER: '' }, { MOTION_BROWSER: 'auto' }, { MOTION_CHROME_PATH: '  ' }];
  for (const pref of [undefined, null, 'auto', ' auto ', '', 'firefox', 42, {}]) {
    for (const env of envs) {
      const list = W.browserAttempts(pref, 'win32', env);
      assert.deepEqual(vias(list), ['chromium-headless-shell'], `${JSON.stringify(pref)} ${JSON.stringify(env)}`);
      assert.deepEqual(list[0].opts, {}, 'no channel and no executablePath: Playwright\'s own browser');
      assert.equal(list.some((a) => a.system || a.risk || a.warning || a.opts.channel || a.opts.executablePath), false);
      assert.equal(list[0].auto, true);
    }
  }
  assert.deepEqual(vias(W.browserAttempts('auto', 'win32', {}, { headless: false })), ['chromium'], 'headed = the full bundled Chromium');
  assert.deepEqual(vias(W.browserAttempts('chromium', 'win32', {})), ['chromium-headless-shell']);
  assert.deepEqual(vias(W.browserAttempts('chromium', 'linux', {})), ['chromium-headless-shell']);
  // MOTION_BROWSER=auto is the way back to the safe default when studio.json opted in
  assert.deepEqual(vias(W.browserAttempts('chrome', 'win32', { MOTION_BROWSER: 'auto' })), ['chromium-headless-shell']);
});

test('browserAttempts: on macOS and Linux "auto" keeps chrome, msedge, bundled, with no warning', () => {
  for (const platform of ['linux', 'darwin']) {
    const list = W.browserAttempts('auto', platform, {});
    assert.deepEqual(vias(list), ['chrome', 'msedge', 'chromium-headless-shell'], platform);
    assert.deepEqual(list.map((a) => a.opts), [{ channel: 'chrome' }, { channel: 'msedge' }, {}]);
    assert.deepEqual(list.map((a) => a.system), [true, true, false]);
    assert.equal(list.some((a) => a.warning || a.risk), false, 'the blank-password check is Windows-only');
    assert.equal(list.every((a) => a.auto), true);
    assert.deepEqual(vias(W.browserAttempts(undefined, platform, {})), ['chrome', 'msedge', 'chromium-headless-shell']);
    assert.deepEqual(vias(W.browserAttempts('auto', platform, {}, { headless: false })), ['chrome', 'msedge', 'chromium']);
  }
});

test('browserAttempts: an explicit opt-in to the installed Chrome/Edge is honored and carries warning=true on win32 only', () => {
  const cases = [
    ['studio.json chrome', 'chrome', {}, 'chrome', { channel: 'chrome' }],
    ['studio.json msedge', 'msedge', {}, 'msedge', { channel: 'msedge' }],
    ['MOTION_BROWSER=chrome', 'auto', { MOTION_BROWSER: 'chrome' }, 'chrome', { channel: 'chrome' }],
    ['MOTION_BROWSER=msedge', undefined, { MOTION_BROWSER: 'msedge' }, 'msedge', { channel: 'msedge' }],
    ['MOTION_BROWSER=CHROME', 'auto', { MOTION_BROWSER: ' CHROME ' }, 'chrome', { channel: 'chrome' }],
    ['MOTION_BROWSER beats studio.json', 'msedge', { MOTION_BROWSER: 'chrome' }, 'chrome', { channel: 'chrome' }],
    ['MOTION_CHROME_PATH chrome.exe', 'auto', { MOTION_CHROME_PATH: CHROME_EXE }, `executable:${path.resolve(CHROME_EXE)}`, { executablePath: path.resolve(CHROME_EXE) }],
    ['MOTION_CHROME_PATH msedge.exe', 'auto', { MOTION_CHROME_PATH: EDGE_EXE }, `executable:${path.resolve(EDGE_EXE)}`, { executablePath: path.resolve(EDGE_EXE) }],
    ['MOTION_CHROME_PATH beats MOTION_BROWSER', 'auto', { MOTION_CHROME_PATH: CHROME_EXE, MOTION_BROWSER: 'msedge' }, `executable:${path.resolve(CHROME_EXE)}`, { executablePath: path.resolve(CHROME_EXE) }],
    ['absolute studio.json path', CHROME_EXE, {}, `executable:${path.resolve(CHROME_EXE)}`, { executablePath: path.resolve(CHROME_EXE) }],
  ];
  for (const [what, pref, env, via, opts] of cases) {
    const win = W.browserAttempts(pref, 'win32', env);
    assert.equal(win.length, 1, `${what}: one attempt, no silent fallback`);
    assert.equal(win[0].via, via, what);
    assert.deepEqual(win[0].opts, opts, what);
    assert.equal(win[0].system, true, what);
    assert.equal(win[0].risk, RISK, what);
    assert.equal(win[0].warning, true, `${what}: warns on win32`);
    assert.equal(win[0].auto, false);
    for (const platform of ['linux', 'darwin']) {
      const other = W.browserAttempts(pref, platform, env);
      assert.deepEqual([other[0].via, other[0].opts, other[0].system, other[0].risk, other[0].warning], [via, opts, true, null, false], `${what} on ${platform}: no warning`);
    }
  }
});

test('browserAttempts: a path to the bundled headless shell (MOTION_CHROME_PATH, studio.json) is bundled, not a system browser', () => {
  for (const [pref, env] of [['auto', { MOTION_CHROME_PATH: SHELL_EXE }], [SHELL_EXE, {}], ['chrome', { MOTION_CHROME_PATH: SHELL_EXE }]]) {
    const list = W.browserAttempts(pref, 'win32', env);
    assert.equal(list.length, 1);
    assert.equal(list[0].via, 'chromium-headless-shell');
    assert.deepEqual(list[0].opts, { executablePath: path.resolve(SHELL_EXE) });
    assert.deepEqual([list[0].system, list[0].risk, list[0].warning], [false, null, false]);
  }
  const other = W.browserAttempts('auto', 'win32', { MOTION_CHROME_PATH: path.join(os.tmpdir(), 'some-chromium-fork.exe') });
  assert.match(other[0].via, /^executable:/);
  assert.equal(other[0].warning, false);
});

test('browserAttempts: MOTION_BROWSER with an unknown value is an error, not a silent fallback', () => {
  for (const platform of ['win32', 'linux']) assert.throws(() => W.browserAttempts('auto', platform, { MOTION_BROWSER: 'firefox' }), /MOTION_BROWSER=firefox is not valid: use auto, chrome, msedge or chromium/);
});

// ---------------------------------------------------------------------------------------------------------------
// The launch guard (temp MOTION_LAUNCH_LOG, no browser)

const T0 = Date.UTC(2026, 8, 30, 12, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const chromeAttempt = () => W.browserAttempts('chrome', 'win32', {})[0];
const guardEnv = (over = {}) => ({ MOTION_LAUNCH_LOG: path.join(tmp(), 'sub', 'launches.json'), ...over });
const launchOnce = (env, now, lib = W) => { const lines = []; const g = lib.guardSystemLaunch(chromeAttempt(), { env, now, warn: (l) => lines.push(l) }); return { g, lines }; };

test('guard: the launch being started counts toward the limit of 4: 3 launches in 10 minutes are allowed, the 4th is refused with the wait time and the way out, and is not logged', () => {
  const env = guardEnv();
  for (let i = 0; i < 3; i++) {
    const { g, lines } = launchOnce(env, T0 + i * SEC);
    assert.equal(g.count, i, 'the launches already logged');
    assert.equal(lines.length, 1, 'exactly one warning line per launch');
    assert.ok(!lines[0].includes('\n'), 'and it is one line');
    assert.match(lines[0], /^warning: starting chrome on Windows counts as one failed logon/);
    assert.match(lines[0], new RegExp(`launch ${i + 1} of 3 allowed in 10 min`));
    assert.ok(lines[0].includes(INSTALL));
  }
  assert.equal(W.readLaunchLog(env.MOTION_LAUNCH_LOG, T0 + 3 * SEC).length, 3);
  const lines4 = [];
  assert.throws(() => W.guardSystemLaunch(chromeAttempt(), { env, now: T0 + 4 * SEC, warn: (l) => lines4.push(l) }), (err) => {
    assert.equal(err.code, 'MOTION_LOCKOUT_GUARD');
    assert.match(err.message, /^refusing to start chrome: 3 launches of an installed Chrome\/Edge in the last 10 minutes, and the limit is 4 launches counting this one \(MOTION_SYSTEM_BROWSER_MAX\)/);
    assert.match(err.message, /lockout/i);
    assert.match(err.message, /Wait 9 min 56 s \(until the oldest counted launch is 10 minutes old\)/, 'the oldest launch was at T0; it is 10 min old at T0 + 10 min');
    assert.ok(err.message.includes(INSTALL), 'says how to switch to the headless shell');
    assert.match(err.message, /MOTION_ALLOW_LOCKOUT_RISK=1/);
    assert.ok(err.message.includes(env.MOTION_LAUNCH_LOG), 'names the log file');
    return true;
  });
  assert.equal(lines4.length, 0, 'a refused launch prints no warning');
  assert.equal(W.readLaunchLog(env.MOTION_LAUNCH_LOG, T0 + 4 * SEC).length, 3, 'and is not logged');
});

test('guard: a log of 3 launches in the window refuses, and the refusal ends exactly when the oldest counted launch is 10 minutes old', () => {
  const env = guardEnv();
  for (let i = 0; i < 3; i++) launchOnce(env, T0 + i * SEC);
  const at = (ms) => W.launchGuard({ env, now: T0 + ms });
  assert.deepEqual([at(5 * SEC).count, at(5 * SEC).refuse, at(5 * SEC).waitMs], [3, true, 10 * MIN - 5 * SEC]);
  assert.equal(at(10 * MIN - 1).refuse, true, '1 ms before the oldest turns 10 minutes old');
  assert.equal(at(10 * MIN).refuse, false, 'exactly 10 minutes old = outside the window');
  assert.equal(at(10 * MIN).count, 2);
  assert.equal(at(10 * MIN + SEC).count, 1);
  assert.throws(() => launchOnce(env, T0 + 10 * MIN - 1), /refusing to start chrome/);
  assert.doesNotThrow(() => launchOnce(env, T0 + 10 * MIN));
  // a log that already holds 4 (written by hand, or before the limit was lowered) is over the limit as well
  const four = guardEnv();
  fs.mkdirSync(path.dirname(four.MOTION_LAUNCH_LOG), { recursive: true });
  fs.writeFileSync(four.MOTION_LAUNCH_LOG, JSON.stringify([0, 1, 2, 3].map((i) => T0 + i * SEC)));
  assert.equal(W.launchGuard({ env: four, now: T0 + 10 * SEC }).refuse, true);
});

test('guard: with more launches logged than the limit the wait is until the count drops back under it', () => {
  const env = guardEnv({ MOTION_SYSTEM_BROWSER_MAX: '4' });
  fs.mkdirSync(path.dirname(env.MOTION_LAUNCH_LOG), { recursive: true });
  fs.writeFileSync(env.MOTION_LAUNCH_LOG, JSON.stringify([0, 1, 2, 3, 4, 5].map((i) => T0 + i * SEC)));
  const g = W.launchGuard({ env, now: T0 + 10 * SEC });
  assert.equal(g.count, 6);
  assert.equal(g.waitMs, 10 * MIN - 7 * SEC, 'the 4th oldest (T0 + 3 s) has to leave the window, not the oldest');
  assert.equal(W.launchGuard({ env, now: T0 + 3 * SEC + 10 * MIN - 1 }).refuse, true);
  assert.equal(W.launchGuard({ env, now: T0 + 3 * SEC + 10 * MIN }).refuse, false, 'two are left, under the 3 allowed');
});

test('guard: MOTION_SYSTEM_BROWSER_MAX sets the limit (integer 1..9, the launch being started counts); anything else is the default 4', () => {
  for (const [value, want] of [[undefined, 4], ['', 4], ['4', 4], ['1', 1], ['2', 2], ['9', 9], [' 3 ', 3], ['0', 4], ['10', 4], ['-1', 4], ['2.5', 4], ['abc', 4]])
    assert.equal(W.systemBrowserMax({ MOTION_SYSTEM_BROWSER_MAX: value }), want, JSON.stringify(value));
  // The MAX-th launch inside the window is refused, so MAX - 1 are allowed (1 behaves like 2: a single launch is allowed).
  for (const [max, allowed] of [['1', 1], ['2', 1], ['3', 2], ['4', 3], ['9', 8], ['99', 3], ['x', 3], [undefined, 3]]) {
    const env = guardEnv({ MOTION_SYSTEM_BROWSER_MAX: max });
    for (let i = 0; i < allowed; i++) assert.doesNotThrow(() => launchOnce(env, T0 + i * SEC), `MOTION_SYSTEM_BROWSER_MAX=${max}: launch ${i + 1} of ${allowed}`);
    assert.throws(() => launchOnce(env, T0 + allowed * SEC), /refusing to start chrome/, `MOTION_SYSTEM_BROWSER_MAX=${max}: launch ${allowed + 1}`);
  }
  const two = guardEnv({ MOTION_SYSTEM_BROWSER_MAX: '2' });
  launchOnce(two, T0);
  assert.throws(() => launchOnce(two, T0 + SEC), /the limit is 2 launches counting this one/);
});

test('guard: MOTION_ALLOW_LOCKOUT_RISK=1 turns the refusal off but the launch is still logged and warned about', () => {
  const env = guardEnv({ MOTION_SYSTEM_BROWSER_MAX: '3', MOTION_ALLOW_LOCKOUT_RISK: '1' }); // 2 allowed
  const out = [0, 1, 2, 3].map((i) => launchOnce(env, T0 + i * SEC));
  assert.equal(W.readLaunchLog(env.MOTION_LAUNCH_LOG, T0 + 4 * SEC).length, 4, 'every launch is in the log');
  for (const o of out) assert.equal(o.lines.length, 1, 'still one warning line');
  assert.doesNotMatch(out[0].lines[0], /over the limit/);
  assert.doesNotMatch(out[1].lines[0], /over the limit/);
  assert.match(out[2].lines[0], /over the limit/);
  assert.match(out[3].lines[0], /over the limit/);
  assert.deepEqual([out[3].g.override, out[3].g.blocked, out[3].g.refuse], [true, true, false]);
  // without the variable (or with another value) the same log refuses
  assert.throws(() => launchOnce({ ...env, MOTION_ALLOW_LOCKOUT_RISK: '0' }, T0 + 5 * SEC), /refusing to start/);
  assert.throws(() => launchOnce({ ...env, MOTION_ALLOW_LOCKOUT_RISK: '' }, T0 + 5 * SEC), /refusing to start/);
});

test('guard: entries older than 1 h are pruned when a launch is recorded, entries older than 10 min are not counted', () => {
  const env = guardEnv();
  fs.mkdirSync(path.dirname(env.MOTION_LAUNCH_LOG), { recursive: true });
  const old = [2 * 60 * MIN, 90 * MIN, 61 * MIN, 30 * MIN, 20 * MIN, 5 * MIN].map((ago) => T0 - ago);
  fs.writeFileSync(env.MOTION_LAUNCH_LOG, JSON.stringify(old));
  const { g } = launchOnce(env, T0);
  assert.equal(g.count, 1, 'only the launch 5 minutes ago is inside the window');
  const raw = JSON.parse(fs.readFileSync(env.MOTION_LAUNCH_LOG, 'utf8'));
  assert.ok(Array.isArray(raw));
  assert.deepEqual(raw, [T0 - 30 * MIN, T0 - 20 * MIN, T0 - 5 * MIN, T0], 'the three older than 1 h are gone, the new one is appended');
});

test('guard: a missing directory is created, a missing, empty or corrupt log is an empty log, and odd entries are ignored', () => {
  const env = guardEnv();
  assert.deepEqual(W.readLaunchLog(env.MOTION_LAUNCH_LOG, T0), [], 'missing file');
  assert.equal(W.launchGuard({ env, now: T0 }).count, 0);
  launchOnce(env, T0);
  assert.deepEqual(JSON.parse(fs.readFileSync(env.MOTION_LAUNCH_LOG, 'utf8')), [T0], 'directory and file created');
  fs.mkdirSync(path.dirname(env.MOTION_LAUNCH_LOG), { recursive: true });
  for (const junk of ['', '   ', '{"launches": [1, 2,', 'not json at all', '\u0000\u0001\u0002', 'null', '"text"', '42', '{}', '{"launches":"no"}', '[null,"x",{},-5,0,[],true]']) {
    fs.writeFileSync(env.MOTION_LAUNCH_LOG, junk);
    assert.deepEqual(W.readLaunchLog(env.MOTION_LAUNCH_LOG, T0), [], JSON.stringify(junk));
    const { g, lines } = launchOnce(env, T0);
    assert.equal(g.count, 0, `${JSON.stringify(junk)}: the launch is allowed`);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(env.MOTION_LAUNCH_LOG, 'utf8')), [T0], 'and the corrupt file is replaced by a valid log');
  }
  fs.writeFileSync(env.MOTION_LAUNCH_LOG, `\uFEFF${JSON.stringify([T0 - SEC])}`);
  assert.deepEqual(W.readLaunchLog(env.MOTION_LAUNCH_LOG, T0), [T0 - SEC], 'a BOM is tolerated');
  // other shapes a hand-written or older log may have
  fs.writeFileSync(env.MOTION_LAUNCH_LOG, JSON.stringify({ launches: [new Date(T0 - 3 * SEC).toISOString(), T0 - 2 * SEC, String(T0 - SEC), { t: T0 - 4 * SEC }] }));
  assert.equal(W.launchGuard({ env, now: T0 }).count, 4);
  fs.writeFileSync(env.MOTION_LAUNCH_LOG, JSON.stringify([T0 + 30 * 60 * MIN, T0 + 5 * MIN, T0 + 5 * MIN, T0 + 5 * MIN, T0 + 5 * MIN]));
  assert.equal(W.launchGuard({ env, now: T0 }).count, 0, 'times in the future (a clock jump, a bad file) never block');
});

test('guard: a log that cannot be written does not stop the launch, but the warning says the limit is not enforced', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a-file'), 'x');
  const env = { MOTION_LAUNCH_LOG: path.join(dir, 'a-file', 'launches.json') }; // its parent is a file
  const { g, lines } = launchOnce(env, T0);
  assert.equal(g.count, 0);
  assert.match(lines[0], /the launch log is not writable so the limit is not enforced/);
  assert.equal(W.recordLaunch({ env, now: T0 }), false);
});

test('guard: a launch that does not carry the Windows risk is not counted, warned about or logged', () => {
  const env = guardEnv();
  const lines = [];
  const warn = (l) => lines.push(l);
  for (const attempt of [W.browserAttempts('auto', 'win32', {})[0], W.browserAttempts('chrome', 'linux', {})[0], W.browserAttempts('chrome', 'darwin', {})[0], W.browserAttempts('auto', 'win32', { MOTION_CHROME_PATH: SHELL_EXE })[0], null]) {
    assert.equal(W.guardSystemLaunch(attempt, { env, now: T0, warn }), null);
  }
  assert.deepEqual(lines, []);
  assert.equal(fs.existsSync(env.MOTION_LAUNCH_LOG), false);
});

test('guard: the log is %LOCALAPPDATA%/motion-studio/system-browser-launches.json, MOTION_LAUNCH_LOG overrides it', () => {
  assert.equal(W.launchLogPath({ LOCALAPPDATA: 'X:\\la' }), path.join('X:\\la', 'motion-studio', 'system-browser-launches.json'));
  const custom = path.join(tmp(), 'mine.json');
  assert.equal(W.launchLogPath({ MOTION_LAUNCH_LOG: custom, LOCALAPPDATA: 'X:\\la' }), custom);
  assert.equal(path.basename(W.launchLogPath({})), 'system-browser-launches.json', 'without LOCALAPPDATA it falls back to the home folder');
  assert.equal(W.launchLogPath({ MOTION_LAUNCH_LOG: 'rel.json' }), path.resolve('rel.json'));
});

// ---------------------------------------------------------------------------------------------------------------
// Error text

test('launchFailureMessage: on Windows "auto" names the install command, why, and the opt-in; other cases keep "could not launch a browser"', () => {
  const failures = ["chromium-headless-shell: browserType.launch: Executable doesn't exist at X"];
  const auto = W.launchFailureMessage(failures, { platform: 'win32', auto: true });
  assert.ok(auto.split('\n').length >= 5, 'multi-line');
  assert.match(auto, /^could not launch a browser: no safe browser found\./);
  assert.ok(auto.includes(`  - ${failures[0]}`));
  assert.ok(auto.includes(INSTALL));
  assert.match(auto, /about 115 MB; it starts slowly under some antivirus/);
  assert.match(auto, /blank password/);
  assert.match(auto, /failed logon/);
  assert.match(auto, /one failed logon per launch/);
  assert.match(auto, /studio\.json "browser": "chrome" or MOTION_BROWSER=chrome \(guarded, see docs\/ARCHITECTURE\.md\)/);
  const headed = W.launchFailureMessage(failures, { platform: 'win32', auto: true, headless: false });
  assert.ok(headed.includes('npx playwright install chromium') && !headed.includes(INSTALL), 'headed runs need the full Chromium');
  const pinned = W.launchFailureMessage(['executable:C:\\x\\nope.exe: file not found (C:\\x\\nope.exe)'], { platform: 'win32', auto: false });
  assert.match(pinned, /^could not launch a browser:\n/);
  assert.doesNotMatch(pinned, /no safe browser found/, 'a path the user pinned is not "no safe browser"');
  assert.ok(pinned.includes(INSTALL));
  for (const platform of ['linux', 'darwin']) {
    const m = W.launchFailureMessage(failures, { platform, auto: true });
    assert.match(m, /^could not launch a browser:\n/);
    assert.doesNotMatch(m, /no safe browser found/);
    assert.ok(m.includes(INSTALL) && /Google Chrome or Microsoft Edge/.test(m), platform);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The two launchers against a fake playwright (no browser is started)

/** A project whose node_modules/playwright records every chromium.launch(opts) in globalThis.__msBpLaunches. */
function fakeProject(studio = {}) {
  const root = tmp('ms-bp-fake-');
  fs.writeFileSync(path.join(root, 'studio.json'), JSON.stringify(studio));
  const pw = path.join(root, 'node_modules', 'playwright');
  fs.mkdirSync(pw, { recursive: true });
  fs.writeFileSync(path.join(pw, 'package.json'), '{"name":"playwright","version":"0.0.0","main":"index.js"}');
  fs.writeFileSync(path.join(pw, 'index.js'), `
exports.chromium = { async launch(opts) {
  globalThis.__msBpLaunches.push(opts);
  const why = globalThis.__msBpFail && globalThis.__msBpFail(opts);
  if (why) throw new Error(why);
  return { version: () => 'fake 1.0', isConnected: () => true, close: async () => {}, newBrowserCDPSession: async () => ({ send: async () => ({ processInfo: [] }), detach: async () => {} }), async newContext() { return { close: async () => {} }; } };
} };`);
  return root;
}
const LAUNCHERS = [
  ['tools/studio-web.mjs launchBrowser', (root, studio) => W.launchBrowser(root, studio)],
  ['product-reel capture.mjs launch', (root) => C.launch(root)],
];
async function inFakeProject(studio, env, fn, fail = null) {
  const root = fakeProject(studio);
  globalThis.__msBpLaunches = [];
  globalThis.__msBpFail = fail;
  try { return await withEnv(env, () => fn(root, globalThis.__msBpLaunches)); } finally { delete globalThis.__msBpLaunches; delete globalThis.__msBpFail; }
}

test('launchers: with no env and no config the default browser is bundled on win32 (chrome first elsewhere), silently and without touching the launch log', async () => {
  for (const [name, launch] of LAUNCHERS) {
    const env = policyEnv();
    await inFakeProject({}, env, async (root, launches) => {
      const { result, stderr } = await withStderr(() => launch(root, {}));
      assert.equal(launches.length, 1, name);
      if (WIN) {
        assert.equal(result.via, 'chromium-headless-shell', name);
        assert.equal(launches[0].channel, undefined, `${name}: no channel`);
        assert.equal(launches[0].executablePath, undefined, `${name}: no executablePath`);
      } else {
        assert.equal(result.via, 'chrome', name);
        assert.equal(launches[0].channel, 'chrome');
      }
      assert.equal(launches[0].headless, true);
      assert.equal(stderr, '', `${name}: no warning`);
      assert.equal(fs.existsSync(env.MOTION_LAUNCH_LOG), false, `${name}: not logged`);
    });
  }
});

test('launchBrowser: the return value keeps { browser, via, version } and says whether the browser is a system one', async () => {
  await inFakeProject({}, policyEnv(), async (root) => {
    const r = await W.launchBrowser(root, {});
    assert.equal(typeof r.browser.newContext, 'function');
    assert.equal(r.version, 'fake 1.0');
    assert.equal(r.via, WIN ? 'chromium-headless-shell' : 'chrome');
    assert.equal(r.system, !WIN);
    assert.equal(r.risk, null);
    const headed = await W.launchBrowser(root, { browser: 'chromium' }, { headless: false });
    assert.equal(headed.via, 'chromium');
    assert.equal(headed.system, false);
  });
});

test('launchers: when the bundled browser is missing, win32 stops with the install command and never tries Chrome/Edge', async () => {
  for (const [name, launch] of LAUNCHERS) {
    await inFakeProject({}, policyEnv(), async (root, launches) => {
      await assert.rejects(() => withStderr(() => launch(root, {})), (err) => {
        assert.match(err.message, /^could not launch a browser/, name);
        if (WIN) {
          assert.match(err.message, /no safe browser found\./);
          assert.ok(err.message.includes(INSTALL), err.message);
          assert.match(err.message, /Executable doesn't exist/, 'the reason from Playwright is kept');
        } else assert.doesNotMatch(err.message, /no safe browser found/);
        return true;
      });
      if (WIN) {
        assert.equal(launches.length, 1, `${name}: exactly one attempt`);
        assert.equal(launches[0].channel, undefined);
        assert.equal(launches.some((o) => o.channel === 'chrome' || o.channel === 'msedge' || o.executablePath), false, 'never falls through to an installed Chrome/Edge');
      } else assert.deepEqual(launches.map((o) => o.channel), ['chrome', 'msedge', undefined], 'elsewhere the old order');
    }, () => "browserType.launch: Executable doesn't exist at C:\\x\\chrome-headless-shell.exe\nLooks like Playwright was just installed or updated.");
  }
});

test('launchers: an explicit opt-in starts the installed browser with one warning line and a log entry on win32, silently elsewhere', async () => {
  const fakeChrome = path.join(tmp(), 'chrome.exe'); // never run: the playwright here is a fake
  fs.writeFileSync(fakeChrome, '');
  const cases = [
    ['studio.json chrome', { browser: 'chrome' }, {}, 'chrome', { channel: 'chrome' }],
    ['studio.json msedge', { browser: 'msedge' }, {}, 'msedge', { channel: 'msedge' }],
    ['MOTION_BROWSER=chrome', {}, { MOTION_BROWSER: 'chrome' }, 'chrome', { channel: 'chrome' }],
    ['MOTION_CHROME_PATH chrome.exe', {}, { MOTION_CHROME_PATH: fakeChrome }, `executable:${path.resolve(fakeChrome)}`, { executablePath: path.resolve(fakeChrome) }],
  ];
  for (const [name, launch] of LAUNCHERS) {
    for (const [what, studio, extra, via, opts] of cases) {
      const env = policyEnv(extra);
      await inFakeProject(studio, env, async (root, launches) => {
        const { result, stderr } = await withStderr(() => launch(root, studio));
        assert.equal(result.via, via, `${name} ${what}`);
        assert.equal(launches.length, 1);
        for (const [k, v] of Object.entries(opts)) assert.equal(launches[0][k], v, `${name} ${what}: ${k}`);
        if (WIN) {
          const lines = stderr.trim().split('\n');
          assert.equal(lines.length, 1, `${name} ${what}: exactly one warning line, got ${JSON.stringify(stderr)}`);
          assert.match(lines[0], /^warning: starting .+ on Windows counts as one failed logon .*launch 1 of 3 allowed in 10 min/);
          assert.equal(W.readLaunchLog(env.MOTION_LAUNCH_LOG).length, 1, 'logged');
          if (name.startsWith('tools')) assert.deepEqual([result.system, result.risk], [true, RISK]);
        } else {
          assert.equal(stderr, '', `${name} ${what}: no warning outside Windows`);
          assert.equal(fs.existsSync(env.MOTION_LAUNCH_LOG), false, 'and no guard');
        }
      });
    }
  }
});

test('launchers: the guard refuses before Chrome is started, and MOTION_ALLOW_LOCKOUT_RISK=1 lets the launch through', async () => {
  for (const [name, launch] of LAUNCHERS) {
    const env = policyEnv({ MOTION_BROWSER: 'chrome', MOTION_SYSTEM_BROWSER_MAX: '3' });
    await inFakeProject({}, env, async (root, launches) => {
      await withStderr(async () => { await launch(root, {}); await launch(root, {}); });
      assert.equal(launches.length, 2);
      if (!WIN) { await withStderr(() => launch(root, {})); assert.equal(launches.length, 3, `${name}: no guard outside Windows`); return; }
      await assert.rejects(() => withStderr(() => launch(root, {})), (err) => err.code === 'MOTION_LOCKOUT_GUARD' && err.message.includes(INSTALL) && /refusing to start chrome/.test(err.message));
      assert.equal(launches.length, 2, `${name}: the third launch never reached chromium.launch`);
      assert.equal(W.readLaunchLog(env.MOTION_LAUNCH_LOG).length, 2, 'and was not logged');
      const { stderr } = await withEnv({ MOTION_ALLOW_LOCKOUT_RISK: '1' }, () => withStderr(() => launch(root, {})));
      assert.equal(launches.length, 3);
      assert.match(stderr, /over the limit/);
      assert.equal(W.readLaunchLog(env.MOTION_LAUNCH_LOG).length, 3);
    });
  }
});

test('launchers: the two implementations share one launch log (a launch made by one counts for the other)', async () => {
  if (!WIN) return;
  const env = policyEnv({ MOTION_BROWSER: 'chrome', MOTION_SYSTEM_BROWSER_MAX: '4' });
  await inFakeProject({}, env, async (root) => {
    await withStderr(async () => { await W.launchBrowser(root, {}); await C.launch(root); await W.launchBrowser(root, {}); });
    for (const [name, launch] of LAUNCHERS) await assert.rejects(() => withStderr(() => launch(root, {})), /refusing to start chrome: 3 launches/, name);
  });
});

test('launchers: MOTION_CHROME_PATH at a file that does not exist still fails as before ("could not launch a browser … file not found"), before any guard or warning', async () => {
  for (const [name, launch] of LAUNCHERS) {
    for (const missing of [path.join(tmp(), 'no-such-browser.exe'), path.join(tmp(), 'chrome.exe')]) {
      const env = policyEnv({ MOTION_CHROME_PATH: missing });
      await inFakeProject({}, env, async (root, launches) => {
        const { stderr, result } = await withStderr(() => launch(root, {}).then(() => null, (err) => err));
        assert.match(result.message, /^could not launch a browser:/, name);
        assert.match(result.message, /file not found/);
        assert.equal(launches.length, 0);
        assert.equal(stderr, '', 'no warning for a browser that is not there');
        assert.equal(fs.existsSync(env.MOTION_LAUNCH_LOG), false, 'and nothing logged');
      });
    }
  }
});

test('launchers: an unknown MOTION_BROWSER value fails before any launch', async () => {
  for (const [name, launch] of LAUNCHERS) {
    await inFakeProject({}, policyEnv({ MOTION_BROWSER: 'firefox' }), async (root, launches) => {
      await assert.rejects(() => launch(root, {}), /MOTION_BROWSER=firefox is not valid/, name);
      assert.equal(launches.length, 0);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The two copies of the policy stay the same

const policyBlock = (file) => {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const a = text.indexOf('// >>> browser-policy');
  const b = text.indexOf('// <<< browser-policy');
  assert.ok(a >= 0 && b > a, `${path.basename(file)} has the browser-policy block`);
  return text.slice(a, b);
};
const POLICY_EXPORTS = ['classifyBrowser', 'browserAttempts', 'launchLogPath', 'systemBrowserMax', 'readLaunchLog', 'launchGuard', 'recordLaunch', 'lockoutRefusal',
  'systemBrowserWarning', 'guardSystemLaunch', 'launchFailureMessage', 'LAUNCH_WINDOW_MS'];

test('sync: capture.mjs carries the same policy block as tools/studio-web.mjs, byte for byte, and exports the same functions', () => {
  assert.equal(policyBlock(CAPTURE_FILE), policyBlock(WEB_FILE));
  for (const name of POLICY_EXPORTS) {
    assert.equal(typeof C[name], typeof W[name], name);
    assert.notEqual(W[name], undefined, `studio-web.mjs exports ${name}`);
  }
});

test('sync: both implementations give the same answers on the same inputs (classification, attempts, guard, texts)', () => {
  const seenErrors = [];
  const run = (lib, f) => { try { return f(lib); } catch (err) { seenErrors.push(err.message); return { error: err.message }; } };
  const prefs = [undefined, null, 'auto', 'chrome', 'msedge', 'chromium', 'firefox', '', CHROME_EXE, SHELL_EXE];
  const envs = [{}, { MOTION_BROWSER: 'chrome' }, { MOTION_BROWSER: 'msedge' }, { MOTION_BROWSER: 'auto' }, { MOTION_BROWSER: 'nope' }, { MOTION_CHROME_PATH: CHROME_EXE },
    { MOTION_CHROME_PATH: SHELL_EXE, MOTION_BROWSER: 'chrome' }, { MOTION_CHROME_PATH: EDGE_EXE }];
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const pref of prefs) for (const env of envs) for (const headless of [true, false]) {
      assert.deepEqual(run(C, (l) => l.browserAttempts(pref, platform, env, { headless })), run(W, (l) => l.browserAttempts(pref, platform, env, { headless })), `${platform} ${pref} ${JSON.stringify(env)} ${headless}`);
    }
    for (const b of [{}, { channel: 'chrome' }, { channel: 'msedge' }, { channel: 'chromium' }, { executablePath: CHROME_EXE }, { executablePath: EDGE_EXE }, { executablePath: SHELL_EXE }, { executablePath: '/usr/bin/chromium' }])
      assert.deepEqual(C.classifyBrowser({ ...b, platform }), W.classifyBrowser({ ...b, platform }), `${platform} ${JSON.stringify(b)}`);
  }
  assert.ok(seenErrors.length > 0, 'the grid includes an invalid MOTION_BROWSER');

  // The guard: one scripted sequence per implementation, on its own log, must give the same counts, waits, texts and log contents.
  const script = (lib) => {
    const env = { MOTION_LAUNCH_LOG: path.join(tmp(), 'launches.json'), MOTION_SYSTEM_BROWSER_MAX: '3' };
    const attempt = lib.browserAttempts('chrome', 'win32', {})[0];
    const trace = [];
    for (const dt of [0, 1000, 2000, 3000, 599000, 600000, 601000, 700000, 3700000]) {
      const lines = [];
      try { const g = lib.guardSystemLaunch(attempt, { env, now: T0 + dt, warn: (l) => lines.push(l) }); trace.push({ dt, count: g.count, lines }); } catch (err) { trace.push({ dt, error: err.message.replace(env.MOTION_LAUNCH_LOG, '<log>'), code: err.code }); }
    }
    trace.push(JSON.parse(fs.readFileSync(env.MOTION_LAUNCH_LOG, 'utf8')));
    trace.push(lib.launchGuard({ env: { ...env, MOTION_ALLOW_LOCKOUT_RISK: '1' }, now: T0 + 3700000 }).override);
    return trace;
  };
  assert.deepEqual(script(C), script(W));
  // and they read and write the very same file format
  const shared = { MOTION_LAUNCH_LOG: path.join(tmp(), 'shared.json') };
  assert.equal(W.recordLaunch({ env: shared, now: T0 }), true);
  assert.equal(C.recordLaunch({ env: shared, now: T0 + SEC }), true);
  assert.deepEqual(W.readLaunchLog(shared.MOTION_LAUNCH_LOG, T0 + 2 * SEC), [T0, T0 + SEC]);
  assert.deepEqual(C.readLaunchLog(shared.MOTION_LAUNCH_LOG, T0 + 2 * SEC), [T0, T0 + SEC]);
  assert.deepEqual(C.launchGuard({ env: shared, now: T0 + 2 * SEC }), W.launchGuard({ env: shared, now: T0 + 2 * SEC }));

  const g = { max: 4, count: 4, blocked: true, refuse: true, override: false, waitMs: 123000, file: 'F' };
  for (const via of ['chrome', 'msedge']) {
    assert.equal(C.lockoutRefusal(via, g), W.lockoutRefusal(via, g));
    assert.equal(C.systemBrowserWarning(via, g), W.systemBrowserWarning(via, g));
    assert.equal(C.systemBrowserWarning(via, { ...g, override: true }, false), W.systemBrowserWarning(via, { ...g, override: true }, false));
  }
  for (const platform of ['win32', 'linux', 'darwin']) for (const auto of [true, false]) for (const headless of [true, false])
    assert.equal(C.launchFailureMessage(['a: b'], { platform, auto, headless }), W.launchFailureMessage(['a: b'], { platform, auto, headless }));
  assert.equal(C.LAUNCH_WINDOW_MS, W.LAUNCH_WINDOW_MS);
  assert.equal(C.systemBrowserMax({ MOTION_SYSTEM_BROWSER_MAX: '7' }), W.systemBrowserMax({ MOTION_SYSTEM_BROWSER_MAX: '7' }));
  assert.equal(C.launchLogPath({ LOCALAPPDATA: 'X:\\la' }), W.launchLogPath({ LOCALAPPDATA: 'X:\\la' }));
});

// ---------------------------------------------------------------------------------------------------------------
// One real browser: the default on this machine is the bundled headless shell, and Chrome is not touched

/** The node_modules folder that provides playwright: env override, else whatever resolves from the repo or cwd. */
function findNodeModules() {
  const env = process.env.MOTION_SMOKE_NODE_MODULES;
  if (env) return fs.existsSync(path.join(env, 'playwright')) || fs.existsSync(path.join(env, 'playwright-core')) ? path.resolve(env) : null;
  for (const base of [path.join(REPO, 'package.json'), path.join(process.cwd(), 'package.json')]) {
    for (const name of ['playwright', 'playwright-core']) {
      try { return path.dirname(path.dirname(createRequire(base).resolve(`${name}/package.json`))); } catch { /* try the next */ }
    }
  }
  return null;
}
const powershell = (script) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 90000, windowsHide: true });
/**
 * Failed logons (Security event 4625) written by chrome.exe or msedge.exe since `sinceMs`, or null when the Security log cannot be
 * read here (not Windows, or no permission).
 */
function browserFailedLogons(sinceMs) {
  if (!WIN) return null;
  const r = powershell(`$s = [DateTimeOffset]::FromUnixTimeMilliseconds(${sinceMs}).LocalDateTime
try { $e = @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4625; StartTime = $s } -ErrorAction Stop) }
catch { if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { $e = @() } else { exit 3 } }
@($e | Where-Object { $_.Message -match 'chrome\\.exe|msedge\\.exe' }).Count`);
  const n = Number(String(r.stdout).trim());
  return r.status === 0 && Number.isInteger(n) ? n : null;
}

test('real browser: launchBrowser with no browser env starts the bundled headless shell on Windows, not Chrome, and writes no failed logon', { timeout: 240000 }, async (t) => {
  if (!WIN) { t.skip('the bundled-first policy is Windows-only'); return; }
  const nm = findNodeModules();
  if (!nm) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  const root = tmp('ms-bp-real-');
  fs.writeFileSync(path.join(root, 'studio.json'), '{}');
  try { fs.symlinkSync(nm, path.join(root, 'node_modules'), 'junction'); } catch { t.skip('cannot link node_modules here'); return; }
  const env = policyEnv(); // MOTION_CHROME_PATH and MOTION_BROWSER unset: the real default
  await withEnv(env, async () => {
    // Before anything starts: the default must already resolve to a bundled browser, so this test cannot launch Chrome.
    const plan = W.browserAttempts('auto', process.platform, process.env);
    assert.deepEqual(plan.map((a) => [a.via, a.opts, a.system]), [['chromium-headless-shell', {}, false]]);
    const since = Date.now() - 60 * MIN;
    const before = browserFailedLogons(since);
    let launched;
    try { launched = await W.launchBrowser(root, {}); } catch (err) {
      if (/no safe browser found/.test(err.message)) { t.skip(`bundled headless shell is not installed (${INSTALL})`); return; }
      throw err;
    }
    let exe = null;
    try {
      assert.equal(launched.via, 'chromium-headless-shell');
      assert.equal(launched.system, false);
      assert.equal(launched.risk, null);
      assert.match(launched.version, /^\d+\./);
      const session = await launched.browser.newBrowserCDPSession();
      const info = await session.send('SystemInfo.getProcessInfo');
      const pid = info.processInfo.find((p) => p.type === 'browser')?.id;
      assert.ok(Number.isInteger(pid), 'the browser process id');
      const r = powershell(`(Get-Process -Id ${pid}).Path`);
      exe = String(r.stdout).trim();
      assert.match(path.basename(exe), /^chrome-headless-shell\.exe$/i, `the process behind the browser: ${exe}`);
      assert.equal(fs.existsSync(env.MOTION_LAUNCH_LOG), false, 'no installed-browser launch was logged');
    } finally { await launched.browser.close(); }
    await new Promise((resolve) => setTimeout(resolve, 1500)); // the Security log is written by LSA a moment after the event
    const after = browserFailedLogons(since);
    if (before === null || after === null) t.diagnostic('Security log not readable here: failed logons not counted');
    else assert.equal(after, before, `failed logons by chrome.exe/msedge.exe since the test began: ${before} → ${after}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// No third copy: the states script moved out of agents/asset-scout.md into skills/product-reel/scripts/states.mjs, which launches
// the browser through capture.mjs launch(). Only studio-web.mjs and capture.mjs carry the policy block.

test('sync: no third policy copy exists (asset-scout.md embeds no block) and capture-session.mjs launches through capture.mjs', () => {
  const scout = fs.readFileSync(path.join(REPO, 'agents', 'asset-scout.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(scout.includes('// >>> browser-policy'), false, 'agents/asset-scout.md carries no policy marker');
  assert.equal(scout.includes('// <<< browser-policy'), false, 'nor the end marker');
  const session = fs.readFileSync(path.join(REPO, 'skills', 'product-reel', 'scripts', 'capture-session.mjs'), 'utf8');
  assert.match(session, /import \{[^}]*\blaunch\b[^}]*\} from '\.\/capture\.mjs';/, 'capture-session.mjs imports launch from capture.mjs');
  assert.doesNotMatch(session, />>> browser-policy/, 'and carries no policy block of its own');
  assert.equal(policyBlock(CAPTURE_FILE), policyBlock(WEB_FILE), 'studio-web.mjs and capture.mjs stay byte-identical');
});
