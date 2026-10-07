// Baseline of the machine-found candidates (pops, hard jumps, dead spans) of the previous critique run, so a critic reviews
// the delta instead of re-verifying the same candidates every round. Pure functions plus the baseline.json read/write.
//
// out/review/<fmt>/baseline.json (video: out/review/<fmt>/video/baseline.json) holds the candidate times of the last run.
// A candidate of the current run is "same" when the previous run had one of the same kind within 2 frames (0.2 s on a sampled long or DOM film) (pops) or a
// dead span overlapping by at least half of the shorter span. A range review (--from/--to) compares only the part of
// the baseline inside its range and replaces only that part.
import path from 'node:path';
import { readJSON, writeJSON } from './studio.mjs';

export const BASELINE_FILE = 'baseline.json';
const r3 = (x) => Math.round(x * 1000) / 1000;

/** Candidates of one run as plain { kind, t, to?, frame? } rows: flickers, jumps (findings and stepped info), dead spans. */
export function candidatesOf(px) {
  const pops = [...px.pops.list.filter((p) => !p.atShotBoundary), ...(px.pops.info ?? []).filter((p) => !p.atShotBoundary)];
  return [...pops.map((p) => ({ kind: p.kind, t: p.t, frame: p.frame })), ...px.deadSpans.spans.map((s) => ({ kind: 'dead', t: s.from, to: s.to }))];
}

function sameCandidate(a, b, tol) {
  if (a.kind !== b.kind) return false;
  if (a.kind !== 'dead') return Math.abs(a.t - b.t) <= tol + 1e-6;
  const ov = Math.min(a.to, b.to) - Math.max(a.t, b.t);
  return ov >= 0.5 * Math.min(a.to - a.t, b.to - b.t) - 1e-9;
}

export function readBaseline(dir) {
  const doc = readJSON(path.join(dir, BASELINE_FILE), null);
  return doc && Array.isArray(doc.pops) && Array.isArray(doc.deadSpans) ? doc : null;
}

const fromDoc = (doc) => [...doc.pops.map((p) => ({ kind: p.kind, t: p.t, frame: p.frame })), ...doc.deadSpans.map((s) => ({ kind: 'dead', t: s.from, to: s.to }))];
const inRange = (c, range) => c.t >= range.from - 1e-6 && c.t < range.to - 1e-6;

/**
 * Compares the current run with the baseline document and marks isNew on the px objects (pops.list, pops.info, deadSpans.spans).
 * @returns {null | { previous:{at,filmHash,mode}, sameFilm:boolean|null, total:number, same:number, new:object[], gone:object[] }}
 *   null = no baseline yet (first run in this folder); the objects stay unmarked.
 */
export function compareBaseline(prevDoc, px, { tol, range, filmHash = null }) {
  if (!prevDoc) return null;
  const prev = fromDoc(prevDoc).filter((c) => range.full || inRange(c, range));
  const used = new Set();
  const mark = (obj, cand) => {
    const i = prev.findIndex((c, j) => !used.has(j) && sameCandidate(c, cand, tol));
    if (i >= 0) used.add(i);
    obj.isNew = i < 0;
    return i >= 0;
  };
  let same = 0;
  const fresh = [];
  const objs = [
    ...[...px.pops.list, ...(px.pops.info ?? [])].filter((p) => !p.atShotBoundary).map((p) => [p, { kind: p.kind, t: p.t, frame: p.frame }]),
    ...px.deadSpans.spans.map((s) => [s, { kind: 'dead', t: s.from, to: s.to }]),
  ];
  for (const [o, c] of objs) { if (mark(o, c)) same++; else fresh.push(c); }
  return {
    previous: { at: prevDoc.at ?? null, filmHash: prevDoc.filmHash ?? null, mode: prevDoc.mode ?? null },
    sameFilm: prevDoc.filmHash && filmHash ? prevDoc.filmHash === filmHash : null,
    total: objs.length, same, new: fresh, gone: prev.filter((_, j) => !used.has(j)),
  };
}

