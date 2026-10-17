// WebGL layers (lib/gl.js, lib/three-layer.js) and the software-GL browser policy.
//  1. pure helpers in Node: GLSL prelude, uniform conversion, hex colours, the exact distance transform, error annotation;
//  2. config + launch args: studio.json "gl" ("software" pins SwiftShader, "gpu" adds nothing);
//  3. browser (skips without playwright or a browser): boot the real runtime on a tiny GL film and check that a compile
//     error names the line, uniforms reach the shader, the same t hashes the same and another t differs, sdfText has the
//     right sign; threeLayer renders when three is resolvable (MOTION_THREE_DIR=<dir that holds node_modules/three>).
// Env: MOTION_TEMPLATE_DIR (test another template copy), MOTION_SMOKE_NODE_MODULES=<dir with playwright>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = process.env.MOTION_TEMPLATE_DIR ? path.resolve(process.env.MOTION_TEMPLATE_DIR) : path.join(REPO, 'skills', 'studio-init', 'template');
const S = await import(pathToFileURL(path.join(TEMPLATE, 'tools', 'studio.mjs')).href);
const GL = await import(pathToFileURL(path.join(TEMPLATE, 'lib', 'gl.js')).href);

function findNodeModules() {
  const env = process.env.MOTION_SMOKE_NODE_MODULES;
  if (env) return fs.existsSync(path.join(env, 'playwright')) || fs.existsSync(path.join(env, 'playwright-core')) ? path.resolve(env) : null;
  for (const base of [path.join(REPO, 'package.json'), path.join(TEMPLATE, 'package.json')]) {
    for (const name of ['playwright', 'playwright-core']) {
      try { return path.dirname(path.dirname(createRequire(base).resolve(`${name}/package.json`))); } catch { /* next */ }
    }
  }
  return null;
}

