// PreToolUse (Bash|PowerShell): block FINAL renders of a studio project until the critique loop
// has passed (tools/gate.mjs#checkGate). Drafts, stills and previews are never gated.
// Fail open on anything unexpected: a missing gate module or an unparsable command means "allow".
import fs from 'node:fs';
import { findProjectRoot, homeDir, loadStudioConfig, gateStatus, formatScores, countP0, clip, readJSONFile } from './common.mjs';
import { detectFinalRenders } from './shell.mjs';

const MAX_REASON = 4000;
const MAX_COMMAND = 256 * 1024;

function dialectFor(toolName) {
  return String(toolName ?? '').toLowerCase() === 'powershell' ? 'powershell' : 'bash';
}

function readScripts(root) {
  const pkg = readJSONFile(`${root}/package.json`, null);
  return pkg && typeof pkg.scripts === 'object' ? pkg.scripts : null;
}

function denyReason(root, cfg, status, via) {
  const gate = cfg.gate ?? {};
  const minRounds = gate.minRounds ?? 3;
  const minScore = gate.minScore ?? 8;
  const lines = [];
  lines.push(`motion-studio gate: final render blocked for "${cfg.title ?? 'Untitled Film'}" (${root}).`);
  lines.push(`Command: ${clip(via, 160)}`);
  if (status.reasons.length) lines.push(`Why: ${status.reasons.join('; ')}`);
  const scores = formatScores(status.last);
  lines.push(`Status: ${status.rounds}/${minRounds} critique rounds logged in docs/review_log.md${scores ? `; last round ${scores}` : ''}${countP0(status.last) ? `; ${countP0(status.last)} open P0` : ''}.`);
  lines.push(
    `To proceed: run the critique loop (skill /motion-studio:critique-loop, agent motion-critic): npm run critique, look at out/review/<format>/*.png, `
    + `append a "## Round N" block (SCORES + PROBLEMS) to docs/review_log.md, fix the 3 worst problems, repeat until `
    + `npm run gate passes (>= ${minRounds} rounds, every axis >= ${minScore}, na only on axes in gate.naAllowed (default brand), no P0 in the last round).`,
  );
  lines.push('Drafts are not gated: npm run render, npm run animatic, node tools/render.mjs --draft, npm run stills.');
  lines.push('Only the user may waive the gate by setting "gate": { "enabled": false } in studio.json; do not change that setting yourself.');
  return clip(lines.join('\n'), MAX_REASON);
}

export async function handle(input) {
  const tool = input.tool_name;
  if (tool && !/^(bash|powershell)$/i.test(String(tool))) return null;
  let command = input.tool_input && typeof input.tool_input.command === 'string' ? input.tool_input.command : '';
  if (!command.trim()) return null;
  // Render commands are short; a huge command is a file write (heredoc). Bound the parse time.
  if (command.length > MAX_COMMAND) command = command.slice(0, MAX_COMMAND);
  // Cheap pre-filter: every final-render shape (direct, package script, nested shell, encoded
  // PowerShell) mentions one of these words.
  if (!/render|build|node|npm|pnpm|yarn|bun|\s-e/i.test(command)) return null;

  const cache = new Map();
  const findRoot = (dir) => {
    if (!cache.has(dir)) cache.set(dir, findProjectRoot(dir));
    return cache.get(dir);
  };
  const hits = detectFinalRenders(command, {
    dialect: dialectFor(tool),
    cwd: input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    env: process.env,
    home: homeDir(),
    findRoot,
    readScripts,
  });
  if (!hits.length) return null;

  const blocked = [];
  const seenRoots = new Set();
  for (const hit of hits) {
    if (seenRoots.has(hit.root)) continue;
    seenRoots.add(hit.root);
    if (!fs.existsSync(`${hit.root}/studio.json`)) continue;
    const { cfg } = await loadStudioConfig(hit.root);
    if (cfg.gate && cfg.gate.enabled === false) continue;
    const status = await gateStatus(hit.root, cfg);
    if (!status || status.pass) continue; // gate module unavailable → fail open
    blocked.push(denyReason(hit.root, cfg, status, hit.via));
  }
  if (!blocked.length) return null;
  return {
    json: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: clip(blocked.join('\n\n'), 9000),
      },
    },
  };
}

