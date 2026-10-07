// Shared helpers of test/capture-states.test.mjs, capture-canvas.test.mjs and capture-brand.test.mjs (not a test file and kept outside test/: node --test
// runs every loadable JS below test/). A local page served by node:http that has what the capture tools care about: a text wordmark in a
// webfont with two colors, a canvas that animates and changes on a click, a button that changes state, a Korean cookie banner on
// desktop, a long body that scrolls, and requests to a second (internal) server. No network, no real site.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCRIPTS = path.join(REPO, 'skills', 'product-reel', 'scripts');
const TEMPLATE = process.env.MOTION_TEMPLATE_DIR ? path.resolve(process.env.MOTION_TEMPLATE_DIR) : path.join(REPO, 'skills', 'studio-init', 'template');
export const bundledFont = (name) => fs.readFileSync(path.join(TEMPLATE, 'assets', 'fonts', name));

export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// ---- temp dirs --------------------------------------------------------------------------------------------------------
const made = new Set();
export const tmp = (prefix = 'ms-capture-') => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.add(dir); return dir; };
/** Removes a temp dir; a link to a shared node_modules is unlinked first, never followed. */
export function rmTree(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const p = path.join(dir, name);
    let link = false;
    try { link = fs.lstatSync(p).isSymbolicLink(); } catch { /* vanished */ }
    if (!link) continue;
    try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch { return; } } // could not unlink: leak the dir rather than recurse into a shared folder
  }
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* the OS temp cleanup takes it */ }
}
export const cleanup = () => { for (const dir of made) rmTree(dir); made.clear(); };

// ---- playwright and processes -----------------------------------------------------------------------------------------
export function findNodeModules() {
  const env = process.env.MOTION_SMOKE_NODE_MODULES;
  if (env) return fs.existsSync(path.join(env, 'playwright')) || fs.existsSync(path.join(env, 'playwright-core')) ? path.resolve(env) : null;
  for (const base of [path.join(REPO, 'package.json'), path.join(TEMPLATE, 'package.json')]) {
    for (const name of ['playwright', 'playwright-core']) {
      try { return path.dirname(path.dirname(createRequire(base).resolve(`${name}/package.json`))); } catch { /* next */ }
    }
  }
  return null;
}

/** A project folder with studio.json and a link to the shared node_modules, or null when playwright is not resolvable. */
export function browserProject(studioJson = '{}') {
  const nm = findNodeModules();
  if (!nm) return null;
  const root = tmp('ms-capture-e2e-');
  fs.writeFileSync(path.join(root, 'studio.json'), studioJson);
  fs.symlinkSync(nm, path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return root;
}

export const runNode = (args, cwd, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => resolve({ code, out, err }));
});
/** True when the run could not start a browser at all (skip, do not fail). */
export const noBrowser = (r) => /could not launch a browser|no browser could be launched|playwright is not installed/.test(r.err);

export const listen = (handler) => new Promise((resolve) => { const srv = http.createServer(handler); srv.listen(0, '127.0.0.1', () => resolve(srv)); });
export const closeServer = (srv) => new Promise((resolve) => { srv.closeAllConnections?.(); srv.close(() => resolve()); });

// ---- the fixture page -------------------------------------------------------------------------------------------------
export const CANVAS_A = [32, 64, 128]; // #204080
export const CANVAS_B = [128, 32, 64]; // #802040

/**
 * @param {object} [o]
 * @param {number|null} [o.internalPort] a second server on 127.0.0.1 that the page tries to reach (must be refused)
 * @param {string|null} [o.auth] expected Authorization header (the page answers 401 without it)
 * @param {string[]} [o.hits] receives every request path
 * @returns {Promise<http.Server>}
 */
