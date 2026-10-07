// Web half of the shared tool library: the static project server and the Playwright page driver (launchBrowser,
// openFilm, captureFrame). Re-exported by studio.mjs; import from there.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FORMATS } from '../lib/layout.js';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const requireFrom = (root) => [path.join(root, 'package.json'), path.join(TOOLS_DIR, '..', 'package.json')].map((p) => createRequire(p));

// ---------------------------------------------------------------------------------------------------------------
// Static server (ES modules and fetch() need http; file:// breaks both)

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.map': 'application/json; charset=utf-8',
};
export const mimeType = (file) => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

const isDotSegment = (seg) => seg.startsWith('.');

/**
 * True when `file` (an existing path inside `base`) is, or sits under, a dot-file or dot-directory once every alias is
 * resolved. The request path alone cannot tell: on NTFS volumes with 8.3 names (the system drive by default) `.env` is also
 * `ENV~1` and `.git` is `GIT~1`, and the OS opens either. realpath.native returns the real long name (`.env`).
 * A path that resolves outside `base` (a symlink or junction the project owner made on purpose) is not judged here.
 */
const realBases = new Map();
function hiddenAfterResolve(base, file) {
  if (!realBases.has(base)) realBases.set(base, fs.realpathSync.native(base));
  const realBase = realBases.get(base);
  const real = fs.realpathSync.native(file);
  const rel = path.relative(realBase, real);
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return false;
  return rel.split(/[\\/]/).some(isDotSegment);
}

function serveRequest(base, allowedHosts, req, res) {
  const plain = (code, msg, headers = {}) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(req.method === 'HEAD' ? undefined : msg + '\n'); };
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'method not allowed', { Allow: 'GET, HEAD' });
  // Host allowlist blocks DNS-rebinding pages from reading project files (.env stays hidden regardless).
  if (!allowedHosts.has(String(req.headers.host ?? '').toLowerCase())) return plain(403, 'forbidden host');
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname); } catch { return plain(400, 'bad request'); }
  if (pathname.includes('\0')) return plain(400, 'bad request');
  const abs = path.resolve(base, '.' + pathname);
  const rel = path.relative(base, abs);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return plain(403, 'forbidden');
  if (rel.split(/[\\/]/).some(isDotSegment)) return plain(404, 'not found');
  // Windows reads `\` as a separator and `name:stream` as an NTFS alternate data stream: neither belongs in a URL path here.
  if (process.platform === 'win32' && /[\\:]/.test(pathname)) return plain(404, 'not found');
  let file = abs;
  let st;
  try { st = fs.statSync(file); if (st.isDirectory()) { file = path.join(file, 'index.html'); st = fs.statSync(file); } } catch { return plain(404, 'not found'); }
  if (!st.isFile()) return plain(404, 'not found');
  // Second check on the canonical path: 8.3 short names (/ENV~1, /GIT~1/config) and case variants pass the one above.
  try { if (hiddenAfterResolve(base, file)) return plain(404, 'not found'); } catch { return plain(404, 'not found'); }
  const headers = { 'Content-Type': mimeType(file), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' };
  let start = 0;
  let end = st.size - 1;
  let code = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && st.size > 0 && (range[1] || range[2])) {
    if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); } else start = Math.max(0, st.size - Number(range[2]));
    if (start > end || start >= st.size) return plain(416, 'range not satisfiable', { 'Content-Range': `bytes */${st.size}` });
    code = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = String(st.size === 0 ? 0 : end - start + 1);
  res.writeHead(code, headers);
  if (req.method === 'HEAD' || st.size === 0) return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// Ports Chromium refuses to load a page from (net::ERR_UNSAFE_PORT), Chromium's net/base/port_util.cc kRestrictedPorts.
// The OS hands out ephemeral ports from its dynamic range; on Windows machines whose range was widened (1024-15000 seen
// here) roughly one server in 800 landed on one of these and the film "failed to load".
const CHROME_UNSAFE_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554,
  556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080]);