/** The baseline document for this run: the previous baseline outside the reviewed range, this run's candidates inside it. */
export function nextBaseline(prevDoc, px, { mode, format, fps, range, filmHash, at = new Date().toISOString() }) {
  const cur = candidatesOf(px);
  const keep = prevDoc && !range.full ? fromDoc(prevDoc).filter((c) => !inRange(c, range)) : [];
  const all = [...keep, ...cur].sort((a, b) => a.t - b.t || (a.kind < b.kind ? -1 : 1));
  return {
    version: 1, createdBy: 'motion-studio', tool: 'critique', mode, format, at, filmHash, fps,
    range: { from: range.from, to: range.to, full: !!range.full },
    pops: all.filter((c) => c.kind !== 'dead').map((c) => ({ kind: c.kind, t: r3(c.t), frame: c.frame })),
    deadSpans: all.filter((c) => c.kind === 'dead').map((c) => ({ from: r3(c.t), to: r3(c.to) })),
  };
}

export function writeBaseline(dir, doc) { writeJSON(path.join(dir, BASELINE_FILE), doc); }

/** The "Film version and delta" section of metrics.md (plain lines, no table). */
export function deltaLines({ delta, pin, firstRun, det }) {
  const L = ['## Film version and delta (what changed since the last evidence)', ''];
  L.push(`- Film version: filmHash ${pin.hash.slice(0, 16)}… (sha256 of film/** + lib/** + studio.json, ${Object.keys(pin.files).length} files; full value in metrics.json and film-hash.json). The critic must compare it with the live film (node tools/critique.mjs --check-hash) before rendering any zoom still.`);
  if (!delta) L.push(`- Baseline: ${firstRun ? 'none yet; this run wrote baseline.json' : 'unreadable; this run replaced baseline.json'}. The next run prints "same as previous run: N of M candidates".`);
  else {
    L.push(`- Previous run: ${delta.previous.at ?? 'unknown time'}${delta.sameFilm === true ? ', same film version' : delta.sameFilm === false ? ', the film was edited since' : ''}.`);
    L.push(`- same as previous run: ${delta.same} of ${delta.total} candidates (pops, jumps, dead spans)${delta.total ? '' : '; none this run'}.`);
    if (delta.new.length) {
      L.push(`- NEW since the previous run (review these first): ${delta.new.length}`);
      for (const c of delta.new) L.push(`  - ${c.kind === 'dead' ? `dead span ${c.t}–${c.to} s` : `${c.kind} f${c.frame} @ ${c.t} s`}`);
    } else L.push('- NEW since the previous run: none (every candidate was already in the previous run; dismiss them again only if the film changed there).');
    if (delta.gone.length) L.push(`- Gone since the previous run: ${delta.gone.length} (${delta.gone.slice(0, 6).map((c) => (c.kind === 'dead' ? `dead ${c.t}–${c.to}` : `${c.kind} @ ${c.t}`)).join(', ')}${delta.gone.length > 6 ? ', …' : ''}).`);
  }
  if (det?.reused) L.push(`- Determinism: reused from the run of ${det.reused.at} (same filmHash, assets, format, range and tool code; --skip-determinism-repeat). Run without the flag to repeat the three passes.`);
  return L;
}

/** The "suppressed" section: what critique.stepped / critique.popIgnore held back, with the candidates themselves. */
export function suppressedLines(pops) {
  const s = pops.suppressed;
  if (!s || (!s.stepped && !s.popIgnore.length)) return [];
  const L = ['## Suppressed by studio.json (not findings)', ''];
  for (const w of s.why) L.push(`- ${w}`);
  const fmt = (p) => `${p.kind} f${p.frame} @ ${p.t} s ×${p.ratio}${p.span ? ` (popIgnore ${p.span[0]}–${p.span[1]} s)` : ''}`;
  if (pops.info?.length) L.push(`- info (stepped hard jumps): ${pops.info.slice(0, 12).map(fmt).join('; ')}${pops.info.length > 12 ? `; … +${pops.info.length - 12} more (metrics.json pops.info)` : ''}`);
  if (pops.ignored?.length) L.push(`- ignored (popIgnore): ${pops.ignored.slice(0, 12).map(fmt).join('; ')}${pops.ignored.length > 12 ? `; … +${pops.ignored.length - 12} more (metrics.json pops.ignored)` : ''}`);
  L.push('- The critic still looks at the strip around a suspicious frame; a stepped film can have a real glitch, which shows as a flicker (P1) or as a jump outside its steps.');
  return L;
}