function findThree() {
  const bases = [process.env.MOTION_THREE_DIR && path.join(process.env.MOTION_THREE_DIR, 'package.json'), path.join(REPO, 'package.json')].filter(Boolean);
  // three's "exports" map hides package.json from require.resolve: look for the folder on the module search path.
  for (const base of bases) {
    for (const dir of createRequire(base).resolve.paths('three') ?? []) {
      if (fs.existsSync(path.join(dir, 'three', 'build', 'three.module.js'))) return path.join(dir, 'three');
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Pure helpers

test('gl buildFragment: prelude declares only the built-ins a shader uses, never twice, and keeps #version sources as is', () => {
  const src = 'void main() { fragColor = vec4(uTime, uP, 0.0, 1.0); }';
  const f = GL.buildFragment(src);
  assert.match(f, /^#version 300 es\n/);
  assert.match(f, /precision highp float;/);
  assert.match(f, /uniform float uTime;/);
  assert.match(f, /uniform float uP;/);
  assert.doesNotMatch(f, /uRes|uFrame|uDur|uLt/, 'unused built-ins are not declared');
  assert.match(f, /out vec4 fragColor;/);
  assert.match(f, /#line 1\n/, 'error lines count from the user source');
  const own = GL.buildFragment('uniform float uTime; out vec4 col; void main() { col = vec4(uTime); }');
  assert.equal((own.match(/uniform float uTime/g) || []).length, 1, 'a declared built-in is not declared again');
  assert.doesNotMatch(own, /out vec4 fragColor/, 'an own output is kept');
  const raw = '#version 300 es\nprecision mediump float;\nout vec4 o; void main() { o = vec4(1); }';
  assert.equal(GL.buildFragment(raw), raw);
});

test('gl uniformValue: the declared type decides the conversion; hex, booleans, arrays and matrices; mismatches throw', () => {
  assert.deepEqual(GL.uniformValue('a', 'float', 0.5), [0.5]);
  assert.deepEqual(GL.uniformValue('b', 'int', 2.6), [3]);
  assert.deepEqual(GL.uniformValue('c', 'bool', true), [1]);
  assert.deepEqual(GL.uniformValue('d', 'vec3', '#ff8000').map((x) => +x.toFixed(4)), [1, 0.502, 0]);
  assert.deepEqual(GL.uniformValue('e', 'vec2', [1, 2]), [1, 2]);
  assert.equal(GL.uniformValue('m', 'mat4', new Float32Array(16)).length, 16);
  assert.deepEqual(GL.uniformValue('arr', 'vec2', [[1, 2], [3, 4], [5, 6]], 3), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(GL.uniformValue('arr', 'float', [1, 2, 3, 4], 2), [1, 2], 'a shorter active array drops the unread tail');
  assert.deepEqual(GL.uniformValue('cols', 'vec3', ['#000000', '#ffffff'], 2), [0, 0, 0, 1, 1, 1]);
  assert.throws(() => GL.uniformValue('v', 'vec3', [1, 2]), /uniform v \(vec3\) needs 3 finite number/);
  assert.throws(() => GL.uniformValue('n', 'float', NaN), /finite/);
  assert.throws(() => GL.uniformValue('s', 'sampler2D', 1), /textures go in textures/);
  assert.throws(() => GL.hexToVec3('red'), /not a #rgb or #rrggbb/);
  assert.deepEqual(GL.hexToVec3('#fff'), [1, 1, 1]);
});

test('gl edt2d: exact squared Euclidean distances (brute force check) and no feature = INF', () => {
  const w = 23;
  const h = 17;
  const feat = new Uint8Array(w * h);
  for (const [x, y] of [[3, 4], [19, 2], [11, 15], [12, 15]]) feat[y * w + x] = 1;
  const d = GL.edt2d(feat, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = Infinity;
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (feat[j * w + i]) best = Math.min(best, (x - i) ** 2 + (y - j) ** 2);
      assert.equal(d[y * w + x], best, `(${x}, ${y})`);
    }
  }
  assert.ok(GL.edt2d(new Uint8Array(4), 2, 2).every((v) => v >= 1e20));
});

test('gl signedDistance: negative inside, positive outside, the outline half a pixel from the pixel centres', () => {
  const w = 21;
  const h = 21;
  const a = new Float32Array(w * h);
  for (let y = 5; y <= 15; y++) for (let x = 5; x <= 15; x++) a[y * w + x] = 1; // an 11x11 square
  const sd = GL.signedDistance(a, w, h);
  assert.ok(sd[10 * w + 10] < -4.9 && sd[10 * w + 10] > -5.6, `centre ${sd[10 * w + 10]}`);
  assert.equal(sd[10 * w + 5], -0.5, 'edge pixel inside');
  assert.equal(sd[10 * w + 4], 0.5, 'edge pixel outside');
  assert.equal(sd[10 * w + 0], 4.5);
  const empty = GL.signedDistance(new Float32Array(16), 4, 4);
  assert.ok(empty.every((v) => v > 0 && Number.isFinite(v)), 'no glyph: positive and finite');
});

test('gl annotateLog: compile errors quote the numbered user lines around the reported line', () => {
  const src = GL.buildFragment('void main() {\n  float x = 1.0;\n  fragColor = vec4(oops);\n}');
  const msg = GL.annotateLog("ERROR: 0:3: 'oops' : undeclared identifier", src, 'fragment');
  assert.match(msg, /fragment shader failed to compile/);
  assert.match(msg, />\s+3 \| {3}fragColor = vec4\(oops\);/);
  assert.match(msg, / {5}2 \| {3}float x = 1\.0;/);
});

test('gl GLSL chunks: sdf, raymarch (with map prototype, rayBox, marchBox), lighting, color, noise (loopable), text', () => {
  assert.ok(Object.isFrozen(GL.GLSL));
  for (const k of ['sdf', 'raymarch', 'lighting', 'color', 'noise', 'text']) assert.equal(typeof GL.GLSL[k], 'string', k);
  assert.match(GL.GLSL.sdf, /float smin\(float a, float b, float k\)/);
  assert.match(GL.GLSL.raymarch, /float map\(vec3 p\);/);
  assert.match(GL.GLSL.raymarch, /vec2 rayBox\(/);
  assert.match(GL.GLSL.raymarch, /float marchBox\(/);
  assert.match(GL.GLSL.lighting, /vec3 envStudio\(vec3 d\)/);
  assert.match(GL.GLSL.noise, /fract\(phase\)/, 'loopNoise wraps the phase so 0 and 1 are the same sample');
  assert.match(GL.GLSL.text, /float textSdf\(sampler2D tex, vec2 uv, float aspect\)/);
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Config and launch arguments

test('studio.json gl: software (default) pins SwiftShader, gpu adds nothing, anything else is a config error', () => {
  assert.equal(S.DEFAULTS.gl, 'software');
  assert.deepEqual(S.glArgs('software'), ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']);
  assert.deepEqual(S.glArgs(undefined), S.glArgs('software'));
  assert.deepEqual(S.glArgs('gpu'), []);
  const tpl = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'studio.json'), 'utf8'));
  assert.equal(tpl.gl, 'software');
  const bad = S.validateConfig({ ...S.deepMerge(S.DEFAULTS, {}), gl: 'metal' });
  const errs = Array.isArray(bad) ? bad : bad?.errors ?? [];
  assert.ok(errs.some((e) => /gl must be one of software, gpu/.test(e)), JSON.stringify(bad));
});

test('template index.html maps three and three/addons/ to node_modules (harmless when three is absent)', () => {
  const html = fs.readFileSync(path.join(TEMPLATE, 'index.html'), 'utf8');
  const m = /<script type="importmap">([^<]+)<\/script>/.exec(html);
  assert.ok(m, 'an importmap');
  const map = JSON.parse(m[1]);
  assert.equal(map.imports.three, './node_modules/three/build/three.module.js');
  assert.equal(map.imports['three/addons/'], './node_modules/three/examples/jsm/');
  assert.ok(html.indexOf('importmap') < html.indexOf('type="module"'), 'the importmap precedes the module script');
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Browser

const GL_FILM = `import { defineFilm, scene } from '../lib/timeline.js';
import { glLayer, sdfText, GLSL, glInfo } from '../lib/gl.js';
const frag = GLSL.sdf + \`
uniform vec3 uColor;
uniform float uR;
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float d = length(p - vec2(0.3 * sin(6.2831853 * uTime), 0.0)) - uR;
  fragColor = vec4(mix(uColor, vec3(0.05), smoothstep(0.0, 0.004, d)), 1.0);
}\`;
const layer = glLayer({ name: 'test', frag, uniforms: (t) => ({ uColor: '#d97757', uR: 0.2 + 0.05 * t, unusedIsIgnored: 3 }) });
window.__gltest = { glLayer, sdfText, glInfo, GLSL };
export default defineFilm(() => ({ background: '#000000', scenes: [scene(0, 2, 'gl', layer.draw)] }));
`;

async function withFilm(t, film, fn, { three = null } = {}) {
  const nm = findNodeModules();
  if (!nm) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-gl-'));
  fs.writeFileSync(path.join(root, 'studio.json'), JSON.stringify({ title: 'GL', duration: 2, fps: 10, subframes: 1, formats: ['1x1'], primaryFormat: '1x1', capture: 'canvas', gate: { enabled: false } }));
  fs.copyFileSync(path.join(TEMPLATE, 'index.html'), path.join(root, 'index.html'));
  fs.cpSync(path.join(TEMPLATE, 'lib'), path.join(root, 'lib'), { recursive: true });
  fs.cpSync(path.join(TEMPLATE, 'assets', 'fonts'), path.join(root, 'assets', 'fonts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'film'));
  fs.writeFileSync(path.join(root, 'film', 'film.js'), film);
  // A real node_modules folder: playwright and (optionally) three are linked in, so /node_modules/three/... is served.
  fs.mkdirSync(path.join(root, 'node_modules'));
  const links = [];
  for (const name of ['playwright', 'playwright-core']) {
    if (!fs.existsSync(path.join(nm, name))) continue;
    const l = path.join(root, 'node_modules', name);
    fs.symlinkSync(path.join(nm, name), l, process.platform === 'win32' ? 'junction' : 'dir');
    links.push(l);
  }
  if (three) {
    const l = path.join(root, 'node_modules', 'three');
    fs.symlinkSync(three, l, process.platform === 'win32' ? 'junction' : 'dir');
    links.push(l);
  }
  const srv = await S.startServer(root);
  let browser = null;
  try {
    try { ({ browser } = await S.launchBrowser(root, S.loadConfig(root))); } catch (err) { t.skip(`no browser: ${String(err.message).split('\n')[0]}`); return; }
    const webgl2 = await (async () => { const p = await browser.newPage(); try { return await p.evaluate(() => !!document.createElement('canvas').getContext('webgl2')); } finally { await p.close(); } })();
    if (!webgl2) { t.skip('this browser has no WebGL2'); return; }
    await fn(browser, srv.url);
  } finally {
    if (browser) await browser.close();
    await srv.close();
    for (const l of links) { try { fs.unlinkSync(l); } catch { try { fs.rmdirSync(l); } catch { /* gone */ } } }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    assert.ok(fs.existsSync(nm), 'shared node_modules untouched');
  }
}

test('browser: a glLayer film is deterministic, uniforms reach the shader, software GL is SwiftShader', { timeout: 240000 }, async (t) => {
  await withFilm(t, GL_FILM, async (browser, url) => {
    const film = await S.openFilm(browser, url, { format: '1x1', scale: 0.25 });
    try {
      assert.deepEqual(film.errors.page, []);
      const r = await film.page.evaluate(async () => {
        const s = window.__studio;
        const h = [await s.hash(0.3), await s.hash(0.7), await s.hash(0.3)];
        s.seek(0);
        const cv = document.getElementById('stage');
        const g = cv.getContext('2d', { willReadFrequently: true });
        const c = g.getImageData(cv.width >> 1, cv.height >> 1, 1, 1).data;
        return { h, centre: Array.from(c), info: window.__gltest.glInfo() };
      });
      assert.equal(r.h[0], r.h[2], 'the same t gives the same pixels');
      assert.notEqual(r.h[0], r.h[1], 'another t gives other pixels');
      assert.deepEqual(r.centre.slice(0, 3), [217, 119, 87], 'uColor #d97757 at the circle centre (t = 0)');
      assert.match(r.info.renderer, /swiftshader/i, `software GL (studio.json gl: software): ${r.info.renderer}`);
      assert.equal(r.info.software, true);
    } finally { await film.context.close(); }
  });
});

test('browser: compile errors name the user line; sdfText is negative inside the glyph and positive outside', { timeout: 240000 }, async (t) => {
  await withFilm(t, GL_FILM, async (browser, url) => {
    const film = await S.openFilm(browser, url, { format: '1x1', scale: 0.25 });
    try {
      const r = await film.page.evaluate(() => {
        const { glLayer, sdfText } = window.__gltest;
        let err = '';
        const bad = glLayer({ name: 'bad', frag: 'void main() {\n  fragColor = vec4(nope);\n}' });
        try { bad.draw(document.getElementById('stage').getContext('2d'), 0, { W: 64, H: 64, t: 0 }); } catch (e) { err = String(e.message); }
        const tex = sdfText('I', { font: 'Inter', weight: 800, size: 120, pad: 30 });
        const at = (x, y) => tex.data[(tex.height - 1 - y) * tex.width + x]; // rows are bottom-up
        return { err, w: tex.width, h: tex.height, centre: at(tex.width >> 1, tex.height >> 1), corner: at(1, 1), aspect: tex.aspect, same: sdfText('I', { font: 'Inter', weight: 800, size: 120, pad: 30 }) === tex };
      });
      assert.match(r.err, /glLayer "bad": fragment shader failed to compile/);
      assert.match(r.err, />\s+2 \| {3}fragColor = vec4\(nope\);/);
      assert.ok(r.centre < 0, `inside the I: ${r.centre}`);
      assert.ok(r.corner > 0.1, `the corner is outside, in texture-height units: ${r.corner}`);
      assert.ok(Math.abs(r.aspect - r.w / r.h) < 1e-12);
      assert.equal(r.same, true, 'memoized per argument set');
    } finally { await film.context.close(); }
  });
});

const THREE_FILM = `import * as THREE from 'three';
import { defineFilm, scene } from '../lib/timeline.js';
import { threeLayer, studioEnv } from '../lib/three-layer.js';
const hero = threeLayer(THREE, {
  setup: ({ scene: s, renderer }) => {
    s.environment = studioEnv(THREE, renderer);
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: '#F4F1EC', roughness: 0.38 }));
    s.add(m, new THREE.DirectionalLight('#ffffff', 2));
    return { m };
  },
  update: (t, { camera, state }) => { state.m.rotation.set(0.4, t * 2, 0); camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0); },
});
export default defineFilm(() => ({ background: '#101010', scenes: [scene(0, 2, 'three', hero.draw)] }));
`;

test('browser: threeLayer renders a deterministic Three.js scene through the importmap (skips without three)', { timeout: 240000 }, async (t) => {
  const three = findThree();
  if (!three) { t.skip('three is not resolvable (npm i -E three@0.160.0, or set MOTION_THREE_DIR)'); return; }
  await withFilm(t, THREE_FILM, async (browser, url) => {
    const film = await S.openFilm(browser, url, { format: '1x1', scale: 0.25 });
    try {
      assert.deepEqual(film.errors.page, []);
      const r = await film.page.evaluate(async () => {
        const s = window.__studio;
        const h = [await s.hash(0.5), await s.hash(1.0), await s.hash(0.5)];
        s.seek(0.5);
        const cv = document.getElementById('stage');
        const c = cv.getContext('2d', { willReadFrequently: true }).getImageData(cv.width >> 1, cv.height >> 1, 1, 1).data;
        return { h, centre: Array.from(c) };
      }, { timeout: 120000 });
      assert.equal(r.h[0], r.h[2], 'the same t gives the same pixels');
      assert.notEqual(r.h[0], r.h[1]);
      assert.ok(r.centre[0] > 60, `the lit box covers the centre (not the #101010 background): ${r.centre}`);
    } finally { await film.context.close(); }
  }, { three });
});
