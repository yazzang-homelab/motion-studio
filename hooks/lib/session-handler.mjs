// SessionStart (startup|resume|clear|compact): when the session starts inside a studio project,
// add a short factual status (title, formats, timing, critique-gate state, finals on disk) and the
// next suggested command. Outside a studio project: no output.
import { findProjectRoot, loadStudioConfig, gateStatus, formatScores, countP0, clip, exists } from './common.mjs';

const MAX_CONTEXT = 1200;

function listFormats(cfg) {
  const formats = Array.isArray(cfg.formats) && cfg.formats.length ? cfg.formats.map(String) : ['9x16'];
  const primary = formats.includes(cfg.primaryFormat) ? cfg.primaryFormat : formats[0];
  return { formats, primary };
}

function finalsOnDisk(root, formats) {
  const present = [];
  const missing = [];
  for (const fmt of formats) (exists(`${root}/out/${fmt}/final.mp4`) ? present : missing).push(fmt);
  return { present, missing };
}

function nextStep(root, cfg, status, finals) {
  if (!exists(`${root}/node_modules`)) return 'npm install, then npm run doctor (browser, ffmpeg, fonts).';
  if (!exists(`${root}/film/film.js`)) return 'write film/film.js (shot list first: /motion-studio:motion-reel).';
  const gateOn = !(cfg.gate && cfg.gate.enabled === false);
  if (gateOn && status && !status.pass) {
    return status.rounds === 0
      ? 'npm run stills, then start the critique loop (/motion-studio:critique-loop).'
      : `continue the critique loop: npm run critique, fix the 3 worst problems, log round ${status.rounds + 1} in docs/review_log.md.`;
  }
  if (finals.missing.length) return 'npm run build (final render of every format + sfx + mix + deliver).';
  if (!exists(`${root}/out/deliver/manifest.json`)) return 'npm run deliver (delivery checks + package).';
  return 'deliverables are in out/deliver/; iterate on notes or ship.';
}

export async function handle(input) {
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = findProjectRoot(cwd);
  if (!root) return null;
  const { cfg, error } = await loadStudioConfig(root);
  const { formats, primary } = listFormats(cfg);
  const status = await gateStatus(root, cfg);
  const finals = finalsOnDisk(root, formats);

  const lines = [];
  lines.push(`motion-studio project "${clip(cfg.title ?? 'Untitled Film', 80)}" at ${root}.`);
  if (error) lines.push(`studio.json problem: ${clip(error, 200)}`);
  const others = formats.filter((f) => f !== primary);
  lines.push(`Formats: ${primary} (primary)${others.length ? `, ${others.join(', ')}` : ''}. `
    + `${cfg.duration ?? '?'} s at ${cfg.fps ?? '?'} fps, ${cfg.bpm ?? '?'} BPM${cfg.loop ? ', seamless loop' : ''}.`);

  const gate = cfg.gate ?? {};
  if (gate.enabled === false) {
    lines.push('Critique gate: disabled by the user in studio.json.');
  } else if (!status) {
    lines.push('Critique gate: status unavailable (plugin gate module missing).');
  } else {
    const scores = formatScores(status.last);
    const p0 = countP0(status.last);
    lines.push(`Critique gate: ${status.pass ? 'PASS' : 'not passed'}; ${status.rounds}/${gate.minRounds ?? 3} rounds in docs/review_log.md`
      + `${scores ? `; last round ${scores}` : ''}${p0 ? `; ${p0} open P0` : ''}.`
      + `${status.pass ? '' : ' Final renders (render:final, build) are blocked until it passes.'}`);
  }
  lines.push(finals.present.length
    ? `Finals on disk: ${finals.present.join(', ')}${finals.missing.length ? `; missing ${finals.missing.join(', ')}` : ''}.`
    : 'Finals on disk: none yet.');
  lines.push(`Next: ${nextStep(root, cfg, status, finals)}`);

  let text = lines.join('\n');
  if (text.length > MAX_CONTEXT) text = clip(text, MAX_CONTEXT);
  return { json: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } } };
}

