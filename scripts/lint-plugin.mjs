#!/usr/bin/env node
// Plugin lint for what `claude plugin validate --strict` does not check (research/plugin-spec.md
// §2.2 "NOT flagged"): frontmatter key allowlists, names, description budgets, agent colors,
// bundled-file links, hooks.json shape, manifest details, JSON parse, CRLF/BOM, skills-only fallbacks
// for ${CLAUDE_PLUGIN_ROOT} commands, leaked test temp dirs. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKILL_KEYS = new Set(['name', 'description', 'when_to_use', 'argument-hint', 'arguments', 'allowed-tools', 'disallowed-tools',
  'model', 'effort', 'context', 'agent', 'background', 'hooks', 'paths', 'shell', 'disable-model-invocation', 'user-invocable',
  'license', 'compatibility', 'metadata']);
const AGENT_KEYS = new Set(['name', 'description', 'tools', 'disallowedTools', 'model', 'effort', 'maxTurns', 'skills', 'memory',
  'background', 'omitClaudeMd', 'isolation', 'color']);
const AGENT_IGNORED = new Set(['hooks', 'mcpServers', 'permissionMode', 'initialPrompt']);
const COLORS = new Set(['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const KNOWN_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch',
  'NotebookEdit', 'NotebookRead', 'TodoWrite', 'Skill', 'Agent', 'Task', 'ToolSearch', 'Monitor', 'TaskStop', 'SendMessage', 'LSP',
  'Artifact', 'EnterWorktree', 'ExitWorktree', 'AskUserQuestion', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate']);
const HOOK_EVENTS = new Set(['SessionStart', 'Setup', 'UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse', 'PermissionRequest',
  'PermissionDenied', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Notification', 'MessageDisplay', 'SubagentStart',
  'SubagentStop', 'TaskCreated', 'TaskCompleted', 'Stop', 'StopFailure', 'TeammateIdle', 'InstructionsLoaded', 'ConfigChange',
  'CwdChanged', 'DirectoryAdded', 'FileChanged', 'WorktreeCreate', 'WorktreeRemove', 'PreCompact', 'PostCompact', 'PreModelSwitch',
  'PostModelSwitch', 'Elicitation', 'ElicitationResult', 'SessionEnd']);
const PLUGIN_KEYS = new Set(['$schema', 'name', 'displayName', 'version', 'description', 'author', 'homepage', 'repository', 'license',
  'keywords', 'metadata', 'defaultEnabled', 'dependencies', 'settings', 'userConfig', 'channels', 'skills', 'commands', 'agents', 'hooks',
  'mcpServers', 'lspServers', 'outputStyles', 'workflows', 'experimental']);
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.work', 'out', '.tmp']);
const TEXT_EXT = new Set(['.mjs', '.js', '.cjs', '.py', '.sh', '.md', '.json', '.yml', '.yaml', '.html', '.css']);
const SKILL_DESC_MAX = 230;
const SKILL_BODY_MAX_LINES = 500;

// ---------------------------------------------------------------------------------------------
// Minimal YAML frontmatter reader: top-level keys, scalars (plain, quoted, block), lists, maps.
// It rejects the constructs that make Claude Code's YAML parser fail (tabs, ": " in plain
// scalars, unterminated quotes, duplicate keys) so they are caught before a release.

function unquote(v, line, errors) {
  if (v.startsWith('"')) {
    if (!/"\s*(#.*)?$/.test(v.slice(1)) || v.length < 2) { errors.push({ line, msg: 'unterminated double-quoted value' }); return v; }
    const end = v.lastIndexOf('"');
    try { return JSON.parse(v.slice(0, end + 1)); } catch { errors.push({ line, msg: 'invalid escape in double-quoted value' }); return v.slice(1, end); }
  }
  if (v.startsWith("'")) {
    const end = v.lastIndexOf("'");
    if (end <= 0) { errors.push({ line, msg: 'unterminated single-quoted value' }); return v; }
    return v.slice(1, end).replace(/''/g, "'");
  }
  return v;
}

function plainScalar(v, line, errors) {
  const s = v.replace(/\s+#.*$/, '').trim();
  if (/:\s/.test(s) || s.endsWith(':')) errors.push({ line, msg: 'plain value contains ": " (YAML mapping error); quote the whole value' });
  if (/^[@`%&*!]/.test(s)) errors.push({ line, msg: `plain value starts with "${s[0]}" (YAML reserved); quote it` });
  if (/^(true|yes|on)$/i.test(s)) return true;
  if (/^(false|no|off)$/i.test(s)) return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^(null|~)$/.test(s)) return null;
  return s;
}

function flowList(v) {
  const inner = v.trim().replace(/^\[/, '').replace(/\]\s*$/, '');
  const items = [];
  let cur = '';
  let q = null;
  for (const c of inner) {
    if (q) { if (c === q) q = null; cur += c; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ',') { items.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) items.push(cur.trim());
  return items.map((x) => x.replace(/^["']|["']$/g, ''));
}

function parseFrontmatter(text) {
  const src = String(text).replace(/^﻿/, '');
  const lines = src.split(/\r?\n/);
  if (lines[0] !== '---') return { ok: false, errors: [{ line: 1, msg: 'no YAML frontmatter block (first line must be ---)' }] };
  const close = lines.findIndex((l, i) => i > 0 && (l === '---' || l === '...'));
  if (close < 0) return { ok: false, errors: [{ line: 1, msg: 'frontmatter block is not closed with ---' }] };
  const errors = [];
  const data = {};
  const lineOf = {};
  let i = 1;
  while (i < close) {
    const raw = lines[i];
    const ln = i + 1;
    if (/^\s*(#.*)?$/.test(raw)) { i++; continue; }
    if (/^\t/.test(raw) || /^ +\t/.test(raw)) { errors.push({ line: ln, msg: 'tab indentation (YAML forbids tabs)' }); i++; continue; }
    const m = /^([A-Za-z0-9_$][A-Za-z0-9_.-]*)\s*:(?:\s+(.*)|\s*)$/.exec(raw);
    if (!m) { errors.push({ line: ln, msg: `cannot parse line: ${raw.slice(0, 60)}` }); i++; continue; }
    const key = m[1];
    const inline = (m[2] ?? '').trim();
    if (key in data) errors.push({ line: ln, msg: `duplicate key "${key}"` });
    lineOf[key] = ln;
    i++;
    const block = [];
    while (i < close && (/^\s/.test(lines[i]) || lines[i] === '' || /^- /.test(lines[i]) || lines[i] === '-')) { block.push(lines[i]); i++; }
    while (block.length && !block[block.length - 1].trim()) block.pop();
    if (/^[|>][+-]?$/.test(inline)) {
      const body = block.map((l) => l.replace(/^\s+/, ''));
      data[key] = inline[0] === '|' ? body.join('\n') : body.join(' ').replace(/\s+/g, ' ').trim();
      continue;
    }
    if (inline) {
      if (inline.startsWith('[')) data[key] = flowList(inline);
      else if (inline.startsWith('{')) data[key] = { __flow: inline };
      else if (inline.startsWith('"') || inline.startsWith("'")) data[key] = unquote(inline, ln, errors);
      else {
        const cont = block.map((l) => l.trim()).filter(Boolean);
        data[key] = plainScalar([inline, ...cont].join(' '), ln, errors);
      }
      continue;
    }
    const items = block.filter((l) => l.trim());
    if (!items.length) { data[key] = null; continue; }
    if (items.every((l) => /^\s*-(\s|$)/.test(l) || /^\s{2,}\S/.test(l))) {
      if (items.some((l) => /^\s*-(\s|$)/.test(l))) {
        data[key] = items.filter((l) => /^\s*-(\s|$)/.test(l)).map((l) => unquote(l.replace(/^\s*-\s*/, '').trim(), ln, errors));
        continue;
      }
    }
    if (items.every((l) => /^\s+[A-Za-z0-9_"'-][^:]*:(\s|$)/.test(l) || /^\s{4,}/.test(l))) { data[key] = { __map: items.length }; continue; }
    data[key] = plainScalar(items.map((l) => l.trim()).join(' '), ln, errors);
  }
  const body = lines.slice(close + 1);
  return { ok: errors.length === 0, errors, data, lineOf, body, bodyStart: close + 2 };
}

// ---------------------------------------------------------------------------------------------

class Report {
  constructor(root) { this.root = root; this.items = []; }
  rel(p) { return path.relative(this.root, p).split(path.sep).join('/') || '.'; }
  error(file, msg, line) { this.items.push({ level: 'error', file: this.rel(file), line, msg }); }
  warn(file, msg, line) { this.items.push({ level: 'warn', file: this.rel(file), line, msg }); }
  get errors() { return this.items.filter((x) => x.level === 'error'); }
  get warnings() { return this.items.filter((x) => x.level === 'warn'); }
}

function readJSONChecked(file, rep) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    rep.error(file, `invalid JSON: ${err.message}`);
    return undefined;
  }
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.name === 'results' && path.basename(dir) === 'evals') continue;
      walk(p, out);
    } else if (e.isFile()) out.push(p);
  }
  return out;
}

function checkManifests(root, rep) {
  const pluginFile = path.join(root, '.claude-plugin', 'plugin.json');
  const mktFile = path.join(root, '.claude-plugin', 'marketplace.json');
  if (!fs.existsSync(pluginFile)) { rep.error(pluginFile, 'missing .claude-plugin/plugin.json'); return null; }
  const plugin = readJSONChecked(pluginFile, rep);
  if (!plugin || typeof plugin !== 'object') return null;
  for (const k of Object.keys(plugin)) if (!PLUGIN_KEYS.has(k)) rep.error(pluginFile, `unknown top-level key "${k}"`);
  if (!KEBAB.test(plugin.name ?? '')) rep.error(pluginFile, `name "${plugin.name}" must be kebab-case`);
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(plugin.version ?? '')) rep.error(pluginFile, `version "${plugin.version}" must be semver (x.y.z)`);
  if (!plugin.description || typeof plugin.description !== 'string') rep.error(pluginFile, 'description is required');
  if (!plugin.author || typeof plugin.author.name !== 'string' || !plugin.author.name) rep.error(pluginFile, 'author.name is required');
  for (const k of ['homepage', 'repository']) {
    if (plugin[k] === undefined) continue;
    try { new URL(plugin[k]); } catch { rep.error(pluginFile, `${k} must parse as a URL`); }
  }
  if (plugin.keywords !== undefined && !(Array.isArray(plugin.keywords) && plugin.keywords.every((x) => typeof x === 'string'))) rep.error(pluginFile, 'keywords must be a string array');
  for (const k of ['skills', 'agents', 'commands', 'hooks', 'outputStyles', 'workflows']) {
    const v = plugin[k];
    for (const p of typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []) {
      if (!p.startsWith('./') || p.includes('..') || p.includes('\\')) rep.error(pluginFile, `${k} path "${p}" must start with ./ and use forward slashes, no ..`);
      else if (!fs.existsSync(path.join(root, p))) rep.error(pluginFile, `${k} path "${p}" does not exist`);
    }
  }
  if (fs.existsSync(mktFile)) {
    const mkt = readJSONChecked(mktFile, rep);
    if (mkt && typeof mkt === 'object') {
      if (!KEBAB.test(mkt.name ?? '')) rep.error(mktFile, `marketplace name "${mkt.name}" must be kebab-case`);
      if (!mkt.owner || !mkt.owner.name) rep.error(mktFile, 'owner.name is required');
      if (!mkt.description) rep.error(mktFile, 'description is required (validate --strict warns without it)');
      const entries = Array.isArray(mkt.plugins) ? mkt.plugins : [];
      if (!entries.length) rep.error(mktFile, 'plugins must list at least one entry');
      const self = entries.find((e) => e && e.name === plugin.name);
      if (!self) rep.error(mktFile, `no plugins[] entry named "${plugin.name}" (install would fail: Plugin not found in marketplace)`);
      for (const [idx, e] of entries.entries()) {
        if (!e || typeof e !== 'object') { rep.error(mktFile, `plugins[${idx}] must be an object`); continue; }
        if ('version' in e) rep.error(mktFile, `plugins[${idx}] must not set version (plugin.json is the single source; mismatch fails --strict)`);
        if (typeof e.source === 'string') {
          if (!(e.source === '.' || e.source.startsWith('./'))) rep.error(mktFile, `plugins[${idx}].source "${e.source}" must be "./" or start with ./`);
          else if (!fs.existsSync(path.join(root, e.source))) rep.error(mktFile, `plugins[${idx}].source "${e.source}" does not exist`);
        }
        if (!e.description) rep.warn(mktFile, `plugins[${idx}] has no description`);
        if (e.tags !== undefined && !(Array.isArray(e.tags) && e.tags.every((t) => typeof t === 'string'))) rep.error(mktFile, `plugins[${idx}].tags must be a string array`);
      }
    }
  }
  if (fs.existsSync(path.join(root, 'CLAUDE.md'))) rep.error(path.join(root, 'CLAUDE.md'), 'CLAUDE.md at the plugin root is not loaded (validate --strict warns); put house rules in the project template');
  return plugin;
}

const REF_RE = /\$\{(CLAUDE_SKILL_DIR|CLAUDE_PLUGIN_ROOT)\}\/([^\s"'`)\]<>|]+)/g;
const MD_LINK_RE = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function checkLinks(file, skillDir, root, bodyLines, bodyStart, rep) {
  let fenced = false;
  bodyLines.forEach((line, k) => {
    const ln = bodyStart + k;
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    for (const m of line.matchAll(REF_RE)) {
      const target = m[2].replace(/[.,;:!?]+$/, '');
      if (/[<>*{}$]/.test(target) || !target) continue;
      const base = m[1] === 'CLAUDE_SKILL_DIR' ? skillDir : root;
      if (!fs.existsSync(path.join(base, target))) rep.error(file, `\${${m[1]}}/${target} does not exist`, ln);
    }
    if (fenced) return;
    for (const m of line.matchAll(MD_LINK_RE)) {
      let target = m[1];
      if (/^(https?:|mailto:|#|\/|\$\{|<)/.test(target)) continue;
      target = decodeURIComponent(target.split('#')[0]);
      if (!target || /[*{}]/.test(target)) continue;
      if (!fs.existsSync(path.join(skillDir, target))) rep.error(file, `relative link ${target} does not exist`, ln);
    }
  });
}

function checkSkills(root, rep, stats) {
  const dir = path.join(root, 'skills');
  if (!fs.existsSync(dir)) return new Map();
  const skills = new Map();
  let budget = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const skillDir = path.join(dir, e.name);
    const file = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(file)) { rep.error(skillDir, 'skill directory has no SKILL.md'); continue; }
    stats.skills++;
    const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    for (const err of fm.errors) rep.error(file, err.msg, err.line);
    if (!fm.data) continue;
    const d = fm.data;
    skills.set(e.name, d);
    for (const k of Object.keys(d)) if (!SKILL_KEYS.has(k)) rep.error(file, `unknown frontmatter key "${k}" (silently ignored by Claude Code)`, fm.lineOf[k]);
    const name = d.name;
    if (typeof name !== 'string' || !name) rep.error(file, 'name is required');
    else {
      if (!KEBAB.test(name) || name.length > 64) rep.error(file, `name "${name}" must be kebab-case (a-z, 0-9, -), <= 64 chars, no ":"`, fm.lineOf.name);
      if (name !== e.name) rep.error(file, `name "${name}" must equal the directory name "${e.name}"`, fm.lineOf.name);
    }
    const desc = d.description;
    if (typeof desc !== 'string' || !desc.trim()) rep.error(file, 'description is required');
    else {
      if (desc.length > SKILL_DESC_MAX) rep.error(file, `description is ${desc.length} chars (max ${SKILL_DESC_MAX}; the skill listing budget is shared)`, fm.lineOf.description);
      const combined = desc.length + (typeof d.when_to_use === 'string' ? d.when_to_use.length : 0);
      if (combined > 1536) rep.error(file, `description + when_to_use is ${combined} chars (listing truncates at 1,536)`);
      budget += combined;
    }
    if (d.effort !== undefined && !EFFORTS.has(d.effort)) rep.error(file, `effort "${d.effort}" must be one of ${[...EFFORTS].join(', ')}`, fm.lineOf.effort);
    for (const b of ['disable-model-invocation', 'user-invocable', 'background']) {
      if (d[b] !== undefined && typeof d[b] !== 'boolean') rep.error(file, `${b} must be a boolean`, fm.lineOf[b]);
    }
    if (d.context !== undefined && d.context !== 'fork') rep.error(file, 'context must be "fork"', fm.lineOf.context);
    if (d.shell !== undefined && !['bash', 'powershell'].includes(d.shell)) rep.error(file, 'shell must be bash or powershell', fm.lineOf.shell);
    if (fm.body.length > SKILL_BODY_MAX_LINES) rep.error(file, `body is ${fm.body.length} lines (keep SKILL.md under ${SKILL_BODY_MAX_LINES}; move detail to references/)`);
    checkLinks(file, skillDir, root, fm.body, fm.bodyStart, rep);
    const tail = fm.body.filter((l) => l.trim()).slice(-6).join('\n');
    if (!/\bNext\b/.test(tail)) rep.warn(file, 'no "Next" routing line near the end of the body');
  }
  stats.skillBudget = budget;
  return skills;
}

function toolNames(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(/[,\s]+(?![^()]*\))/).filter(Boolean);
  return [];
}

function checkAgents(root, rep, stats, skills, pluginName) {
  const dir = path.join(root, 'agents');
  if (!fs.existsSync(dir)) return;
  for (const file of walk(dir).filter((f) => f.endsWith('.md'))) {
    stats.agents++;
    const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    for (const err of fm.errors) rep.error(file, err.msg, err.line);
    if (!fm.data) continue;
    const d = fm.data;
    for (const k of Object.keys(d)) {
      if (AGENT_IGNORED.has(k)) rep.error(file, `"${k}" is ignored for plugin agents (hooks go in hooks/hooks.json)`, fm.lineOf[k]);
      else if (!AGENT_KEYS.has(k)) rep.error(file, `unknown frontmatter key "${k}" (silently ignored by Claude Code)`, fm.lineOf[k]);
    }
    const base = path.basename(file, '.md');
    if (typeof d.name !== 'string' || !d.name) rep.error(file, 'name is required');
    else {
      if (d.name.includes(':')) rep.error(file, `name "${d.name}" contains ":" (Claude Code skips such agents)`, fm.lineOf.name);
      else if (!KEBAB.test(d.name)) rep.error(file, `name "${d.name}" must be kebab-case`, fm.lineOf.name);
      if (d.name !== base) rep.warn(file, `name "${d.name}" differs from the file name "${base}.md"`, fm.lineOf.name);
    }
    if (typeof d.description !== 'string' || !d.description.trim()) rep.error(file, 'description is required');
    if (d.color !== undefined && !COLORS.has(d.color)) rep.error(file, `color "${d.color}" must be one of ${[...COLORS].join(', ')}`, fm.lineOf.color);
    if (d.effort !== undefined && !EFFORTS.has(d.effort)) rep.error(file, `effort "${d.effort}" must be one of ${[...EFFORTS].join(', ')}`, fm.lineOf.effort);
    if (d.model !== undefined && !(['inherit', 'sonnet', 'opus', 'haiku', 'fable'].includes(d.model) || /^claude-/.test(String(d.model)))) rep.error(file, `model "${d.model}" is not inherit/sonnet/opus/haiku/fable or a claude-* id`, fm.lineOf.model);
    if (d.maxTurns !== undefined && !(Number.isInteger(d.maxTurns) && d.maxTurns > 0)) rep.error(file, 'maxTurns must be a positive integer', fm.lineOf.maxTurns);
    if (d.memory !== undefined && !['user', 'project', 'local'].includes(d.memory)) rep.error(file, 'memory must be user, project or local', fm.lineOf.memory);
    if (d.isolation !== undefined && d.isolation !== 'worktree') rep.error(file, 'isolation must be "worktree"', fm.lineOf.isolation);
    for (const key of ['tools', 'disallowedTools']) {
      for (const t of toolNames(d[key])) {
        const bare = t.replace(/\(.*\)$/, '');
        if (bare === 'AskUserQuestion') rep.error(file, 'subagents never get AskUserQuestion; return questions to the main session', fm.lineOf[key]);
        else if (!KNOWN_TOOLS.has(bare) && !bare.startsWith('mcp__')) rep.warn(file, `unknown tool "${t}" in ${key}`, fm.lineOf[key]);
      }
    }
    const pre = Array.isArray(d.skills) ? d.skills : typeof d.skills === 'string' ? toolNames(d.skills) : [];
    for (const s of pre) {
      const bare = String(s).startsWith(`${pluginName}:`) ? String(s).slice(pluginName.length + 1) : String(s);
      const sk = skills.get(bare);
      if (!sk) rep.error(file, `preloaded skill "${s}" is not a skill of this plugin`, fm.lineOf.skills);
      else if (sk['disable-model-invocation'] === true) rep.error(file, `preloaded skill "${s}" has disable-model-invocation: true and cannot be preloaded`, fm.lineOf.skills);
    }
  }
}

function checkHooks(root, rep, stats) {
  const file = path.join(root, 'hooks', 'hooks.json');
  if (!fs.existsSync(file)) return;
  const cfg = readJSONChecked(file, rep);
  if (!cfg || typeof cfg !== 'object') return;
  for (const k of Object.keys(cfg)) {
    if (HOOK_EVENTS.has(k)) rep.error(file, `${k} is declared at the top level; wrap events in {"hooks": {...}}`);
    else if (k !== 'description' && k !== 'hooks') rep.error(file, `unknown top-level key "${k}"`);
  }
  if (!cfg.hooks || typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks)) { rep.error(file, 'missing the "hooks" wrapper object'); return; }
  for (const [event, groups] of Object.entries(cfg.hooks)) {
    if (!HOOK_EVENTS.has(event)) rep.error(file, `unknown hook event "${event}"`);
    if (!Array.isArray(groups)) { rep.error(file, `${event} must be an array of matcher groups`); continue; }
    for (const [gi, g] of groups.entries()) {
      const where = `${event}[${gi}]`;
      if (g.matcher !== undefined && typeof g.matcher !== 'string') rep.error(file, `${where}.matcher must be a string`);
      if (!Array.isArray(g.hooks) || !g.hooks.length) { rep.error(file, `${where}.hooks must be a non-empty array`); continue; }
      for (const [hi, h] of g.hooks.entries()) {
        stats.hooks++;
        const at = `${where}.hooks[${hi}]`;
        if (h.type !== 'command') { rep.error(file, `${at}: only "command" hooks are used by this plugin (got ${h.type})`); continue; }
        if (!Array.isArray(h.args)) rep.error(file, `${at}: use exec form ("command": "node", "args": [...]) so paths need no shell quoting`);
        if (typeof h.command !== 'string' || /\s/.test(h.command)) rep.error(file, `${at}: command must be a bare executable name in exec form`);
        if (h.timeout !== undefined && !(typeof h.timeout === 'number' && h.timeout > 0)) rep.error(file, `${at}: timeout must be a positive number of seconds`);
        for (const a of Array.isArray(h.args) ? h.args : []) {
          if (typeof a !== 'string') { rep.error(file, `${at}: args must be strings`); continue; }
          const m = /^\$\{CLAUDE_PLUGIN_ROOT\}\/(.+)$/.exec(a);
          if (m && !fs.existsSync(path.join(root, m[1]))) rep.error(file, `${at}: ${a} does not exist`);
        }
      }
    }
  }
}

// ${CLAUDE_PLUGIN_ROOT} is substituted only in plugin skills. A skills-only install (`npx skills add`) sends the
// literal text, so a command built on it fails with "Cannot find module". Every use in skill text needs the
// skills-only alternative (${CLAUDE_SKILL_DIR}/../<skill>/... works in both modes) spelled out nearby.
const PLUGIN_ROOT_RE = /\$\{CLAUDE_PLUGIN_ROOT\}/;
const SKILLS_ONLY_RE = /skills[- ]only/i;
const FALLBACK_WINDOW = 8;

function checkPluginRootFallback(root, rep) {
  const dir = path.join(root, 'skills');
  if (!fs.existsSync(dir)) return;
  for (const file of walk(dir).filter((f) => f.endsWith('.md'))) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!PLUGIN_ROOT_RE.test(line)) return;
      const near = lines.slice(Math.max(0, i - FALLBACK_WINDOW), i + FALLBACK_WINDOW + 1);
      if (near.some((l) => SKILLS_ONLY_RE.test(l))) return;
      rep.warn(file, `uses \${CLAUDE_PLUGIN_ROOT} (unset in skills-only installs) with no "skills-only" fallback within ${FALLBACK_WINDOW} lines; `
        + 'add the ${CLAUDE_SKILL_DIR}/../<skill>/... form or say what a skills-only install does instead', i + 1);
    });
  }
}

