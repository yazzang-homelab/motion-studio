// The printed half of tools/critique.mjs: the 7-axis rubric, the severity definitions, the hunt list, where each mode writes, and the
// markdown report (metrics.md) with the ready-to-fill review-log block.
import fs from 'node:fs';
import path from 'node:path';
import { readJSON, fmtTime } from './studio.mjs';
import { silenceLabel } from './refs.mjs';
import { LOOP_RATIO } from './critique-metrics.mjs';

const RUBRIC = [
  ['hook', 'first 2 s', '4 frame 0 empty / logo fading in · 6 moves but generic, centered · 8 frame 0 already composed, an event lands in the first second · 10 an image nobody has seen, hit on the first downbeat'],
  ['readability', 'phone.png, 360 px', '4 key words unreadable or overlapping · 6 readable but cramped or low contrast · 8 every word readable, one focal point, held long enough · 10 instant hierarchy in every format'],
  ['motion', 'springs, no dead frames', '4 linear slides, teleports, pops · 6 springs but uniform, a velocity kink · 8 every move has mass, overlap and stagger · 10 choreographed edges, anticipation, invisible seam'],
  ['variety', 'new thing every 2-4 s', '4 a dead span ≥ 2 s or one shot type repeated · 6 changes but one technique · 8 a new idea every 2-4 s, transitions per cut · 10 escalates and surprises, rhythm on purpose'],
  ['composition', 'framing, safe area', '4 centered on gradient, corner labels, frame borders · 6 balanced but static, a format looks cropped · 8 clear focal point, grid, every format reframed · 10 any frame is a poster'],
  ['brand', 'na for a pure showreel', '4 wrong colors/fonts, invented UI · 6 extra accents, fallback fonts · 8 exact palette, one accent, bundled fonts, real UI · 10 feels like the brand\'s own launch film'],
  ['sound', 'cues, sync, mix', '4 silent, generic pad, clipping · 6 generic SFX, drifting cues · 8 cuts on downbeats, hits within 25 ms, -14 LUFS ±0.5, ≤ -1 dBTP · 10 every hit lands on its event, builds to the drop'],
];
const SEVERITY = [
  ['P0', 'broken or banned; fix before any final render (determinism mismatch, frame 0 empty, overlapping/unreadable key text, banned default look, invented UI, loop seam jump, clipping)'],
  ['P1', 'clearly hurts the film (dead beat, sliding instead of easing, a pop or stutter, weak hook, cramped type, a cue a frame off its event)'],
  ['P2', 'polish (spacing, timing nudge, color balance, grain, a long hold)'],
];
const HUNT = [
  ['text overlapping during swaps', 'contact.png + strip.png around every state change'],
  ['anything sliding instead of easing', 'strip.png spacing between frames'],
  ['corner labels and frame borders', 'metrics corners/borders + contact.png'],
  ['centered-on-gradient shots', 'shots.png'],
  ['blurry scaled text', 'phone.png; will-change warnings in npm run lint'],
  ['a dead beat with nothing happening', 'metrics deadSpans/static beats + contact.png'],
  ['a stutter at the loop seam', 'loop.png + metrics loop (loop films)'],
  ['frame 0 empty', 'metrics frame0 + first contact tile'],
];

function status(ok, skip, warn) { return skip ? 'n/a ' : !ok ? 'FAIL' : warn ? 'WARN' : 'PASS'; }

/** Where a run writes: the live film in out/review/<fmt>/, a rendered mp4 (--video) in out/review/<fmt>/video/. */
export const reviewDir = (root, fmt, video) => path.join(root, 'out', 'review', fmt, ...(video ? ['video'] : []));
export const relDir = (root, dir) => path.relative(root, dir).split(path.sep).join('/');

/** The evidence of the other mode, if a run left any: { dir, mode, at } for the printed report and the JSON result. */
export function otherEvidence(root, fmt, video) {
  const dir = reviewDir(root, fmt, !video);
  const file = path.join(dir, 'metrics.json');
  if (!fs.existsSync(file)) return null;
  const doc = readJSON(file, null);
  const expected = video ? 'live' : 'video';
  // An older critique run wrote its --video evidence over the live files: say what the folder really holds.
  return { dir: relDir(root, dir), mode: doc?.mode && doc.mode !== expected ? `${doc.mode}, written by an older run` : expected, at: fs.statSync(file).mtime.toISOString().replace(/\.\d+Z$/, 'Z') };
}

