# Asset capture reference

The product-reel skill ships `scripts/capture.mjs` (plus its in-page half `scripts/capture-page.mjs`, the font
helpers in `scripts/capture-fonts.mjs` and the font registry report in `scripts/capture-registry.mjs`) and two scripts that
drive a page after load: `scripts/states.mjs` (UI states, "States capture" below) and `scripts/canvas-frames.mjs`
(a canvas sampled over time, "Canvas frames" below). All three share the browser policy and the network policy.
SKILL.md prints the full command path. This file explains what the script does, what it writes and
how to use the result.

## What it does

1. Finds the film project (`--root`, else the nearest folder with `studio.json`) and launches the
   browser with its own launcher (not the project's `tools/studio.mjs` one, because a captured page is untrusted
   and the sandbox flag must be under this script's control). Choice, the same browser policy as the project's
   launcher: `MOTION_CHROME_PATH`, then `MOTION_BROWSER` (`auto`, `chrome`, `msedge`, `chromium`), then `studio.json`
   `browser` (`chrome`, `msedge`, `chromium` or an absolute path). `auto` = Playwright's bundled headless shell on Windows
   (never an installed Chrome or Edge there: a fresh-profile launch counts as a failed Windows logon and can lock the
   account; install it with `npx playwright install chromium-headless-shell`) and Chrome, Edge, bundled elsewhere. An
   installed Chrome or Edge on Windows only by explicit choice: one warning line per launch, and the 4th launch in 10 minutes
   is refused (3 pass; `MOTION_SYSTEM_BROWSER_MAX`, `MOTION_ALLOW_LOCKOUT_RISK=1`, log `MOTION_LAUNCH_LOG`); details in
   `docs/ARCHITECTURE.md` section 9.10. 60 s launch timeout. Chrome's renderer sandbox stays ON on every OS. It is off
   only with `--no-sandbox`, with `MOTION_NO_SANDBOX=1` (also `true`, `yes`, `on`), or as root on Linux, and a note prints
   whenever it is off. Playwright comes from the project's `node_modules`; the browser itself is not downloaded by
   `npm install` (Windows: `npx playwright install chromium-headless-shell`).
2. Opens the URL once per viewport in a fresh context, waits for `load`, up to 8 s of network
   idle, fonts, and `--settle` seconds for entrance animations.
3. Saves a viewport screenshot per viewport (and full-page ones with `--full-page`).
4. On the first viewport only, reads computed styles to find:
   - logo candidates: SVGs and images in the header, nav, home link or anything named "logo",
     falling back to the first marks near the top of the page; SVGs are saved with their computed
     fill and stroke inlined so they render standalone, and every candidate also gets a PNG crop
   - a text wordmark, only when no logo image or SVG was found: see "Text wordmark" below
   - icons (`rel=icon`, `apple-touch-icon`, `mask-icon`, else `/favicon.ico`) and `og:image`.
     Downloaded images get their extension from the file's first bytes (PNG, JPEG, WebP, GIF, AVIF,
     ICO, SVG), never from `Content-Type` or the URL. A mismatch is noted (`server said image/jpeg but
     the bytes are image/png`), and a body that is no image (an HTML error page served with a 200) is
     refused with a note instead of being saved as `logo.png`
   - colors: background area, text weight, links and interactive elements, `theme-color`, and
     CSS custom properties on `:root`/`html`/`body` that hold colors
   - fonts: the first family of the stack used by body, headings, paragraphs, buttons, nav and
     inputs, whether it loaded, and `@font-face` rules with their source URLs (see "Fonts and licenses")
   - copy: title, description, site name, h1, h2/h3, button and nav text
   - component crops: custom `--selector` matches first, then header, hero, up to 4 CTAs, up to
     4 cards, up to 4 large product images, pricing, and up to 3 sections. A box that is not inside
     the page is skipped with a note: zero size, starting left of or above the page (`x < 0`, `y < 0`,
     for example an off-canvas drawer at `left: -9999px`), starting right of the viewport (a carousel
     slide), reaching past the page width or starting below the end of the page. Below the fold is
     fine, the screenshot scrolls there. Skipped candidates do not use up the component budget
5. Stages everything in `assets/.capture-tmp/`, and only after success replaces the files the
   previous capture listed. Files you added to `assets/brand/` yourself are never removed.
