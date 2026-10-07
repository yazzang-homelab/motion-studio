#!/usr/bin/env node
// Brand-asset capture for product reels: real screenshots, logo candidates, element crops, palette,
// fonts and copy from a product URL, written into a film project's assets/ with a manifest.
// Runs the film project's own Playwright, so nothing is installed into the plugin. The page is only read, never
// modified, except for an optional cookie-banner click in a throwaway browser context.
// The page is untrusted: Chrome keeps its renderer sandbox on (--no-sandbox / MOTION_NO_SANDBOX=1, or root on Linux, turn
// it off with a printed note), requests to loopback, LAN, link-local and non-web addresses are refused unless they go to
// the target's own host or --allow-private is given (capture-guard.mjs), and credentials or secret-looking query values in
// the URL never reach a log, manifest.json or studio.json.
// The web fonts the page actually loads are downloaded into assets/fonts/ and registered in fonts.json; their licenses
// stay UNVERIFIED in the manifest unless a license URL or file turns up, so the user must check them before publishing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { extractInPage } from './capture-page.mjs';
import { collectFonts, readFontsJson, registerFonts } from './capture-fonts.mjs';
import { createGuard, parseTarget, redactDeep, redactText, redactUrl } from './capture-guard.mjs';
import { bannerNote, dismissBanner } from './capture-banner.mjs';
import { brandReport, registryLines } from './capture-registry.mjs';
import { buildPalette, hex } from './capture-palette.mjs';
import { parseDataUrl, sniffImage } from './capture-image.mjs';

// Re-exported: these used to live in this file and the tests and other scripts import them from here.
export { buildPalette, parseDataUrl, sniffImage };

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  tablet: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};
const MAX_DOWNLOAD = 5 * 1024 * 1024;

const SPEC = {
  root: { type: 'string', desc: 'film project root (default: nearest folder with studio.json)' },
  out: { type: 'string', default: 'assets', desc: 'assets folder inside the project' },
  viewports: { type: 'list', default: ['desktop', 'mobile'], desc: 'desktop, tablet, mobile' },
  'full-page': { type: 'boolean', desc: 'also save full-page screenshots' },
  selector: { type: 'list', desc: 'extra CSS selectors to crop as components (repeatable)' },
  'max-components': { type: 'number', default: 12, desc: 'cap on automatic component crops' },
  'dismiss-banners': { type: 'boolean', desc: 'click an obvious cookie/consent button (English, Korean, Japanese, Chinese, German, French, Spanish) before capturing; a note says when none matched' },
  dark: { type: 'boolean', desc: 'emulate prefers-color-scheme: dark' },
  settle: { type: 'number', default: 0.8, desc: 'seconds to wait after load for animations to settle' },
  timeout: { type: 'number', default: 45, desc: 'navigation timeout in seconds' },
  fonts: { type: 'boolean', default: true, desc: 'download the web fonts the page loads into assets/fonts/ and register them (license UNVERIFIED unless found; --no-fonts skips)' },
  'apply-brand': { type: 'boolean', desc: 'write name, url (credentials and secret query values removed) and suggested colors into studio.json brand' },
  'allow-private': { type: 'boolean', desc: 'let the page reach loopback, LAN and link-local addresses (default: only the target host itself; use for pages you trust)' },
  'no-sandbox': { type: 'boolean', desc: "start Chrome without its renderer sandbox (also MOTION_NO_SANDBOX=1, and automatic as root on Linux); only for pages you trust" },
  json: { type: 'boolean', desc: 'print one JSON result line on stdout' },
  help: { type: 'boolean', alias: 'h', desc: 'show this help' },
};

class UsageError extends Error {}
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

function usage() {
  const rows = Object.entries(SPEC).map(([k, s]) => {
    const flag = `--${k}${s.type === 'boolean' ? '' : ` <${s.type}>`}${s.alias ? `, -${s.alias}` : ''}`;
    const def = s.default !== undefined ? ` (default ${Array.isArray(s.default) ? s.default.join(',') : s.default})` : '';
    return `  ${flag.padEnd(28)} ${s.desc}${def}`;
  });
  return ['Usage: node capture.mjs <url> [options]', '',
    'Captures screenshots, logo candidates, component crops, palette, fonts and copy from <url>',
    'into <project>/assets/brand/ and writes <project>/assets/manifest.json. The web fonts the page loads go to',
    '<project>/assets/fonts/ and fonts.json (license UNVERIFIED unless found: check it before publishing).', '', ...rows].join('\n');
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (const [k, s] of Object.entries(SPEC)) if (s.default !== undefined) flags[k] = Array.isArray(s.default) ? [...s.default] : s.default;
  const listSeen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { flags.help = true; continue; }
    if (!a.startsWith('--') || a === '--') { if (a !== '--') positionals.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s, 2);
    if (k.startsWith('no-') && SPEC[k.slice(3)]?.type === 'boolean') { flags[k.slice(3)] = false; continue; }
    const s = SPEC[k];
    if (!s) throw new UsageError(`unknown flag --${k}`);
    if (s.type === 'boolean') { if (v !== undefined) throw new UsageError(`--${k} takes no value`); flags[k] = true; continue; }
    if (v === undefined) { v = argv[++i]; if (v === undefined) throw new UsageError(`--${k} needs a value`); }
    if (s.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${k} must be a non-negative number`);
      flags[k] = n;
    } else if (s.type === 'list') {
      // The first explicit use replaces the default; later uses append.
      if (!listSeen.has(k)) { flags[k] = []; listSeen.add(k); }
      flags[k].push(...(k === 'selector' ? [v] : v.split(',').map((x) => x.trim()).filter(Boolean)));
    } else flags[k] = v;
  }
  return { flags, positionals };
}

function findProjectRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'studio.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new UsageError('missing <url>');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new UsageError(`not a valid URL: ${input}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UsageError(`only http(s) URLs are supported, got ${u.protocol}`);
  return u.href;
}

// Bounded closes for the built-in launcher below, the same design as boundClose/boundContexts in the template's
// tools/studio-web.mjs (this script also runs in a project that has no tools/). Chrome's shutdown on Windows sometimes takes
// 15-20 s, and a wedged renderer can hold a context.close() forever.

/** Longest wait for one browser/context close (env MOTION_CLOSE_TIMEOUT_MS, default 8 s). */
export const closeTimeoutMs = () => Number(process.env.MOTION_CLOSE_TIMEOUT_MS) || 8000;

/** The value of `promise`, or `fallback` when it rejects or takes longer than `ms`. Never rejects. */
function within(promise, ms, fallback) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, ms, fallback); });
  return Promise.race([Promise.resolve(promise).catch(() => fallback), late]).finally(() => clearTimeout(timer));
}

