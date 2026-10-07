#!/usr/bin/env node
// Automated evidence for the critique loop (course step 11): labelled stills, a strip, a phone test and machine
// metrics (determinism, glyph coverage of the drawn text, dead spans, single-frame pops, frame 0, loop seam, corner
// labels, frame borders, cue sync, loudness, silent spans), then the 7-axis rubric and a ready-to-fill review-log
// block. It never scores; the critic does.
// Determinism check = in-order / shuffled / fresh-page hashes at times straddling every shot boundary and cue
// (idea from buildwithhanif/claude-animation-skill `verify`, MIT; reimplemented). Pop scan = frame-difference
// spikes against their neighbours (@twoclipping's "3x their neighbours" rule).
//
//   node tools/critique.mjs [--format f] [--video [PATH]] [--from S] [--to S] [--strip-at S] [--page-height PX] [--no-determinism] [--skip-determinism-repeat] [--json]
//   node tools/critique.mjs --check-hash [--format f] [--video]     does the live film still match the evidence? (exit 0 = yes)
//
// This file is the CLI driver. The metric maths lives in critique-metrics.mjs, the live-film pass in critique-live.mjs (glyph
// preflight: critique-fonts.mjs), the rendered-mp4 pass in critique-video.mjs, the evidence sheets in critique-sheets.mjs and the
// printed report in critique-report.mjs.
//
// Evidence of the LIVE film lives in out/review/<fmt>/; evidence of a rendered mp4 (--video) in out/review/<fmt>/video/.
// The two never overwrite each other: the critic compares them (live: determinism, glyph coverage, loop.png, exact
// pixels; video: what the encode and the mix really contain, loudness and silent spans included).
// contact / shots / phone / strip are sheets of whole tile rows, paged so that no image is taller than --page-height
// (default 1800 px; the image viewer shrinks anything past ~2000 px, so a page is also never wider than 1990 px): page 1 is
// <name>.png, page n >= 2 is <name>-n.png (contact.png, contact-2.png ...), the same rule as tools/stills.mjs; pages of an
// earlier run are deleted. Every page is listed in metrics.md and in the --json result (pages).
// --from / --to review one chapter: stills, sheets and every metric cover only that range (metrics.json range).
import fs from 'node:fs';
import path from 'node:path';
import { FORMATS, UsageError, projectRoot, loadConfig, parseArgs, usage, main, writeJSON, writeFileAtomic, ensureDir, log, isMainModule } from './studio.mjs';
import { PAGE_HEIGHT, SHEET_MAX_SIDE } from './stills.mjs';
import { parseReviewLog, checkGate } from './gate.mjs';
import { filmHash, assetsHash, writeFilmHash, checkFilmHash, detKey, toolHash, readDetCache, writeDetCache } from './critique-pin.mjs';
import { readBaseline, compareBaseline, nextBaseline, writeBaseline, deltaLines, suppressedLines } from './critique-baseline.mjs';
import { CRIT_DEFAULTS, findings } from './critique-metrics.mjs';
import { critiqueLive } from './critique-live.mjs';
import { critiqueVideo } from './critique-video.mjs';
import { reviewDir, relDir, otherEvidence, report } from './critique-report.mjs';

export { reviewDir };

// ---------------------------------------------------------------------------------------------------------------
// CLI

