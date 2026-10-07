// PostToolUse (Write|Edit|MultiEdit): lint film/lib code of a studio project for determinism and
// house-rule violations right after Claude changes it. Errors → exit 2 with a short stderr report
// (Claude sees it next to the tool result). Warnings only → additionalContext JSON. Otherwise silent.
import fs from 'node:fs';
import { normPath, resolvePath, findProjectRoot, relInside, importTemplate } from './common.mjs';

const MAX_LINES = 20;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const LINTED = /^(film|lib)\/.+\.(js|mjs|html|css)$/i;

function inLintScope(rel) {
  return rel.toLowerCase() === 'index.html' || LINTED.test(rel);
}

function editedPath(input) {
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const tr = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {};
  const raw = ti.file_path ?? ti.path ?? tr.filePath ?? tr.file_path ?? null;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return resolvePath(input.cwd, raw) ?? normPath(raw);
}

function describe(p, rel) {
  const where = `${rel}:${p.line ?? '?'}${p.col ? `:${p.col}` : ''}`;
  const fix = p.fix ? ` Fix: ${p.fix}` : '';
  return `  ${where} ${p.rule ?? 'lint'}: ${p.message ?? ''}${fix}`.replace(/\s+$/, '');
}

function report(rel, errors, warnings) {
  const lines = [];
  const items = [...errors, ...warnings];
  const room = MAX_LINES - 3;
  for (const p of items.slice(0, room)) lines.push(describe(p, rel));
  if (items.length > room) lines.push(`  (+${items.length - room} more: node tools/lint.mjs ${rel})`);
  return lines;
}

export async function handle(input) {
  const file = editedPath(input);
  if (!file) return null;
  const root = findProjectRoot(file);
  if (!root) return null;
  const rel = relInside(root, file);
  if (!rel || !inLintScope(rel)) return null;

  let text;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // deleted or unreadable: nothing to lint
  }

  const lint = await importTemplate('tools/lint.mjs');
  if (!lint || typeof lint.lintSource !== 'function') return null;
  let problems;
  try {
    problems = await lint.lintSource(text, rel);
  } catch {
    return null;
  }
  if (!Array.isArray(problems) || !problems.length) return null;

  const errors = problems.filter((p) => p && p.severity === 'error');
  const warnings = problems.filter((p) => p && p.severity !== 'error');
  const byLine = (a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.col ?? 0) - (b.col ?? 0);
  errors.sort(byLine);
  warnings.sort(byLine);

  if (errors.length) {
    const head = `motion-studio lint: ${rel} has ${errors.length} error${errors.length === 1 ? '' : 's'}`
      + `${warnings.length ? ` and ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''} (determinism / house rules).`;
    const tail = 'Every frame must be a pure function of t: fix these before rendering (npm run lint re-checks the project).';
    return { code: 2, stderr: [head, ...report(rel, errors, warnings), tail].join('\n') };
  }
  const head = `motion-studio lint: ${rel} has ${warnings.length} warning${warnings.length === 1 ? '' : 's'} (house rules; not blocking).`;
  return {
    json: {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: [head, ...report(rel, [], warnings)].join('\n'),
      },
    },
  };
}