6. Fonts (unless `--no-fonts`), on the first viewport: collects the `@font-face` rules of every
   stylesheet the page can read plus the cross-origin ones it cannot (Google Fonts links without
   `crossorigin`): Node fetches and parses those. Only rules whose face the browser actually loaded
   are kept, so a declared but unused weight or a script slice the text never needed is not
   downloaded. Each kept face is fetched as woff2 (else woff, ttf, otf) and identified by magic
   bytes; HTML pages, truncated files and collections are refused. After the capture is committed
   the files go to the project's `assets/fonts/` (what the runtime loads, whatever `--out` says) and get one entry each in `assets/fonts/fonts.json`.
7. Writes `assets/manifest.json` and, with `--apply-brand`, merges `brand.name`, `brand.url` and
   the suggested colors into `studio.json` (an existing brand name is kept).

Exit codes: 0 success, 1 failure (no project, navigation error, no browser, refused navigation), 2 usage error.

## Network policy and credentials

The page is untrusted, so the capture protects the machine it runs on (`capture-guard.mjs`):

- Refused unless the request goes to the target's own host and port (or `--allow-private` is given): loopback,
  RFC 1918 (10/8, 172.16/12, 192.168/16), CGNAT (100.64/10), link-local (169.254/16, which includes the
  169.254.169.254 cloud-metadata address), IPv6 ::1, ULA (fc00::/7) and link-local (fe80::/10), multicast and reserved
  ranges, `localhost`, `*.localhost`, `metadata.google.internal`, any name that resolves to one of those, and every
  scheme except http(s), `data:`, `blob:` and `about:`. `--allow-private` lifts only the address check.
- The check covers the page's own requests (a context route), redirect hops (a DevTools session per page), every
  request of every target including workers (a browser-wide session) and WebSockets. The images, icons, `og:image`,
  font CSS and font files that Node downloads on the page's behalf go through the same check on every hop (at most 5
  redirects), and a `Content-Length` over the cap (images 5 MB, fonts 10 MB, font CSS 2 MB, license probe 200 KB) is
  refused before the body is read. A refusal never echoes the response body.
- If the navigation itself is refused the run fails with `navigation refused (<reason>): <url>. Pass --allow-private only
  when you trust the page.` and saves nothing. A redirect that was answered before it could be blocked aborts the run.
- Residual risk: speculation rules (`<script type="speculationrules">`) make Chrome's browser process fetch URLs that no
  request filter sees; the manifest carries a note when a page declares them. UDP (WebRTC), bare TCP preconnects and DNS
  rebinding between the check and Chrome's own lookup are not filtered either.
- A WOFF or WOFF2 whose header declares a decompression bomb (over 256 MiB, or over 64 KiB and more than 200 times its
  compressed size) is refused for that source; the next `src` of the face is tried and the reason lands in
  `fonts.skipped[]`.
- Credentials: `https://user:pass@host/` is sent as HTTP auth to the target's origin only. `user:pass@` and the values of
  secret-looking parameters (`token`, `secret`, `password`, `pass`, `auth`, `sig`, `signature`, `session`, `sid`, `jwt`,
  `credential`, `bearer`, `otp`, `key`, `apikey`, `code`, `cookie`, `ticket`, `sas`, and forms such as `access_token`,
  `X-Amz-Signature`, `client_secret`) are replaced by `***` in stderr, error messages, `manifest.json` (`url`, `finalUrl`,
  `logos[].url`, `images[].url`, `fonts.files[].from`, `notes`), the `--json` line and `studio.json` `brand.url` (with
  `--apply-brand`). Matching is per whole word, so `keyword` and `author` stay readable.

## Output files