export function report(r, crit, cfg, fmt, gate, nextRound, where) {
  const px = r.px;
  const L = [];
  // Every file name the report mentions is relative to out/review/<fmt>/; --video evidence lives one folder deeper.
  const at = (text) => (where.video ? String(text).replace(/\b(?:contact|shots|phone|strip|loop)\.png\b|\bmetrics\.(?:json|md)\b/g, (m) => `video/${m}`) : text);
  const rg = r.range;
  L.push(`# Critique evidence · ${r.film.title} · ${fmt} · ${r.mode === 'live' ? `live film (${r.browser.via} ${r.browser.version})` : r.video}`);
  L.push('', `${r.film.duration} s · ${r.film.fps} fps · ${r.film.frames} frames · ${r.film.width}x${r.film.height} · ${r.beats} beats · ${r.cues} cues · ${r.shots.length} shots${r.film.loop ? ' · loop' : ''}${rg.full ? '' : ` · range ${fmtTime(rg.from)}–${fmtTime(rg.to)}`}`);
  const paged = Object.values(r.pages ?? {}).some((p) => p.length > 1);
  L.push('', `## Evidence (${where.dir}/) — open every image with the Read tool${paged ? ', every page of a paged sheet' : ''}`);
  if (!rg.full) L.push(`Range ${fmtTime(rg.from)}–${fmtTime(rg.to)} (--from/--to, frames ${rg.fromFrame}-${rg.toFrame - 1}): the stills, sheets and metrics cover only this range. ${r.mode === 'live' ? 'Frame 0 and the loop seam belong to the whole film and are not checked.' : 'Loudness is the whole file.'}`);
  const desc = { contact: 'one still per beat', shots: 'one still per shot midpoint', phone: 'one still per second at 360 px wide', strip: `${r.strip?.frames ?? 12} consecutive frames from ${fmtTime(r.strip?.from)}${r.strip?.auto ? ' (most motion)' : ''}`, loop: r.loop?.unwrapped ? 'last frame | t=dur unwrapped | seek(0) | |last − first| ×4 (one normal step) | |end − first| ×4 (black = the loop closes)' : 'last frame | seek(0) | |last − first| ×4 (one normal step)' };
  for (const k of ['contact', 'shots', 'phone', 'strip', 'loop']) {
    const pg = r.pages?.[k];
    if (pg && pg.length > 1) pg.forEach((p, i) => L.push(`- ${p.file.padEnd(14)} ${desc[k]} · page ${i + 1}/${pg.length}: ${p.tiles} tiles ${fmtTime(p.from)}–${fmtTime(p.to)}`));
    else if (r.images[k]) L.push(`- ${r.images[k].padEnd(14)} ${desc[k]}`);
  }
  L.push('- metrics.json  every number below');
  L.push('', where.video ? `Rendered-mp4 evidence: it never overwrites the live film's files. ${where.other ? `Live-film evidence from an earlier run: ${where.other.dir}/ (metrics.json ${where.other.at}); compare determinism, loop.png and pops there with the encode's pops and loudness here.` : 'No live-film evidence yet: run node tools/critique.mjs (without --video) for determinism, loop.png and exact pixels.'}`
    : `Live-film evidence. ${where.other ? `Rendered-mp4 evidence from an earlier run: ${where.other.dir}/ (metrics.json ${where.other.at}, ${where.other.mode}); it holds loudness, true peak and what the encode really contains.` : 'For loudness and the encode itself run node tools/critique.mjs --video after npm run mix: it writes out/review/' + fmt + '/video/ and leaves these files alone.'}`);
  L.push('', '## Metrics', '', '| metric | status | evidence |', '|---|---|---|');
  const det = r.determinism;
  L.push(`| determinism | ${status(det.pass, det.skipped)} | ${det.skipped ? det.reason : `${det.samples} times around every shot boundary and cue × 3 passes (in order, shuffled, fresh page): ${det.mismatches.length} mismatch(es)${det.mismatches.length ? ` at ${det.mismatches.slice(0, 5).map((m) => fmtTime(m.t)).join(', ')}` : ''}`} |`);
  const fo = r.fonts;
  const foText = !fo || fo.skipped ? (fo?.reason ?? 'not run')
    : `${fo.faces} font spec(s) drawn (${fo.entries.map((e) => `${e.family} ${e.weight}: ${e.chars} chars`).join(', ') || 'none'}); ${fo.pass ? 'every character has a glyph in its family' : fo.entries.filter((e) => !e.pass).map((e) => `${e.family} ${e.weight}: ${e.missingCount} without a glyph (${e.missing.slice(0, 12).map((m) => m.ch).join(' ')}${e.missingCount > 12 ? ' …' : ''})`).join('; ')}${fo.note ? `; ${fo.note}` : ''}`;
  L.push(`| fonts | ${status(fo?.pass ?? true, !fo || fo.skipped)} | ${foText} |`);
  const quiet = [...px.deadSpans.beatEnergy].sort((a, b) => a.energy - b.energy)[0];
  L.push(`| dead spans | ${status(!px.deadSpans.spans.length)} | ${px.deadSpans.spans.length ? px.deadSpans.spans.map((s) => `${fmtTime(s.from)}–${fmtTime(s.to)} (${s.sec} s)`).join(', ') : `none ≥ ${crit.deadSpanSec} s`}; static beats: ${px.deadSpans.staticBeats.length ? px.deadSpans.staticBeats.join(', ') : 'none'}${quiet ? `; quietest beat ${quiet.beat} (${quiet.energy})` : ''} |`);
  const realPops = px.pops.list.filter((p) => !p.atShotBoundary);
  L.push(`| pops | ${status(!realPops.some((p) => p.kind === 'flicker'))} | ${realPops.length ? realPops.slice(0, 6).map((p) => `${p.kind} f${p.frame} ${fmtTime(p.t)} ×${p.ratio}`).join(', ') : 'no single-frame pops or jumps'}; ${px.pops.cuts.length} hard cut(s) on shot boundaries${px.pops.note ? `; ${px.pops.note}` : ''} |`);
  L.push(`| frame 0 | ${status(px.frame0.pass, px.frame0.skipped)} | ${px.frame0.skipped ? `skipped: ${px.frame0.reason}` : `${(px.frame0.content * 100).toFixed(1)}% of pixels differ from the smooth background (most common colour rgb(${px.frame0.background?.join(',')})) · edge share ${px.frame0.edgeShare}`} |`);
  const lp = r.loop;
  const closure = lp.unwrapped ? `hash(0) ${lp.hashEqual ? '=' : '≠'} hash(dur, { wrap: false })${lp.hashEqual ? '' : ` (end vs first Δ${lp.endDiff})`}` : `${lp.note ?? 'no unwrapped hash'}: continuity only`;
  L.push(`| loop seam | ${status(lp.pass, !lp.enabled)} | ${lp.enabled ? `${closure}; last→first ${lp.seamDiff} vs last step ${lp.prevDiff} (ratio ${lp.ratio ?? 'n/a'}, ≤ ${LOOP_RATIO})` : lp.reason === 'range' ? lp.note : 'not a loop film (studio.json loop=false)'} |`);
  L.push(`| corners | ${status(px.corners.pass)} | frames with small content in the ${Math.round(crit.cornerPct * 100)}% corner boxes: TL ${Math.round(px.corners.share.tl * 100)}% · TR ${Math.round(px.corners.share.tr * 100)}% · BL ${Math.round(px.corners.share.bl * 100)}% · BR ${Math.round(px.corners.share.br * 100)}% |`);
  L.push(`| borders | ${status(px.borders.pass)} | frames with edge lines on ≥ 3 sides: ${Math.round(px.borders.share * 100)}% (top ${Math.round(px.borders.sides.top * 100)}% · bottom ${Math.round(px.borders.sides.bottom * 100)}% · left ${Math.round(px.borders.sides.left * 100)}% · right ${Math.round(px.borders.sides.right * 100)}%) |`);
  const sy = r.sync;
  L.push(`| sync | ${status(sy.impactShare == null || sy.impactShare >= 0.8, !sy.cues)} | ${sy.cues ? `${sy.onBeat}/${sy.cues} cues within 25 ms of a beat (${Math.round(sy.share * 100)}%; hits ${sy.impactShare == null ? 'n/a' : `${Math.round(sy.impactShare * 100)}%`})` : 'no cues'}; shot changes on downbeats ${sy.shotChangesOnDownbeat}/${sy.shotChanges}${sy.offGrid.length ? `; off-grid: ${sy.offGrid.slice(0, 6).map((c) => `${c.type}@${c.t} (+${c.offMs} ms)`).join(', ')}` : ''} |`);
  const a = r.audio;
  const sil = a.silence;
  const silText = !a.present || a.skipped || !sil ? ''
    : sil.skipped ? ` · silence check skipped (${sil.reason})`
      : ` · silence: ${sil.gaps.length ? `${sil.gaps.length} gap(s) of ≥ ${sil.minSec} s below ${sil.noiseDb} dB (${sil.gaps.slice(0, 4).map((g) => silenceLabel(g)).join(', ')})` : `no span of ≥ ${sil.minSec} s below ${sil.noiseDb} dB`}${sil.ignored?.length ? `; ${sil.ignored.length} at the very start/end or allowed` : ''}`;
  L.push(`| audio | ${status(a.pass, a.skipped, a.present && sil?.gaps?.length > 0)} | ${a.skipped ? a.reason : a.present ? `${a.I} LUFS (target ${a.target} ±${a.tol}) · TP ${a.TP} dBTP (≤ ${a.truePeak}) · LRA ${a.LRA} · ${a.channels} ch ${a.sampleRate} Hz · audio ${a.duration} s / video ${a.videoDuration} s${silText}` : 'no audio stream'} |`);
  L.push('', '## Machine-found candidate problems (confirm on the sheets; add what you see)');
  if (r.findings.length) r.findings.forEach((f, i) => L.push(`${i + 1}. [${f.severity}] [${f.t == null ? '--:--.--' : fmtTime(f.t)}] ${f.text} (metrics ${f.metric})`));
  else L.push('none. The metrics cannot see overlaps, slides, blur or taste: the images can.');
  const naOk = gate.naAllowed ?? ['brand']; // normalised by checkGate
  L.push('', `## Score 1-10 on 7 axes (score the worst moment; 8 = ready to ship; \`na\` passes the gate only on ${naOk.length ? naOk.join(', ') : 'no axis'} (gate.naAllowed))`);
  for (const [k, what, anchors] of RUBRIC) L.push(at(`- ${k} (${what}): ${anchors}`));
  L.push('', '## Severity');
  for (const [k, v] of SEVERITY) L.push(`- ${k} ${v}`);
  L.push('', '## Hunt for (course step 11)');
  for (const [k, v] of HUNT) L.push(at(`- ${k}: ${v}`));
  L.push('', 'Full harsh-director prompt: prompts/critique-pass.txt. Be a harsh motion director, not a proud author.');
  L.push('', '## Append to docs/review_log.md (fill every <...>; problems worst first, P0 first)', '', '```');
  L.push(`## Round ${nextRound} — ${fmt} — <what changed since the last round>`);
  L.push(`SCORES: ${(cfg.gate?.axes ?? RUBRIC.map((x) => x[0])).map((k) => `${k}=<${naOk.includes(k) ? '1-10|na' : '1-10'}>`).join(' ')}`);
  L.push('PROBLEMS:');
  const pre = r.findings.slice(0, 3);
  pre.forEach((f, i) => L.push(`${i + 1}. [${f.severity}] [${f.t == null ? 'mm:ss.cc' : fmtTime(f.t)}] ${f.text}`));
  for (let i = pre.length; i < 3; i++) L.push(`${i + 1}. [P0|P1|P2] [mm:ss.cc] <what is wrong and where; which evidence file shows it${where.video ? ' (video/…)' : ''}>`);
  L.push(`FIXES: ${nextRound === 1 ? 'none (first round)' : '<what changed since the previous round>'}`, '```');
  L.push('', `Gate now: ${gate.pass ? 'PASS' : 'FAIL'} (${gate.rounds}/${gate.minRounds} rounds)${gate.reasons.length ? ` — ${gate.reasons.join('; ')}` : ''}`);
  L.push('Next: fix the 3 worst → re-render only the affected seconds (node tools/render.mjs --from A --to B --draft) → node tools/critique.mjs → append the round → node tools/gate.mjs');
  return L.join('\n') + '\n';
}
