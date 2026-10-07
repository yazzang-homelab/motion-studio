// One browser session for the capture tools that drive a page (states.mjs, canvas-frames.mjs). It is the same safety
// stack as capture.mjs: capture.mjs launch() (the shared browser policy: Windows starts Playwright's bundled headless shell,
// never an installed Chrome or Edge; renderer sandbox ON unless asked off; bounded closes) plus the network policy of
// capture-guard.mjs (private, local and non-web addresses refused, redirect hops and WebSockets included, credentials in
// the URL moved to httpCredentials and never written).
// The project's own tools/studio.mjs launchBrowser() is used only with --project-launcher: it starts Playwright with its
// default flags, which turn Chrome's renderer sandbox OFF on every OS, so a page you do not trust must not be opened there.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from './capture.mjs';
import { createGuard, parseTarget, redactText } from './capture-guard.mjs';
import { UsageError } from './capture-cli.mjs';

export const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  tablet: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

/** `input` as an http(s) URL (https:// is added to a bare host); throws a UsageError for anything else. */
export function parseHttpUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) throw new UsageError('missing <url>');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new UsageError('not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UsageError(`only http(s) URLs are supported, got ${u.protocol}`);
  return u.href;
}

function studioConfig(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'studio.json'), 'utf8').replace(/^﻿/, '')); } catch { return {}; }
}

/**
 * Starts the browser. Default: capture.mjs launch(root) (sandbox on, shared browser policy). With projectLauncher the
 * project's tools/studio.mjs launchBrowser(root, studio.json) is used instead (same browser choice, sandbox OFF).
 * @returns {Promise<{ browser, via: string, sandbox: boolean, launcher: 'capture' | 'project' }>}
 */
export async function openBrowser(root, { noSandbox = false, projectLauncher = false, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  if (projectLauncher) {
    const file = path.join(root, 'tools', 'studio.mjs');
    if (!fs.existsSync(file)) throw new UsageError(`--project-launcher needs the project's tools/studio.mjs (${file} does not exist); drop the flag to use the built-in launcher`);
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.launchBrowser !== 'function') throw new UsageError(`${file} does not export launchBrowser`);
    const r = await mod.launchBrowser(root, studioConfig(root));
    log("note: Chrome's renderer sandbox is OFF (the project's launchBrowser starts Playwright with its default flags); use this only for a page you trust");
    return { browser: r.browser, via: r.via, sandbox: false, launcher: 'project' };
  }
  let r;
  try { r = await launch(root, { noSandbox }); } catch (err) {
    if (/^MOTION_BROWSER=/.test(err.message)) throw new UsageError(err.message); // a wrong environment value is a usage error, before any launch
    throw err;
  }
  return { ...r, launcher: 'capture' };
}

/** The guard for one target: { target, guard } with the URL split into navigation URL, credentials and a printable form. */
export function makeGuard(urlInput, { allowPrivate = false } = {}) {
  const target = parseTarget(parseHttpUrl(urlInput));
  return { target, guard: createGuard({ target: target.url, allowPrivate, credentials: target.credentials }) };
}

/**
 * Opens `target` in a fresh context of `browser` behind `guard` and waits for load, network idle (8 s at most), fonts and `settle`
 * seconds. The caller closes the context. Throws (context closed) when the navigation fails or is refused.
 * @returns {Promise<{ context, page, status: number | null }>}
 */
export async function openPage(browser, target, guard, { viewport = 'desktop', dpr = null, locale = null, timeout = 45, settle = 0.8, notes = [] } = {}) {
  const vp = VIEWPORTS[viewport];
  if (!vp) throw new UsageError(`viewport must be one of ${Object.keys(VIEWPORTS).join(', ')}`);
  const context = await browser.newContext({
    ...vp, ...(dpr ? { deviceScaleFactor: dpr } : {}), ...(locale ? { locale } : {}),
    colorScheme: 'light', reducedMotion: 'no-preference', serviceWorkers: 'block', // a service worker's requests would bypass the route guard
    ...(target.credentials ? { httpCredentials: target.credentials } : {}),
  });
  try {
    await guard.protect(context);
    const page = await context.newPage();
    await guard.watch(page);
    let res = null;
    try { res = await page.goto(target.url, { waitUntil: 'load', timeout: timeout * 1000 }); } catch (err) {
      const refused = guard.blocked.find((b) => !/^WebSocket/.test(b.reason));
      throw new Error(redactText(refused ? `${viewport}: navigation refused (${refused.reason}): ${refused.url}. Pass --allow-private only when you trust the page.` : String(err.message).split('\n')[0]));
    }
    if (res && res.status() >= 400) notes.push(`${viewport}: HTTP ${res.status()} for ${target.display}`);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => notes.push(`${viewport}: network never went idle; captured after load`));
    await page.evaluate(() => document.fonts.ready.then(() => true)).catch(() => {});
    if (!guard.allowPrivate && await page.evaluate(() => !!document.querySelector('script[type="speculationrules"]')).catch(() => false)) {
      notes.push(`${viewport}: the page declares speculation rules. Chrome fetches those URLs itself and this tool cannot filter them, so a private or local address named in them may have been requested.`);
    }
    if (settle > 0) await page.waitForTimeout(settle * 1000);
    return { context, page, status: res?.status() ?? null };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

/** A refused redirect hop that was still answered: the run's files must not be trusted. Returns the error text or null. */
export async function escapeProblem(guard, label) {
  const escaped = await guard.settle();
  if (!escaped.length) return null;
  return `${label}: the page reached ${escaped[0].url} (${escaped[0].reason}) through a redirect before it could be blocked; its files cannot be trusted. Pass --allow-private only when you trust the page.`;
}