export const isChromeUnsafePort = (port) => CHROME_UNSAFE_PORTS.has(port);

/**
 * node:http static server for the project on 127.0.0.1 (ephemeral port by default). An ephemeral port that Chrome would
 * refuse to navigate to is given back and another one is drawn; an explicit `port` is used as asked.
 */
export function startServer(root, { port = 0, host = '127.0.0.1' } = {}) {
  const base = path.resolve(root);
  const allowedHosts = new Set();
  const server = http.createServer((req, res) => {
    try { serveRequest(base, allowedHosts, req, res); } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  return new Promise((resolve, reject) => {
    let draws = 0;
    server.once('error', (err) => reject(err.code === 'EADDRINUSE' ? Object.assign(new Error(`port ${port} is already in use`), { code: err.code }) : err));
    const listen = () => server.listen(port, host, () => {
      const p = server.address().port;
      if (port === 0 && isChromeUnsafePort(p) && ++draws < 100) { server.close(() => listen()); return; }
      for (const h of [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`, `${host}:${p}`]) allowedHosts.add(h.toLowerCase());
      resolve({
        url: `http://${host}:${p}`, port: p, server,
        close: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections?.(); }),
      });
    });
    listen();
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Browser

export async function importPlaywright(root = process.cwd()) {
  const problems = [];
  for (const name of ['playwright', 'playwright-core']) {
    for (const req of requireFrom(path.resolve(root))) {
      try { const mod = req(name); if (mod?.chromium) return mod; } catch (err) { if (err.code !== 'MODULE_NOT_FOUND') problems.push(`${name}: ${err.message}`); }
    }
  }
  throw new Error(`playwright is not installed for ${root}${problems.length ? ` (${problems.join('; ')})` : ''}.\n` +
    'Fix: run `npm install` in the film project (installs playwright), then run `npx playwright install chromium-headless-shell`.');
}

export const BROWSER_ARGS = Object.freeze(['--disable-accelerated-2d-canvas', '--force-color-profile=srgb', '--disable-lcd-text',
  '--hide-scrollbars', '--mute-audio', '--font-render-hinting=none']);

/** The value of `promise`, or `fallback` when it rejects or takes longer than `ms`. Never rejects. */
function within(promise, ms, fallback) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, ms, fallback); });
  return Promise.race([Promise.resolve(promise).catch(() => fallback), late]).finally(() => clearTimeout(timer));
}

/** Resolves true when `promise` settles within `ms`, false when the wait is abandoned. Never rejects. */
export const settleWithin = (promise, ms) => within(Promise.resolve(promise).then(() => true, () => true), ms, false);

/** Longest wait for one browser/context close (env MOTION_CLOSE_TIMEOUT_MS, default 8 s). */
export const closeTimeoutMs = () => Number(process.env.MOTION_CLOSE_TIMEOUT_MS) || 8000;

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
 * Makes browser.close() bounded and idempotent. Chrome's shutdown on Windows sometimes takes 15-20 s (measured
 * 1-23 s for the same page). After `ms` the browser process is killed (`pid`, when known) and the close gets 3 s more
 * so Playwright removes its temp profile; otherwise the wait is abandoned and Playwright's own exit hook kills the
 * browser (a slow `taskkill /T` on Windows). Resolves true when the browser closed in time, false otherwise.
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
    process.stderr.write(`note: the browser did not close within ${(ms / 1000).toFixed(1)} s; ${killed ? 'killed it' : 'not waiting for it (it is killed when this process exits)'}\n`);
    return false;
  })());
  return browser;
}

/**
 * Every context the browser creates gets the same bounded, idempotent close: context.close() resolves true when the
 * context closed within closeTimeoutMs() and false when the wait was abandoned (browser.close() ends the rest). Without
 * it a wedged renderer holds `await context.close()` in any tool that does not race it by hand.
 */
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

