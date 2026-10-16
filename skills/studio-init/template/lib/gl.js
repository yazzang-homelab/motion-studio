// lib/gl.js (browser) — WebGL2 shader layers inside a seek(t) film. A layer is a fragment shader drawn into its own
// offscreen WebGL2 canvas and composited into the stage's 2D canvas with drawImage, so 3D, SDF raymarching, liquid metal
// and shader backgrounds sit in the same scene list, beat grid and critique loop as the 2D code.
//
// The render contract holds: a frame is a function of the uniforms, and the uniforms are a function of time only
// (uTime = c.t, plus whatever uniforms(t, c, lt) returns, typically springs from lib/motion.js computed in JavaScript).
// Determinism needs one GL backend on every machine: studio.json "gl": "software" (the default) starts Chrome on
// SwiftShader, dithering is off, MSAA is off and floats are highp. See skills/gl-scenes/SKILL.md.
//
//   const blob = glLayer({ frag, uniforms: (t, c, lt) => ({ uSquash: sp(lt - 1.2, 'snappy') }) });
//   scene(0, 6, 'blob', blob.draw)           // draw(g, lt, c), the scene draw signature
//
// GLSL chunks (GLSL.sdf, GLSL.raymarch, ...) are plain strings: concatenate the ones a shader needs before its own code.

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Built-in uniforms: declared by the prelude only when the shader mentions them and does not declare them itself.
const BUILTINS = Object.freeze([
  ['uTime', 'float'], // film time c.t (the subframe time when motion blur is on)
  ['uLt', 'float'], // scene-local time
  ['uP', 'float'], // scene progress 0..1
  ['uFrame', 'int'], // output frame index (the same for every subframe of one frame)
  ['uRes', 'vec2'], // GL canvas size in device pixels
  ['uDur', 'float'], // film length in seconds
]);

const even = (n) => Math.max(2, 2 * Math.round(n / 2));
const declares = (src, name) => new RegExp(`\\buniform\\s+\\w+\\s+${name}\\b`).test(src);
const mentions = (src, name) => new RegExp(`\\b${name}\\b`).test(src);

/** The fragment source the layer compiles: `src` as is when it starts with #version, else prelude + src. */
export function buildFragment(src) {
  const s = String(src ?? '');
  if (/^\s*#version/.test(s)) return s;
  const lines = ['#version 300 es', 'precision highp float;', 'precision highp int;', 'precision highp sampler2D;'];
  for (const [name, type] of BUILTINS) if (mentions(s, name) && !declares(s, name)) lines.push(`uniform ${type} ${name};`);
  if (!/\bout\s+(?:highp\s+|mediump\s+|lowp\s+)?vec4\s+\w+\s*;/.test(s)) lines.push('out vec4 fragColor;');
  return `${lines.join('\n')}\n#line 1\n${s}`;
}

/** '#rgb' | '#rrggbb' → [r, g, b] in 0..1, still sRGB-encoded (decode in GLSL with toLinear() before lighting). */
export function hexToVec3(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`gl: "${hex}" is not a #rgb or #rrggbb color`);
  const h = m[1].length === 3 ? m[1].replace(/./g, (x) => x + x) : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

/** Compile/link log → message with the numbered source lines around each reported line (ANGLE: "ERROR: 0:12: ..."). */
export function annotateLog(log, source, stage) {
  const lines = String(source).split('\n');
  // #line 1 after the prelude: user line n is source line (preludeLines + n). Report user numbering when present.
  const at = lines.findIndex((l) => l === '#line 1');
  const offset = at >= 0 ? at + 1 : 0;
  const nums = [...String(log).matchAll(/\b\d+:(\d+):/g)].map((m) => Number(m[1])).filter((n) => n > 0);
  const out = [`gl: ${stage} shader failed to compile:`, String(log).trim()];
  for (const n of [...new Set(nums)].slice(0, 4)) {
    out.push('');
    for (let k = Math.max(1, n - 2); k <= Math.min(lines.length - offset, n + 2); k++) out.push(`${k === n ? '>' : ' '}${String(k).padStart(5)} | ${lines[offset + k - 1]}`);
  }
  return out.join('\n');
}

function compile(gl, type, src, stage) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(annotateLog(log, src, stage));
  }
  return sh;
}