/** Resolves true when `promise` settles within `ms`, false when the wait is abandoned. Never rejects. */
const settleWithin = (promise, ms) => within(Promise.resolve(promise).then(() => true, () => true), ms, false);

/** Kill a process (its process group first on POSIX, where Playwright launches the browser detached). */
function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform !== 'win32') { try { process.kill(-pid, 'SIGKILL'); return true; } catch { /* not a group leader */ } }
  try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; }
}

/** The browser's own pid over CDP (Chromium only), or null. Read at launch, while the browser still answers. */
async function browserPid(browser) {
  let session = null;
  const ask = (async () => {
    session = await browser.newBrowserCDPSession();
    const info = await session.send('SystemInfo.getProcessInfo');
    const pid = info?.processInfo?.find((p) => p.type === 'browser')?.id;
    return Number.isInteger(pid) ? pid : null;
  })();
  const pid = await within(ask, 5000, null);
  session?.detach().catch(() => {});
  return pid;
}

/**
 * Makes browser.close() bounded and idempotent. After `ms` the browser process is killed (`pid`, when known and the browser
 * is still connected) and the close gets 3 s more so Playwright removes its temp profile; otherwise the wait is abandoned
 * and Playwright's own exit hook kills the browser. Resolves true when the browser closed in time, false otherwise.
 */
export function boundClose(browser, ms = closeTimeoutMs(), { pid = null } = {}) {
  const close = browser.close.bind(browser);
  let closing = null;
  browser.close = (options) => (closing ??= (async () => {
    const pending = close(options);
    if (await settleWithin(pending, ms)) return true;
    const stillUp = typeof browser.isConnected !== 'function' || browser.isConnected();
    const killed = stillUp && killPid(pid);
    if (killed) await settleWithin(pending, 3000);
    log(`note: the browser did not close within ${(ms / 1000).toFixed(1)} s; ${killed ? 'killed it' : 'not waiting for it (it is killed when this process exits)'}`);
    return false;
  })());
  return browser;
}

/** Every context the browser creates gets a bounded, idempotent close(): true when it closed in time, false when abandoned. */
function boundContexts(browser) {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    const close = context.close.bind(context);
    let closing = null;
    context.close = (options) => (closing ??= settleWithin((async () => close(options))(), closeTimeoutMs()));
    return context;
  };
  return browser;
}

/**
 * Whether Chrome's renderer sandbox stays on. It is ON unless the user asks for it off (--no-sandbox, or MOTION_NO_SANDBOX
 * set to 1/true/yes/on) or the process is root on Linux, where Chrome refuses to start with a sandbox. A captured page is
 * untrusted content, so the sandbox is the second wall behind a renderer bug (Playwright would otherwise add --no-sandbox
 * on every OS).
 * @returns {{ off: boolean, why: string | null }}
 */
export function sandboxDecision({ flag = false, env = process.env, platform = process.platform, uid = typeof process.getuid === 'function' ? process.getuid() : null } = {}) {
  if (flag) return { off: true, why: 'the --no-sandbox flag' };
  if (/^(1|true|yes|on)$/i.test(String(env.MOTION_NO_SANDBOX ?? '').trim())) return { off: true, why: 'MOTION_NO_SANDBOX is set' };
  if (platform === 'linux' && uid === 0) return { off: true, why: 'running as root on Linux, where Chrome does not start with its sandbox' };
  return { off: false, why: null };
}

// >>> browser-policy: one shared block, byte-identical in the template's tools/studio-web.mjs and in product-reel's
// scripts/capture.mjs (that script also runs in projects without tools/). test/browser-policy.test.mjs fails when they drift.
//
// Why: on Windows an installed Chrome or Edge that starts with a fresh user-data-dir (Playwright makes a new temp profile for
// every launch) tests the Windows account for a blank password (LogonUser). That fails, is written to the Security log as a
// failed logon (event 4625, SubStatus 0xc000006a) and counts toward the account lockout threshold. Measured on one laptop: one
// failed logon per launch, 464 in 24 h, 45 lockouts. The result is cached per profile, so only a fresh profile pays.
// Playwright's bundled chrome-headless-shell does not run the check (measured: 3 launches, 0 failed logons).
// Side effect, accepted: the headless shell is unsigned, so real-time antivirus scans each of its processes (about 4-5 s each on
// the measured laptop: launch 3.5 s, first newPage 11 s, 15-25 s per tool run against 2.4 s for the signed Chrome). An antivirus
// exclusion for %LOCALAPPDATA%\ms-playwright removes that; the flags tried (--disable-gpu, --in-process-gpu, --no-sandbox) did not.
// Policy: on Windows 'auto' starts only the bundled browser. An installed Chrome/Edge is an explicit opt-in (studio.json
// "browser": "chrome" | "msedge", MOTION_BROWSER, or MOTION_CHROME_PATH at chrome.exe / msedge.exe) that prints one warning and
// is counted in a small log; launchGuard refuses the launch once too many fall inside the lockout window.
// On macOS and Linux nothing of this applies: 'auto' keeps the order chrome, msedge, bundled.