| Path | Content |
|---|---|
| `assets/brand/screens/<viewport>.png` | viewport screenshot at device scale (desktop 2880x1800, mobile 1170x2532) |
| `assets/brand/screens/<viewport>-full.png` | full page (with `--full-page`) |
| `assets/brand/logo/NN-<kind>.svg\|png` | logo candidates; `-crop.png` is the on-page rendering |
| `assets/brand/logo/icon-N-<rel>.<ext>` | favicons and touch icons |
| `assets/brand/og-image.<ext>` | social preview image (brand imagery, not a logo) |
| `assets/brand/components/NN-<label>-<text>.png` | element crops at 2x |
| `assets/fonts/<family>-<weight>[-italic][-u<hash>].<ext>` | the web fonts the page loaded, named like `tools/fonts.mjs add-file` |
| `assets/fonts/fonts.json` | one entry per saved face: `{ family, src, weight, style, unicodeRange?, source?, license?, licenseFile? }` (`source` = the folder URL the face was downloaded from, no query) |
| `assets/fonts/OFL-<Family>.txt`, `LICENSE-<Family>.txt` | a license text found next to a self-hosted font |
| `assets/brand/logo/wordmark-crop.png` | reference crop of a text wordmark (the text record is `manifest.brand.wordmark`) |
| `assets/brand/states/<name>/` | `states.mjs`: PNGs and `states.json` |
| `assets/brand/frames/` | `canvas-frames.mjs`: sprite sheets, `frames.json`, `pack/` |
| `assets/manifest.json` | everything below |

## manifest.json

```json
{
  "version": 1,
  "tool": "motion-studio product-reel capture",
  "url": "https://example.com/", "finalUrl": "https://example.com/", "capturedAt": "ISO time",
  "browser": "chromium-headless-shell", "sandbox": true, "viewports": ["desktop", "mobile"],
  "screens": [{ "file": "assets/brand/screens/desktop.png", "viewport": "desktop", "width": 2880, "height": 1800, "fullPage": false }],
  "logos": [{ "file": "assets/brand/logo/01-inline-svg.svg", "source": "inline-svg", "selector": "header > a.logo > svg", "box": { "x": 48, "y": 20, "w": 140, "h": 32 } }],
  "components": [{ "file": "assets/brand/components/03-cta-start-free.png", "label": "cta", "selector": "...", "text": "Start free", "box": { "x": 0, "y": 0, "w": 0, "h": 0 } }],
  "images": [{ "file": "assets/brand/og-image.jpg", "source": "og:image", "url": "..." }],
  "colors": {
    "suggested": { "bg": "#FBFAF7", "fg": "#15131A", "accent": "#5B3DF5", "muted": "#6E6A7C" },
    "palette": [{ "hex": "#FBFAF7", "share": 0.79, "sources": ["background", "text"] }],
    "cssVars": [{ "name": "--brand", "value": "#5B3DF5", "hex": "#5B3DF5" }],
    "themeColor": "#5B3DF5"
  },
  "fonts": {
    "families": [{ "family": "Acme Sans", "stack": "...", "usedBy": ["body", "h1"], "weights": ["400", "800"], "loaded": true }],
    "faces": [{ "family": "Acme Sans", "weight": "100 900", "style": "normal", "unicodeRange": null, "src": "https://.../font.woff2" }],
    "loaded": [{ "family": "Acme Sans", "weight": "100 900", "style": "normal", "unicodeRange": null, "status": "loaded" }],
    "files": [{
      "family": "Acme Sans", "weight": "100 900", "style": "normal", "unicodeRange": null,
      "file": "assets/fonts/acme-sans-100-900.woff2", "format": "woff2", "bytes": 48256, "from": "https://.../font.woff2",
      "licenseFile": null,
      "license": { "status": "UNVERIFIED", "note": "no license URL or file found; check the font license before publishing" }
    }],
    "skipped": [{ "family": "Inter", "weight": "400", "style": "normal", "unicodeRange": null, "reason": "already registered in fonts.json (assets/fonts/inter-100-900-latin.woff2); left as it is" }],
    "registry": [{ "family": "Acme Sans", "usedBy": ["body", "h1"], "status": "added", "license": "unverified", "registered": 0, "added": 1, "text": "NOT registered before; this capture added 1 file: ..." }]
  },
  "brand": { "wordmark": { "text": "acme", "html": "ac<span>me</span>", "parts": [{ "text": "ac", "role": "base", "color": "#EEF1FF" }, { "text": "me", "tag": "span", "role": "accent", "color": "#5B8CFF" }], "colors": { "base": "#EEF1FF", "accent": "#5B8CFF" }, "font": { "family": "Acme Sans", "weight": "700", "size": "32px", "letterSpacing": "2px" }, "crop": "assets/brand/logo/wordmark-crop.png", "fontRegistry": { "status": "registered", "license": "verified", "text": "..." } } },
  "text": { "title": "...", "description": "...", "siteName": "...", "lang": "en", "h1": [], "headings": [], "buttons": [], "nav": [] },
  "blocked": [{ "url": "http://127.0.0.1:9/x", "reason": "127.0.0.1 is a private, local or link-local address" }],
  "notes": ["warnings and follow-ups"]
}
```