// A test that creates temp directories has to clean them up: leaked ms-* directories piled up to 1,100+ in os.tmpdir().
const MKTEMP_RE = /\bmkdtemp(?:Sync)?\s*\(/;
const CLEANUP_RE = /\b(?:rmSync|rmdirSync|rm)\s*\(/;

function checkTestTempCleanup(root, rep) {
  const dir = path.join(root, 'test');
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.test.mjs'))) {
    const file = path.join(dir, name);
    const text = fs.readFileSync(file, 'utf8');
    if (MKTEMP_RE.test(text) && !CLEANUP_RE.test(text)) {
      rep.warn(file, 'creates temp directories (mkdtemp) but never removes them; clean up in after()/finally (leaked ms-* directories fill the disk)');
    }
  }
}

function checkFiles(root, rep, stats) {
  for (const file of walk(root)) {
    const ext = path.extname(file).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    const buf = fs.readFileSync(file);
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) rep.error(file, 'UTF-8 BOM (write files without a BOM)');
    if (buf.includes(0x0d)) {
      const lf = buf.indexOf(0x0d);
      if (buf[lf + 1] === 0x0a) rep.error(file, 'CRLF line endings (use LF; .gitattributes eol=lf)');
    }
    if (ext === '.json') { stats.json++; readJSONChecked(file, rep); }
  }
}

