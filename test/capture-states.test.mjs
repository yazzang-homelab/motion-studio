// skills/product-reel/scripts/states.mjs (+ capture-cli.mjs, capture-session.mjs): the UI-state capture that used to be a ~400-line script
// embedded in agents/asset-scout.md. Pure tests run anywhere; the browser tests skip unless playwright resolves and a browser starts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  REPO, SCRIPTS, PNG, browserProject, cleanup, closeServer, listen, noBrowser, rmTree, runNode, startSite, tmp,
} from '../scripts/test-support/capture-site.mjs';

const S = await import(pathToFileURL(path.join(SCRIPTS, 'states.mjs')).href);
const CLI = await import(pathToFileURL(path.join(SCRIPTS, 'capture-cli.mjs')).href);
const SESSION = await import(pathToFileURL(path.join(SCRIPTS, 'capture-session.mjs')).href);
const C = await import(pathToFileURL(path.join(SCRIPTS, 'capture.mjs')).href);
after(cleanup);

const withEnv = async (patch, fn) => {
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

// ---------------------------------------------------------------------------------------------------------------
// The files an agent and a skills-only user are pointed at

test('asset-scout no longer embeds the states script: the agent and product-reel call states.mjs by both path forms', () => {
  const scout = read('agents', 'asset-scout.md');
  const skill = read('skills', 'product-reel', 'SKILL.md');
  assert.ok(scout.split('\n').length < 200, `the agent body is short again (${scout.split('\n').length} lines)`);
  assert.doesNotMatch(scout, /## States capture/, 'the heredoc section is gone');
  assert.ok(!scout.includes('<<\'JS\'') && !/--input-type=module - /.test(scout), 'no script is fed to node from stdin any more');
  assert.doesNotMatch(scout, /```\n\/\/ states capture/, 'no embedded script block');
  for (const text of [scout, skill]) {
    assert.match(text, /\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/product-reel\/scripts\/states\.mjs/, 'plugin install path');
    assert.match(text, /\$\{CLAUDE_SKILL_DIR\}\/scripts\/states\.mjs/, 'skills-only path');
    assert.match(text, /canvas-frames\.mjs/);
  }
  assert.match(skill, /Skills-only install[^:]*:[\s\S]{0,200}\$\{CLAUDE_SKILL_DIR\}\/scripts\/states\.mjs/, 'skills-only usage is spelled out');
  assert.match(skill, /no project, `studio\.json` or `tools\/` is required/);
  for (const f of ['states.mjs', 'canvas-frames.mjs', 'canvas-pack.mjs', 'png-sheet.mjs', 'capture-session.mjs', 'capture-cli.mjs', 'capture-registry.mjs']) {
    assert.ok(fs.existsSync(path.join(SCRIPTS, f)), f);
    assert.ok(fs.readFileSync(path.join(SCRIPTS, f), 'utf8').split('\n').length < 600, `${f} stays under about 600 lines`);
  }
});

test('the page-driving scripts start no browser by themselves: only capture.mjs launch() (the shared policy) or, on request, the project launcher', () => {
  for (const f of ['states.mjs', 'canvas-frames.mjs', 'capture-session.mjs', 'canvas-pack.mjs']) {
    const text = fs.readFileSync(path.join(SCRIPTS, f), 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '');
    assert.doesNotMatch(text, /chromium\.launch|launchPersistent|channel\s*:|executablePath\s*:|'chrome'|"chrome"|msedge/, `${f} names no browser`);
  }
  assert.match(fs.readFileSync(path.join(SCRIPTS, 'capture-session.mjs'), 'utf8'), /from '\.\/capture\.mjs'/, 'the launcher is capture.mjs launch()');
});

// ---------------------------------------------------------------------------------------------------------------
// capture-cli.mjs

const SPEC = { name: { type: 'string' }, n: { type: 'int', min: 1, max: 9, default: 3 }, x: { type: 'number' }, flag: { type: 'boolean' }, on: { type: 'boolean', default: true }, pick: { type: 'list' }, help: { type: 'boolean', alias: 'h' } };

test('parseFlags: --k=v, --k v, repeated lists kept verbatim, --no-flag, defaults, -h, positionals', () => {
  const r = CLI.parseFlags(['url', '--name=a=b', '--n', '5', '--x=1.5', '--flag', '--no-on', '--pick', 'text=A, B', '--pick=div > a', 'second', '-h'], SPEC);
  assert.deepEqual(r.positionals, ['url', 'second']);
  assert.deepEqual(r.flags, { n: 5, on: false, name: 'a=b', x: 1.5, flag: true, pick: ['text=A, B', 'div > a'], help: true });
  assert.deepEqual(CLI.parseFlags([], SPEC).flags, { n: 3, on: true, pick: [] }, 'defaults, empty list');
});

test('parseFlags: unknown flags, missing values, a value that looks like a flag, bad numbers and ranges are usage errors', () => {
  const bad = (argv, re) => assert.throws(() => CLI.parseFlags(argv, SPEC), (e) => e instanceof CLI.UsageError && re.test(e.message), argv.join(' '));
  bad(['--nope'], /unknown flag --nope/);
  bad(['--name'], /--name needs a value/);
  bad(['--name', '--flag'], /--name needs a value/);
  bad(['--n', 'abc'], /whole number/);
  bad(['--n', '2.5'], /whole number/);
  bad(['--n', '0'], /at least 1/);
  bad(['--n', '10'], /at most 9/);
  bad(['--x', ''], /must be a number/);
  bad(['--flag=1'], /takes no value/);
});

test('resolveRoot and insideRoot: --root, nearest studio.json, current folder; output folders cannot leave the project', () => {
  const proj = tmp('ms-cli-');
  fs.writeFileSync(path.join(proj, 'studio.json'), '{}');
  fs.mkdirSync(path.join(proj, 'a', 'b'), { recursive: true });
  const bare = tmp('ms-cli-bare-');
  assert.equal(CLI.resolveRoot(undefined, path.join(proj, 'a', 'b')), proj);
  assert.equal(CLI.resolveRoot(undefined, bare), bare, 'skills-only: no studio.json, the current folder');
  assert.equal(CLI.resolveRoot(proj, bare), proj);
  assert.throws(() => CLI.resolveRoot(path.join(bare, 'missing'), bare), /is not a folder/);
  assert.equal(CLI.insideRoot(proj, 'assets/brand/states/x'), path.join(proj, 'assets', 'brand', 'states', 'x'));
  for (const bad of ['..', '../x', 'a/../../x', path.join(bare, 'y')]) assert.throws(() => CLI.insideRoot(proj, bad), /outside the project folder/, bad);
  const file = path.join(proj, 'out', 'f.json');
  CLI.writeFileAtomic(file, '{"a":1}\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['f.json'], 'no temp file is left behind');
});

// ---------------------------------------------------------------------------------------------------------------
// states.mjs arguments

test('parseStatesArgs: a URL, the old "<outDir> <url>" order, --viewport both, repeated --click/--crop, usage errors', () => {
  const a = S.parseStatesArgs(['https://x.example/', '--viewport=both', '--click=text=Pricing', '--click', 'button:has-text("Try")', '--crop=.hero, .cta']);
  assert.equal(a.url, 'https://x.example/');
  assert.deepEqual(a.viewports, ['desktop', 'mobile']);
  assert.deepEqual(a.flags.click, ['text=Pricing', 'button:has-text("Try")']);
  assert.deepEqual(a.flags.crop, ['.hero, .cta'], 'a selector with a comma stays one selector');
  assert.equal(a.flags['scroll-frames'], 6);
  assert.equal(a.flags['dismiss-banners'], true);
  const legacy = S.parseStatesArgs(['assets/brand/states/p', 'https://x.example/']);
  assert.equal(legacy.flags.out, 'assets/brand/states/p');
  assert.equal(legacy.url, 'https://x.example/');
  assert.throws(() => S.parseStatesArgs([]), /missing <url>/);
  assert.throws(() => S.parseStatesArgs(['a', 'b', 'c']), /exactly one <url>/);
  assert.throws(() => S.parseStatesArgs(['https://x.example/', '--viewport=huge']), /--viewport must be/);
  assert.equal(S.parseStatesArgs(['--help']).flags.help, true);
});

test('defaultName: the page host and path as a readable file-safe folder name', () => {
  assert.equal(S.defaultName('https://emulog.app/'), 'emulog-app');
  assert.equal(S.defaultName('https://shop.example/en/pricing?x=1'), 'shop-example-en-pricing');
  assert.equal(S.defaultName('http://127.0.0.1:8080/'), '127-0-0-1');
  assert.equal(S.defaultName('https://예시.kr/가격'), '예시-kr-가격');
});

test('parseHttpUrl: adds https://, refuses other schemes', () => {
  assert.equal(SESSION.parseHttpUrl('example.com/a'), 'https://example.com/a');
  assert.equal(SESSION.parseHttpUrl('http://127.0.0.1:3000/x'), 'http://127.0.0.1:3000/x');
  assert.throws(() => SESSION.parseHttpUrl('file:///etc/passwd'), /only http\(s\)/);
  assert.throws(() => SESSION.parseHttpUrl('  '), /missing <url>/);
  assert.throws(() => SESSION.parseHttpUrl('http://'), /not a valid URL/);
});

// ---------------------------------------------------------------------------------------------------------------
// The launcher: capture.mjs launch() by default (sandbox on), the project's launchBrowser only on request

function fakePlaywrightProject({ withProjectLauncher = false } = {}) {
  const root = tmp('ms-states-fakepw-');
  fs.writeFileSync(path.join(root, 'studio.json'), '{}');
  const pw = path.join(root, 'node_modules', 'playwright');
  fs.mkdirSync(pw, { recursive: true });
  fs.writeFileSync(path.join(pw, 'package.json'), '{"name":"playwright","version":"0.0.0","main":"index.js"}');
  fs.writeFileSync(path.join(pw, 'index.js'), `
globalThis.__msLaunches = globalThis.__msLaunches || [];
exports.chromium = { async launch(opts) {
  globalThis.__msLaunches.push(opts);
  return { version: () => 'fake', isConnected: () => true, close: async () => {}, newBrowserCDPSession: async () => ({ send: async () => ({ processInfo: [] }), detach: async () => {} }), async newContext() { return { close: async () => {} }; } };
} };`);
  if (withProjectLauncher) {
    fs.mkdirSync(path.join(root, 'tools'));
    fs.writeFileSync(path.join(root, 'tools', 'studio.mjs'), "export async function launchBrowser(root, cfg) { globalThis.__projectLauncherCalls = (globalThis.__projectLauncherCalls || []).concat([{ root, cfg }]); return { browser: { fake: true }, via: 'project-fake' }; }\n");
  }
  return root;
}

test('openBrowser: the built-in launcher keeps the sandbox on and never calls the project launcher; --project-launcher does, with a note that the sandbox is off', async () => {
  const root = fakePlaywrightProject({ withProjectLauncher: true });
  const lines = [];
  try {
    await withEnv({ MOTION_CHROME_PATH: '', MOTION_BROWSER: undefined, MOTION_NO_SANDBOX: undefined }, async () => {
      globalThis.__msLaunches = [];
      globalThis.__projectLauncherCalls = [];
      const own = await SESSION.openBrowser(root, { log: (l) => lines.push(l) });
      assert.deepEqual([own.launcher, own.sandbox], ['capture', !C.sandboxDecision().off]);
      assert.equal(globalThis.__msLaunches.length, 1);
      assert.equal(globalThis.__msLaunches[0].chromiumSandbox, !C.sandboxDecision().off, 'Playwright is told to keep the sandbox');
      assert.deepEqual(globalThis.__projectLauncherCalls, [], 'the project launcher (sandbox off) was not used');

      const proj = await SESSION.openBrowser(root, { projectLauncher: true, log: (l) => lines.push(l) });
      assert.deepEqual([proj.launcher, proj.via, proj.sandbox], ['project', 'project-fake', false]);
      assert.equal(globalThis.__projectLauncherCalls.length, 1);
      assert.equal(globalThis.__projectLauncherCalls[0].root, root);
      assert.ok(lines.some((l) => /renderer sandbox is OFF/.test(l)), lines.join('\n'));
    });
  } finally { rmTree(root); delete globalThis.__msLaunches; delete globalThis.__projectLauncherCalls; }
  const bare = fakePlaywrightProject();
  try { await assert.rejects(() => SESSION.openBrowser(bare, { projectLauncher: true }), (e) => e instanceof CLI.UsageError && /needs the project's tools\/studio\.mjs/.test(e.message)); } finally { rmTree(bare); }
});

test('states.mjs through the shared browser policy: on Windows "auto" asks only for the bundled browser (a stub playwright refuses to start any)', async () => {
  const root = fakePlaywrightProject();
  const record = path.join(root, 'launches.jsonl');
  fs.writeFileSync(path.join(root, 'node_modules', 'playwright', 'index.js'), `
const fs = require('node:fs');
exports.chromium = { async launch(opts) { fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ channel: opts.channel ?? null, executablePath: opts.executablePath ?? null }) + '\\n'); throw new Error('stub: refusing to start a browser'); } };
`);
  try {
    const env = { MOTION_CHROME_PATH: '', MOTION_BROWSER: '', MOTION_SYSTEM_BROWSER_MAX: '', MOTION_ALLOW_LOCKOUT_RISK: '', MOTION_LAUNCH_LOG: path.join(root, 'launches-log.json') };
    const r = await runNode([path.join(SCRIPTS, 'states.mjs'), 'http://127.0.0.1:9/', '--root', root], root, env);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /could not launch a browser/);
    const launches = fs.readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    if (process.platform === 'win32') {
      assert.deepEqual(launches, [{ channel: null, executablePath: null }], 'the bundled headless shell only, never an installed Chrome/Edge');
      assert.match(r.err, /npx playwright install chromium-headless-shell/);
    } else assert.deepEqual(launches.map((l) => l.channel), ['chrome', 'msedge', null]);
    const bad = await runNode([path.join(SCRIPTS, 'states.mjs'), 'http://127.0.0.1:9/', '--root', root], root, { ...env, MOTION_BROWSER: 'firefox' });
    assert.equal(bad.code, 2, 'a wrong MOTION_BROWSER is a usage error before any launch');
    assert.match(bad.err, /MOTION_BROWSER=firefox is not valid/);
    assert.equal(fs.readFileSync(record, 'utf8').trim().split('\n').length, launches.length, 'no further launch');
  } finally { rmTree(root); }
});

test('states.mjs command line: --help, a missing URL and an output folder outside the project are usage errors (no browser)', async () => {
  const root = tmp('ms-states-cli-');
  const help = await runNode([path.join(SCRIPTS, 'states.mjs'), '--help'], root);
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /Usage: node states\.mjs <url>/);
  assert.match(help.out, /--click/);
  const none = await runNode([path.join(SCRIPTS, 'states.mjs')], root);
  assert.equal(none.code, 2);
  assert.match(none.err, /states: missing <url>/);
  const outside = await runNode([path.join(SCRIPTS, 'states.mjs'), 'http://127.0.0.1:9/', '--out', '../elsewhere'], root);
  assert.equal(outside.code, 2, outside.err);
  assert.match(outside.err, /outside the project folder/);
});

// ---------------------------------------------------------------------------------------------------------------
// In Chrome

test('states.mjs in Chrome: every state, Korean crops, consent click, scroll frames, private addresses refused, credentials kept out of every file', { timeout: 300000 }, async (t) => {
  const root = browserProject();
  if (!root) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  const want = `Basic ${Buffer.from('admin:hunter2').toString('base64')}`;
  const internalHits = [];
  const hits = [];
  const internal = await listen((req, res) => { internalHits.push(req.url); res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); });
  const site = await startSite({ internalPort: internal.address().port, auth: want, hits });
  try {
    const port = site.address().port;
    const url = `http://admin:hunter2@127.0.0.1:${port}/?token=abc123`;
    const r = await runNode([path.join(SCRIPTS, 'states.mjs'), url, '--root', root, '--name', 'probe', '--viewport', 'both', '--settle', '0.3',
      '--crop=text=구동 보고', '--crop=text=인사이트', '--click=text=인사이트', '--click', '#mode', '--click=text=not on this page'], root);
    if (noBrowser(r)) { t.skip(`no browser: ${r.err.split('\n')[0]}`); return; }
    assert.equal(r.code, 0, `${r.err}\n${r.out}`);
    const summary = JSON.parse(r.out.trim().split('\n').pop());
    const dir = 'assets/brand/states/probe';
    const states = JSON.parse(fs.readFileSync(path.join(root, dir, 'states.json'), 'utf8'));
    assert.equal(summary.ok, true);
    assert.equal(summary.states, `${dir}/states.json`);
    assert.equal(states.ok, true);
    assert.deepEqual(states.viewports, ['desktop', 'mobile']);

    // states: first view, scroll frames (the window scrolls), clicks in order, crops in order with computed styles
    const names = states.shots.map((s) => path.basename(s.file));
    assert.ok(names.includes('desktop-00-first.png') && names.includes('mobile-00-first.png'), names.join(', '));
    assert.ok(names.includes('desktop-scroll-01.png') && names.includes('desktop-scroll-02.png'), `scroll frames: ${names.join(', ')}`);
    assert.ok(names.includes('mobile-full.png'), 'a scrolling mobile page also gets a full-page shot');
    assert.ok(names.includes('desktop-10-click-text-인사이트.png') && names.includes('desktop-11-click-mode.png'), names.join(', '));
    assert.ok(states.notes.some((n) => /desktop: click text=not on this page: not visible/.test(n)), 'a selector that is not on the page is a note, not a crash');
    const crops = states.crops.filter((c) => c.viewport === 'desktop');
    assert.deepEqual(crops.map((c) => path.basename(c.file)), ['desktop-crop-20-text-구동-보고.png', 'desktop-crop-21-text-인사이트.png']);
    assert.equal(new Set(states.crops.map((c) => c.file)).size, states.crops.length, 'no file is listed twice');
    assert.equal(crops[0].style.text, '구동 보고');
    assert.equal(crops[0].style.bg, 'rgb(34, 34, 51)');
    assert.match(crops[0].style.font, /^400 16px /);
    assert.equal(crops[0].style.box.length, 4);
    for (const f of [...states.shots, ...states.crops]) {
      const buf = fs.readFileSync(path.join(root, f.file));
      assert.ok(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), f.file);
      assert.ok(f.width > 0 && f.height > 0, `${f.file} size recorded`);
    }
    assert.notEqual(fs.readFileSync(path.join(root, crops[0].file)).length, fs.readFileSync(path.join(root, crops[1].file)).length, 'different pixels, not one overwritten file');
    const afterClick = states.shots.find((s) => /11-click-mode/.test(s.file));
    assert.ok(afterClick, 'the #mode click was captured');

    // consent: the Korean button is clicked on desktop (the page then asks /agreed); mobile has no banner and says so
    assert.ok(states.notes.includes('desktop: clicked cookie banner button "모두 허용"'), states.notes.join('\n'));
    assert.ok(hits.some((h) => h.url === '/agreed' && h.auth === want));
    assert.ok(states.notes.some((n) => /^mobile: dismiss-banners: no banner matched \(\d+ visible buttons and links checked/.test(n)), states.notes.join('\n'));
    assert.ok(names.includes('desktop-01-escape.png'), 'the banner click changed the pixels, so 01-escape is kept');

    // network policy: the internal server was never reached, the refusals are listed
    assert.deepEqual(internalHits, [], `the internal server was reached: ${internalHits.join(', ')}`);
    assert.ok(states.blocked.some((b) => /\/pixel\.png/.test(b.url)) && summary.blocked >= 1, JSON.stringify(states.blocked));
    assert.ok(states.notes.some((n) => /^blocked \d+ request\(s\) to private, local or non-web addresses/.test(n)));
    // A full Chrome sends <link rel=prerender> and the browser-wide filter blocks it; the headless shell never sends it.
    const prerenders = states.via !== 'chromium-headless-shell';
    for (const re of [...(prerenders ? [/\/prerender-link/] : []), /\/from-shared/, /ws:\/\/127\.0\.0\.1:\d+\/ws/]) assert.ok(states.blocked.some((b) => re.test(b.url)), `${re} in ${JSON.stringify(states.blocked)}`);
    assert.ok(states.notes.some((n) => /the page declares speculation rules\. Chrome fetches those URLs itself/.test(n)), states.notes.join('\n'));

    // credentials: moved to httpCredentials, the token shown as ***, nothing secret in any file or output
    assert.equal(states.url, `http://127.0.0.1:${port}/?token=***`);
    for (const secret of ['hunter2', 'abc123']) {
      assert.ok(!r.out.includes(secret) && !r.err.includes(secret) && !JSON.stringify(states).includes(secret), `${secret} leaked`);
    }
    assert.ok(hits.some((h) => h.url === '/?token=abc123' && h.auth === want), 'the real URL was navigated, with the credentials after the 401');

    // browser: the sandbox is on unless the platform forces it off; on Windows the bundled headless shell, never an installed Chrome/Edge
    assert.equal(states.sandbox, !C.sandboxDecision().off);
    assert.equal(states.launcher, 'capture');
    if (process.platform === 'win32' && !process.env.MOTION_CHROME_PATH && !process.env.MOTION_BROWSER) assert.equal(states.via, 'chromium-headless-shell');
  } finally {
    await closeServer(site);
    await closeServer(internal);
    rmTree(root);
  }
});