`brand` exists only when a text wordmark was recorded (or an earlier run left other `brand` keys, which are kept).
Paths are relative to the project root with forward slashes, ready for the film to load. Boxes are
CSS pixels in page coordinates. `browser` is how the browser was launched (`chromium-headless-shell`, `chromium`, `chrome`,
`msedge` or `executable:<path>`). `sandbox` says whether Chrome's sandbox was on. `blocked` lists (at most 50) the
requests the network policy refused, and is replaced on every run. `url`, `finalUrl` and every URL in the file have
credentials and secret query values removed. Other keys that tools or people add to the manifest are kept on
the next capture.

## Reading the palette

`suggested` is a starting point, not a decision:

| Role | How it is picked | Check |
|---|---|---|
| `bg` | the background color covering the most area in the first three screen heights | a dark hero on a light site can win; ask |
| `fg` | the most used text color with contrast >= 7 against `bg` (else >= 4.5) | headlines and body copy may differ |
| `accent` | saturated color weighted toward buttons and links, else `theme-color` | should match the primary CTA |
| `muted` | a low-saturation text color distinct from `fg`, else a mix of `fg` and `bg` | secondary copy |

`cssVars` often names the brand colors directly (`--brand`, `--primary`); prefer them when present.
The house rule is one accent: if the site uses several, ask which one leads.

## Fonts and licenses

The capture saves the fonts the page loaded, so the film can use the same faces without a manual
download. Saved is not licensed.

| Manifest `fonts.files[].license` | Meaning | Do |
|---|---|---|
| `status: "UNVERIFIED"` | no license URL or text was found for the family | ask the user; treat the font as unusable until they confirm a license |
| `status: "FOUND"`, `source: "font file"` | the font's own metadata names a license (id 13/14 of the `name` table), for example `https://openfontlicense.org` | read the URL, confirm it covers a published film |
| `status: "FOUND"`, `source: "google-fonts"` | served from `fonts.gstatic.com`; Google Fonts carries only open-source licenses | the `url` is the specimen page; the family's license is listed there |
| `status: "FOUND"`, `source: "license file next to the font"` | an `OFL.txt` / `LICENSE.txt` sits in the same folder on the site; it was copied to `assets/fonts/` and set as `licenseFile` | read it |

`fonts.json` gets `license` / `licenseFile` keys only when a license text was actually copied; an
entry without them has none on record. The script prints a reminder to check every license before
publishing, and the manifest `notes` repeat it.

- Existing `fonts.json` entries are never overwritten: a face is skipped (and listed in
  `fonts.skipped`) when the file already provides the same family, style and unicode-range with the
  same weight or a variable range that contains it. The bundled Inter (`100 900`) therefore absorbs a
  site's static Inter weights.
- A family that loads from Google Fonts can also be vendored the normal way:
  `npm run fonts -- add "Family:400,700"` (Korean and other CJK families: see
  `npm run fonts -- --help`, `--subsets korean`).
- A self-hosted or commercial family is licensed to the site owner. Use it only with the user's
  confirmation and license; otherwise remove it (`npm run fonts -- remove "Family"`), pick the
  closest bundled or open family and say so.
- `system-ui` or a generic family means the site uses system fonts; choose a bundled face.
- Set `studio.json` `brand.fonts` yourself after the check. Capture never does, and the bundled
  Instrument Serif and Inter have no Hangul: for Korean copy check `npm run fonts -- coverage`.

## Text wordmark

Many products have no logo file in the header: the brand is the product name set in a webfont, often with one part in
the accent color (`emu<span>log</span>`). When the header search finds no logo image or SVG, `capture.mjs` looks for the
element that is the brand text (a link to `/`, a `logo`/`brand`/`wordmark` class or id, text equal to the site name, in the
header or nav) and records it as text in `manifest.brand.wordmark` instead of only asking the user for a logo file:

