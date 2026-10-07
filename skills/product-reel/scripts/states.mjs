#!/usr/bin/env node
// UI-state capture for product reels: the screenshots capture.mjs cannot take in one shot. It opens a page and writes
//   00-first      the page as it loads
//   01-escape     only when the cookie/consent click or Escape changed the pixels (promo modals often cover the product)
//   scroll-NN     frames through whatever really scrolls: the window, or the inner pane of an app shell
//   10-click-...  one shot per --click, in order (an open menu, a picker, a second tab)
//   crop-20-...   one element crop per --crop (file <viewport>-crop-20-<slug>.png), with computed styles (colors, radius, font, box) so the film can rebuild it
// plus states.json next to the PNGs. Real pixels only, nothing is drawn.
// Same safety stack as capture.mjs (see capture-session.mjs): bundled headless shell on Windows, renderer sandbox on, requests
// to private/local/non-web addresses refused, credentials and token query values never written.
//   plugin install   node "${CLAUDE_PLUGIN_ROOT}/skills/product-reel/scripts/states.mjs" <url> [options]
//   skills-only      node "${CLAUDE_SKILL_DIR}/scripts/states.mjs" <url> [options]   (run in a folder where `playwright` resolves)
import fs from 'node:fs';
import path from 'node:path';
import { domainToUnicode } from 'node:url';
import { dismissBanner, bannerNote } from './capture-banner.mjs';
import { isMain, makeSlugger } from './capture.mjs';
import { UsageError, insideRoot, parseFlags, relTo, resolveRoot, usageText, writeFileAtomic } from './capture-cli.mjs';
import { escapeProblem, makeGuard, openBrowser, openPage } from './capture-session.mjs';
import { redactText, redactUrl } from './capture-guard.mjs';

export const SPEC = {
  root: { type: 'string', desc: 'project folder (default: nearest folder with studio.json, else the current folder)' },
  out: { type: 'string', desc: 'output folder inside the project (default assets/brand/states/<name>)' },
  name: { type: 'string', desc: 'folder name under assets/brand/states/ (default: the page host)' },
  viewport: { type: 'string', default: 'desktop', desc: 'desktop, mobile or both (also tablet)' },
  click: { type: 'list', desc: 'selector to click, one shot after each, in order (repeatable); Playwright selectors: text=Pricing, button:has-text("Try"), CSS' },
  crop: { type: 'list', desc: 'selector to crop with its computed styles (repeatable)' },
  'full-page': { type: 'boolean', desc: 'also save a full-page screenshot per viewport' },
  'scroll-frames': { type: 'int', default: 6, min: 0, max: 30, desc: 'scroll frames through the element that really scrolls (0 = none)' },
  wait: { type: 'int', default: 700, min: 0, max: 30000, desc: 'milliseconds to wait after each click before the shot' },
  settle: { type: 'number', default: 0.8, min: 0, desc: 'seconds to wait after load' },
  timeout: { type: 'number', default: 45, min: 1, desc: 'navigation timeout in seconds' },
  locale: { type: 'string', desc: 'browser locale, e.g. ko-KR' },
  'dismiss-banners': { type: 'boolean', default: true, desc: 'click an obvious cookie/consent button before the other states (--no-dismiss-banners to skip)' },
  escape: { type: 'boolean', default: true, desc: 'press Escape and keep the shot only if the pixels changed (--no-escape to skip)' },
  'allow-private': { type: 'boolean', desc: 'let the page reach loopback, LAN and link-local addresses (default: only the target host); pages you trust only' },
  'no-sandbox': { type: 'boolean', desc: "start Chrome without its renderer sandbox (also MOTION_NO_SANDBOX=1, automatic as root on Linux); pages you trust only" },
  'project-launcher': { type: 'boolean', desc: "start the browser with the project's tools/studio.mjs launchBrowser (sandbox OFF); pages you trust only" },
  help: { type: 'boolean', alias: 'h', desc: 'show this help' },
};

export function usage() {
  return usageText(['Usage: node states.mjs <url> [options]', '',
    'Screenshots of the UI states of <url>: first view, Escape/consent result, scroll frames, one shot per --click, element crops',
    'with computed styles (--crop). Writes PNGs and states.json under assets/brand/states/<name>/ and prints one JSON line.',
    'Skills-only install: node "${CLAUDE_SKILL_DIR}/scripts/states.mjs" <url> --root <folder where playwright is installed>.'], SPEC);
}

/** Parsed command line: { flags, url, viewports }. The old `<outDir> <url>` positional order is still accepted. */
export function parseStatesArgs(argv) {
  const { flags, positionals } = parseFlags(argv, SPEC);
  if (flags.help) return { flags, url: null, viewports: [] };
  if (positionals.length === 2 && !flags.out) flags.out = positionals.shift();
  if (positionals.length !== 1) throw new UsageError(positionals.length ? 'expected exactly one <url>' : 'missing <url>');
  const viewports = flags.viewport === 'both' ? ['desktop', 'mobile'] : [flags.viewport];
  if (!viewports.every((v) => ['desktop', 'tablet', 'mobile'].includes(v))) throw new UsageError('--viewport must be desktop, tablet, mobile or both');
  return { flags, url: positionals[0], viewports };
}

