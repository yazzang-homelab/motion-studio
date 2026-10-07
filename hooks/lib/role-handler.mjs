// PreToolUse (Write|Edit|MultiEdit): keep motion-studio subagents inside their write lanes.
// Lanes are relative to the studio project root. The main session and every other agent are
// never restricted (silent). A plugin subagent reports agent_type "motion-studio:<name>"; the
// last ":"-segment is the role, so the guard also covers same-named project agents.
import { normPath, resolvePath, findProjectRoot, relInside, realish } from './common.mjs';

const LANES = {
  'chapter-animator': ['film/scenes/**', 'out/check/**'],
  'motion-critic': ['docs/review_log.md', 'out/review/**'],
  'style-analyst': ['docs/style_guide.md', 'docs/shotlist.md', 'refs/**'],
  'asset-scout': ['assets/**'],
  'motion-director': ['docs/**'],
};

// Carve-outs inside a lane. Shared elements (film/scenes/shared_<name>.js: hero, UI kit) are imported by
// every chapter and owned by the director/main session (docs/ANIMATION_GUIDE.md), so one chapter's
// subagent must not change them under the others. Any extension: a shared_*.mjs or data file is just as shared.
const READ_ONLY = {
  'chapter-animator': ['film/scenes/shared_*'],
};

const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const f = (s) => (FOLD ? s.toLowerCase() : s);

function roleOf(agentType) {
  if (typeof agentType !== 'string' || !agentType.trim()) return null;
  const role = agentType.trim().split(':').pop();
  return Object.prototype.hasOwnProperty.call(LANES, role) ? role : null;
}

// Patterns: "dir/**" = anything below dir; "*" = any run of characters within one path segment; else exact.
function matches(rel, pat) {
  const r = f(rel);
  const p = f(pat);
  if (p.endsWith('/**')) return r.startsWith(p.slice(0, -2)) && r.length > p.length - 2;
  if (p.includes('*')) {
    const re = p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
    return new RegExp(`^${re}$`).test(r);
  }
  return r === p;
}

const allowed = (rel, lanes) => lanes.some((pat) => matches(rel, pat));

function deny(reason) {
  return { json: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } };
}

export async function handle(input) {
  const role = roleOf(input.agent_type);
  if (!role) return null;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const raw = ti.file_path ?? ti.path ?? null;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const target = resolvePath(input.cwd, raw) ?? normPath(raw);
  if (!target) return null;

  const cwdRoot = input.cwd ? findProjectRoot(input.cwd) : null;
  const fileRoot = findProjectRoot(target);
  const root = fileRoot ?? cwdRoot;
  if (!root) return null; // not a studio project: lanes do not apply

  // Scratch files of the session are always fine.
  const scratch = normPath(input.scratchpad_dir ?? '');
  if (scratch && relInside(realish(scratch), realish(target)) !== null) return null;

  const lanes = LANES[role];
  const readOnly = READ_ONLY[role] ?? [];
  const rel = relInside(realish(root), realish(target));
  const lane = lanes.join(', ') + (readOnly.length ? ` (except ${readOnly.join(', ')})` : '');
  const who = String(input.agent_type).trim();
  if (rel === null || rel === '') {
    return deny(`motion-studio role-guard: ${who} may only write ${lane} inside the studio project ${root}; ${target} is outside it. `
      + 'Return the change you need to the main session instead of writing it.');
  }
  const shared = readOnly.find((pat) => matches(rel, pat));
  if (shared) {
    return deny(`motion-studio role-guard: ${who} may not write ${rel}: ${shared} files are shared by every chapter and read-only `
      + 'for chapter subagents. Report the bug or the change you need (file, reason, proposed edit) to the main session instead.');
  }
  if (allowed(rel, lanes)) return null;
  return deny(`motion-studio role-guard: ${who} may only write ${lane} (relative to ${root}); ${rel} is outside that lane. `
    + 'Report the needed change (file, reason, proposed edit) to the main session instead of editing it.');
}