const WINDOWS_LOGON_RISK = 'windows-blank-password-logon';
const SYSTEM_CHANNEL = /^(?:chrome|msedge)(?:-(?:beta|dev|canary))?$/i;
const SYSTEM_BROWSER_FILE = /^(?:chrome(?:\.exe)?|msedge(?:\.exe)?|google[-_ ]chrome.*|microsoft[-_ ]edge.*)$/i;
const BUNDLED_BROWSER_FILE = /headless[_-]shell|chromium/i;
const isAbsoluteAnyOs = (p) => path.isAbsolute(p) || path.win32.isAbsolute(p);
const lastSegment = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() ?? '';

/**
 * Is this launch of an installed (system) Chrome/Edge, and does it carry the Windows blank-password logon risk?
 * System = channel chrome | msedge (also -beta, -dev, -canary), or an executablePath whose file name is chrome(.exe), msedge(.exe),
 * google-chrome* or microsoft-edge*. Playwright's own browsers (no channel and no path, or a path whose file name contains
 * headless_shell, headless-shell or chromium) are not. The risk exists on win32 only.
 * @returns {{ system: boolean, risk: 'windows-blank-password-logon' | null }}
 */
export function classifyBrowser({ channel, executablePath, platform = process.platform } = {}) {
  let system = false;
  if (channel) system = SYSTEM_CHANNEL.test(String(channel));
  else if (executablePath) {
    const file = lastSegment(executablePath);
    system = !BUNDLED_BROWSER_FILE.test(file) && SYSTEM_BROWSER_FILE.test(file);
  }
  return { system, risk: system && platform === 'win32' ? WINDOWS_LOGON_RISK : null };
}

const BROWSER_NAMES = ['auto', 'chrome', 'msedge', 'chromium'];

/**
 * The browsers to try, in order, as [{ via, opts, system, risk, warning, auto }] (opts go to chromium.launch). Pure.
 * `pref` is studio.json "browser" (auto | chrome | msedge | chromium | absolute path). env MOTION_CHROME_PATH (a path) beats
 * env MOTION_BROWSER (auto | chrome | msedge | chromium), and both beat `pref`.
 * 'auto' on win32 = the bundled browser only (never an installed Chrome/Edge); elsewhere chrome, msedge, bundled.
 * `warning` is true for a launch that carries the Windows logon risk: only an explicit choice ever gets there on win32.
 * `via` names the bundled browser 'chromium-headless-shell' (headless, Playwright's default since 1.49) or 'chromium' (headed).
 */
export function browserAttempts(pref = 'auto', platform = process.platform, env = process.env, { headless = true } = {}) {
  const envPath = String(env.MOTION_CHROME_PATH ?? '').trim();
  const envName = String(env.MOTION_BROWSER ?? '').trim();
  if (envName && !BROWSER_NAMES.includes(envName.toLowerCase()))
    throw new Error(`MOTION_BROWSER=${envName} is not valid: use auto, chrome, msedge or chromium (a browser path goes in MOTION_CHROME_PATH)`);
  const want = envPath || envName.toLowerCase() || (typeof pref === 'string' && pref.trim() ? pref.trim() : 'auto');
  const bundledVia = headless ? 'chromium-headless-shell' : 'chromium';
  const make = (via, opts, auto = false) => {
    const { system, risk } = classifyBrowser({ ...opts, platform });
    return { via, opts, system, risk, warning: risk !== null, auto };
  };
  if (isAbsoluteAnyOs(want)) {
    const exe = path.isAbsolute(want) ? path.resolve(want) : want;
    return [make(/headless[_-]shell/i.test(lastSegment(exe)) ? 'chromium-headless-shell' : `executable:${exe}`, { executablePath: exe })];
  }
  if (want === 'chrome' || want === 'msedge') return [make(want, { channel: want })];
  if (want === 'chromium') return [make(bundledVia, {})];
  return platform === 'win32' ? [make(bundledVia, {}, true)]
    : [make('chrome', { channel: 'chrome' }, true), make('msedge', { channel: 'msedge' }, true), make(bundledVia, {}, true)];
}