const SPEC = {
  format: { type: 'string', alias: 'f', arg: '<fmt>', desc: 'Format to review (default: primaryFormat)' },
  video: { type: 'string', optional: true, arg: '<path>', desc: 'Review a rendered mp4 instead of the live film (bare: out/<fmt>/final.mp4, else silent.mp4); evidence goes to out/review/<fmt>/video/' },
  from: { type: 'number', arg: '<sec>', desc: 'Review only from this time on (one chapter of a long film): stills, sheets and every metric cover the range; frame 0 and the loop seam are checked only for the whole film' },
  to: { type: 'number', arg: '<sec>', desc: 'Review only up to this time (see --from)' },
  'page-height': { type: 'number', default: PAGE_HEIGHT, arg: '<px>', desc: 'Most height of one sheet image (the image viewer shrinks anything past about 2000 px); taller sheets are split into pages of whole tile rows: contact.png, contact-2.png ... (0 = one tall sheet)' },
  'strip-at': { type: 'number', arg: '<sec>', desc: 'Centre of the 12-frame strip (default: the moment with most motion)' },
  determinism: { type: 'boolean', default: true, desc: 'Skip the determinism passes' },
  'skip-determinism-repeat': { type: 'boolean', desc: 'Reuse the passing determinism result of the previous live run when filmHash, assets/, format, range and tool code are unchanged (otherwise the three passes run as usual)' },
  'check-hash': { type: 'boolean', desc: 'Only compare the live film (sha256 of film/** + lib/** + studio.json) with the evidence in out/review/<fmt>[/video]/; exit 0 = match, 1 = mismatch or no hash; starts no browser' },
  json: { type: 'boolean', desc: 'Print one JSON result line on stdout' },
};
const TITLE = `Usage: node tools/critique.mjs [--format f] [--video [PATH]] [--from S] [--to S] [--strip-at S] [--page-height PX] [--no-determinism] [--skip-determinism-repeat] [--json]
       node tools/critique.mjs --check-hash [--format f] [--video]

Writes out/review/<fmt>/{contact,shots,phone,strip,loop}.png + metrics.json + metrics.md and prints the rubric.
A sheet taller than --page-height (default ${PAGE_HEIGHT} px) is split into pages of whole rows, and a page is never wider than ${SHEET_MAX_SIDE} px:
page 1 is contact.png, then contact-2.png, contact-3.png ... (shots, phone and strip the same); open every page.
With --video the same files go to out/review/<fmt>/video/ (the live film's evidence stays untouched, so the two can be compared).
--from/--to review one chapter: the stills, sheets and metrics (dead spans, pops, determinism, glyph coverage, silence) cover only that range.
Live mode also checks that every character the film draws has a glyph in its font (P0 font-fallback); --video checks the mix
for silent spans of 1 s or more (P1 audio-gap; studio.json critique.allowSilence: [[from, to], ...] lists intended ones).
Every evidence folder gets film-hash.json (filmHash = sha256 of film/** + lib/** + studio.json) and baseline.json (pop, jump and dead-span
candidate times); the next run prints "same as previous run: N of M candidates" and lists the new ones first. Stepped (pixel-art) films:
studio.json critique.stepped = true lists hard jumps as info, critique.popIgnore = [[t0, t1], ...] silences the pop scan inside spans.
--skip-determinism-repeat reuses a passing determinism result (determinism-cache.json) when filmHash, assets/ (every file's content), format, range and tool code are unchanged. A browser upgrade is not detected: run once without the flag then.`;

function resolveVideo(root, fmt, v) {
  if (v !== true) {
    const p = path.resolve(v);
    if (!fs.existsSync(p)) throw new Error(`--video: not found: ${v}`);
    return p;
  }
  const cands = [path.join(root, 'out', fmt, 'final.mp4'), path.join(root, 'out', fmt, 'silent.mp4')];
  const hit = cands.find((p) => fs.existsSync(p));
  if (!hit) throw new Error(`--video: no out/${fmt}/final.mp4 or silent.mp4; run npm run render (and npm run mix), or pass a path`);
  return hit;
}

