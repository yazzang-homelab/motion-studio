#!/usr/bin/env node
// Environment check for a film project: Node, Playwright, a launchable browser, ffmpeg (+ the filters the tools
// use), Python/librosa (optional), studio.json, bundled fonts, .env keys (present/absent only, never values).
// Prints a table and the exact fix command for this OS. Every slow check has its own budget (TIMEOUTS) and the
// independent ones run concurrently, so the table (or --json line) always arrives: a check that has not answered
// in time is reported as 'timeout' instead of being waited for.
//
//   node tools/doctor.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { findProjectRoot, loadConfig, parseArgs, usage, main, UsageError, importPlaywright, launchBrowser, run, loadEnv,
  readJSON, isMainModule, TOOLS_DIR } from './studio.mjs';
import { LAUNCH_WINDOW_MS, launchGuard } from './studio-web.mjs';

const OS = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
// Every filter a tool builds a graph with (mix.mjs pads/trims the stems to the exact film length with apad + atrim).
export const FILTERS = Object.freeze(['loudnorm', 'ebur128', 'alimiter', 'sidechaincompress', 'amix', 'tmix', 'scale', 'apad', 'atrim']);
const KEYS = ['ELEVENLABS_API_KEY', 'FAL_KEY'];
/** Budget per check in ms: Playwright import, browser launch (all fallbacks), each ffmpeg probe, Python + librosa. */
export const TIMEOUTS = Object.freeze({ playwright: 30000, browser: 60000, ffmpeg: 20000, python: 60000 });
const EXIT_GRACE_MS = 5000; // after the output: time for a launched browser to close before the process exits

// Fix commands per check and OS. `npm` works everywhere; the rest is what each OS ships.
const FIX = {
  node: { win32: 'winget install OpenJS.NodeJS.LTS', darwin: 'brew install node@22', linux: 'curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22' },
  project: { all: 'node "<plugin>/skills/studio-init/scripts/init.mjs" <dir>   (or /motion-studio:studio-init)' },
  config: { all: 'fix the listed keys in studio.json (defaults: tools/studio.mjs DEFAULTS)' },
  playwright: { all: 'npm install   (installs playwright from package.json)' },
  // Windows: the bundled headless shell first; an installed Chrome/Edge counts a failed logon per launch there (BROWSER_RISK).
  browser: {
    win32: 'npx playwright install chromium-headless-shell   (about 115 MB; or set MOTION_CHROME_PATH to a Chromium browser; the installed Chrome is opt-in: studio.json "browser": "chrome" or MOTION_BROWSER=chrome, guarded)',
    darwin: 'brew install --cask google-chrome   (or: npx playwright install chromium-headless-shell, or set MOTION_CHROME_PATH)',
    linux: 'npx playwright install --with-deps chromium-headless-shell   (or install google-chrome-stable, or set MOTION_CHROME_PATH)',
  },
  ffmpeg: {
    win32: 'npm install ffmpeg-static   (or: winget install Gyan.FFmpeg, or set FFMPEG_PATH=C:\\path\\to\\ffmpeg.exe)',
    darwin: 'npm install ffmpeg-static   (or: brew install ffmpeg, or set FFMPEG_PATH)',
    linux: 'npm install ffmpeg-static   (or: sudo apt-get install -y ffmpeg, or set FFMPEG_PATH)',
  },
  filters: { all: 'use a full ffmpeg build (ffmpeg-static, or your OS package), or point FFMPEG_PATH at one' },
  python: {
    win32: 'py -3 -m venv .venv && .venv\\Scripts\\python -m pip install librosa   (optional: beats.mjs falls back to its JS engine)',
    darwin: 'python3 -m venv .venv && .venv/bin/pip install librosa   (optional: beats.mjs falls back to its JS engine)',
    linux: 'python3 -m venv .venv && .venv/bin/pip install librosa   (optional: beats.mjs falls back to its JS engine)',
  },
  fonts: { all: 'node tools/fonts.mjs add "Family:400,700"   (or restore assets/fonts/ from the template)' },
  keys: { all: 'add the key to .env (see .env.example); never paste keys into chat or code' },
  routeB: { win32: 'winget install OpenJS.NodeJS.LTS   (route B needs Node 22+)', darwin: 'brew install node@22', linux: 'fnm install 22' },
};
const fixFor = (id) => (FIX[id]?.[OS] ?? FIX[id]?.all ?? '');
// Why an installed Chrome/Edge on Windows is a warning and not an ok (the browser policy lives in tools/studio-web.mjs).
const BROWSER_RISK = 'installed Chrome/Edge on Windows: every launch with a fresh profile makes Chrome test the account for a blank password, ' +
  'which counts as a failed logon and can lock the account after the policy limit (measured: one failed logon per launch)';