/** Default output folder name: host plus path of the page, readable and file-safe. */
export function defaultName(urlHref) {
  const u = new URL(urlHref);
  let path0 = u.pathname === '/' ? '' : u.pathname;
  try { path0 = decodeURIComponent(path0); } catch { /* keep the escaped form */ }
  const raw = `${domainToUnicode(u.hostname) || u.hostname}${path0}`;
  return [...raw.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')].slice(0, 48).join('').replace(/-+$/, '') || 'page';
}

const msg = (e) => redactText(String((e && e.message) || e).split('\n')[0]);
const pngSize = (b) => (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : {});

// Marks the element that really scrolls (the window, or the tallest inner pane of an app shell) and reports which.
function markScroller() {
  const docScrolls = document.scrollingElement.scrollHeight > innerHeight + 200;
  const inner = docScrolls ? null : [...document.querySelectorAll('body *')].filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY)
    && el.scrollHeight > el.clientHeight + 200 && el.clientHeight > innerHeight * 0.5).sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  if (inner) inner.setAttribute('data-ms-scroller', '1');
  return inner ? 'inner pane' : docScrolls ? 'window' : 'none';
}
// Scrolls frame k (1-based, 0.9 of a screen each) and says whether the position moved.
function scrollFrame(k) {
  const el = document.querySelector('[data-ms-scroller]') || document.scrollingElement;
  const y = Math.round(k * el.clientHeight * 0.9);
  const prev = el.scrollTop;
  if (y >= el.scrollHeight - 40) return false;
  el.scrollTo(0, y);
  return el.scrollTop > prev + 10;
}
const scrollToTop = () => (document.querySelector('[data-ms-scroller]') || document.scrollingElement).scrollTo(0, 0);
function styleOf(el) {
  const s = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return { text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 160), bg: s.backgroundColor, color: s.color, radius: s.borderRadius, border: s.border,
    shadow: s.boxShadow === 'none' ? null : s.boxShadow, font: `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`, box: [r.x, r.y, r.width, r.height].map(Math.round) };
}

/**
 * Captures the states of one page. `opts`: { url, root, out (absolute), viewports, clicks, crops, fullPage, scrollFrames, wait, settle,
 * timeout, locale, dismissBanners, escape, allowPrivate, noSandbox, projectLauncher, log }. Writes the PNGs and states.json;
 * returns the states.json object (errors do not throw: they are listed in `errors`, `ok` is false).
 */