function program(gl, frag) {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT, 'vertex');
  const fs = compile(gl, gl.FRAGMENT_SHADER, frag, 'fragment');
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`gl: program failed to link:\n${gl.getProgramInfoLog(p)}`);
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
// Uniform values. The shader's own declared type decides the call, so a JS number feeds a float, an int or a bool
// uniform alike, and a '#rrggbb' string feeds a vec3.

const flat = (v) => (Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v, Number) : [Number(v)]);

/**
 * Normalize a JS value for a uniform of GL type name ('float', 'vec3', 'mat4', 'int', 'bool', ...) and array length
 * `size` (uniform vec2 uDrop[6] → size 6: pass 6 [x, y] pairs or 12 numbers). Throws on a mismatch.
 */
export function uniformValue(name, type, v, size = 1) {
  let x = v;
  if (typeof x === 'string') x = hexToVec3(x);
  if (typeof x === 'boolean') x = x ? 1 : 0;
  if (Array.isArray(x)) x = x.flatMap((e) => (typeof e === 'string' ? hexToVec3(e) : typeof e === 'boolean' ? [e ? 1 : 0] : Array.isArray(e) || ArrayBuffer.isView(e) ? Array.from(e) : [e]));
  const want = { float: 1, int: 1, bool: 1, vec2: 2, vec3: 3, vec4: 4, ivec2: 2, ivec3: 3, ivec4: 4, mat2: 4, mat3: 9, mat4: 16 }[type];
  if (!want) throw new Error(`gl: uniform ${name} has type ${type}, which uniforms() cannot set (textures go in textures: {...})`);
  // The compiler may report a shorter active array than declared (trailing elements never read): extra values are dropped.
  const all = flat(x);
  const n = want * size;
  const arr = size > 1 && all.length > n && all.length % want === 0 ? all.slice(0, n) : all;
  if (arr.length !== n || arr.some((q) => !Number.isFinite(q))) throw new Error(`gl: uniform ${name} (${type}${size > 1 ? `[${size}]` : ''}) needs ${n} finite number(s), got ${JSON.stringify(v)}`);
  return /^(int|bool|ivec)/.test(type) ? arr.map((q) => Math.round(q)) : arr;
}

function glTypeName(gl, t) {
  const T = { [gl.FLOAT]: 'float', [gl.FLOAT_VEC2]: 'vec2', [gl.FLOAT_VEC3]: 'vec3', [gl.FLOAT_VEC4]: 'vec4', [gl.INT]: 'int', [gl.BOOL]: 'bool',
    [gl.INT_VEC2]: 'ivec2', [gl.INT_VEC3]: 'ivec3', [gl.INT_VEC4]: 'ivec4', [gl.FLOAT_MAT2]: 'mat2', [gl.FLOAT_MAT3]: 'mat3', [gl.FLOAT_MAT4]: 'mat4',
    [gl.SAMPLER_2D]: 'sampler2D' };
  return T[t] || `0x${t.toString(16)}`;
}