// Checks whose failure (or timeout) means the tools cannot run; the others are advice.
const REQUIRED = new Set(['node', 'project', 'config', 'playwright', 'browser', 'ffmpeg', 'filters', 'fonts']);
const LABELS = {
  node: 'Node.js >= 20', routeB: 'Node >= 22 (route B)', project: 'film project', config: 'studio.json', playwright: 'Playwright',
  browser: 'browser (headless)', 'windows-logon-guard': 'Windows logon guard', ffmpeg: 'ffmpeg', filters: 'ffmpeg filters', python: 'Python + librosa (optional)',
  fonts: 'bundled fonts', keys: '.env keys (optional)',
};
const ORDER = Object.keys(LABELS);

const TIMED_OUT = Symbol('timeout');
/**
 * Run task() against its own budget: resolves its value, or TIMED_OUT after `ms` (the task keeps running; a late
 * value goes to onLate, e.g. to close a browser that launched after all). Rejections propagate.
 */
export async function withTimeout(task, ms, { onLate } = {}) {
  let timer;
  let late = false;
  const p = Promise.resolve().then(task);
  p.then((v) => { if (late) onLate?.(v); }, () => {});
  const r = await Promise.race([p, new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); })]).finally(() => clearTimeout(timer));
  if (r === TIMED_OUT) late = true;
  return r;
}
withTimeout.TIMED_OUT = TIMED_OUT;

// resolvePython / resolveFfmpeg probe candidates with spawnSync (15–20 s each when a candidate hangs). A worker runs
// them so the event loop stays free for the other checks and their timers; a timed-out worker is terminated.
function inWorker(fn, root) {
  const code = `const { parentPort, workerData: w } = require('node:worker_threads');
import(w.url).then((m) => m[w.fn](w.root)).then((v) => parentPort.postMessage({ v }), (e) => parentPort.postMessage({ e: String((e && e.message) || e) }));`;
  const worker = new Worker(code, { eval: true, workerData: { url: pathToFileURL(path.join(TOOLS_DIR, 'studio.mjs')).href, fn, root } });
  const promise = new Promise((resolve, reject) => {
    worker.once('message', (m) => (m.e != null ? reject(new Error(m.e)) : resolve(m.v)));
    worker.once('error', reject);
    worker.once('exit', (c) => reject(new Error(`${fn} worker exited with ${c}`)));
  }).finally(() => worker.terminate().catch(() => {}));
  return { promise, stop: () => { worker.unref(); worker.terminate().catch(() => {}); } };
}

/** The slow probes, injectable for tests. Each returns a promise; the budgets are applied by checks(). */
export const PROBES = {
  playwright: async (base) => {
    await importPlaywright(base);
    try { return createRequire(path.join(base, 'package.json'))('playwright/package.json').version; } catch { return '?'; } // playwright-core only
  },
  browser: (base, cfg) => launchBrowser(base, cfg),
  logonGuard: () => launchGuard(),
  resolve: (fn, base) => { const w = inWorker(fn, base); return Object.assign(w.promise, { stop: w.stop }); },
  run,
};

const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

/**
 * All checks, in table order: [{ id, label, status: ok|fail|warn|info|timeout, detail, fix, required }].
 * `cleanups` collects background work the CLI lets finish before exiting (a launched browser closing).
 */