function lintPlugin(root) {
  const rep = new Report(root);
  const stats = { skills: 0, agents: 0, hooks: 0, json: 0, skillBudget: 0 };
  const plugin = checkManifests(root, rep);
  const skills = checkSkills(root, rep, stats);
  checkAgents(root, rep, stats, skills, plugin && plugin.name ? plugin.name : '');
  checkHooks(root, rep, stats);
  checkPluginRootFallback(root, rep);
  checkTestTempCleanup(root, rep);
  checkFiles(root, rep, stats);
  return { root, stats, errors: rep.errors, warnings: rep.warnings };
}

// ---------------------------------------------------------------------------------------------

const USAGE = `Usage: node scripts/lint-plugin.mjs [--root DIR] [--strict] [--json]

Lints the plugin at DIR (default: this repository) for what \`claude plugin validate --strict\`
does not check. Exit 0 = clean, 1 = errors (or warnings with --strict), 2 = usage error.

Options:
  --root DIR   plugin root to lint
  --strict     treat warnings as errors
  --json       print one JSON result line on stdout
  -h, --help   show this help
`;

function cli(argv) {
  let root = DEFAULT_ROOT;
  let strict = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { process.stdout.write(USAGE); return 0; }
    if (a === '--strict') { strict = true; continue; }
    if (a === '--json') { json = true; continue; }
    if (a === '--root' || a.startsWith('--root=')) {
      const v = a === '--root' ? argv[++i] : a.slice(7);
      if (!v) { process.stderr.write(`lint-plugin: --root needs a value\n\n${USAGE}`); return 2; }
      root = path.resolve(v);
      continue;
    }
    process.stderr.write(`lint-plugin: unknown argument ${a}\n\n${USAGE}`);
    return 2;
  }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) { process.stderr.write(`lint-plugin: ${root} is not a directory\n`); return 1; }
  const res = lintPlugin(root);
  const lines = [...res.errors, ...res.warnings].map((x) => `  ${x.level === 'error' ? 'ERROR' : 'WARN '} ${x.file}${x.line ? `:${x.line}` : ''}  ${x.msg}`);
  const s = res.stats;
  const failed = res.errors.length > 0 || (strict && res.warnings.length > 0);
  lines.push(`lint-plugin: ${s.skills} skills, ${s.agents} agents, ${s.hooks} hooks, ${s.json} JSON files; `
    + `skill listing text ${s.skillBudget} chars; ${res.errors.length} error(s), ${res.warnings.length} warning(s) → ${failed ? 'FAIL' : 'OK'}`);
  process.stderr.write(`${lines.join('\n')}\n`);
  if (json) process.stdout.write(`${JSON.stringify({ ok: !failed, ...res })}\n`);
  return failed ? 1 : 0;
}

process.exitCode = cli(process.argv.slice(2));
