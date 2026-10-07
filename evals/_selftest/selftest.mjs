#!/usr/bin/env node
// Zero-cost self-test for the motion-studio eval suite. `claude plugin eval --max-cost-usd 0` only proves the case
// files load; this script also proves the graders mean what they say:
//   1. authoring rules (frontmatter keys, runs >= 3, budgets, single-quoted regexes, tools follow graders, a
//      must-not-fire case, an outcome grader in every case, no absolute paths, skills that exist, LF scaffolds)
//   2. every regex / tool_used grader against hand-written passing and failing samples (samples.mjs)
//   3. --scaffold: runs each scaffold in a temp dir and checks the untouched workspace does NOT already satisfy the
//      outcome graders (no free passes) while a simulated good edit does (no false failures); cross-checks with the
//      shipped gate parser, the project's lint and the hooks' studio-project detection where a case relies on them
// Node built-ins only. Usage: node evals/_selftest/selftest.mjs [--scaffold] [--render] [--keep] [--json]
import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { SAMPLES, WORKSPACE_CHECKS } from './samples.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVALS = resolve(HERE, '..');
const ROOT = resolve(EVALS, '..');

const PROMPT_KEYS = new Set(['schema_version', 'name', 'description', 'tags', 'plugins', 'runs', 'expected_outcome',
  'model', 'max_turns', 'timeout_seconds', 'allowed_tools', 'append_system_prompt', 'env']);