| Key | Content |
|---|---|
| `text`, `displayText` | the text as written and as shown (after `text-transform`) |
| `html` | the element's `innerHTML` (null above 800 characters), so the structure (`emu<span>log</span>`) is exact |
| `parts[]` | one entry per run of text with its own style: `text`, `tag` (null = the element itself), `role`, `color` (`#RRGGBB`), `fontFamily`, `fontWeight`, `fontSize`, `fontStyle`, `textTransform` |
| `colors` | `base` (the element's own color) and `accent`, `accent2` ... for the other part colors |
| `font` | computed `family`, `stack`, `weight`, `size`, `letterSpacing`, `lineHeight`, `style`, `textTransform` |
| `fontLoaded`, `fontRegistry` | whether the browser loaded that family, and its row of the font registry (below) |
| `selector`, `box`, `link`, `crop` | where it sits on the page and the reference crop `assets/brand/logo/wordmark-crop.png` |

A note says so (`no logo image or SVG found; the brand is a text wordmark ...`). Rebuild the wordmark in the film from this
record with the same font, per-part colors and letter-spacing; ask for an SVG or PNG only when the film needs an exact lockup.
A page with a logo image or SVG records no wordmark, and a stale `brand.wordmark` from an earlier run is removed.

## Font registry report

For every family in use (computed styles of body, headings, buttons, nav and inputs, the wordmark, and every face the browser
loaded) the run prints `font registry: <family> (<used by>): <text>` and stores the same rows in `manifest.fonts.registry`:

| `status` | Meaning |
|---|---|
| `registered` | already in `assets/fonts/fonts.json` before this run; this run added nothing |
| `registered+added` | in `fonts.json`, and this run added more faces of the family |
| `added` | not in `fonts.json` before; this run saved the files and registered them |
| `not-registered` | a web font that was not registered (`--no-fonts`, a face that never loaded, a failed download; the reason is given) |
| `system` | a generic or installed font (`-apple-system`, `sans-serif`, a family with no `@font-face`): nothing to register |

`license` is `verified` when every entry of the family carries a license id and a license text file in `fonts.json` (as
`node tools/fonts.mjs add-file ... --license-file ...` writes them), `unverified` when none does, `mixed` for both, and `found`
when this run copied a license text next to the font (read it). A face added next to a verified entry of the same family reuses
its license (`fonts.files[].license.source: "fonts.json"`, with `reusedFrom` naming the entry and the note naming the basis), so a second UNVERIFIED entry is never added beside a verified one.
The reuse needs evidence that the file belongs to the same distribution: the entry's recorded `source` has the same origin as the new file, or the entry has no `source` (registered by hand) and the new file's own license check does not name a different license. A file from another origin, or one that declares another license, gets its own license check (UNVERIFIED unless one is found) and keeps no borrowed license.
When a family is `unverified` or `mixed`, a closing note names it: record a license before adding anything for it.

## States capture

`scripts/states.mjs <url>` photographs what one load cannot. It writes `<viewport>-<state>.png` files and `states.json` into
`assets/brand/states/<name>/` (`--name`, default the page host; or `--out <folder inside the project>`):

| State | When |
|---|---|
| `00-first` | always: the page as it loads |
| `01-escape` | only when the consent click or Escape changed the pixels (a promo modal closed) |
| `scroll-NN` | up to `--scroll-frames 6` frames through whatever scrolls, the window or an inner app pane (a note says which) |
| `full` | `--full-page`, and always for a scrolling mobile page |
| `10-click-<selector>`, `11-click-...` | one per `--click`, in order, after `--wait 700` ms |
| `crop-20-<selector>`, `crop-21-...` | one per `--crop` (file `<viewport>-crop-20-<selector>.png`, like every shot carries its viewport prefix), with computed `bg`, `color`, `radius`, `border`, `shadow`, `font`, `box` in `states.json` |

Selectors are Playwright selectors (`text=Pricing`, `text=구동 보고`, `button:has-text("Try")`, CSS). A selector that is not visible
is skipped with a note, a failing one is listed in `errors` (exit code 1) and the other states are still written. The banner click
is the one of `--dismiss-banners` in capture.mjs (turn it off with `--no-dismiss-banners`). Flags: `--viewport desktop|mobile|both`,
`--locale`, `--settle`, `--timeout`, `--allow-private`, `--no-sandbox`. It prints one JSON line (`ok`, `states`, `shots`, `crops`,
`blocked`, `via`, `sandbox`, `notes`, `errors`).

Browser. States and canvas frames use capture.mjs's launcher: the shared browser policy (Windows: the bundled headless shell, never
an installed Chrome or Edge), the renderer sandbox on, bounded closes. The project's own `tools/studio.mjs` `launchBrowser` is used
only with `--project-launcher`, because Playwright's default flags turn the sandbox off with it; use that for a page you trust.