/** Launch window the guard counts in (the lockout window of the measured laptop: 10 failed logons in 10 minutes). */
export const LAUNCH_WINDOW_MS = 10 * 60 * 1000;
const LAUNCH_KEEP_MS = 60 * 60 * 1000;
const LAUNCH_MAX_DEFAULT = 4;
const minutesText = (ms) => { const s = Math.max(1, Math.ceil(ms / 1000)); return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`; };

/** env MOTION_LAUNCH_LOG, else %LOCALAPPDATA%/motion-studio/system-browser-launches.json. */
export function launchLogPath(env = process.env) {
  const own = String(env.MOTION_LAUNCH_LOG ?? '').trim();
  if (own) return path.resolve(own);
  return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'motion-studio', 'system-browser-launches.json');
}

/**
 * The limit for installed-browser launches per 10 minutes: env MOTION_SYSTEM_BROWSER_MAX (integer 1..9), default 4. The launch being
 * started counts toward it: with 4 the 4th launch inside 10 minutes is refused, so 3 are allowed (1 behaves like 2: one is allowed).
 */
export function systemBrowserMax(env = process.env) {
  const n = Number(String(env.MOTION_SYSTEM_BROWSER_MAX ?? '').trim());
  return Number.isInteger(n) && n >= 1 && n <= 9 ? n : LAUNCH_MAX_DEFAULT;
}

function launchTime(entry) {
  const v = entry && typeof entry === 'object' ? (entry.t ?? entry.ts ?? entry.time ?? entry.at) : entry;
  const ms = typeof v === 'number' ? v : typeof v === 'string' ? (/^\d+$/.test(v.trim()) ? Number(v) : Date.parse(v)) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Launch times (ms since epoch, oldest first) from the JSON log; a missing, corrupt or odd file is an empty log. */
export function readLaunchLog(file = launchLogPath(), now = Date.now()) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return []; }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.launches) ? raw.launches : [];
  return list.map(launchTime).filter((t) => t !== null && t <= now + 60000).sort((a, b) => a - b); // a far-future time would block for ever
}

/**
 * What the guard says right now: { max, allowed, count, blocked, refuse, override, waitMs, file }. `count` = launches already
 * logged in the last 10 minutes; the one about to start makes count + 1, and a count that reaches `max` is refused, so
 * `allowed` = max - 1 launches fit (at least 1). `blocked` = count >= allowed; `refuse` = blocked and MOTION_ALLOW_LOCKOUT_RISK
 * is not 1; `waitMs` = how long until the count is back under `allowed` (the oldest counted launch turns 10 minutes old).
 */
export function launchGuard({ env = process.env, now = Date.now(), file = launchLogPath(env) } = {}) {
  const max = systemBrowserMax(env);
  const recent = readLaunchLog(file, now).filter((t) => now - t < LAUNCH_WINDOW_MS);
  const allowed = Math.max(1, max - 1);
  const blocked = recent.length >= allowed;
  const override = /^(?:1|true|yes|on)$/i.test(String(env.MOTION_ALLOW_LOCKOUT_RISK ?? '').trim());
  const waitMs = blocked ? Math.max(0, recent[recent.length - allowed] + LAUNCH_WINDOW_MS - now) : 0;
  return { max, allowed, count: recent.length, blocked, refuse: blocked && !override, override, waitMs, file };
}

/** Appends `now` to the launch log and drops entries older than 1 h. Returns false when the log cannot be written. */
export function recordLaunch({ env = process.env, now = Date.now(), file = launchLogPath(env) } = {}) {
  const keep = readLaunchLog(file, now).filter((t) => now - t < LAUNCH_KEEP_MS);
  keep.push(now);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(keep) + '\n');
    return true;
  } catch { return false; }
}

/** The error text when the guard refuses a launch. */
export function lockoutRefusal(via, g) {
  const window = LAUNCH_WINDOW_MS / 60000;
  return [`refusing to start ${via}: ${g.count} launches of an installed Chrome/Edge in the last ${window} minutes, and the limit is ${g.max} launches counting this one (MOTION_SYSTEM_BROWSER_MAX).`,
    'On Windows every launch with a fresh profile counts as a failed logon (Chrome tests the account for a blank password); the account lockout',
    'policy locks the account after too many of them (10 within 10 minutes on the laptop where this was measured, lockout 10 minutes).',
    `Wait ${minutesText(g.waitMs)} (until the oldest counted launch is ${window} minutes old), or switch to the bundled headless shell:`,
    'npx playwright install chromium-headless-shell, then remove "browser" from studio.json and unset MOTION_BROWSER and MOTION_CHROME_PATH.',
    `Launch log: ${g.file}. To start anyway and accept the lockout risk: MOTION_ALLOW_LOCKOUT_RISK=1.`].join('\n');
}

/** The one stderr line printed for a launch of an installed browser on Windows. */
export function systemBrowserWarning(via, g, logged = true) {
  const over = g.override && g.blocked ? ' (over the limit: MOTION_ALLOW_LOCKOUT_RISK is set)' : '';
  return `warning: starting ${via} on Windows counts as one failed logon (Chrome tests the account for a blank password); launch ${g.count + 1} of ${g.allowed} allowed in ${LAUNCH_WINDOW_MS / 60000} min${over}${logged ? '' : ', the launch log is not writable so the limit is not enforced'}. The bundled headless shell avoids it: npx playwright install chromium-headless-shell`;
}

/**
 * Called before each launch attempt. A no-op unless the attempt carries the Windows risk. Otherwise: refuse (throws, code
 * 'MOTION_LOCKOUT_GUARD') when the window is full, else record the launch and print the one warning line. `warn` gets the line.
 */
export function guardSystemLaunch(attempt, { env = process.env, now = Date.now(), warn = (line) => process.stderr.write(`${line}\n`) } = {}) {
  if (!attempt?.risk) return null;
  const g = launchGuard({ env, now });
  if (g.refuse) throw Object.assign(new Error(lockoutRefusal(attempt.via, g)), { code: 'MOTION_LOCKOUT_GUARD', guard: g });
  const logged = recordLaunch({ env, now, file: g.file });
  warn(systemBrowserWarning(attempt.via, g, logged));
  return g;
}

/** The "could not launch a browser" error text. `auto` = the failed attempts came from the 'auto' preference. */
export function launchFailureMessage(failures, { platform = process.platform, auto = false, headless = true } = {}) {
  const list = failures.map((f) => `  - ${f}`);
  const install = headless ? 'npx playwright install chromium-headless-shell' : 'npx playwright install chromium';
  if (platform === 'win32' && auto) {
    return ['could not launch a browser: no safe browser found.', ...list,
      'Windows: launching an installed Chrome/Edge with a fresh profile makes Chrome test your account for a blank password;',
      'every launch counts as a failed logon and locks the account after the policy limit (measured: one failed logon per launch).',
      headless ? `Install the bundled headless shell: ${install}   (about 115 MB; it starts slowly under some antivirus).` : `Install the bundled Chromium: ${install}`,
      'To use the installed browser anyway: set studio.json "browser": "chrome" or MOTION_BROWSER=chrome (guarded, see docs/ARCHITECTURE.md).'].join('\n');
  }
  return ['could not launch a browser:', ...list,
    platform === 'win32'
      ? `Fix: ${install}, or set MOTION_CHROME_PATH=<path to a Chromium browser>. The installed Chrome/Edge is opt-in on Windows: studio.json "browser": "chrome" or MOTION_BROWSER=chrome (guarded, see docs/ARCHITECTURE.md).`
      : `Fix: install Google Chrome or Microsoft Edge, or run \`${install}\`, or set MOTION_CHROME_PATH=<path to a Chromium browser>.`].join('\n');
}
// <<< browser-policy