/**
 * Starts the browser chosen by the browser policy above: env MOTION_CHROME_PATH (a path), env MOTION_BROWSER, then studio.json
 * "browser". 'auto' = Playwright's bundled browser (the headless shell) on Windows, chrome → msedge → bundled elsewhere.
 * An installed Chrome/Edge on Windows only on explicit request, with a warning line and the launch guard. Returns
 * { browser, via, version, system, risk }; via = 'chromium-headless-shell' | 'chromium' | 'chrome' | 'msedge' | 'executable:<path>'.
 */
export async function launchBrowser(root, cfg = {}, { headless = true } = {}) {
  const pw = await importPlaywright(root);
  const args = [...BROWSER_ARGS];
  if (process.platform === 'linux') args.push('--no-sandbox');
  const attempts = browserAttempts(cfg.browser ?? 'auto', process.platform, process.env, { headless });
  const failures = [];
  for (const attempt of attempts) {
    const { via, opts, system, risk } = attempt;
    if (opts.executablePath && !fs.existsSync(opts.executablePath)) { failures.push(`${via}: file not found (${opts.executablePath})`); continue; }
    guardSystemLaunch(attempt); // throws when too many installed-browser launches fall in the lockout window
    try {
      const launched = await pw.chromium.launch({ headless, args, timeout: 60000, ...opts });
      const browser = boundContexts(boundClose(launched, closeTimeoutMs(), { pid: await browserPid(launched) }));
      return { browser, via, version: browser.version(), system, risk };
    } catch (err) { failures.push(`${via}: ${String(err.message).split('\n')[0]}`); }
  }
  throw new Error(launchFailureMessage(failures, { platform: process.platform, auto: attempts.every((a) => a.auto), headless }));
}

// Optional fetches the runtime tolerates as 404 (lib/runtime.js beats grid, lib/fonts.js manifest) plus the favicon Chrome
// requests on its own. Their "Failed to load resource … 404" console lines are not film errors; every other one is.
export const OPTIONAL_RESOURCES = Object.freeze(['/audio/beats.json', '/assets/fonts/fonts.json', '/favicon.ico']);

/** True for a console error that only reports a 404 of an optional resource (matched on the message's location URL). */
export function isBenignConsoleError(text, url) {
  if (!/^Failed to load resource\b.*\b404\b/.test(String(text ?? ''))) return false;
  let pathname;
  try { pathname = new URL(String(url ?? '')).pathname; } catch { return false; }
  return OPTIONAL_RESOURCES.some((r) => pathname === r || pathname.endsWith(r));
}

export const even = (n) => Math.max(2, 2 * Math.round(n / 2));
const firstLine = (s) => String(s ?? '').split('\n')[0];
const MISSING_MS = 15000; // boot() creates window.__studio synchronously once the module graph ran
const CONSOLE_GRACE_MS = 3000; // a 404'd import logs a console error but never throws a pageerror

function describeErrors(errors) {
  const list = [...errors.page.map((e) => `pageerror: ${e}`), ...errors.console.map((e) => `console: ${e}`)].slice(0, 6);
  return list.length ? `\n  ${list.join('\n  ').slice(0, 4000)}` : '';
}

// An Error whose first line explains the failure; `detail` carries the page stack (a few lines) for the report.
const bootError = (message, stack) => Object.assign(new Error(message), { detail: String(stack ?? '').split('\n').slice(1, 7).map((l) => l.trim()).filter(Boolean) });
// The page error's own stack is already listed by describeErrors.
const threwWhileBooting = (errors, also = '') => new Error(`the page threw while booting: ${firstLine(errors.page[0])}${also}`);
const studioErrorOf = (page) => page.evaluate(() => (window.__studio && window.__studio.error != null ? String(window.__studio.error) : null)).catch(() => null);
const alsoStudioError = (studioError, cause) => (studioError && firstLine(studioError) !== firstLine(cause) ? ` (__studio.error: ${firstLine(studioError)})` : '');

// How long the state snapshot below waits for a still-pending __studio.ready before calling it "pending".
const SNAPSHOT_MS = 400;
/**
 * The boot state as the page sees it right now: { exists } while there is no window.__studio, else { exists, reason }
 * where reason is the rejection text of __studio.ready, null once it resolved, or undefined while it is still pending
 * after `ms`. Never rejects.
 */