Plugin install: `node "${CLAUDE_PLUGIN_ROOT}/skills/product-reel/scripts/states.mjs" <url> --root <project> ...`. Skills-only install:
`node "${CLAUDE_SKILL_DIR}/scripts/states.mjs" <url> --root <folder> ...`; `--root` (default: the nearest folder with `studio.json`,
else the current folder) is where `playwright` must resolve and where `assets/brand/states/` is created. This script replaces the
~400-line script that used to be embedded in `agents/asset-scout.md` and ran from stdin; `<outDir> <url>` is still accepted as the two
positional arguments.

## Canvas frames

Some products draw their demo screen in one `<canvas>` that changes per click and animates by itself. `capture.mjs` takes one
shot at load, `states.mjs` one shot per click at the wall-clock moment the screenshot lands. `scripts/canvas-frames.mjs` samples
the canvas over time:

```
node canvas-frames.mjs <url> --canvas "#screen canvas" "--clip=ready" "--clip=db=.tab[data-go=db]" --seconds 9 --step-ms 33 --down 4 --before-each ".tab[data-go=ready]"
node canvas-frames.mjs pack --range db=4:200 --range ready=4:130
```

- Each `--clip name=<selector>` clicks the element at t = 0 inside the page and then records `--seconds` of frames, one every
  `--step-ms` (a fixed start time plus `n x step`, so a slow frame does not shift the later ones; the real time of every frame is
  kept). A clip without `=selector` samples the canvas as it is. `--before-each` clicks a selector (and waits `--before-wait`) before
  every clip so each starts from the same state, for example another screen so the transition always plays. `--probe <selector>`
  records that element's text with every frame (a breadcrumb that names the screen). The click is a DOM `click()`, not pointer
  events.
- Output per clip: `<out>/<clip>.png`, a sprite sheet of `--cols 10` frames per row, and `<out>/frames.json`: canvas selector, buffer and
  CSS size, `frame` size, `scale` (`1:1` or `down` with its factor), `stepMs`, and per clip `file`, `frames`, `rows`, `times[]` (ms since
  the click), `hashes[]` (one FNV-1a hash per frame), `distinct`, `firstChange`, `blank`, `maxLagMs`, `label`, `probe[]`.
- Why integer scaling and never an element screenshot. The canvas has a pixel buffer (`canvas.width x canvas.height`) that the page
  scales into a CSS box, and a screenshot of the box is the scaled result. When the box is not a whole multiple of the buffer, the
  browser resamples it: a 1280 px wide buffer in a 640 px `border-box` with a 2 px border draws into 1272 device px, a ratio of
  0.99375, and a pixel-art canvas turns blurry. The script instead calls `drawImage(canvas, 0, 0, w, h, x, y, fw, fh)` on a sheet
  context with `imageSmoothingEnabled = false` at a whole-number ratio (1:1, or an exact divisor: `--down 4` turns 1280x960 into
  320x240), so every frame is the page's own pixels. A note reports a canvas that the page shows at a non-integer scale.
  `--frame WxH` or `--down N` that is not a whole-number reduction of the buffer on both axes is refused. The film then scales the
  frames by whole numbers.
- Notes warn when a clip never changed (`distinct` 1: nothing animated, or the click did nothing), when frames are fully transparent
  (a WebGL canvas without `preserveDrawingBuffer` reads back blank outside its draw call) and when sampling fell behind
  (`maxLagMs`). A tainted canvas (a cross-origin image drawn without CORS) or a canvas that changes its buffer size while sampling
  stops the run with an error.
- `pack` keeps only the frames the film plays: `--range name=first:count` (slot `i` of the pack = source frame `first + i`),
  `--trim-lead` (start at the first frame that differs from frame 0), `--cols`. It writes `<dir>/pack/<clip>.png` and
  `pack/pack.json` (`first`, `n`, `cols`, `rows`, `frame`, `times`, `hashes`). Pixels are copied, never resampled, and the PNG
  reader and writer are built in: no ffmpeg is needed.