export async function captureStates(opts) {
  const { root, out, viewports, log = () => {} } = opts;
  const { target, guard } = makeGuard(opts.url, { allowPrivate: !!opts.allowPrivate });
  fs.mkdirSync(out, { recursive: true });
  const slug = makeSlugger(32);
  const shots = [];
  const crops = [];
  const notes = [];
  const errors = [];
  const save = (name, buf, meta, list) => {
    const file = path.join(out, name);
    fs.writeFileSync(file, buf);
    list.push({ file: relTo(root, file), bytes: buf.length, ...pngSize(buf), ...meta });
  };
  const { browser, via, sandbox, launcher } = await openBrowser(root, { noSandbox: !!opts.noSandbox, projectLauncher: !!opts.projectLauncher, log });
  await guard.protectBrowser(browser);
  try {
    for (const vp of viewports) {
      let opened;
      try { opened = await openPage(browser, target, guard, { viewport: vp, locale: opts.locale, timeout: opts.timeout, settle: opts.settle, notes }); } catch (e) { errors.push(msg(e)); continue; }
      const { context, page } = opened;
      const shot = async (state, extra = {}) => {
        const buf = await page.screenshot({ type: 'png', animations: 'disabled', ...extra });
        save(`${vp}-${state}.png`, buf, { viewport: vp, state }, shots);
        return buf;
      };
      try {
        const first = await shot('00-first');
        if (opts.dismissBanners) notes.push(bannerNote(vp, await dismissBanner(page)));
        if (opts.escape) {
          // Promo modals often cover the real product; Escape closes most. Keep the shot only if pixels changed.
          const before = page.url();
          await page.keyboard.press('Escape');
          await page.waitForTimeout(700);
          if (page.url() !== before) { notes.push(`${vp}: Escape navigated; went back`); await page.goBack({ waitUntil: 'load' }).catch(() => {}); }
        }
        const after = await page.screenshot({ type: 'png', animations: 'disabled' });
        if (!after.equals(first)) { save(`${vp}-01-escape.png`, after, { viewport: vp, state: '01-escape' }, shots); notes.push(`${vp}: the page changed after consent/Escape; compare 00-first and 01-escape`); }
        const scroller = await page.evaluate(markScroller);
        for (let i = 1; i <= opts.scrollFrames && scroller !== 'none'; i++) {
          if (!(await page.evaluate(scrollFrame, i))) break;
          await page.waitForTimeout(400);
          await shot(`scroll-${String(i).padStart(2, '0')}`);
        }
        await page.evaluate(scrollToTop);
        if (scroller === 'inner pane') notes.push(`${vp}: the page scrolls inside an inner pane, not the window; the scroll frames follow it`);
        if (opts.fullPage || (vp === 'mobile' && scroller === 'window')) {
          save(`${vp}-full.png`, await page.screenshot({ type: 'png', fullPage: true, animations: 'disabled' }), { viewport: vp, state: 'full' }, shots);
        }
        for (const [i, sel] of opts.clicks.entries()) {
          try {
            const loc = page.locator(sel).first();
            if (!(await loc.isVisible().catch(() => false))) { notes.push(`${vp}: click ${redactText(sel)}: not visible`); continue; }
            const url0 = page.url();
            await loc.click({ timeout: 4000 });
            await page.waitForTimeout(opts.wait);
            if (page.url() !== url0) notes.push(`${vp}: click ${redactText(sel)} navigated to ${redactUrl(page.url())}; the later states are on that page`);
            await shot(`${10 + i}-click-${slug(sel)}`);
          } catch (e) { errors.push(`${vp}: click ${redactText(sel)}: ${msg(e)}`); }
        }
        for (const [i, sel] of opts.crops.entries()) {
          try {
            const loc = page.locator(sel).first();
            if (!(await loc.isVisible().catch(() => false))) { notes.push(`${vp}: crop ${redactText(sel)}: not visible`); continue; }
            const style = await loc.evaluate(styleOf);
            save(`${vp}-crop-${20 + i}-${slug(sel)}.png`, await loc.screenshot({ type: 'png', animations: 'disabled', timeout: 6000 }), { viewport: vp, selector: sel, style }, crops);
          } catch (e) { errors.push(`${vp}: crop ${redactText(sel)}: ${msg(e)}`); }
        }
        const escaped = await escapeProblem(guard, vp);
        if (escaped) errors.push(escaped);
      } catch (e) {
        errors.push(`${vp}: ${guard.blocked.length ? `blocked: ${guard.blocked[0].url}; ` : ''}${msg(e)}`);
      } finally {
        await context.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  notes.push(...guard.notes());
  const result = {
    version: 1, tool: 'motion-studio product-reel states', url: target.display, via, launcher, sandbox, capturedAt: new Date().toISOString(),
    viewports, clicks: opts.clicks.map(redactText), cropSelectors: opts.crops.map(redactText), shots, crops,
    blocked: guard.blocked.slice(0, 20), notes: notes.map(redactText), errors,
    ok: errors.length === 0,
  };
  const file = path.join(out, 'states.json');
  writeFileAtomic(file, `${JSON.stringify(result, null, 2)}\n`);
  return { ...result, file: relTo(root, file) };
}

async function main(argv) {
  const { flags, url, viewports } = parseStatesArgs(argv);
  if (flags.help) { process.stdout.write(`${usage()}\n`); return 0; }
  const root = resolveRoot(flags.root);
  const { target } = makeGuard(url);
  const out = insideRoot(root, flags.out ?? path.join('assets', 'brand', 'states', flags.name ?? defaultName(target.url)));
  const log = (line) => process.stderr.write(`${line}\n`);
  log(`states: ${target.display} -> ${relTo(root, out)}`);
  const r = await captureStates({
    url, root, out, viewports, clicks: flags.click, crops: flags.crop, fullPage: flags['full-page'], scrollFrames: flags['scroll-frames'], wait: flags.wait,
    settle: flags.settle, timeout: flags.timeout, locale: flags.locale, dismissBanners: flags['dismiss-banners'], escape: flags.escape,
    allowPrivate: flags['allow-private'], noSandbox: flags['no-sandbox'], projectLauncher: flags['project-launcher'], log,
  });
  for (const n of r.notes) log(`note: ${n}`);
  for (const e of r.errors) log(`error: ${e}`);
  process.stdout.write(`${JSON.stringify({ ok: r.ok, states: r.file, shots: r.shots.length, crops: r.crops.length, blocked: r.blocked.length, via: r.via, sandbox: r.sandbox, notes: r.notes, errors: r.errors })}\n`);
  return r.ok ? 0 : 1;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    if (err instanceof UsageError) { process.stderr.write(`states: ${err.message}\n\n${usage()}\n`); process.exitCode = 2; return; }
    process.stderr.write(`states: ${redactText(err.message)}\n`);
    if (process.env.DEBUG) process.stderr.write(`${redactText(err.stack)}\n`);
    process.exitCode = 1;
  });
}