const readyState = (page, ms = SNAPSHOT_MS) => page.evaluate((limit) => {
  const s = window.__studio;
  if (!s) return { exists: false };
  const pending = new Promise((resolve) => setTimeout(resolve, limit, { exists: true, reason: undefined }));
  return Promise.race([Promise.resolve(s.ready).then(() => ({ exists: true, reason: null }), (e) => ({ exists: true, reason: String((e && e.stack) || e) })), pending]);
}, ms).catch(() => ({ exists: false }));

/**
 * The error for "the page raised a pageerror while booting". One rule, whatever order the events arrived in: when the
 * film had already created __studio and its ready promise rejected (an unhandled rejection is also reported as a
 * pageerror), the report is the __studio.ready one, with __studio.error when that says something else; otherwise the
 * page threw before or apart from __studio and the report is the page error itself.
 */
async function pageErrorReport(page, errors) {
  const state = await readyState(page);
  const studioError = state.exists ? await studioErrorOf(page) : null;
  if (typeof state.reason === 'string') return bootError(`__studio.ready rejected: ${firstLine(state.reason)}${alsoStudioError(studioError, state.reason)}`, state.reason);
  return threwWhileBooting(errors, alsoStudioError(studioError, errors.page[0]));
}

/**
 * 1. wait until window.__studio exists (waitForFunction on a boolean; fails fast on a page error, or on console errors
 *    that outlive a short grace); 2. await __studio.ready inside the page, mapped to null | the rejection text (a
 *    promise is never handed back through waitForFunction). Throws a readable Error including __studio.error.
 *    Messages (first line): "__studio.ready rejected: <cause>[ (__studio.error: ...)]", "__studio.ready did not resolve
 *    within N s", "the page threw while booting: <page error>[ (__studio.error: ...)]", "window.__studio was never created".
 */
export async function waitReady(page, errors, { timeoutMs, pageError }) {
  const t0 = Date.now();
  const left = () => Math.max(1, timeoutMs - (Date.now() - t0));
  const timers = [];
  const after = (ms, value) => new Promise((resolve) => { timers.push(setTimeout(resolve, ms, value)); });
  // A page error ends the wait after a short grace, so errors raised together are all reported.
  const threw = pageError.then(() => after(100, 'pageerror'));
  try {
    // Never rejects: a late rejection (context closed after the race was decided) must not become unhandled.
    const created = page.waitForFunction(() => !!window.__studio, null, { timeout: Math.min(left(), MISSING_MS), polling: 50 })
      .then(() => 'created', (err) => (err?.name === 'TimeoutError' ? 'missing' : { error: err }));
    const consoleFail = new Promise((resolve) => {
      const tick = () => { if (errors.console.length && Date.now() - t0 >= CONSOLE_GRACE_MS) resolve('console'); else timers.push(setTimeout(tick, 100)); };
      tick();
    });
    const first = await Promise.race([created, threw, consoleFail]);
    if (first?.error) throw first.error;
    if (first === 'pageerror') throw await pageErrorReport(page, errors);
    if (first !== 'created' && !(await page.evaluate(() => !!window.__studio).catch(() => false))) {
      const why = first === 'missing' ? ` within ${Math.round(Math.min(timeoutMs, MISSING_MS) / 1000)} s` : '';
      throw new Error(`window.__studio was never created${why} (index.html must import lib/runtime.js and call boot(film))`);
    }
    const settled = page.evaluate(() => Promise.resolve(window.__studio.ready).then(() => null, (e) => String((e && e.stack) || e)))
      .then((reason) => ({ reason }));
    settled.catch(() => {});
    const res = await Promise.race([settled, threw.then(() => ({ threw: true })), after(left(), { timedOut: true })]);
    if (res.threw) throw await pageErrorReport(page, errors);
    const studioError = res.reason != null || res.timedOut ? await studioErrorOf(page) : null;
    const also = alsoStudioError(studioError, res.reason);
    if (res.timedOut) throw bootError(`__studio.ready did not resolve within ${Math.round(timeoutMs / 1000)} s${also}`, studioError);
    if (res.reason != null) throw bootError(`__studio.ready rejected: ${firstLine(res.reason)}${also}`, res.reason);
  } finally {
    for (const t of timers) clearTimeout(t);
  }
}