const GRADER_TYPES = new Set(['regex', 'tool_used', 'tool_order', 'file_exists', 'llm', 'baseline']);
const GRADER_KEYS = { common: ['type', 'weight', 'arm'], regex: ['pattern', 'flags', 'match', 'target'],
  tool_used: ['tool', 'input_match', 'min', 'max'], tool_order: ['before', 'after'], file_exists: ['path', 'exists'],
  llm: ['criteria', 'focus'], baseline: ['baseline_file', 'criteria'] };
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'NotebookRead', 'Skill', 'AskUserQuestion', 'Agent', 'TodoWrite',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskStop']);
const WRITERS = ['Write', 'Edit', 'Bash'];
const ABS_PATH = /(?:^|[\s'"`(=])(?:[A-Za-z]:[\\/](?!\/)|\/(?:Users|home|tmp|var|etc|opt|private)\/|~[\\/])/m;

const USAGE = `usage: node evals/_selftest/selftest.mjs [--scaffold] [--render] [--keep] [--json]
  --scaffold  also run each scaffold_script in a temp dir and grade the untouched + simulated workspaces
  --render    with --scaffold, include render-smoke (npm install + browser download; Linux/macOS)
  --keep      keep the temp workspaces and print their paths
  --json      print one JSON result line on stdout
exit 0 = all checks pass, 1 = failures, 2 = bad usage`;

// ---------- minimal YAML (the subset the suite uses: scalars, quoted strings, flow [..] and {..}, nested maps) ----------
function splitFlow(s) {
  const out = []; let depth = 0, q = null, cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === q) { if (q === "'" && s[i + 1] === "'") { cur += s[++i]; } else q = null; } continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function scalar(raw) {
  const v = raw.trim();
  if (v === '') return null;
  if (v.startsWith("'")) { if (!v.endsWith("'") || v.length < 2) throw new Error(`unterminated single quote: ${v}`); return v.slice(1, -1).replace(/''/g, "'"); }
  if (v.startsWith('"')) { if (!v.endsWith('"') || v.length < 2) throw new Error(`unterminated double quote: ${v}`); return JSON.parse(v); }
  if (v.startsWith('[')) { if (!v.endsWith(']')) throw new Error(`unterminated flow sequence: ${v}`); return splitFlow(v.slice(1, -1)).map(scalar); }
  if (v.startsWith('{')) {
    if (!v.endsWith('}')) throw new Error(`unterminated flow mapping: ${v}`);
    return Object.fromEntries(splitFlow(v.slice(1, -1)).map((kv) => { const i = kv.indexOf(':'); return [kv.slice(0, i).trim(), scalar(kv.slice(i + 1))]; }));
  }
  if (/^[|>]/.test(v)) throw new Error(`block scalars are outside the self-test YAML subset: ${v}`);
  if (/^(?:true|false)$/.test(v)) return v === 'true';
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  if (/^(?:null|~)$/.test(v)) return null;
  return v.replace(/\s+#.*$/, '');
}
export function parseYaml(text) {
  const root = {}, stack = [{ indent: -1, obj: root }];
  text.split('\n').forEach((line, n) => {
    if (!line.trim() || /^\s*#/.test(line)) return;
    const indent = line.match(/^ */)[0].length, m = line.slice(indent).match(/^([\w.-]+):(?:\s+(.*))?$/);
    if (!m) throw new Error(`line ${n + 1}: outside the self-test YAML subset: ${line.trim()}`);
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (m[2] === undefined || m[2].trim() === '') { parent[m[1]] = {}; stack.push({ indent, obj: parent[m[1]] }); }
    else parent[m[1]] = scalar(m[2]);
  });
  return root;
}
export function splitFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error('missing --- frontmatter block');
  return { raw: m[1], data: parseYaml(m[1]), body: m[2] };
}

// ---------- grader semantics (mirrors the runner's documented behavior) ----------
export function compileRegex(pattern, flags = '') {
  if (/[gy]/.test(flags)) throw new Error(`flags "${flags}": g and y make RegExp.test stateful; use i, m, s, u`);
  return new RegExp(pattern, flags);
}
export function gradeRegex(g, text) {
  const match = g.match ?? 'contains';
  if (match === 'contains') return compileRegex(g.pattern, g.flags).test(text);
  if (match === 'not_contains') return !compileRegex(g.pattern, g.flags).test(text);
  const cm = String(match).match(/^count:(\d+)$/);
  if (!cm) throw new Error(`unknown match "${match}"`);
  return (text.match(new RegExp(g.pattern, (g.flags || '') + 'g')) || []).length === Number(cm[1]);
}
export function gradeToolUsed(g, calls) {
  const re = g.input_match ? compileRegex(g.input_match) : null;
  const n = calls.filter((c) => c.tool === g.tool && (!re || re.test(JSON.stringify(c.input)))).length;
  return n >= (g.min ?? 1) && n <= (g.max ?? Infinity);
}

// ---------- suite discovery ----------
function listCases(dir = EVALS, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('_') || (dir === EVALS && e.name === 'results')) continue;
    const p = join(dir, e.name);
    if (existsSync(join(p, 'prompt.md')) || existsSync(join(p, 'case.yaml'))) out.push(p); else listCases(p, out);
  }
  return out;
}
export function loadSuite() {
  return listCases().map((dir) => {
    const name = relative(EVALS, dir).split(sep).join('/');
    const c = { name, dir, problems: [], graders: [] };
    try {
      const pm = splitFrontmatter(readFileSync(join(dir, 'prompt.md'), 'utf8'));
      Object.assign(c, { fm: pm.data, fmRaw: pm.raw, body: pm.body.trim() });
    } catch (e) { c.problems.push(`prompt.md: ${e.message}`); c.fm = {}; c.body = ''; }
    if (existsSync(join(dir, 'case.yaml'))) {
      try { c.yaml = parseYaml(readFileSync(join(dir, 'case.yaml'), 'utf8')); } catch (e) { c.problems.push(`case.yaml: ${e.message}`); }
    }
    const gdir = join(dir, 'graders');
    for (const f of existsSync(gdir) ? readdirSync(gdir).filter((x) => x.endsWith('.md')).sort() : []) {
      const text = readFileSync(join(gdir, f), 'utf8');
      try { const { raw, data, body } = splitFrontmatter(text); c.graders.push({ name: f.slice(0, -3), raw, text, ...data, body: body.trim() }); }
      catch (e) { c.problems.push(`graders/${f}: ${e.message}`); }
    }
    return c;
  });
}

// ---------- 1. authoring rules ----------
function checkRules(suite) {
  const errs = [], add = (c, msg) => errs.push(`${c.name}: ${msg}`);
  let negative = 0;
  for (const c of suite) {
    c.problems.forEach((p) => add(c, p));
    const fm = c.fm, tags = fm.tags || [], tools = new Set(fm.allowed_tools || []);
    for (const k of Object.keys(fm)) if (!PROMPT_KEYS.has(k)) add(c, `prompt.md: frontmatter key "${k}" is not accepted by claude plugin eval`);
    if (!(fm.runs >= 3)) add(c, `runs must be >= 3 (got ${fm.runs})`);
    if (!Number.isInteger(fm.max_turns) || !Number.isInteger(fm.timeout_seconds)) add(c, 'set max_turns and timeout_seconds explicitly');
    if (!c.body) add(c, 'prompt body is empty');
    if (!fm.description) add(c, 'add a description');
    const heavy = tags.includes('scaffold') || tags.includes('render');
    if (tags.includes('trigger') && !(fm.max_turns >= 5 && fm.max_turns <= 8 && fm.timeout_seconds >= 120 && fm.timeout_seconds <= 180))
      add(c, `trigger budget must be 5-8 turns / 120-180 s (got ${fm.max_turns} / ${fm.timeout_seconds})`);
    if (heavy && !(fm.max_turns >= 25 && fm.max_turns <= 40 && fm.timeout_seconds >= 600 && fm.timeout_seconds <= 900))
      add(c, `build budget must be 25-40 turns / 600-900 s (got ${fm.max_turns} / ${fm.timeout_seconds})`);
    if (!heavy && !(fm.max_turns <= 10 && fm.timeout_seconds <= 600)) add(c, 'answer-only case budget must stay within 10 turns / 600 s');
    if (tools.has('Bash') && !tags.includes('render')) add(c, 'only [render]-tagged cases may ask for Bash (native Windows refuses shell grants)');
    if (tools.has('AskUserQuestion')) add(c, 'drop AskUserQuestion: nobody answers in a headless run and the questions never reach the graded reply');
    if (fm.env) for (const k of Object.keys(fm.env)) if (!/^EVAL_[A-Z0-9_]*$/.test(k)) add(c, `env key ${k} must match EVAL_[A-Z0-9_]*`);
    if (ABS_PATH.test(c.body)) add(c, 'prompt contains an absolute or ~/ path');
    if (c.yaml) {
      if (c.yaml.schema_version !== '1.1') add(c, 'case.yaml needs schema_version: "1.1"');
      if (c.yaml.name !== c.name.split('/').pop()) add(c, `case.yaml name "${c.yaml.name}" must equal the directory name`);
      const script = c.yaml.context?.scaffold_script;
      if (script) {
        const p = join(c.dir, script);
        if (!existsSync(p)) add(c, `scaffold_script ${script} not found`);
        else {
          const s = readFileSync(p, 'utf8');
          if (s.includes('\r')) add(c, `${script} has CRLF line endings (bash would fail)`);
          if (!s.startsWith('#!/usr/bin/env bash\n')) add(c, `${script} must start with #!/usr/bin/env bash`);
          if (!/^set -euo pipefail$/m.test(s)) add(c, `${script} must set -euo pipefail`);
          if (!s.includes('${BASH_SOURCE[0]}')) add(c, `${script} must locate its case dir via \${BASH_SOURCE[0]}`);
        }
        if (!tags.includes('scaffold') && !tags.includes('render')) add(c, 'cases with a scaffold_script must be tagged scaffold or render');
      }
    }
    if (!c.graders.length) add(c, 'no graders');
    if (!c.graders.some((g) => !['tool_used', 'tool_order'].includes(g.type))) add(c, 'needs at least one outcome grader besides tool_used/tool_order');
    for (const g of c.graders) {
      const where = `graders/${g.name}.md`;
      if (!GRADER_TYPES.has(g.type)) { add(c, `${where}: unknown type "${g.type}"`); continue; }
      const allowed = new Set([...GRADER_KEYS.common, ...GRADER_KEYS[g.type]]);
      for (const k of Object.keys(g)) if (!['name', 'raw', 'text', 'body'].includes(k) && !allowed.has(k)) add(c, `${where}: key "${k}" is not an option of ${g.type}`);
      if (g.weight !== undefined && !(g.weight > 0)) add(c, `${where}: weight must be > 0`);
      if (g.arm !== undefined && !['with-only', 'both'].includes(g.arm)) add(c, `${where}: arm must be with-only or both`);
      if (ABS_PATH.test(g.text)) add(c, `${where}: contains an absolute or ~/ path`);
      for (const key of ['pattern', 'input_match']) {
        if (g[key] === undefined) continue;
        if (!new RegExp(`^${key}: '`, 'm').test(g.raw)) add(c, `${where}: ${key} must be single-quoted (double quotes break on \\d, \\s)`);
        try { compileRegex(g[key], key === 'pattern' ? g.flags : ''); } catch (e) { add(c, `${where}: ${key} does not compile: ${e.message}`); }
      }
      const target = g.type === 'llm' ? g.focus : g.target;
      if (target && typeof target === 'object') {
        if (target.source !== 'file' || !target.path) add(c, `${where}: file target needs { source: file, path }`);
        if (!WRITERS.some((t) => tools.has(t))) add(c, `${where}: reads a file but the case allows no Write/Edit/Bash`);
      }
      if (g.type === 'regex' && !g.pattern) add(c, `${where}: regex needs pattern`);
      if (g.type === 'file_exists') {
        if (!g.path) add(c, `${where}: file_exists needs path`);
        if (g.exists !== false && !WRITERS.some((t) => tools.has(t))) add(c, `${where}: file_exists needs Write/Edit/Bash in allowed_tools`);
      }
      if (g.type === 'llm' && !(/\bPASS\b/.test(g.body) && /\bFAIL\b/.test(g.body))) add(c, `${where}: llm rubric needs concrete PASS and FAIL lines`);
      if (g.type === 'tool_used') {
        if (!g.tool) add(c, `${where}: tool_used needs tool`);
        const min = g.min ?? 1;
        if (min >= 1 && !tools.has(g.tool)) add(c, `${where}: needs ${g.tool} in allowed_tools`);
        if (min >= 1 && !READ_ONLY.has(g.tool) && g.tool !== 'Write' && g.tool !== 'Edit') add(c, `${where}: ${g.tool} is not granted by the zero-cost lint (--allow-tools Write Edit), so the lint would flag it`);
        if (g.tool === 'Skill' && g.min === 0 && g.max === 0 && g.arm === 'both' && tags.includes('negative')) negative++;
        if (g.tool === 'Skill' && g.input_match) {
          const names = g.min === 0 ? [] : [...g.input_match.matchAll(/\?([\w-]+)"/g)].map((m) => m[1]);
          for (const s of names) if (!existsSync(join(ROOT, 'skills', s, 'SKILL.md'))) add(c, `${where}: skill "${s}" has no skills/${s}/SKILL.md`);
        }
      }
    }
  }
  if (!negative) errs.push('suite: needs a [negative] case with a tool_used Skill grader (min 0, max 0, arm both)');
  const negList = suite.flatMap((c) => c.graders.filter((g) => g.tool === 'Skill' && g.max === 0).map((g) => g.input_match || ''));
  const skillDirs = existsSync(join(ROOT, 'skills')) ? readdirSync(join(ROOT, 'skills')).filter((d) => existsSync(join(ROOT, 'skills', d, 'SKILL.md'))) : [];
  for (const re of negList) for (const s of skillDirs) {
    if (re && !compileRegex(re).test(JSON.stringify({ skill: `motion-studio:${s}` }))) errs.push(`suite: must-not-fire grader misses skill ${s}`);
    if (re && !compileRegex(re).test(JSON.stringify({ skill: s }))) errs.push(`suite: must-not-fire grader misses bare skill name ${s}`);
  }
  return errs;
}

// ---------- 2. samples ----------
function findGrader(suite, caseName, graderName) {
  const c = suite.find((x) => x.name === caseName), g = c?.graders.find((x) => x.name === graderName);
  if (!g) throw new Error(`sample refers to unknown grader ${caseName}/${graderName}`);
  return g;
}
export function grade(g, input) {
  if (g.type === 'regex') return gradeRegex(g, input.text);
  if (g.type === 'tool_used') return gradeToolUsed(g, input.calls);
  throw new Error(`samples cannot grade type ${g.type}`);
}
function checkSamples(suite) {
  const errs = [];
  for (const s of SAMPLES) {
    try {
      const g = findGrader(suite, s.case, s.grader), got = grade(g, s);
      if (got !== s.pass) errs.push(`${s.case}/${s.grader}: sample "${s.label}" graded ${got ? 'PASS' : 'FAIL'}, expected ${s.pass ? 'PASS' : 'FAIL'}`);
    } catch (e) { errs.push(`${s.case}/${s.grader}: ${e.message}`); }
  }
  for (const c of suite) for (const g of c.graders) {
    if (!['regex', 'tool_used'].includes(g.type)) continue;
    const pass = SAMPLES.some((s) => s.case === c.name && s.grader === g.name && s.pass);
    const fail = SAMPLES.some((s) => s.case === c.name && s.grader === g.name && !s.pass);
    if (!pass || !fail) errs.push(`${c.name}/${g.name}: needs at least one passing and one failing sample (has ${pass ? '' : 'no '}pass, ${fail ? '' : 'no '}fail)`);
  }
  return { errs, count: SAMPLES.length };
}

// ---------- 3. scaffolds ----------
function findBash() {
  if (process.env.EVAL_BASH) return process.env.EVAL_BASH;
  if (process.platform !== 'win32') return 'bash';
  // Never fall back to System32\bash.exe (WSL): the eval runner uses Git Bash, so the self-test must too.
  const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8', shell: false });
  const cands = [r.stdout && resolve(r.stdout.trim(), '..', '..', '..', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].filter(Boolean);
  const hit = cands.find((p) => existsSync(p));
  if (!hit) throw new Error('Git Bash not found; set EVAL_BASH to bash.exe');
  return hit;
}
const tail = (r) => (r.stderr || r.stdout || r.error?.message || '').trim().split('\n').slice(-6).join(' | ');
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
function listFiles(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.pw-browsers' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) listFiles(p, base, out); else out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}
// Grades a regex or file_exists grader against a workspace. file_exists here means "exists now"; the runner counts
// only files created during the run, which is why the untouched-workspace expectations are all false for it.
function gradeInWorkspace(ws, g, reply) {
  if (g.type === 'file_exists') { const re = globToRegExp(g.path); return listFiles(ws).some((f) => re.test(f)) === (g.exists ?? true); }
  if (g.type !== 'regex') throw new Error(`workspace checks cannot grade type ${g.type}`);
  const t = g.target;
  if (t && typeof t === 'object') { const p = join(ws, t.path); return existsSync(p) ? gradeRegex(g, readFileSync(p, 'utf8')) : false; }
  return gradeRegex(g, reply ?? '');
}
function projectLint(ws) {
  const lint = join(ws, 'tools', 'lint.mjs');
  if (!existsSync(lint)) return null;
  return spawnSync(process.execPath, [lint, 'film/film.js'], { cwd: ws, encoding: 'utf8', shell: false, timeout: 60000 });
}
// Cross-check against the shipped gate parser (tools/gate.mjs#parseReviewLog): what the graders accept must also be
// what `npm run gate` counts, so a grader can never pass a round the gate would ignore.
const GATE = join(ROOT, 'skills', 'studio-init', 'template', 'tools', 'gate.mjs');
async function gateExpect(ws, want, label, errs, notes, name) {
  if (!want) return;
  if (!existsSync(GATE)) { notes.push(`${name}: ${label}: template tools/gate.mjs missing, gate cross-check skipped`); return; }
  const { parseReviewLog } = await import(pathToFileURL(GATE).href);
  const rounds = parseReviewLog(readFileSync(join(ws, want.file), 'utf8')), last = rounds[rounds.length - 1];
  const got = { rounds: rounds.length, lastAxes: last ? Object.keys(last.scores).length : 0,
    lastTimed: last ? last.problems.length > 0 && last.problems.every((p) => p.time !== null) : false };
  for (const k of ['rounds', 'lastAxes', 'lastTimed']) {
    if (want[k] !== undefined && got[k] !== want[k]) errs.push(`${name}: ${label}: gate parser ${k}=${got[k]}, expected ${want[k]}`);
  }
}
// Cross-check against the plugin hooks' own project detection (hooks/lib/common.mjs#findProjectRoot): a case that
// leans on a hook (post-edit lint, role-guard lanes) must scaffold a folder the hooks treat as a studio project.
const HOOKS_COMMON = join(ROOT, 'hooks', 'lib', 'common.mjs');
async function hooksExpect(ws, want, errs, notes, name) {
  if (want === undefined) return;
  if (!existsSync(HOOKS_COMMON)) { notes.push(`${name}: hooks/lib/common.mjs missing, hook project check skipped`); return; }
  const { findProjectRoot, normPath } = await import(pathToFileURL(HOOKS_COMMON).href);
  const got = findProjectRoot(ws);
  if (want && got !== normPath(ws)) errs.push(`${name}: the plugin hooks do not see the scaffolded workspace as a studio project (found ${got})`);
  if (!want && got !== null) errs.push(`${name}: the plugin hooks treat the scaffolded workspace as a studio project (${got})`);
}
async function checkScaffolds(suite, { render, keep }) {
  const errs = [], notes = [], bash = findBash();
  for (const c of suite) {
    const script = c.yaml?.context?.scaffold_script;
    if (!script) continue;
    const spec = WORKSPACE_CHECKS[c.name];
    if (!spec) { errs.push(`${c.name}: no WORKSPACE_CHECKS entry in samples.mjs`); continue; }
    if (spec.heavy && !render) { notes.push(`${c.name}: skipped (needs --render)`); continue; }
    const ws = mkdtempSync(join(tmpdir(), `ms-eval-${c.name}-`));
    try {
      const t0 = Date.now();
      const r = spawnSync(bash, [join(c.dir, script).split(sep).join('/')], { cwd: ws, encoding: 'utf8', shell: false, timeout: spec.heavy ? 900000 : 120000 });
      if (r.status !== 0) { errs.push(`${c.name}: scaffold exit ${r.status}: ${tail(r)}`); continue; }
      notes.push(`${c.name}: scaffold ok in ${((Date.now() - t0) / 1000).toFixed(1)} s${keep ? ` (${ws})` : ''}`);
      const missing = (spec.files || []).filter((f) => !existsSync(join(ws, f)));
      missing.forEach((f) => errs.push(`${c.name}: scaffold did not create ${f}`));
      if (missing.length) continue;
      await hooksExpect(ws, spec.studioProject, errs, notes, c.name);
      const judge = (label, expect, reply) => {
        for (const [gname, want] of Object.entries(expect)) {
          const g = c.graders.find((x) => x.name === gname);
          if (!g) { errs.push(`${c.name}: WORKSPACE_CHECKS names unknown grader ${gname}`); continue; }
          let got;
          try { got = gradeInWorkspace(ws, g, reply); } catch (e) { errs.push(`${c.name}/${gname}: ${e.message}`); continue; }
          if (got !== want) errs.push(`${c.name}/${gname}: ${label} workspace graded ${got ? 'PASS' : 'FAIL'}, expected ${want ? 'PASS' : 'FAIL'}`);
        }
      };
      const lintExpect = (label, want) => {
        if (want === undefined) return;
        const lr = projectLint(ws);
        if (!lr) { notes.push(`${c.name}: ${label}: tools/lint.mjs not in the template yet, lint cross-check skipped`); return; }
        if (lr.status !== want) errs.push(`${c.name}: ${label}: project lint exit ${lr.status}, expected ${want}: ${tail(lr)}`);
      };
      judge('untouched', spec.untouched || {}, '');
      lintExpect('untouched', spec.lintUntouched);
      await gateExpect(ws, spec.gateUntouched, 'untouched', errs, notes, c.name);
      // Each simulation starts from the scaffolded state: snapshot the files it touches, restore afterwards.
      for (const sim of spec.simulations || []) {
        if ((sim.skipOn || []).includes(process.platform)) { notes.push(`${c.name}: simulation "${sim.label}" skipped on ${process.platform}`); continue; }
        const touched = [...Object.keys(sim.append || {}), ...Object.keys(sim.write || {})];
        const snap = Object.fromEntries(touched.map((f) => [f, readFileSync(join(ws, f), 'utf8')]));
        for (const [f, text] of Object.entries(sim.append || {})) appendFileSync(join(ws, f), text);
        for (const [f, text] of Object.entries(sim.write || {})) writeFileSync(join(ws, f), text);
        if (sim.node) {
          const t1 = Date.now(), nr = spawnSync(process.execPath, sim.node, { cwd: ws, encoding: 'utf8', shell: false, timeout: 600000 });
          if (nr.status !== 0) { errs.push(`${c.name}: simulation "${sim.label}": node ${sim.node.join(' ')} exit ${nr.status}: ${tail(nr)}`); continue; }
          notes.push(`${c.name}: simulation "${sim.label}" ran in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
        }
        judge(`simulated "${sim.label}"`, sim.expect, sim.reply);
        lintExpect(`simulated "${sim.label}"`, sim.lint);
        await gateExpect(ws, sim.gate, `simulated "${sim.label}"`, errs, notes, c.name);
        for (const [f, text] of Object.entries(snap)) writeFileSync(join(ws, f), text);
      }
    } finally { if (!keep) rmSync(ws, { recursive: true, force: true }); }
  }
  return { errs, notes };
}

async function main(argv) {
  const opts = { scaffold: false, render: false, keep: false, json: false };
  for (const a of argv) {
    if (a === '-h' || a === '--help') { process.stdout.write(USAGE + '\n'); return 0; }
    const k = a.replace(/^--/, '');
    if (!a.startsWith('--') || !(k in opts)) { process.stderr.write(`unknown argument: ${a}\n${USAGE}\n`); return 2; }
    opts[k] = true;
  }
  const suite = loadSuite();
  const rules = checkRules(suite);
  const samples = checkSamples(suite);
  const png = [];
  const sheet = join(EVALS, 'critique-writes-log', 'fixtures', 'contact.png');
  if (existsSync(sheet)) {
    const size = statSync(sheet).size;
    if (size >= 200 * 1024) png.push(`critique-writes-log: contact.png is ${size} bytes (keep it under 200 KB)`);
    const gen = await import(pathToFileURL(join(EVALS, 'critique-writes-log', 'make-contact-sheet.mjs')).href);
    if (gen.pixelHash(gen.decodePNG(readFileSync(sheet))) !== gen.pixelHash(gen.renderSheet())) png.push('critique-writes-log: contact.png differs from make-contact-sheet.mjs output (regenerate it)');
  }
  const scaf = opts.scaffold ? await checkScaffolds(suite, opts) : { errs: [], notes: ['scaffolds: skipped (pass --scaffold)'] };
  const errors = [...rules, ...samples.errs, ...png, ...scaf.errs];
  const summary = { ok: errors.length === 0, cases: suite.length, graders: suite.reduce((n, c) => n + c.graders.length, 0), samples: samples.count, errors, notes: scaf.notes };
  if (opts.json) process.stdout.write(JSON.stringify(summary) + '\n');
  else {
    for (const n of scaf.notes) process.stderr.write(`  ${n}\n`);
    for (const e of errors) process.stderr.write(`FAIL ${e}\n`);
    process.stderr.write(`${summary.ok ? 'OK' : 'FAILED'}: ${summary.cases} cases, ${summary.graders} graders, ${summary.samples} samples, ${errors.length} problem(s)\n`);
  }
  return summary.ok ? 0 : 1;
}

// Node realpaths the main module (import.meta.url) but leaves process.argv[1] as typed: compare real paths, or a run through
// a symlink or junction exits 0 without doing anything.
function isMain() {
  if (!process.argv[1]) return false;
  const real = (p) => { let r = resolve(p); try { r = realpathSync.native(r); } catch { /* keep the resolved path */ } return process.platform === 'win32' ? r.toLowerCase() : r; };
  try { return real(process.argv[1]) === real(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { process.stderr.write(`${err.stack || err}\n`); process.exitCode = 1; });
}