async function cli(argv) {
  const { flags, positionals } = parseArgs(argv, SPEC, { title: TITLE });
  if (flags.help) { process.stdout.write(usage(TITLE, SPEC)); return 0; }
  if (positionals.length) throw new UsageError(`unexpected argument ${positionals[0]}`, usage(TITLE, SPEC));
  const root = projectRoot();
  const cfg = loadConfig(root);
  const fmt = flags.format ?? cfg.primaryFormat;
  if (!FORMATS[fmt]) throw new UsageError(`unknown format "${fmt}" (valid: ${Object.keys(FORMATS).join(', ')})`, usage(TITLE, SPEC));
  if (flags.stripAt != null && !(flags.stripAt >= 0)) throw new UsageError('--strip-at must be ≥ 0');
  if (!(flags.pageHeight >= 0) || (flags.pageHeight > 0 && flags.pageHeight < 200)) throw new UsageError(`--page-height must be 0 (one tall sheet) or at least 200 px (got ${flags.pageHeight})`);
  if (flags.from != null && !(flags.from >= 0)) throw new UsageError(`--from must be ≥ 0 (got ${flags.from})`);
  if (flags.to != null && !(flags.to > (flags.from ?? 0))) throw new UsageError(`--to must be greater than ${flags.from != null ? '--from' : '0'} (got ${flags.to})`);
  if (flags.checkHash) return checkHashCommand(root, fmt, flags);
  const outDir = ensureDir(reviewDir(root, fmt, !!flags.video)); // --video never overwrites the live film's evidence
  const closers = []; // browser + server, closed after the results are written
  try {
    await review(root, cfg, fmt, flags, outDir, closers);
  } finally {
    for (const close of closers.reverse()) await Promise.resolve().then(close).catch(() => {});
  }
  return 0;
}

/** --check-hash: does the live film still match the evidence in out/review/<fmt>[/video]/? No browser; exit 0 only on a match. */
function checkHashCommand(root, fmt, flags) {
  const c = checkFilmHash(root, reviewDir(root, fmt, !!flags.video));
  const NL = String.fromCharCode(10);
  if (flags.json) process.stdout.write(JSON.stringify({ ok: c.match === true, ...c }) + NL);
  else if (c.match === true) process.stdout.write(`film hash MATCH ${c.live.slice(0, 16)}... (${c.dir}/): ${c.reason}${NL}`);
  else process.stdout.write([`film hash ${c.match === false ? 'MISMATCH' : 'UNKNOWN'} (${c.dir}/): ${c.reason}`, `  live     ${c.live.slice(0, 16)}...`, `  evidence ${c.evidence ? `${c.evidence.slice(0, 16)}...` : 'none'}`, ''].join(NL));
  return c.match === true ? 0 : 1;
}