/** New context sized to the canvas, __RENDER__ set before any script, waits for __studio.ready and surfaces page errors. */
export async function openFilm(browser, serverUrl, { format, scale = 1, query = {}, timeoutMs = 60000 } = {}) {
  const f = format ? FORMATS[format] : null;
  const viewport = f ? { width: even(f.w * scale), height: even(f.h * scale) } : { width: 1080, height: 1080 };
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const errors = { page: [], console: [] };
  let sawPageError;
  const pageError = new Promise((resolve) => { sawPageError = resolve; });
  try {
    await context.addInitScript(() => { window.__RENDER__ = true; });
    const page = await context.newPage();
    page.on('pageerror', (e) => { errors.page.push(String(e?.stack || e?.message || e)); sawPageError(); });
    page.on('crash', () => { errors.page.push('the page crashed (out of memory?)'); sawPageError(); });
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const url = m.location()?.url ?? '';
      if (isBenignConsoleError(m.text(), url)) return;
      errors.console.push(`${m.text()}${url ? ` (${url})` : ''}`);
    });
    const params = new URLSearchParams({ render: '1', ...(format ? { format } : {}), scale: String(scale) });
    for (const [k, v] of Object.entries(query)) params.set(k, String(v));
    const href = `${String(serverUrl).replace(/\/+$/, '')}/index.html?${params}`;
    try {
      const resp = await page.goto(href, { waitUntil: 'load', timeout: timeoutMs });
      if (resp && !resp.ok()) throw new Error(`GET index.html → HTTP ${resp.status()}`);
      await waitReady(page, errors, { timeoutMs, pageError });
      if (errors.page.length) throw threwWhileBooting(errors);
    } catch (err) {
      const detail = err.detail?.length ? `\n    ${err.detail.join('\n    ')}` : '';
      throw new Error(`film failed to load (${href}): ${firstLine(err.message)}${detail}${describeErrors(errors)}`);
    }
    const meta = await page.evaluate(() => JSON.parse(JSON.stringify(window.__studio.meta ?? {})));
    if (Number.isFinite(meta.width) && Number.isFinite(meta.height) && (meta.width !== viewport.width || meta.height !== viewport.height))
      await page.setViewportSize({ width: meta.width, height: meta.height });
    return { page, context, meta, errors };
  } catch (err) {
    await settleWithin(context.close(), closeTimeoutMs());
    throw err;
  }
}

export function dataUrlToBuffer(url) {
  const s = String(url ?? '');
  const comma = s.indexOf(',');
  if (!s.startsWith('data:image/png;base64,') || comma < 0 || s.length < 40) throw new Error(`__studio.frame returned no PNG (got "${s.slice(0, 40)}")`);
  return Buffer.from(s.slice(comma + 1), 'base64');
}

/**
 * canvas: __studio.frame (in-page subframe accumulation) → PNG; page: seek + page.screenshot (sub ignored). For page
 * capture, `blur` = { frameT, sub, subs } tells the film that `t` is subframe `sub` of `subs` of the output frame at
 * `frameT` (scenes then see c.frame / c.sub / c.subs / c.frameT of the output frame, as in canvas capture).
 */
export async function captureFrame(page, meta, t, { sub = 1, shutter = 0.5, fps, blur } = {}) {
  if (meta.capture === 'page') {
    await page.evaluate(({ tt, b }) => { window.seek(tt, b); }, { tt: t, b: blur ?? null });
    return page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide', scale: 'css', timeout: 120000 });
  }
  const url = await page.evaluate((o) => window.__studio.frame(o), { t, sub, shutter, fps: fps ?? meta.fps, type: 'image/png' });
  return dataUrlToBuffer(url);
}
