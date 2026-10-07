// In-page half of capture.mjs. Playwright serializes this function into the page, so it must not
// reference anything outside its own body. It reads computed styles only; the single DOM change
// is data-ms-* marker attributes that let Node screenshot the chosen elements.
export function extractInPage({ maxComponents = 12, selectors = [] } = {}) {
  const warnings = [];
  const W = innerWidth, H = innerHeight, REGION = 3 * H;

  // Normalize any CSS color (rgb, hex, oklch, color()) to sRGB bytes by painting one pixel.
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = 1;
  const cx = cvs.getContext('2d', { willReadFrequently: true });
  const colorCache = new Map();
  const rgba = (css) => {
    if (!css || css === 'transparent' || css === 'none') return null;
    if (colorCache.has(css)) return colorCache.get(css);
    let out = null;
    if (CSS.supports('color', css)) {
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = css;
      cx.fillRect(0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data;
      out = d[3] < 128 ? null : [d[0], d[1], d[2]];
    }
    colorCache.set(css, out);
    return out;
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return null;
    return { r, cs };
  };
  const box = (r) => ({ x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) });
  const cssPath = (el) => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 4 && e !== document.body; e = e.parentElement) {
      let p = e.localName;
      const cls = [...e.classList].filter((c) => /^[A-Za-z][\w-]{0,30}$/.test(c)).slice(0, 2);
      if (cls.length) p += `.${cls.join('.')}`;
      parts.unshift(p);
    }
    return parts.join(' > ') || el.localName;
  };
  const text = (el, max = 80) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, max);

  // ---- colors ---------------------------------------------------------------------------------
  const acc = new Map();
  const add = (rgb, kind, w) => {
    if (!rgb || !(w > 0)) return;
    const k = `${rgb.join(',')}|${kind}`;
    acc.set(k, (acc.get(k) || 0) + w);
  };
  const clipArea = (r) => Math.max(0, Math.min(r.right, W) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, REGION) - Math.max(r.top, 0));
  const pageBg = rgba(getComputedStyle(document.body).backgroundColor) || rgba(getComputedStyle(document.documentElement).backgroundColor) || [255, 255, 255];
  add(pageBg, 'background', W * REGION * 0.25);
  const all = document.body.querySelectorAll('*');
  if (all.length > 6000) warnings.push(`large page (${all.length} elements); colors sampled from the first 6000`);
  const interactiveSel = 'button, a, [role="button"], input[type="submit"], input[type="button"]';
  for (let i = 0; i < Math.min(all.length, 6000); i++) {
    const el = all[i];
    const v = visible(el);
    if (!v) continue;
    const { r, cs } = v;
    const area = clipArea(r);
    const interactive = el.matches(interactiveSel);
    const bg = rgba(cs.backgroundColor);
    if (bg && area > 0) add(bg, interactive ? 'interactive' : 'background', interactive ? Math.max(area, 400) : area);
    if (interactive && !bg && Number.parseFloat(cs.borderTopWidth) > 0) add(rgba(cs.borderTopColor), 'interactive', 200);
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
    if (own.length && r.top < REGION) {
      const w = own.length * (Number.parseFloat(cs.fontSize) || 16) / 16;
      add(rgba(cs.color), el.closest('a') ? 'link' : 'text', w);
    }
  }
  const colorSamples = [...acc].map(([k, w]) => { const [c, kind] = k.split('|'); return { rgb: c.split(',').map(Number), kind, w }; });

  // ---- CSS custom properties that hold colors, and @font-face rules ------------------------------
  const cssVars = [];
  const faces = [];
  let unreadable = 0;
  const unreadableSheets = []; // cross-origin sheets the CSSOM refuses to open: Node fetches and parses their text
  const rootStyle = getComputedStyle(document.documentElement);
  const walk = (rules, base) => {
    for (const rule of rules) {
      if (rule instanceof CSSImportRule) { // an @import has its own base URL for relative font paths
        const sub = rule.styleSheet;
        if (!sub) continue;
        try { walk(sub.cssRules, sub.href || base); } catch { unreadable++; if (sub.href) unreadableSheets.push(sub.href); }
        continue;
      }
      if (rule.cssRules && !(rule instanceof CSSStyleRule)) { walk(rule.cssRules, base); continue; }
      if (rule instanceof CSSFontFaceRule) {
        const st = rule.style;
        const srcText = st.getPropertyValue('src');
        const m = /url\(\s*(['"]?)([^'")]+)\1\s*\)/.exec(srcText);
        if (faces.length < 400) {
          faces.push({
            family: st.getPropertyValue('font-family').replace(/['"]/g, '').trim(),
            weight: st.getPropertyValue('font-weight') || '400',
            style: st.getPropertyValue('font-style') || 'normal',
            unicodeRange: st.getPropertyValue('unicode-range') || null,
            src: m ? new URL(m[2], base).href : null,
            srcText, // every url() with its format() hint; Node picks the best one
            base,
          });
        }
      } else if (rule instanceof CSSStyleRule && /^(:root|html|body)\b/.test(rule.selectorText || '')) {
        for (const name of rule.style) {
          if (!name.startsWith('--') || cssVars.length >= 60 || cssVars.some((v) => v.name === name)) continue;
          const value = (rootStyle.getPropertyValue(name) || rule.style.getPropertyValue(name)).trim();
          const c = value.length < 80 ? rgba(value) : null;
          if (c) cssVars.push({ name, value, hex: `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`.toUpperCase() });
        }
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules, sheet.href || location.href); } catch { unreadable++; if (sheet.href) unreadableSheets.push(sheet.href); }
  }
  if (unreadable) warnings.push(`${unreadable} cross-origin stylesheet(s) not readable in the page; their @font-face rules are fetched separately, but their CSS variables are missing`);

  // ---- fonts in use -----------------------------------------------------------------------------
  const families = new Map();
  const firstFamily = (ff) => (ff || '').split(',')[0].replace(/['"]/g, '').trim();
  for (const [role, sel] of [['body', 'body'], ['h1', 'h1'], ['h2', 'h2'], ['h3', 'h3'], ['p', 'p'], ['button', 'button, [role="button"], a[class*="btn" i]'], ['nav', 'nav a, header a'], ['input', 'input, textarea']]) {
    const el = [...document.querySelectorAll(sel)].find((e) => visible(e));
    if (!el) continue;
    const cs = getComputedStyle(el);
    const fam = firstFamily(cs.fontFamily);
    if (!fam) continue;
    const f = families.get(fam) || { family: fam, stack: cs.fontFamily, usedBy: [], weights: [] };
    f.usedBy.push(role);
    if (!f.weights.includes(cs.fontWeight)) f.weights.push(cs.fontWeight);
    families.set(fam, f);
  }
  const loaded = [];
  try {
    for (const f of document.fonts) loaded.push({ family: f.family.replace(/['"]/g, ''), weight: f.weight, style: f.style, unicodeRange: f.unicodeRange || null, status: f.status });
  } catch { /* FontFaceSet iteration unsupported */ }
  for (const f of families.values()) f.loaded = loaded.some((l) => l.family === f.family && l.status === 'loaded');

  // ---- meta, icons, copy ------------------------------------------------------------------------
  const meta = (sel) => document.querySelector(sel)?.getAttribute('content')?.trim() || null;
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
  const icons = [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"], link[rel="shortcut icon"]')]
    .map((l) => ({ rel: l.getAttribute('rel'), href: abs(l.getAttribute('href')), sizes: l.getAttribute('sizes') }))
    .filter((x, i, a) => x.href && !/^data:[^,]*,$/.test(x.href) && a.findIndex((y) => y.href === x.href) === i).slice(0, 6);
  if (!icons.length) icons.push({ rel: 'favicon', href: abs('/favicon.ico'), sizes: null });
  const og = meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]');
  const themeColor = rgba(meta('meta[name="theme-color"]') || '');
  const uniq = (arr, n) => [...new Set(arr.filter(Boolean))].slice(0, n);
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((e) => visible(e));
  const copy = {
    title: document.title || null,
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    siteName: meta('meta[property="og:site_name"]') || meta('meta[name="application-name"]'),
    lang: document.documentElement.lang || null,
    h1: uniq(vis('h1').map((e) => text(e, 120)), 3),
    headings: uniq(vis('h2, h3').map((e) => text(e, 120)), 10),
    buttons: uniq(vis('button, [role="button"], input[type="submit"], a[class*="btn" i], a[class*="button" i], a[class*="cta" i]')
      .map((e) => text(e, 40) || e.value || '').filter((t) => t.length >= 2 && t.length <= 40), 12),
    nav: uniq(vis('nav a, header a').map((e) => text(e, 30)), 12),
  };

  // ---- logo candidates --------------------------------------------------------------------------
  const logoSel = ['header a[href="/"] svg', 'header a[href="/"] img', 'a[aria-label*="home" i] svg', '[class*="logo" i] svg', '[class*="logo" i] img',
    '[id*="logo" i] svg', '[id*="logo" i] img', 'img[alt*="logo" i]', 'img[src*="logo" i]', 'header svg', 'nav svg', 'header img', 'nav img'];
  const seen = new Set();
  const logos = [];
  const PAINT = ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'fill-rule'];
  const serializeSvg = (svg) => {
    const clone = svg.cloneNode(true);
    const src = [svg, ...svg.querySelectorAll('*')];
    const dst = [clone, ...clone.querySelectorAll('*')];
    // Page CSS often colors the logo; inline the computed paint so the file stands alone.
    src.forEach((e, i) => {
      const cs = getComputedStyle(e);
      for (const p of PAINT) { const v = cs.getPropertyValue(p); if (v && !dst[i].getAttribute(p)) dst[i].setAttribute(p, v); }
    });
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const r = svg.getBoundingClientRect();
    if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${Math.round(r.width)} ${Math.round(r.height)}`);
    clone.setAttribute('width', Math.round(r.width));
    clone.setAttribute('height', Math.round(r.height));
    clone.style.color = getComputedStyle(svg).color;
    if (clone.querySelector('use[href^="http"], use[*|href^="http"]')) warnings.push('a logo SVG references an external sprite; prefer its PNG crop');
    return new XMLSerializer().serializeToString(clone);
  };
  // Fallback last: any svg or img near the top of the page, for sites without a header element.
  const topFallback = () => [...document.querySelectorAll('svg, img')].filter((e) => !e.closest('svg svg') && e.getBoundingClientRect().top < Math.max(240, 0.5 * H)).slice(0, 3);
  for (const sel of [...logoSel, topFallback]) {
    for (const el of typeof sel === 'function' ? sel() : document.querySelectorAll(sel)) {
      if (logos.length >= 6 || seen.has(el)) continue;
      const v = visible(el);
      if (!v || v.r.width < 16 || v.r.width > 640 || v.r.height > 240) continue;
      seen.add(el);
      const mark = String(logos.length + 1);
      const kind = (el.localName === 'svg' ? 'inline-svg' : 'img') + (typeof sel === 'function' ? '-top' : '');
      const cand = { kind, selector: cssPath(el), box: box(v.r), mark };
      // Serialize before marking so the marker attribute never lands in the saved file.
      if (el.localName === 'svg') cand.svg = serializeSvg(el);
      else cand.src = el.currentSrc || abs(el.getAttribute('src'));
      el.setAttribute('data-ms-logo', mark);
      logos.push(cand);
    }
  }

  // ---- text wordmark: a brand set in type, not drawn as an image (only looked for when no logo image or SVG was found) -------------
  const hexOf = (css) => { const c = rgba(css); return c ? `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`.toUpperCase() : null; };
  const flat = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const findWordmark = () => {
    const names = [flat(copy.siteName), flat((document.title || '').split(/\s[|\-\u2013\u2014:\u00b7]\s/)[0])].filter((n) => n.length >= 2);
    const GENERIC = /^(home|menu|start|main|top|\ud648|\uba54\ub274)$/i;
    const sels = ['header a[href="/"]', 'nav a[href="/"]', '[class*="wordmark" i]', 'a[class*="logo" i]', 'a[class*="brand" i]', '[class*="logo" i]', '[class*="brand" i]',
      '[id*="logo" i]', '[id*="brand" i]', '[class*="site-title" i]', '[class*="site-name" i]', 'a[aria-label*="home" i]', 'header a', 'nav a', '[role="banner"] a'];
    const seenEl = new Set();
    let best = null;
    for (const sel of sels) {
      let list = [];
      try { list = [...document.querySelectorAll(sel)].slice(0, 12); } catch { /* selector not supported */ }
      for (const el of list) {
        if (seenEl.has(el)) continue;
        seenEl.add(el);
        const v = visible(el);
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!v || !t || t.length > 40 || GENERIC.test(t) || v.r.width > 640 || v.r.height > 240 || el.querySelector('img, svg, canvas, picture')) continue;
        const a = el.closest('a');
        let rootLink = false;
        try { const u = a && new URL(a.getAttribute('href') || '', location.href); rootLink = !!u && u.origin === location.origin && u.pathname === '/' && !u.hash; } catch { /* odd href */ }
        const f = flat(t);
        let score = 0;
        if (rootLink) score += 4;
        if (/logo|brand|wordmark|site-?(title|name)/i.test(`${el.id} ${typeof el.className === 'string' ? el.className : ''}`)) score += 3;
        if (names.some((n) => n === f || (n.length >= 3 && f.length >= 3 && (n.includes(f) || f.includes(n))))) score += 3;
        if (el.closest('header, nav, [role="banner"]') && v.r.top < 0.3 * H) score += 2;
        if ((Number.parseFloat(v.cs.fontSize) || 0) >= 18) score += 1;
        if (score >= 4 && (!best || score > best.score)) best = { el, score, v, text: t };
      }
    }
    if (!best) return null;
    const { el, v, text: shown } = best;
    const own = getComputedStyle(el);
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const raw = n.textContent.replace(/\s+/g, ' ');
      if (!raw.trim()) continue;
      const pe = n.parentElement;
      const s = getComputedStyle(pe);
      const part = { text: raw, tag: pe === el ? null : pe.localName, color: hexOf(s.color), fontFamily: firstFamily(s.fontFamily), fontWeight: s.fontWeight, fontSize: s.fontSize, fontStyle: s.fontStyle, textTransform: s.textTransform };
      const last = parts[parts.length - 1];
      const same = (x, y) => ['color', 'fontFamily', 'fontWeight', 'fontSize', 'fontStyle', 'textTransform'].every((k) => x[k] === y[k]);
      if (last && same(last, part) && last.tag === part.tag) last.text += raw; else parts.push(part);
    }
    if (parts.length) { parts[0].text = parts[0].text.replace(/^\s+/, ''); parts[parts.length - 1].text = parts[parts.length - 1].text.replace(/\s+$/, ''); }
    const base = hexOf(own.color);
    const accents = [];
    for (const p of parts) {
      if (p.color === base) p.role = 'base';
      else { let k = accents.indexOf(p.color); if (k === -1) k = accents.push(p.color) - 1; p.role = k === 0 ? 'accent' : `accent${k + 1}`; }
    }
    const family = firstFamily(own.fontFamily);
    const html = el.innerHTML.replace(/\s+/g, ' ').trim();
    el.setAttribute('data-ms-wordmark', '1');
    return {
      text: shown, displayText: text(el, 40), html: html.length <= 800 ? html : null, selector: cssPath(el), box: box(v.r), link: el.closest('a')?.getAttribute('href') ?? null, score: best.score,
      parts: parts.map(({ text: t, tag, role, color, fontFamily, fontWeight, fontSize, fontStyle, textTransform }) => ({ text: t, tag, role, color, fontFamily, fontWeight, fontSize, fontStyle, textTransform })),
      colors: { base, ...Object.fromEntries(accents.map((c, k) => [k === 0 ? 'accent' : `accent${k + 1}`, c])) },
      font: { family, stack: own.fontFamily, weight: own.fontWeight, size: own.fontSize, letterSpacing: own.letterSpacing, lineHeight: own.lineHeight, style: own.fontStyle, textTransform: own.textTransform },
      fontLoaded: [...document.fonts].some((f) => f.family.replace(/['"]/g, '') === family && f.status === 'loaded'),
    };
  };
  const wordmark = logos.length ? null : findWordmark();
  if (!logos.length && !wordmark) warnings.push('no logo image or SVG and no text wordmark found in header/nav; ask the user for an SVG or PNG logo');

  // ---- component crops --------------------------------------------------------------------------
  const chosen = [];
  const iou = (a, b) => {
    const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const inter = x * y;
    return inter / (a.width * a.height + b.width * b.height - inter || 1);
  };
  // A crop only makes sense for an element that sits inside the page. Drawers parked at left: -9999px, zero-size
  // wrappers, carousel slides right of the first screen and boxes past the document end fail to screenshot or come out
  // blank, and they would also use up the component budget. Below the fold is fine: the screenshot scrolls there.
  const docW = Math.max(document.documentElement.scrollWidth, W);
  const docH = Math.max(document.documentElement.scrollHeight, H);
  const skippedCrops = [];
  const cropProblem = (b) => (b.w <= 0 || b.h <= 0 ? 'zero size'
    : b.x < 0 || b.y < 0 ? `starts outside the page (x ${b.x}, y ${b.y})`
    : b.x >= W ? `starts right of the ${W}px viewport (x ${b.x})`
    : b.x + b.w > docW + 1 ? `extends past the page width (${b.x + b.w} > ${docW})`
    : b.y >= docH ? `starts below the end of the page (y ${b.y} >= ${docH})` : null);
  const pickEl = (el, label, selector) => {
    if (!el || chosen.length >= maxComponents + selectors.length) return;
    const v = visible(el);
    if (!v) { if (label === 'custom') skippedCrops.push({ selector, label, reason: 'not visible (display none, hidden, transparent or zero size)' }); return; }
    if (v.r.width < 40 || v.r.height < 20) {
      if (label === 'custom') skippedCrops.push({ selector, label, reason: `too small (${Math.round(v.r.width)}x${Math.round(v.r.height)}, a crop needs at least 40x20)` });
      return;
    }
    const b = box(v.r);
    const why = cropProblem(b);
    if (why) { skippedCrops.push({ selector: selector || cssPath(el), label, reason: why }); return; }
    if (chosen.some((c) => c.el === el || iou(c.rect, v.r) > 0.8)) return;
    const n = chosen.length + 1;
    el.setAttribute('data-ms-cap', String(n));
    chosen.push({ el, rect: v.r, n, label, selector: selector || cssPath(el), text: text(el, 40), box: b });
  };
  for (const sel of selectors) {
    let els = [];
    try { els = [...document.querySelectorAll(sel)]; } catch { warnings.push(`invalid selector: ${sel}`); }
    if (!els.length) warnings.push(`selector matched nothing: ${sel}`);
    els.slice(0, 3).forEach((e) => pickEl(e, 'custom', sel));
  }
  const auto = chosen.length;
  const budget = () => chosen.length - auto < maxComponents;
  if (budget()) pickEl(document.querySelector('header') || document.querySelector('nav'), 'header');
  const h1 = vis('h1')[0];
  if (h1 && budget()) {
    let hero = h1;
    while (hero.parentElement && hero.parentElement !== document.body && hero.getBoundingClientRect().height < 0.45 * H) hero = hero.parentElement;
    if (hero.getBoundingClientRect().height <= 2.5 * H) pickEl(hero, 'hero');
  }
  for (const e of vis('button, [role="button"], a[class*="btn" i], a[class*="button" i], a[class*="cta" i]').slice(0, 30)) {
    if (!budget() || chosen.filter((c) => c.label === 'cta').length >= 4) break;
    const r = e.getBoundingClientRect();
    if (r.width >= 60 && r.width <= 600 && r.height >= 24 && r.height <= 120 && text(e).length >= 2) pickEl(e, 'cta');
  }
  for (const e of vis('[class*="card" i]').slice(0, 40)) {
    if (!budget() || chosen.filter((c) => c.label === 'card').length >= 4) break;
    const r = e.getBoundingClientRect();
    if (r.width >= 150 && r.height >= 100 && r.height <= 1.5 * H) pickEl(e, 'card');
  }
  for (const e of vis('main img, section img, [class*="screenshot" i], [class*="preview" i]').slice(0, 40)) {
    if (!budget() || chosen.filter((c) => c.label === 'image').length >= 4) break;
    const r = e.getBoundingClientRect();
    if (r.width >= 280 && r.height >= 160) pickEl(e, 'image');
  }
  if (budget()) pickEl(document.querySelector('[class*="pricing" i], #pricing'), 'pricing');
  for (const e of vis('main section, body > section').slice(1, 8)) {
    if (!budget() || chosen.filter((c) => c.label === 'section').length >= 3) break;
    if (e.getBoundingClientRect().height <= 2 * H) pickEl(e, 'section');
  }
  const components = chosen.map(({ n, label, selector, text: t, box: b }) => ({ n, label, selector, text: t, box: b }));
  for (const c of skippedCrops.filter((x) => x.label === 'custom')) warnings.push(`component crop skipped: ${c.selector} ${c.reason}`);
  const autoSkipped = skippedCrops.filter((x) => x.label !== 'custom');
  if (autoSkipped.length) warnings.push(`${autoSkipped.length} automatic component candidate(s) skipped outside the page: ${autoSkipped.slice(0, 3).map((c) => `${c.selector} (${c.reason})`).join('; ')}${autoSkipped.length > 3 ? '; ...' : ''}`);

  return {
    colorSamples, cssVars, themeColor,
    fonts: { families: [...families.values()], faces: faces.slice(0, 40).map(({ srcText, base, ...f }) => f), loaded: loaded.slice(0, 40), rules: faces, allLoaded: loaded, unreadableSheets },
    icons, ogImage: og ? abs(og) : null, logos, wordmark, components, skippedCrops, text: copy, warnings,
  };
}