export function startSite({ internalPort = null, auth = null, hits = [] } = {}) {
  const inter = bundledFont('inter-100-900-latin.woff2');
  const serif = bundledFont('instrument-serif-400-latin.woff2');
  return listen((req, res) => {
    hits.push({ url: req.url, auth: req.headers.authorization || null });
    if (auth && req.headers.authorization !== auth) { res.writeHead(401, { 'www-authenticate': 'Basic realm="staging"' }); return res.end('login required'); }
    const path0 = new URL(req.url, 'http://x').pathname;
    if (path0 === '/px.woff2' || path0 === '/px-bold.woff2') { res.writeHead(200, { 'content-type': 'font/woff2' }); return res.end(inter); }
    if (path0 === '/other.woff2') { res.writeHead(200, { 'content-type': 'font/woff2' }); return res.end(serif); }
    if (path0 === '/logo.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
    if (path0 === '/agreed') { res.writeHead(204); return res.end(); }
    if (path0 === '/with-logo') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(logoPage()); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(homePage({ internalPort }));
  });
}

function logoPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Logo Co</title><style>body{margin:0;font:16px sans-serif}</style></head>
<body><header><a class="brand" href="/"><img src="/logo.png" width="48" height="48" alt="Logo Co logo"></a></header><h1>Logo Co</h1><p>A page with a logo image.</p></body></html>`;
}

function homePage({ internalPort }) {
  const internal = internalPort ? `<img src="http://127.0.0.1:${internalPort}/pixel.png" width="20" height="20"><link rel="prerender" href="http://127.0.0.1:${internalPort}/prerender-link"><script type="speculationrules">{"prefetch":[{"source":"list","urls":["/next"]}]}</script>
<script>try { new WebSocket('ws://127.0.0.1:${internalPort}/ws'); } catch (e) {} try { new SharedWorker(URL.createObjectURL(new Blob(["fetch('http://127.0.0.1:${internalPort}/from-shared', { mode: 'no-cors' })"]))); } catch (e) {}</script>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pixel Studio | demo</title>
<style>
@font-face{font-family:"Px Mono";font-weight:400;src:url(/px.woff2) format("woff2")}
@font-face{font-family:"Px Mono";font-weight:700;src:url(/px-bold.woff2) format("woff2")}
@font-face{font-family:"Other Face";font-weight:400;src:url(/other.woff2) format("woff2")}
body{margin:0;background:#101426;color:#eef1ff;font-family:-apple-system,BlinkMacSystemFont,sans-serif}
header{display:flex;gap:16px;align-items:center;padding:12px 20px}
.brand{font:700 32px/1 "Px Mono";letter-spacing:2px;color:#cfd8ff;text-decoration:none}
.brand span{color:#5b8cff}
nav a{color:#9aa4b6;margin-left:14px;text-decoration:none}
h1{font:400 40px "Other Face";margin:16px 20px}
p{font:400 16px "Px Mono";margin:8px 20px}
.card{padding:12px;margin:8px 20px;border:1px solid #999;width:260px}
#screen{box-sizing:border-box;width:200px;height:150px;border:2px solid #fff;margin:20px}
#screen canvas{display:block;width:100%;height:100%;image-rendering:pixelated}
button{margin:0 20px;padding:8px 14px}
#state{margin-left:12px}
.spacer{height:2600px}
</style></head><body>
<header><a class="brand" href="/">px<span>studio</span></a><nav><a href="/docs">Docs</a><a href="/price">Pricing</a></nav></header>
<main><h1>Pixel Studio</h1><p>A demo page for the capture tools.</p>
<div class="card" style="background:#223">구동 보고</div><div class="card" style="background:#322">인사이트</div>
<div id="screen"><canvas id="cv" width="64" height="48" aria-label="demo screen"></canvas></div>
<button id="mode" type="button">Mode A</button><span id="state">home</span>
${internal}
<div class="spacer"></div></main>
<script>
let mode = 'A';
const g = document.getElementById('cv').getContext('2d');
function draw() {
  g.fillStyle = mode === 'A' ? '#204080' : '#802040';
  g.fillRect(0, 0, 64, 48);
  g.fillStyle = '#ffffff';
  g.fillRect(Math.floor(performance.now() / 33) % 56, 20, 8, 8);
}
draw();
setInterval(draw, 8);
document.getElementById('mode').onclick = function () { mode = mode === 'A' ? 'B' : 'A'; this.textContent = 'Mode ' + mode; document.getElementById('state').textContent = 'mode-' + mode.toLowerCase(); };
if (screen.width > 600) {
  const d = document.createElement('div'); d.className = 'cookie-banner';
  d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;background:#222;color:#fff;padding:16px';
  const a = document.createElement('button'); a.textContent = '설정';
  const b = document.createElement('button'); b.textContent = '모두 허용'; b.onclick = () => { fetch('/agreed'); d.remove(); };
  d.append(a, ' ', b); document.body.append(d);
}
</script></body></html>`;
}