- Same safety stack as the other scripts: `--allow-private`, `--no-sandbox`, `--project-launcher`, `--locale`, `--dpr` (a canvas
  that sizes its buffer to the device pixel ratio needs the same value as the page it was measured on; default 2 on desktop).
  Skills-only: `node "${CLAUDE_SKILL_DIR}/scripts/canvas-frames.mjs" ...` with `--root <folder>`.

## Using the captures in the film

- Load images in the film's `setup()` so every frame draws from decoded bitmaps; never fetch
  inside a draw call.
- Screens are at 2x device scale: a 1440 px wide desktop capture is 2880 px, enough to fill a
  1920 px wide frame or to zoom into a panel without blur.
- Crop further in code (`drawImage` with a source rectangle) using the `box` values scaled by the
  device scale factor.
- Match rebuilt UI to the crops: corner radius, padding and colors measured from the image.

## When capture falls short

| Symptom (in `notes`) | Action |
|---|---|
| bot check page | ask the user for screenshots and the logo; do not try to bypass it |
| login wall, empty app shell | ask for screenshots of the logged-in product, or a demo account the user controls |
| `no logo image or SVG found; the brand is a text wordmark ...` note | the brand is type: rebuild it from `manifest.brand.wordmark` (see "Text wordmark"); ask for an SVG or PNG only for an exact lockup |
| `no logo image or SVG and no text wordmark found` note | ask for an SVG; the favicon is a last resort |
| the screen is a `<canvas>` that animates or changes per click | `canvas-frames.mjs` (see "Canvas frames") |
| `font registry: ... UNVERIFIED` note | record a license before adding or using the family (`node tools/fonts.mjs add-file ... --license-file ...`) |
| cross-origin stylesheets not readable | colors and fonts still come from computed styles and the `@font-face` rules are fetched separately; only CSS variables may be missing |
| a font you expected is not in `assets/fonts/` | it was not loaded on that page (see the `not used by this page` note), or `fonts.skipped` says why; rerun with a `--selector` or another URL where the text appears |
| `not an image (declared ...)` note | the URL served HTML or another non-image with a 200; ask for the logo file |
| `component crop skipped: <selector> ...` note | the element is off the page, hidden or too small; pick another selector |
| cookie banner covers the page | rerun with `--dismiss-banners`. It matches accept, agree and allow labels in English, Korean, Japanese, Chinese, German, French and Spanish (`모두 허용`, `동의`, `同意`, `Alle akzeptieren` ...), and OK, Got it, Close, `확인`, `닫기` only inside a fixed or sticky bar, a dialog or a cookie, consent or modal container. `notes` say `clicked cookie banner button "<label>"`, `dismiss-banners: no banner matched (N visible buttons and links checked ...)` or `the check failed`. On a miss, click it with `states.mjs --click=<selector>` (the `asset-scout` agent runs it) |
| `blocked N request(s) to private, local or non-web addresses` note | the page reached for a local or LAN address; expected for trackers and dev servers. Nothing was saved from them. Use `--allow-private` only for a page you trust |
| `navigation refused` error | the URL points at a private, local or non-web address; use the public URL, or `--allow-private` for your own dev server |
| Chrome cannot start with its sandbox (container, CI as root) | pass `--no-sandbox` or set `MOTION_NO_SANDBOX=1`, and capture only pages you trust |
| `could not launch a browser: no safe browser found.` (Windows) | the headless shell is not installed: `npx playwright install chromium-headless-shell` in the film project. An installed Chrome or Edge is a guarded opt-in there (each fresh-profile launch counts as a failed Windows logon) |
| `refusing to start chrome: N launches of an installed Chrome/Edge in the last 10 minutes ...` (Windows) | the launch guard of an installed browser you chose: wait the time it names, or switch to the headless shell and clear `browser`, `MOTION_BROWSER` and `MOTION_CHROME_PATH` |
| animations caught mid-way | rerun with `--settle 2` |
| single-page app still loading | increase `--settle`; the script already waits for network idle up to 8 s |

File names of components and icons keep Unicode letters, digits and marks (Hangul, kana, accents), at most 40 code points;
two different inputs that slug to the same name get a `-<6 hex>` hash suffix instead of overwriting each other.

Capture only sites the user owns or has permission to use in a promotional film.