export async function checks(root, { timeouts = TIMEOUTS, probes = PROBES, cleanups = [] } = {}) {
  const T = { ...TIMEOUTS, ...timeouts };
  const P = { ...PROBES, ...probes };
  const rows = new Map();
  const add = (id, status, detail, fix = status === 'ok' || status === 'info' ? '' : fixFor(id)) => {
    if (!rows.has(id)) rows.set(id, { id, label: LABELS[id], status, detail, fix, required: REQUIRED.has(id) });
  };
  const late = (id, ms, what) => add(id, 'timeout', `${what} gave no answer within ${Math.round(ms / 1000)} s`,
    `re-run npm run doctor when the machine is less busy; if it keeps timing out: ${fixFor(id)}`);

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 20 ? 'ok' : 'fail', `v${process.versions.node}`);
  add('routeB', major >= 22 ? 'ok' : 'info', major >= 22 ? 'HyperFrames / Remotion / skills CLI can run' : `v${process.versions.node}: route A works; HyperFrames and the skills CLI need Node 22+`, major >= 22 ? '' : fixFor('routeB'));
  let cfg = null;
  if (!root) add('project', 'fail', `no studio.json in ${process.cwd()} or above`);
  else {
    add('project', 'ok', root);
    try { cfg = loadConfig(root); add('config', 'ok', `${cfg.title} · ${cfg.duration} s · ${cfg.fps} fps · ${cfg.formats.join(' ')}`); } catch (err) { add('config', 'fail', String(err.message).replace(/\s+/g, ' ').slice(0, 300)); }
  }
  const base = root ?? process.cwd();

  // Three independent chains run concurrently: Playwright → browser, ffmpeg → version + filters, Python → librosa.
  const browserChain = async () => {
    let version;
    try { version = await withTimeout(() => P.playwright(base), T.playwright); } catch (err) { add('playwright', 'fail', firstLine(err)); add('browser', 'fail', 'needs Playwright first', fixFor('playwright')); return; }
    if (version === TIMED_OUT) { late('playwright', T.playwright, 'loading Playwright'); add('browser', 'timeout', 'not tried: Playwright did not load', fixFor('playwright')); return; }
    add('playwright', 'ok', `playwright ${version}`);
    try {
      const b = await withTimeout(() => P.browser(base, cfg ?? {}), T.browser, { onLate: (x) => x?.browser?.close?.().catch(() => {}) });
      if (b === TIMED_OUT) return late('browser', T.browser, 'launching headless Chrome/Edge/Chromium');
      cleanups.push(Promise.resolve().then(() => b.browser.close()).catch(() => {})); // closing can take seconds; not part of the check
      const detail = `${b.via} ${b.version}${process.env.MOTION_CHROME_PATH ? ' (MOTION_CHROME_PATH)' : ''}`;
      // launchBrowser reports the risk itself; a probe that only names the browser (via chrome | msedge) counts as installed too.
      const risky = b.risk !== undefined ? b.risk !== null : OS === 'win32' && (b.via === 'chrome' || b.via === 'msedge');
      if (risky) add('browser', 'warn', `${detail}: ${BROWSER_RISK}`, fixFor('browser'));
      else add('browser', 'ok', detail);
    } catch (err) { add('browser', 'fail', String(err.message).split('\n').slice(0, 3).join(' ').slice(0, 300)); }
  };

  const ffmpegChain = async () => {
    let ff;
    const res = P.resolve('resolveFfmpeg', base);
    try { ff = await withTimeout(() => res, T.ffmpeg); } catch (err) { add('ffmpeg', 'fail', firstLine(err)); add('filters', 'fail', 'needs ffmpeg first', fixFor('ffmpeg')); return; }
    if (ff === TIMED_OUT) { res.stop?.(); late('ffmpeg', T.ffmpeg, 'looking for ffmpeg'); add('filters', 'timeout', 'not checked: no ffmpeg yet'); return; }
    const [ver, fil] = await Promise.all([P.run(ff, ['-hide_banner', '-version'], { timeoutMs: T.ffmpeg }), P.run(ff, ['-hide_banner', '-filters'], { timeoutMs: T.ffmpeg })]);
    const via = process.env.FFMPEG_PATH || process.env.FFMPEG ? 'FFMPEG_PATH' : /ffmpeg-static/.test(ff) ? 'ffmpeg-static' : ff === 'ffmpeg' ? 'PATH' : 'resolved';
    if (ver.timedOut) late('ffmpeg', T.ffmpeg, `${ff} -version`);
    else if (ver.code !== 0) add('ffmpeg', 'fail', `${ff} does not run: ${String(ver.stderr).split('\n')[0]}`);
    else {
      const line = (String(ver.stdout).split(/\r?\n/)[0] || '').replace(/^ffmpeg version\s*/, '');
      const gpl = /--enable-gpl/.test(ver.stdout);
      add('ffmpeg', 'ok', `${line.split(' ')[0]} (${via}: ${ff})${gpl ? ' · GPL build: fine for rendering; mind the GPL if you redistribute the binary' : ''}`);
    }
    if (fil.timedOut) return late('filters', T.ffmpeg, `${ff} -filters`);
    if (fil.code !== 0) return add('filters', 'fail', `${ff} -filters failed: ${String(fil.stderr).split('\n')[0]}`);
    const have = new Set([...String(fil.stdout).matchAll(/^\s*[TSC.|]{2,3}\s+(\w+)\s/gm)].map((m) => m[1]));
    const missing = FILTERS.filter((f) => !have.has(f));
    add('filters', missing.length ? 'fail' : 'ok', missing.length ? `missing: ${missing.join(', ')}` : FILTERS.join(' '));
  };

  const pythonChain = async () => {
    const t0 = Date.now();
    const res = P.resolve('resolvePython', base);
    let py;
    try { py = await withTimeout(() => res, T.python); } catch (err) {
      // A broken MOTION_PYTHON pin is never replaced by another Python (a wrong librosa would give different beats). beats.mjs
      // --engine auto logs it and uses the JS engine (checked in beats.mjs librosaStatus); --engine librosa stops with the reason.
      const pinned = /^MOTION_PYTHON=/.test(firstLine(err));
      return add('python', 'warn', `${pinned ? '' : 'no usable Python: '}${firstLine(err)}; beats.mjs --engine auto (default) uses its JS engine, --engine librosa stops`,
        pinned ? 'point MOTION_PYTHON at a working Python that has librosa, or unset it (beats.mjs then finds .venv / python3 / python)' : fixFor('python'));
    }
    if (py === TIMED_OUT) { res.stop?.(); return late('python', T.python, 'looking for Python'); }
    if (!py) return add('python', 'warn', 'no Python found; beats.mjs uses its JS engine');
    const r = await P.run(py, ['-c', 'import sys, librosa; sys.stdout.write(sys.version.split()[0] + " librosa " + librosa.__version__)'], { timeoutMs: Math.max(1000, T.python - (Date.now() - t0)) });
    if (r.timedOut) late('python', T.python, `${py}: import librosa`);
    else if (r.code === 0) add('python', 'ok', `${String(r.stdout).trim()} (${py})`);
    else add('python', 'warn', `${py}: librosa not importable; beats.mjs uses its JS engine`);
  };

  const guard = (fn, ids) => fn().catch((err) => { for (const id of ids) add(id, 'fail', `doctor error: ${firstLine(err)}`); });
  const slow = Promise.all([guard(browserChain, ['playwright', 'browser']), guard(ffmpegChain, ['ffmpeg', 'filters']), guard(pythonChain, ['python'])]);

  if (root) { // fast, synchronous checks while the slow ones run
    const list = readJSON(path.join(root, 'assets', 'fonts', 'fonts.json'), []);
    const items = [...(Array.isArray(list) ? list : list.fonts ?? []), ...(cfg?.fonts ?? [])];
    const srcOf = (f) => (typeof f?.src === 'string' ? f.src : '');
    // A drive, UNC share or `..` src leaves the project: it is never a bundled font (and `fonts remove` will not delete it).
    const outside = items.filter((f) => /^(?:[a-z]:|[\\/]{2})|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(srcOf(f)));
    const missing = items.filter((f) => !outside.includes(f) && (!srcOf(f) || !fs.existsSync(path.join(root, f.src))));
    const lic = [...new Set(items.map((f) => f?.licenseFile).filter((p) => typeof p === 'string' && p))].filter((p) => !fs.existsSync(path.join(root, p)));
    const families = new Set(items.map((f) => f?.family));
    const brand = Object.entries(cfg?.brand?.fonts ?? {}).filter(([, fam]) => fam && !families.has(fam));
    const problems = [
      ...outside.map((f) => `${f.src} is outside the project: keep fonts under assets/fonts/`), ...missing.map((f) => `missing ${srcOf(f) || '(no src)'}`), ...lic.map((p) => `missing license ${p}`),
      ...brand.map(([role, fam]) => `brand.fonts.${role} "${fam}" is not bundled (loadFonts would fail)`),
    ];
    add('fonts', !items.length || problems.length ? 'fail' : 'ok', items.length ? (problems.length ? problems.slice(0, 4).join('; ') : `${families.size} families, ${items.length} files: ${[...families].join(', ')}`) : 'assets/fonts/fonts.json lists no fonts');
    const env = loadEnv(root);
    const state = KEYS.map((k) => `${k} ${env[k] || process.env[k] ? 'PRESENT' : 'absent'}`);
    add('keys', 'info', `${state.join(' · ')}${fs.existsSync(path.join(root, '.env')) ? '' : ' (no .env file)'}`, KEYS.some((k) => !(env[k] || process.env[k])) ? fixFor('keys') : '');
  }
  await slow;
  if (OS === 'win32') { // informational: what the launch guard has counted (this run's own launch included when it was an installed browser)
    try {
      const g = await P.logonGuard();
      const next = !g.blocked ? '' : g.override ? '; the next one is over the limit but allowed (MOTION_ALLOW_LOCKOUT_RISK)' : `; the next one is refused for ${Math.ceil(g.waitMs / 1000)} s`;
      add('windows-logon-guard', 'info', `${g.count} installed-browser launch(es) logged in the last ${LAUNCH_WINDOW_MS / 60000} min (limit ${g.max})${next} · ${g.file}`);
    } catch (err) { add('windows-logon-guard', 'info', `launch log unreadable: ${firstLine(err)}`); }
  }
  return ORDER.filter((id) => rows.has(id)).map((id) => rows.get(id));
}