// studio.json "browser" (auto | chrome | msedge | chromium | absolute path), 'auto' when there is no readable studio.json. The
// browser policy above applies MOTION_CHROME_PATH and MOTION_BROWSER on top. capture.mjs launches by itself instead of calling
// the template's launchBrowser because it must control the sandbox flag for untrusted pages.
function browserPreference(root) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'studio.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (typeof cfg.browser === 'string' && cfg.browser.trim()) return cfg.browser.trim();
  } catch { /* no readable studio.json: auto */ }
  return 'auto';
}

export async function launch(root, { noSandbox = false } = {}) {
  const req = createRequire(path.join(root, 'package.json'));
  let pw = null;
  for (const name of ['playwright', 'playwright-core']) {
    try { pw = req(name); break; } catch { /* try the next package */ }
  }
  if (!pw?.chromium) throw new Error(`playwright is not installed for ${root}. Fix: run \`npm install\` in the film project.`);
  const attempts = browserAttempts(browserPreference(root), process.platform, process.env);
  const sandbox = sandboxDecision({ flag: noSandbox });
  if (sandbox.off) log(`note: Chrome's renderer sandbox is OFF (${sandbox.why}); a malicious page could run code as this user, so capture only pages you trust`);
  const failures = [];
  const args = ['--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio', ...(sandbox.off ? ['--no-sandbox'] : [])];
  for (const attempt of attempts) {
    const { via, opts } = attempt;
    if (opts.executablePath && !fs.existsSync(opts.executablePath)) { failures.push(`${via}: file not found (${opts.executablePath})`); continue; }
    guardSystemLaunch(attempt); // throws when too many installed-browser launches fall in the lockout window
    try {
      const launched = await pw.chromium.launch({ headless: true, chromiumSandbox: !sandbox.off, args, timeout: 60000, ...opts }); // 60 s as the template launcher: a cold Chrome behind antivirus is slow
      return { browser: boundContexts(boundClose(launched, closeTimeoutMs(), { pid: await browserPid(launched) })), via, sandbox: !sandbox.off };
    } catch (err) { failures.push(`${via}: ${err.message.split('\n')[0]}`); }
  }
  const hint = failures.some((x) => /sandbox|namespace|zygote/i.test(x))
    ? '\nChrome could not start with its sandbox. In a container or CI pass --no-sandbox (or set MOTION_NO_SANDBOX=1), and only capture pages you trust.' : '';
  throw new Error(`${launchFailureMessage(failures, { platform: process.platform, auto: attempts.every((a) => a.auto) })}${hint}`);
}

const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');
const hash6 = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 6);