async function review(root, cfg, fmt, flags, outDir, closers) {
  const crit = { ...CRIT_DEFAULTS, ...cfg.critique };
  const t0 = Date.now();
  const pin = filmHash(root); // the film this evidence set will show
  // Determinism cache: only the live film runs the passes; a passing result for the same key is reused on request.
  const live = !flags.video;
  const detParts = { filmHash: pin.hash, assets: assetsHash(root), format: fmt, from: flags.from ?? null, to: flags.to ?? null, tool: toolHash() };
  const key = detKey(detParts);
  const cached = live && flags.skipDeterminismRepeat && flags.determinism !== false ? readDetCache(outDir, key) : null;
  if (live && flags.skipDeterminismRepeat && flags.determinism !== false) log(cached ? `critique: determinism reused from ${cached.at} (same filmHash ${pin.hash.slice(0, 12)}…)` : 'critique: --skip-determinism-repeat: no matching passing result for this film version, running the passes');
  const r = flags.video ? await critiqueVideo(root, cfg, fmt, flags, outDir, resolveVideo(root, fmt, flags.video), closers)
    : await critiqueLive(root, cfg, fmt, cached ? { ...flags, determinism: false } : flags, outDir, closers);
  if (cached) r.determinism = { ...cached.result, skipped: true, pass: true, reused: { at: cached.at, key }, reason: `reused from the run of ${cached.at}: same filmHash ${pin.hash.slice(0, 16)}…, assets, format, range and tool code (${cached.result.samples} times × 3 passes passed then; --skip-determinism-repeat)` };
  const after = filmHash(root);
  const changed = after.hash !== pin.hash;
  if (changed) log(`critique: WARNING the film changed while this run was rendering (film/**, lib/** or studio.json): the evidence mixes two versions; run it again`);
  if (live && !cached && r.determinism && !r.determinism.skipped && !changed) writeDetCache(outDir, key, detParts, r.determinism);
  // Baseline: mark every candidate new or same against the previous run of this folder, then replace the baseline.
  const prevBase = readBaseline(outDir);
  const delta = compareBaseline(prevBase, r.px, { tol: r.px.pops.note ? 0.2 : 2 / r.film.fps, range: r.range, filmHash: pin.hash });
  r.findings = findings(r, crit);
  writeBaseline(outDir, nextBaseline(prevBase, r.px, { mode: r.mode, format: fmt, fps: r.film.fps, range: r.range, filmHash: pin.hash }));
  writeFilmHash(outDir, pin, { mode: r.mode, format: fmt, createdAt: new Date().toISOString(), ...(changed ? { changedDuringRun: true, filmHashAtEnd: after.hash } : {}) });
  const gate = checkGate(root, cfg);
  let rounds = [];
  try { rounds = parseReviewLog(fs.readFileSync(path.join(root, 'docs', 'review_log.md'), 'utf8')); } catch { rounds = []; }
  const nextRound = (rounds.length ? Math.max(...rounds.map((x) => x.n)) : 0) + 1;
  const { px, ...rest } = r;
  const metrics = { version: 1, createdBy: 'motion-studio', tool: 'critique', format: fmt, dir: relDir(root, outDir), critique: crit, seconds: Math.round((Date.now() - t0) / 100) / 10, ...rest,
    ...Object.fromEntries(['deadSpans', 'pops', 'frame0', 'corners', 'borders'].map((k) => [k, px[k]])), sampled: px.sampled,
    filmHash: pin.hash, filmHashFiles: Object.keys(pin.files).length, ...(changed ? { filmChangedDuringRun: true, filmHashAtEnd: after.hash } : {}),
    determinismCache: live ? { key, reused: !!cached, enabled: !!flags.skipDeterminismRepeat } : null,
    baseline: { file: 'baseline.json', first: !prevBase, delta: delta && { previous: delta.previous, sameFilm: delta.sameFilm, total: delta.total, same: delta.same, new: delta.new, gone: delta.gone } },
    gate: { pass: gate.pass, rounds: gate.rounds, reasons: gate.reasons }, nextRound };
  writeJSON(path.join(outDir, 'metrics.json'), metrics);
  const where = { video: r.mode === 'video', dir: relDir(root, outDir), other: otherEvidence(root, fmt, r.mode === 'video') };
  let md = report(r, crit, cfg, fmt, gate, nextRound, where);
  const NL = String.fromCharCode(10);
  const extra = [...deltaLines({ delta, pin, firstRun: !prevBase, det: r.determinism }), ...(changed ? ['- WARNING: the film changed while this run was rendering; this evidence mixes two versions. Run critique again.'] : []), '', ...suppressedLines(px.pops)].join(NL).trimEnd() + NL + NL;
  const at = md.indexOf(`${NL}## Score 1-10`);
  md = at < 0 ? md + NL + extra : md.slice(0, at + 1) + extra + md.slice(at + 1);
  writeFileAtomic(path.join(outDir, 'metrics.md'), md);
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ok: true, format: fmt, mode: r.mode, dir: where.dir, other: where.other, images: r.images, pages: r.pages, range: r.range,
      summary: { determinism: r.determinism.reused ? 'reused' : r.determinism.skipped ? 'skip' : r.determinism.pass ? 'pass' : 'fail', fonts: r.fonts.skipped ? 'skip' : r.fonts.pass ? 'pass' : 'fail', deadSpans: px.deadSpans.spans.length, pops: px.pops.list.filter((p) => !p.atShotBoundary).length, frame0: px.frame0.skipped ? null : px.frame0.pass, loop: r.loop.enabled ? r.loop.pass : null, corners: px.corners.pass, borders: px.borders.pass, syncShare: r.sync.share, audio: r.audio.skipped ? null : r.audio.pass, audioGaps: r.audio.silence?.gaps ? r.audio.silence.gaps.length : null },
      filmHash: pin.hash, delta: delta && { same: delta.same, total: delta.total, new: delta.new.length, gone: delta.gone.length },
      findings: r.findings, nextRound, gate: { pass: gate.pass, reasons: gate.reasons } }) + '\n');
  } else process.stdout.write(md);
  log(`critique: wrote ${where.dir}/ in ${metrics.seconds} s`);
  return 0;
}

if (isMainModule(import.meta.url)) main(() => cli(process.argv.slice(2)));