/** Failed = any 'fail', or a required check that timed out. */
export const failedChecks = (list) => list.filter((c) => c.status === 'fail' || (c.status === 'timeout' && c.required));

const SPEC = { json: { type: 'boolean', desc: 'Print one JSON result line on stdout' } };
const TITLE = 'Usage: node tools/doctor.mjs [--json]\n\nChecks Node, Playwright, the browser (Windows: the bundled headless shell; an installed Chrome/Edge only warns), ffmpeg and its filters, Python/librosa, studio.json, fonts and .env keys.\n' +
  `Budgets: browser ${TIMEOUTS.browser / 1000} s, each ffmpeg probe ${TIMEOUTS.ffmpeg / 1000} s, Python + librosa ${TIMEOUTS.python / 1000} s (then 'timeout').\nExit 1 when a required check fails or times out.`;

function render(list, root) {
  const failed = failedChecks(list);
  const w = Math.max(...list.map((c) => c.label.length));
  const lines = [`motion-studio doctor · ${OS} · ${root ?? 'no project'}`, ''];
  for (const c of list) lines.push(`${c.status.toUpperCase().padEnd(7)} ${c.label.padEnd(w)}  ${c.detail}`);
  const fixes = list.filter((c) => c.fix);
  if (fixes.length) {
    lines.push('', 'Fix:');
    for (const c of fixes) lines.push(`  ${c.label}: ${c.fix}`);
  }
  lines.push('', failed.length ? `${failed.length} required check(s) failed or timed out.` : 'All required checks passed. Next: npm run preview (live preview) or npm run critique.');
  return lines.join('\n') + '\n';
}

async function cli(argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  if (flags.help) { process.stdout.write(usage(TITLE, SPEC)); return 0; }
  if (positionals.length) throw new UsageError(`unexpected argument ${positionals[0]}`, usage(TITLE, SPEC));
  const root = findProjectRoot();
  const cleanups = [];
  const list = await checks(root, { cleanups });
  const code = failedChecks(list).length ? 1 : 0;
  const text = flags.json ? JSON.stringify({ ok: code === 0, os: OS, root, timeouts: TIMEOUTS, checks: list }) + '\n' : render(list, root);
  await new Promise((resolve) => process.stdout.write(text, resolve));
  // A browser still closing, or a probe that timed out, must not hold the answered CLI open.
  await withTimeout(() => Promise.allSettled(cleanups), EXIT_GRACE_MS);
  process.exit(code);
}

if (isMainModule(import.meta.url)) main(() => cli(process.argv.slice(2)));