/** File-name slug that keeps Unicode letters, marks and digits (Hangul, kana, accents), so non-Latin selectors and labels stay readable. */
export const slugify = (s, max = 40) => {
  const slug = [...String(s).normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')].slice(0, max).join('').replace(/-+$/, '');
  return slug || 'item';
};

/** slugify() that never gives two different inputs the same name: the second one gets a short hash of its own text. */
export function makeSlugger(max = 40) {
  const owner = new Map(); // slug -> the input that first took it
  return (input) => {
    const text = String(input);
    const base = slugify(text, max);
    if (!owner.has(base) || owner.get(base) === text) { owner.set(base, text); return base; }
    const name = `${base}-${hash6(text)}`;
    owner.set(name, text);
    return name;
  };
}

// Chromium follows redirects itself. A hop to a refused address is failed before it is sent (guard.watch); one that still got
// an answer (a cross-process iframe that was not armed yet, a worker) taints the capture, so nothing is saved.
async function noEscapes(guard, vpName) {
  const escaped = await guard.settle();
  if (!escaped.length) return;
  const e = escaped[0];
  throw new Error(`${vpName}: the page reached ${e.url} (${e.reason}) through a redirect before it could be blocked; nothing was saved. Pass --allow-private only when you trust the page.`);
}

async function openPage(browser, target, vpName, flags, notes, guard) {
  const vp = VIEWPORTS[vpName];
  const context = await browser.newContext({
    ...vp, colorScheme: flags.dark ? 'dark' : 'light', reducedMotion: 'no-preference',
    serviceWorkers: 'block', // a service worker's requests would bypass the route guard
    ...(target.credentials ? { httpCredentials: target.credentials } : {}), // the URL's user:password, sent to the target's origin only
  });
  try {
    await guard.protect(context);
    const page = await context.newPage();
    await guard.watch(page); // redirect hops are invisible to routes
    let res;
    try { res = await page.goto(target.url, { waitUntil: 'load', timeout: flags.timeout * 1000 }); } catch (err) {
      const refused = guard.blocked.find((b) => !/^WebSocket/.test(b.reason));
      throw new Error(redactText(refused ? `${vpName}: navigation refused (${refused.reason}): ${refused.url}. Pass --allow-private only when you trust the page.` : String(err.message).split('\n')[0]));
    }
    if (res && res.status() >= 400) notes.push(`${vpName}: HTTP ${res.status()} for ${target.display}`);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => notes.push(`${vpName}: network never went idle; captured after load`));
    await page.evaluate(() => document.fonts.ready.then(() => true)).catch(() => {});
    // Speculation rules are prefetched by the browser process itself, which no request filter sees (see capture-guard.mjs).
    if (!guard.allowPrivate && await page.evaluate(() => !!document.querySelector('script[type="speculationrules"]')).catch(() => false)) {
      notes.push(`${vpName}: the page declares speculation rules. Chrome fetches those URLs itself and this tool cannot filter them, so a private or local address named in them may have been requested.`);
    }
    if (flags['dismiss-banners']) notes.push(bannerNote(vpName, await dismissBanner(page)));
    if (flags.settle > 0) await page.waitForTimeout(flags.settle * 1000);
    const title = await page.title().catch(() => '');
    if (/just a moment|attention required|access denied|verify you are human/i.test(title)) {
      notes.push(`${vpName}: the site served a bot check ("${title}"); ask the user for screenshots instead`);
    }
    await noEscapes(guard, vpName);
    return { context, page, status: res?.status() ?? null };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

// Fetch an image. The extension comes from the bytes (sniffImage); anything that is not a recognized image is refused
// with a note that names the declared type, so an HTML 404 page never lands in assets/brand as logo.png.
// The download goes through the capture guard: every hop is checked against the network policy, redirects are followed by
// hand (max 5), and an oversized body is refused before it is read. A refusal is recorded in guard.blocked and reported
// once in the notes; the response body is never echoed into them.
async function download(context, url, notes, guard) {
  let body;
  let declared = '';
  if (url.startsWith('data:')) {
    const data = parseDataUrl(url);
    if (!data) return null;
    ({ body, type: declared } = data);
  } else {
    const res = await guard.get(context, url, { timeout: 15000, maxBytes: MAX_DOWNLOAD });
    if (!res.ok) return null;
    body = res.body;
    declared = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  }
  const kind = sniffImage(body);
  if (!kind) {
    const head = body.toString('utf8', 0, 512).trimStart();
    const what = /^<(?:!doctype|html|\?xml)/i.test(head) ? 'looks like an HTML or XML page' : /^[[{]/.test(head) ? 'looks like JSON' : 'unrecognized bytes';
    notes.push(`not an image (declared ${declared || 'no type'}, ${what}): ${redactUrl(url).slice(0, 100)}`);
    return null;
  }
  if (declared && declared !== kind.type && declared.startsWith('image/')) notes.push(`server said ${declared} but the bytes are ${kind.type}: saved as ${kind.ext} (${redactUrl(url).slice(0, 80)})`);
  return { body, type: kind.type, ext: kind.ext };
}

function readManifest(manifestPath) {
  try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return null; }
}

// A capture is staged in assets/.capture-tmp and committed only after the browser work succeeded,
// so a failed run (offline, bot check, timeout) never destroys the previous capture.
function commitCapture(root, old, stage, brandDir) {
  const listed = [...(old?.screens || []), ...(old?.logos || []), ...(old?.components || []), ...(old?.images || []), { file: old?.brand?.wordmark?.crop }].map((x) => x?.file).filter(Boolean);
  for (const f of listed) {
    const abs = path.resolve(root, f);
    // Only files an earlier capture wrote inside assets/brand/ are removed; files the user added stay.
    if (abs.startsWith(brandDir + path.sep) && fs.existsSync(abs)) fs.rmSync(abs, { force: true });
  }
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  for (const f of walk(stage)) {
    const dest = path.join(brandDir, path.relative(stage, f));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f, dest);
  }
}

export async function capture(input, flags) {
  // The real URL (query token included) is used for navigation; userinfo moves to httpCredentials; everything logged or stored is redacted.
  const target = parseTarget(normalizeUrl(input));
  const guard = createGuard({ target: target.url, allowPrivate: !!flags['allow-private'], credentials: target.credentials });
  const root = flags.root ? path.resolve(flags.root) : findProjectRoot(process.cwd());
  if (!root || !fs.existsSync(path.join(root, 'studio.json'))) {
    throw new Error('no film project found: run inside a folder with studio.json or pass --root <project>');
  }
  const bad = flags.viewports.filter((v) => !VIEWPORTS[v]);
  if (bad.length || !flags.viewports.length) throw new UsageError(`--viewports must be from ${Object.keys(VIEWPORTS).join(', ')}`);
  const assets = path.resolve(root, flags.out);
  const brandDir = path.join(assets, 'brand');
  const manifestPath = path.join(assets, 'manifest.json');
  const old = readManifest(manifestPath);
  const stage = path.join(assets, '.capture-tmp');
  fs.rmSync(stage, { recursive: true, force: true });
  for (const d of ['screens', 'logo', 'components']) fs.mkdirSync(path.join(stage, d), { recursive: true });
  const finalRel = (f) => rel(root, path.join(brandDir, path.relative(stage, f)));

  const notes = [];
  const t0 = Date.now();
  let launched;
  try { launched = await launch(root, { noSandbox: !!flags['no-sandbox'] }); } catch (err) { fs.rmSync(stage, { recursive: true, force: true }); throw err; }
  const { browser, via, sandbox } = launched;
  await guard.protectBrowser(browser); // requests a Playwright route never sees (SharedWorker, <link rel=prerender>)
  log(`capture: ${target.display} (browser ${via}${sandbox ? '' : ', sandbox off'})`);
  const slug = makeSlugger();
  const screens = [], logos = [], components = [], images = [];
  let info = null, finalUrl = target.url, fontPlan = null, fontsWritten = [], wordmarkCrop = null;
  let existingFonts = []; // assets/fonts/fonts.json as it was before this run: the font registry report compares against it
  try { existingFonts = readFontsJson(root).list.map((e) => ({ ...e })); } catch (err) { notes.push(`fonts.json not readable (${err.message.split('\n')[0]}); the font registry report starts from an empty list`); }
  try {
    for (const [idx, vpName] of flags.viewports.entries()) {
      const { context, page } = await openPage(browser, target, vpName, flags, notes, guard);
      try {
        finalUrl = page.url();
        const vp = VIEWPORTS[vpName];
        const shot = path.join(stage, 'screens', `${vpName}.png`);
        await page.screenshot({ path: shot, animations: 'disabled' });
        screens.push({ file: finalRel(shot), viewport: vpName, width: vp.viewport.width * vp.deviceScaleFactor, height: vp.viewport.height * vp.deviceScaleFactor, fullPage: false });
        if (flags['full-page']) {
          await page.evaluate(async () => {
            for (let y = 0; y < document.body.scrollHeight && y < 20 * innerHeight; y += innerHeight) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
            scrollTo(0, 0);
          });
          const full = path.join(stage, 'screens', `${vpName}-full.png`);
          await page.screenshot({ path: full, fullPage: true, animations: 'disabled' });
          screens.push({ file: finalRel(full), viewport: vpName, fullPage: true });
        }
        if (idx !== 0) continue;
        // Everything below reads the first (widest) viewport only.
        info = await page.evaluate(extractInPage, { maxComponents: flags['max-components'], selectors: flags.selector || [] });
        for (const w of info.warnings) notes.push(w);
        for (const [n, cand] of info.logos.entries()) {
          const base = path.join(stage, 'logo', `${String(n + 1).padStart(2, '0')}-${cand.kind}`);
          if (cand.svg) { fs.writeFileSync(`${base}.svg`, cand.svg); logos.push({ file: finalRel(`${base}.svg`), source: cand.kind, selector: cand.selector, box: cand.box }); }
          if (cand.src) {
            const got = await download(context, cand.src, notes, guard);
            if (got) { const f = base + got.ext; fs.writeFileSync(f, got.body); logos.push({ file: finalRel(f), source: cand.kind, url: cand.src.startsWith('data:') ? 'data:' : cand.src, box: cand.box }); }
            else notes.push(`logo download failed: ${redactUrl(cand.src).slice(0, 120)}`);
          }
          if (cand.mark) {
            const f = `${base}-crop.png`;
            await page.locator(`[data-ms-logo="${cand.mark}"]`).first().screenshot({ path: f, animations: 'disabled', timeout: 5000 })
              .then(() => logos.push({ file: finalRel(f), source: `${cand.kind}-crop`, box: cand.box }))
              .catch((err) => notes.push(`logo crop ${cand.mark} failed: ${err.message.split('\n')[0]}`));
          }
        }
        if (info.wordmark) { // a brand set in type: a reference crop next to the text record (manifest brand.wordmark)
          const f = path.join(stage, 'logo', 'wordmark-crop.png');
          await page.locator('[data-ms-wordmark]').first().screenshot({ path: f, animations: 'disabled', timeout: 5000 })
            .then(() => { wordmarkCrop = finalRel(f); })
            .catch((err) => notes.push(`wordmark crop failed: ${err.message.split('\n')[0]}`));
        }
        for (const [n, icon] of info.icons.entries()) {
          const got = await download(context, icon.href, notes, guard);
          if (!got) { notes.push(`icon download failed: ${redactUrl(icon.href).slice(0, 120)}`); continue; }
          const f = path.join(stage, 'logo', `icon-${n + 1}-${slug(icon.rel)}${got.ext}`);
          fs.writeFileSync(f, got.body);
          logos.push({ file: finalRel(f), source: icon.rel, url: icon.href, sizes: icon.sizes || null });
        }
        if (info.ogImage) {
          const got = await download(context, info.ogImage, notes, guard);
          if (got) { const f = path.join(stage, `og-image${got.ext}`); fs.writeFileSync(f, got.body); images.push({ file: finalRel(f), source: 'og:image', url: info.ogImage }); }
        }
        for (const c of info.components) {
          const f = path.join(stage, 'components', `${String(c.n).padStart(2, '0')}-${c.label}-${slug(c.text || c.selector)}.png`);
          await page.locator(`[data-ms-cap="${c.n}"]`).first().screenshot({ path: f, animations: 'disabled', timeout: 8000 })
            .then(() => components.push({ file: finalRel(f), label: c.label, selector: c.selector, text: c.text || null, box: c.box }))
            .catch((err) => notes.push(`component ${c.label} (${c.selector}) failed: ${err.message.split('\n')[0]}`));
        }
        await noEscapes(guard, vpName);
        if (flags.fonts !== false) { // needs the live context for the requests; files are written only after the capture is committed
          try { fontPlan = await collectFonts(context, info.fonts, finalUrl, readFontsJson(root).list, notes, guard); } catch (err) { notes.push(`fonts not captured: ${err.message.split('\n')[0]}`); }
        }
      } finally {
        await context.close().catch(() => {});
      }
    }
    commitCapture(root, old, stage, brandDir);
    if (fontPlan && fontPlan.files.length) {
      try { fontsWritten = registerFonts(root, fontPlan.files); } catch (err) { notes.push(`fonts downloaded but not registered: ${err.message.split('\n')[0]}`); }
    }
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(stage, { recursive: true, force: true });
  }

  const colors = buildPalette(info.colorSamples, info.themeColor);
  const { rules: _rules, allLoaded: _allLoaded, unreadableSheets: _unreadable, ...fontInfo } = info.fonts;
  const unverified = [...new Set(fontsWritten.filter((f) => f.license.status === 'UNVERIFIED').map((f) => f.family))];
  if (fontsWritten.length) {
    notes.push(`fonts: ${fontsWritten.length} file(s) the page loads were saved to assets/fonts/ and registered in fonts.json. ${unverified.length ? `License UNVERIFIED for ${unverified.join(', ')}. ` : ''}Check each font's license before you publish, and set brand.fonts only to fonts you may use.`);
  }
  const { wordmark, registry, notes: brandNotes } = brandReport({ info, wordmarkCrop, existingFonts, fontsWritten, fontPlan, fontsEnabled: flags.fonts !== false });
  notes.push(...brandNotes);
  notes.push(...guard.notes());
  const brand = { ...(old?.brand && typeof old.brand === 'object' ? old.brand : {}) };
  if (wordmark) brand.wordmark = wordmark; else delete brand.wordmark;
  const fresh = {
    version: 1,
    tool: 'motion-studio product-reel capture',
    url: target.display, finalUrl: redactUrl(finalUrl), capturedAt: new Date().toISOString(), browser: via, sandbox,
    viewports: flags.viewports,
    screens, logos, components, images,
    colors: { suggested: colors.suggested, palette: colors.palette, cssVars: info.cssVars, themeColor: info.themeColor ? hex(info.themeColor) : null },
    fonts: { ...fontInfo, files: fontsWritten, skipped: fontPlan?.skipped ?? [], registry },
    ...(old?.brand || wordmark ? { brand } : {}),
    text: info.text,
    blocked: guard.blocked.slice(0, 50), // requests the network policy refused: { url, reason }
    notes: [...notes, 'Colors and fonts are suggestions from computed styles; confirm them with the user before animating.'],
  };
  // Page-supplied URLs (logos, icons, fonts, notes) can carry signed tokens too: redact every string this tool writes.
  const manifest = { ...(old && typeof old === 'object' ? old : {}), ...redactDeep(fresh) };
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  let applied = null;
  if (flags['apply-brand']) {
    const cfgPath = path.join(root, 'studio.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.brand = cfg.brand || {};
    cfg.brand.name = cfg.brand.name || info.text.siteName || (info.text.title || '').split(/\s[|\-–—:]\s/)[0].trim();
    cfg.brand.url = manifest.finalUrl;
    cfg.brand.colors = { ...(cfg.brand.colors || {}), ...Object.fromEntries(Object.entries(colors.suggested).filter(([, v]) => v)) };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    applied = { name: cfg.brand.name, url: cfg.brand.url, colors: cfg.brand.colors };
  }
  return { root, manifest: rel(root, manifestPath), seconds: +((Date.now() - t0) / 1000).toFixed(1), counts: { screens: screens.length, logos: logos.length, components: components.length, images: images.length }, suggested: colors.suggested, fonts: info.fonts.families.map((f) => f.family), fontFiles: manifest.fonts.files, fontsSkipped: manifest.fonts.skipped, fontRegistry: registry, wordmark, unverifiedFonts: unverified, applied, sandbox, blocked: guard.blocked.length, url: manifest.url, finalUrl: manifest.finalUrl, notes: manifest.notes };
}

async function main(argv) {
  const { flags, positionals } = parseArgs(argv);
  if (flags.help) { process.stdout.write(usage() + '\n'); return 0; }
  if (positionals.length !== 1) throw new UsageError(positionals.length ? 'expected exactly one <url>' : 'missing <url>');
  const url = normalizeUrl(positionals[0]);
  const r = await capture(url, flags);
  log(`wrote ${r.manifest}: ${r.counts.screens} screens, ${r.counts.logos} logo files, ${r.counts.components} components in ${r.seconds} s`);
  log(`suggested colors: bg ${r.suggested.bg}  fg ${r.suggested.fg}  accent ${r.suggested.accent ?? '(none found)'}  muted ${r.suggested.muted}`);
  log(`fonts in use: ${r.fonts.join(', ') || '(none detected)'}`);
  for (const line of registryLines(r.fontRegistry)) log(line);
  if (r.wordmark) log(`wordmark: "${r.wordmark.text}" ${r.wordmark.html ? `(${r.wordmark.html}) ` : ''}in ${r.wordmark.font.family} ${r.wordmark.font.weight} ${r.wordmark.font.size}, recorded in the manifest under brand.wordmark`);
  if (r.fontFiles.length) {
    log(`fonts saved: ${r.fontFiles.length} file(s) in assets/fonts/ (${[...new Set(r.fontFiles.map((f) => f.family))].join(', ')}), registered in assets/fonts/fonts.json`);
    log(`fonts license: ${r.unverifiedFonts.length ? `UNVERIFIED for ${r.unverifiedFonts.join(', ')}. ` : ''}Check each font's license before you publish the film; fonts.json is only a list of files, not a grant of rights.`);
  }
  for (const n of r.notes) log(`note: ${n}`);
  if (flags.json) process.stdout.write(JSON.stringify({ ok: true, ...r }) + '\n');
  return 0;
}

/**
 * True when the module at `metaUrl` is the script node was started with. Node realpath()s the main module for
 * import.meta.url but leaves process.argv[1] as typed, so a path through a symlink or junction (a symlinked skills
 * install, a symlinked $HOME, macOS /tmp) has to be compared by real path, or main() never runs and the CLI exits 0 with
 * no output. Falls back to the resolved path when a real path cannot be read.
 */
export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (p) => {
    let r = path.resolve(p);
    try { r = fs.realpathSync.native(r); } catch { /* keep the resolved path */ }
    return process.platform === 'win32' ? r.toLowerCase() : r; // drive-letter case differs between shells
  };
  try { return real(argv1) === real(fileURLToPath(metaUrl)); } catch { return false; }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    if (err instanceof UsageError) { log(`capture: ${err.message}\n\n${usage()}`); process.exitCode = 2; return; }
    log(`capture: ${redactText(err.message)}`); // a Playwright error can quote the URL, token included
    if (process.env.DEBUG) log(redactText(err.stack));
    process.exitCode = 1;
  });
}