function setUniform(gl, u, arr) {
  const { loc, type } = u;
  switch (type) {
    case 'float': return gl.uniform1fv(loc, arr);
    case 'vec2': return gl.uniform2fv(loc, arr);
    case 'vec3': return gl.uniform3fv(loc, arr);
    case 'vec4': return gl.uniform4fv(loc, arr);
    case 'int': case 'bool': return gl.uniform1iv(loc, arr);
    case 'ivec2': return gl.uniform2iv(loc, arr);
    case 'ivec3': return gl.uniform3iv(loc, arr);
    case 'ivec4': return gl.uniform4iv(loc, arr);
    case 'mat2': return gl.uniformMatrix2fv(loc, false, arr);
    case 'mat3': return gl.uniformMatrix3fv(loc, false, arr);
    case 'mat4': return gl.uniformMatrix4fv(loc, false, arr);
    default: return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Signed distance fields of text (for extruded type in a raymarcher).

const INF = 1e20;

/** Felzenszwalb–Huttenlocher 1D squared-distance transform of f (length n) into d, with scratch v (Int32) and z (Float64). */
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * Exact squared Euclidean distance (in pixels²) from every pixel to the nearest pixel where feature[i] is true.
 * Rows then columns (separable), O(w·h). No feature at all gives INF everywhere.
 */
export function edt2d(feature, w, h) {
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = feature[i] ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
  }
  return grid;
}

/**
 * Signed distance in pixels from a coverage mask (alpha 0..1 per pixel): negative inside (alpha ≥ 0.5), positive
 * outside, with the half-pixel edge offset so the zero crossing sits on the glyph outline.
 */
export function signedDistance(alpha, w, h) {
  const inside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inside[i] = alpha[i] >= 0.5 ? 1 : 0;
  const toInside = edt2d(inside, w, h);
  const toOutside = edt2d(inside.map((x) => 1 - x), w, h);
  const out = new Float32Array(w * h);
  const far = Math.hypot(w, h);
  for (let i = 0; i < w * h; i++) {
    // Pixel centres: the outline sits half a pixel from the nearest pixel of the other side.
    const d = inside[i] ? -(Math.sqrt(toOutside[i]) - 0.5) : Math.sqrt(toInside[i]) - 0.5;
    out[i] = Math.max(-far, Math.min(far, d)); // an all-inside or all-outside mask has no outline: clamp the INF
  }
  return out;
}

const sdfCache = new Map();

/**
 * Signed distance field of one line of text, for textures: { uText: sdfText('MOTION', {...}) }. Distances are in units
 * of the texture height (negative inside), rows stored bottom-up so texture(uText, uv) takes uv with y up like
 * gl_FragCoord. Sample it with GLSL.text's textSdf(uText, uv, aspect), which is exact outside the texture too.
 * Uses a bundled font: brand fonts are loaded before the film builds, so calling this in the film factory, setup or a
 * draw is fine; a family that is not loaded draws in a fallback face (check with npm run critique's font check).
 * Options: font (family) = 'Inter', weight = 700, size = 160 (px of the raster), pad = 0.35·size, letterSpacing = 0 (px),
 * width/height (px, default: fit the text). Deterministic and memoized per argument set.
 */
export function sdfText(text, { font = 'Inter', weight = 700, style = 'normal', size = 160, pad = null, letterSpacing = 0, width = null, height = null } = {}) {
  const str = String(text);
  if (!str.trim()) throw new Error('sdfText: text is empty');
  const p = pad == null ? Math.round(size * 0.35) : Math.max(0, Math.round(pad));
  const key = JSON.stringify([str, font, weight, style, size, p, letterSpacing, width, height]);
  const hit = sdfCache.get(key);
  if (hit) return hit;
  const cv = document.createElement('canvas');
  const g = cv.getContext('2d', { willReadFrequently: true });
  const css = `${style} ${weight} ${size}px "${font}"`;
  g.font = css;
  if ('letterSpacing' in g) g.letterSpacing = `${letterSpacing}px`;
  const m = g.measureText(str);
  const asc = m.actualBoundingBoxAscent;
  const desc = m.actualBoundingBoxDescent;
  const left = m.actualBoundingBoxLeft;
  const inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
  const w = Math.round(width ?? Math.ceil(inkW) + 2 * p);
  const h = Math.round(height ?? Math.ceil(asc + desc) + 2 * p);
  cv.width = w;
  cv.height = h;
  g.font = css; // resizing a canvas resets its state
  if ('letterSpacing' in g) g.letterSpacing = `${letterSpacing}px`;
  g.fillStyle = '#fff';
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  // Centre the ink box in the texture.
  g.fillText(str, (w - inkW) / 2 + left, (h - (asc + desc)) / 2 + asc);
  const px = g.getImageData(0, 0, w, h).data;
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = px[i * 4 + 3] / 255;
  const sd = signedDistance(alpha, w, h);
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[(h - 1 - y) * w + x] = sd[y * w + x] / h; // bottom-up, height units
  const out = Object.freeze({ kind: 'sdf', text: str, font: css, width: w, height: h, aspect: w / h, data });
  sdfCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Layers

let infoCache = null;

/** { renderer, version, software } of this page's WebGL2 (SwiftShader when studio.json "gl" is "software"), or null. */
export function glInfo() {
  if (infoCache) return infoCache;
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return null;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  infoCache = Object.freeze({ renderer, version: String(gl.getParameter(gl.VERSION)), software: /swiftshader/i.test(renderer) });
  const lose = gl.getExtension('WEBGL_lose_context');
  if (lose) lose.loseContext();
  return infoCache;
}

function uploadTexture(gl, unit, desc, name) {
  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  if (desc && desc.kind === 'sdf') {
    // R32F when it can be filtered (OES_texture_float_linear; SwiftShader has it): half floats quantize the distance
    // enough to streak the normals of bevelled type. R16F is filterable in core WebGL2 and is the fallback.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const f32 = !!gl.getExtension('OES_texture_float_linear');
    gl.texImage2D(gl.TEXTURE_2D, 0, f32 ? gl.R32F : gl.R16F, desc.width, desc.height, 0, gl.RED, gl.FLOAT, desc.data);
  } else if (desc && typeof desc === 'object' && 'width' in desc && 'height' in desc) {
    // A canvas, image or ImageBitmap: uploaded once, y flipped so uv has y up like gl_FragCoord.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, desc);
  } else throw new Error(`gl: texture ${name} must be an sdfText() result, a canvas, an image or an ImageBitmap`);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/**
 * A fragment-shader layer. Options:
 *   frag      GLSL ES 3.00 fragment source (prelude added unless it starts with #version; write fragColor)
 *   uniforms  (t, c, lt) => ({ name: value }): number, boolean, [2..4], 4/9/16-length matrices, '#rrggbb'
 *   textures  { name: sdfText(...) | canvas | image } bound to sampler2D uniforms; <name>Size (vec2) and
 *             <name>Aspect (float) are set too when the shader declares them
 *   scale     GL resolution relative to the stage (0.5 for drafts; the 2D canvas upsamples)
 *   name      label for error messages
 * Returns { draw(g, lt, c), dispose(), canvas, frag }. draw paints the layer over the frame at (0, 0, c.W, c.H) in
 * the current 2D transform; it can be passed directly as a scene draw.
 */
export function glLayer({ frag, uniforms = null, textures = null, scale = 1, name = 'gl' } = {}) {
  if (typeof frag !== 'string' || !frag.trim()) throw new Error(`glLayer "${name}": frag must be GLSL source`);
  if (uniforms != null && typeof uniforms !== 'function') throw new Error(`glLayer "${name}": uniforms must be (t, c, lt) => ({...})`);
  if (!(scale > 0 && scale <= 4)) throw new Error(`glLayer "${name}": scale must be in (0, 4] (got ${scale})`);
  const source = buildFragment(frag);
  let st = null; // { canvas, gl, prog, uni: Map<name,{loc,type}>, tex: Map<name,unit> }

  function init() {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, premultipliedAlpha: false, alpha: true, depth: false, stencil: false, powerPreference: 'low-power' });
    if (!gl) throw new Error(`glLayer "${name}": WebGL2 is not available in this browser (npm run doctor shows the GL renderer; keep studio.json "gl": "software")`);
    let prog;
    try { prog = program(gl, source); } catch (err) { throw new Error(`glLayer "${name}": ${String(err.message).replace(/^gl: /, '')}`); }
    gl.useProgram(prog);
    gl.disable(gl.DITHER); // dithering is implementation-defined: it would change pixels between GL drivers
    gl.disable(gl.BLEND);
    const uni = new Map();
    const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(prog, i);
      const nm = info.name.replace(/\[0\]$/, '');
      uni.set(nm, { loc: gl.getUniformLocation(prog, info.name), type: glTypeName(gl, info.type), size: info.size });
    }
    const tex = new Map();
    let unit = 0;
    for (const [tn, desc] of Object.entries(textures || {})) {
      const u = uni.get(tn);
      if (!u) continue; // declared but unused samplers are optimized out
      if (u.type !== 'sampler2D') throw new Error(`glLayer "${name}": texture ${tn} is declared as ${u.type}, not sampler2D`);
      uploadTexture(gl, unit, desc, tn);
      gl.uniform1i(u.loc, unit);
      tex.set(tn, desc);
      unit++;
    }
    st = { canvas, gl, prog, uni, tex };
  }

  const set = (nm, v) => {
    const u = st.uni.get(nm);
    if (!u || u.type === 'sampler2D') return;
    setUniform(st.gl, u, uniformValue(nm, u.type, v, u.size));
  };

  const draw = (g, lt, c) => {
    if (!c || !(c.W > 0) || !(c.H > 0)) throw new Error(`glLayer "${name}": draw(g, lt, c) needs the scene context c`);
    if (!st) init();
    const { gl, canvas } = st;
    if (gl.isContextLost()) throw new Error(`glLayer "${name}": the WebGL context was lost (GPU reset or too many contexts); re-render this frame`);
    const T = typeof g.getTransform === 'function' ? g.getTransform() : { a: 1, d: 1 };
    const w = even(Math.abs(T.a || 1) * c.W * scale);
    const h = even(Math.abs(T.d || 1) * c.H * scale);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(st.prog);
    const t = Number(c.t ?? lt) || 0;
    const film = c.film || {};
    set('uTime', t);
    set('uLt', Number(lt) || 0);
    set('uP', Number(c.p) || 0);
    set('uFrame', Number(c.frame) || 0);
    set('uRes', [w, h]);
    set('uDur', Number(film.dur ?? c.dur) || 0);
    for (const [tn, desc] of st.tex) {
      const dw = desc.width;
      const dh = desc.height;
      set(`${tn}Size`, [dw, dh]);
      set(`${tn}Aspect`, dw / dh);
    }
    if (uniforms) {
      const vals = uniforms(t, c, lt);
      if (vals && typeof vals === 'object') {
        for (const [k, v] of Object.entries(vals)) {
          if (!st.uni.has(k)) continue; // unused uniforms are optimized out by the compiler: not an error
          set(k, v);
        }
      }
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const err = gl.getError();
    if (err !== gl.NO_ERROR) throw new Error(`glLayer "${name}": WebGL error 0x${err.toString(16)} while drawing`);
    g.drawImage(canvas, 0, 0, c.W, c.H);
  };

  const dispose = () => {
    if (!st) return;
    const lose = st.gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    st = null;
  };

  return Object.freeze({ draw, dispose, frag: source, get canvas() { return st ? st.canvas : null; } });
}

// ---------------------------------------------------------------------------------------------------------------
// GLSL chunks. Concatenate what a shader needs: frag: GLSL.sdf + GLSL.raymarch + GLSL.lighting + myCode.

const SDF = `
// --- GLSL.sdf (iquilezles.org distance functions) ---
float sdSphere(vec3 p, float r) { return length(p) - r; }
float sdBox(vec3 p, vec3 b) { vec3 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0); }
float sdRoundBox(vec3 p, vec3 b, float r) { vec3 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r; }
float sdTorus(vec3 p, vec2 t) { vec2 q = vec2(length(p.xz) - t.x, p.y); return length(q) - t.y; }
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) { vec3 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h) - r; }
float sdBox2(vec2 p, vec2 b) { vec2 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0); }
// Polynomial smooth minimum: k = blend radius in distance units (0 = hard union). One field, no cross-fade.
float smin(float a, float b, float k) { if (k <= 0.0) return min(a, b); float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
float opSmoothUnion(float a, float b, float k) { return smin(a, b, k); }
// Removes d1 from d2 with a rounded seam of radius k.
float opSmoothSubtraction(float d1, float d2, float k) { float h = clamp(0.5 - 0.5 * (d2 + d1) / k, 0.0, 1.0); return mix(d2, -d1, h) + k * h * (1.0 - h); }
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
`;

const RAYMARCH = `
// --- GLSL.raymarch: define float map(vec3 p) after this chunk. #define MARCH_STEPS / MARCH_FAR / NORMAL_EPS before it
// to tune (NORMAL_EPS about one texel of world size when map() samples a texture, e.g. sdfText type). ---
float map(vec3 p);
#ifndef MARCH_STEPS
#define MARCH_STEPS 128
#endif
#ifndef MARCH_FAR
#define MARCH_FAR 40.0
#endif
#ifndef NORMAL_EPS
#define NORMAL_EPS 0.0006
#endif
// Entry and exit distance of a ray through the box |p| <= b around the origin (a miss when x > y or y < 0). Clip the
// march to the bounds of the shape: on a mostly empty frame this skips the march for most pixels (often 3-5x faster).
vec2 rayBox(vec3 ro, vec3 rd, vec3 b) {
  vec3 m = 1.0 / mix(rd, vec3(1e-8), step(abs(rd), vec3(1e-8)));
  vec3 n = m * ro;
  vec3 k = abs(m) * b;
  vec3 t1 = -n - k, t2 = -n + k;
  return vec2(max(max(t1.x, t1.y), t1.z), min(min(t2.x, t2.y), t2.z));
}
// Distance along rd to the surface between t0 and t1, or -1.0 for a miss.
float marchRange(vec3 ro, vec3 rd, float t0, float t1) {
  float t = max(t0, 0.0);
  for (int i = 0; i < MARCH_STEPS; i++) {
    float d = map(ro + rd * t);
    if (d < 0.0004 * (1.0 + t)) return t;
    t += d;
    if (t > t1) break;
  }
  return -1.0;
}
float march(vec3 ro, vec3 rd) { return marchRange(ro, rd, 0.0, MARCH_FAR); }
// march() inside the box |p| <= b only (b = a box that always contains the shape).
float marchBox(vec3 ro, vec3 rd, vec3 b) {
  vec2 h = rayBox(ro, rd, b);
  if (h.x > h.y || h.y < 0.0) return -1.0;
  return marchRange(ro, rd, h.x, h.y);
}
vec3 calcNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float h = NORMAL_EPS;
  return normalize(k.xyy * map(p + k.xyy * h) + k.yyx * map(p + k.yyx * h) + k.yxy * map(p + k.yxy * h) + k.xxx * map(p + k.xxx * h));
}
float softShadow(vec3 ro, vec3 rd, float mint, float maxt, float k) {
  float res = 1.0, t = mint;
  for (int i = 0; i < 48; i++) {
    float h = map(ro + rd * t);
    res = min(res, k * h / t);
    t += clamp(h, 0.01, 0.25);
    if (res < 0.002 || t > maxt) break;
  }
  return clamp(res, 0.0, 1.0);
}
float ao(vec3 p, vec3 n) {
  float occ = 0.0, w = 1.0;
  for (int i = 1; i <= 5; i++) { float h = 0.03 * float(i); occ += (h - map(p + n * h)) * w; w *= 0.7; }
  return clamp(1.0 - 2.5 * occ, 0.0, 1.0);
}
`;

const LIGHTING = `
// --- GLSL.lighting ---
float fresnelSchlick(float F0, float cosTheta) { return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0); }
vec3 fresnelSchlick(vec3 F0, float cosTheta) { return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0); }
// A rectangular softbox seen from the origin: n = direction to its centre, size = half-extent in tangent units.
float softbox(vec3 d, vec3 n, vec3 up, vec2 size, float feather) {
  float c = dot(d, n);
  if (c <= 0.0) return 0.0;
  vec3 u = normalize(cross(up, n));
  vec3 v = cross(n, u);
  vec3 q = d / c;
  vec2 xy = abs(vec2(dot(q, u), dot(q, v)));
  vec2 e = 1.0 - smoothstep(size - feather, size, xy);
  return e.x * e.y;
}
// Linear HDR studio: a dark room with a large key softbox above-front, two strip lights and a rim panel behind.
// Chrome only reads as chrome with hard bright/dark bands to reflect; an even grey environment makes it plastic.
vec3 envStudio(vec3 d) {
  d = normalize(d);
  vec3 col = mix(vec3(0.012), vec3(0.035), smoothstep(-0.3, 0.8, d.y));
  col += vec3(0.06, 0.055, 0.05) * smoothstep(-0.05, -0.5, d.y); // floor bounce
  col += vec3(7.0) * softbox(d, normalize(vec3(0.0, 1.0, 0.35)), vec3(0.0, 0.0, -1.0), vec2(0.85, 0.45), 0.08);
  col += vec3(4.0, 3.9, 3.7) * softbox(d, normalize(vec3(-1.0, 0.12, 0.25)), vec3(0.0, 1.0, 0.0), vec2(0.10, 0.95), 0.04);
  col += vec3(2.6, 2.7, 3.0) * softbox(d, normalize(vec3(1.0, 0.05, 0.45)), vec3(0.0, 1.0, 0.0), vec2(0.16, 0.8), 0.05);
  col += vec3(1.6) * softbox(d, normalize(vec3(0.0, 0.25, -1.0)), vec3(0.0, 1.0, 0.0), vec2(1.2, 0.12), 0.06);
  // Front fill behind the camera, brighter at the top: flat faces turned to the camera reflect it as a graded sheet
  // (without it extruded chrome type mirrors the dark room and turns black).
  col += vec3(1.5) * mix(0.25, 1.0, smoothstep(-0.2, 0.45, d.y)) * softbox(d, normalize(vec3(0.0, 0.12, 1.0)), vec3(0.0, 1.0, 0.0), vec2(1.1, 0.5), 0.35);
  return col;
}
`;

const COLOR = `
// --- GLSL.color ---
vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
// Narkowicz ACES fit: linear HDR in, display-referred 0..1 out (still linear; apply toSrgb after).
vec3 tonemapACES(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
`;

const NOISE = `
// --- GLSL.noise (hash-based, no tables: the same value on every GL driver within float precision) ---
float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash13(i), b = hash13(i + vec3(1, 0, 0)), c = hash13(i + vec3(0, 1, 0)), d = hash13(i + vec3(1, 1, 0));
  float e = hash13(i + vec3(0, 0, 1)), f1 = hash13(i + vec3(1, 0, 1)), g = hash13(i + vec3(0, 1, 1)), h = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, f1, u.x), mix(g, h, u.x), u.y), u.z) * 2.0 - 1.0;
}
// Seamless-loop noise in [-1, 1]: the sample point travels a circle (radius r) through the volume as phase goes 0 -> 1,
// so phase 0 and phase 1 give exactly the same value. phase = uTime / uDur in a loop film.
float loopNoise(vec2 p, float phase, float r) {
  float a = 6.28318530718 * fract(phase);
  return vnoise(vec3(p.x + r * cos(a), p.y, r * sin(a)));
}
float loopNoise(vec2 p, float phase) { return loopNoise(p, phase, 1.0); }
`;

const TEXT = `
// --- GLSL.text: sdfText() textures. uv in 0..1 of the texture (y up); result in texture-height units, negative inside,
// exact outside the texture (box distance added). Extrude: max(textSdf(...) * height, abs(p.z) - depth). ---
float textSdf(sampler2D tex, vec2 uv, float aspect) {
  vec2 c = clamp(uv, 0.0, 1.0);
  float d = texture(tex, c).r;
  return d + length((uv - c) * vec2(aspect, 1.0));
}
`;

export const GLSL = Object.freeze({ sdf: SDF, raymarch: RAYMARCH, lighting: LIGHTING, color: COLOR, noise: NOISE, text: TEXT });
