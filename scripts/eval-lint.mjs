#!/usr/bin/env node
// Zero-cost lint of the eval suite (research/eval-spec.md §9): `claude plugin eval` with
// --max-cost-usd 0 parses and schema-checks every case and runs the grader/tool feasibility
// checks, but launches no agent run and spends $0.00. It exits 2 (partial: cost_ceiling) even
// when cases fail to load, so the verdict comes from stderr signals. Node built-ins only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIGNALS = [
  /failed to load/i,
  /cannot pass with the granted tools/i,
  /not granted/i,
  /Warning: ignoring experimental\.evals/i,
  /^\s*✗ /m, // "✗ ..." load-error lines
];

const USAGE = `Usage: node scripts/eval-lint.mjs [--root DIR] [--allow-tools Write,Edit] [--no-scaffold]
                               [--timeout SECONDS] [--keep] [--skip-if-missing] [--json]

Runs \`claude plugin eval <root> --trust-plugin --no-publish --max-cost-usd 0 --scaffold
--allow-tools Write Edit --json <tmp>\` and fails on load errors or infeasible graders.
Costs nothing and needs no credentials. The claude binary comes from CLAUDE_BIN or PATH.

Exit codes: 0 suite loads cleanly · 1 lint failure / claude missing or failed · 2 usage error

Options:
  --root DIR          plugin root (default: this repository)
  --allow-tools LIST  comma list granted like the paid run (default: Write,Edit)
  --no-scaffold       do not pass --scaffold
  --timeout SECONDS   kill claude after this long (default: 240)
  --keep              keep the temporary result directory
  --skip-if-missing   exit 0 with a notice when claude is not installed
  --json              print one JSON result line on stdout
  -h, --help          show this help
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { root: DEFAULT_ROOT, tools: ['Write', 'Edit'], scaffold: true, timeout: 240, keep: false, skipIfMissing: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === '') throw new UsageError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '-h': case '--help': o.help = true; break;
      case '--root': o.root = path.resolve(value()); break;
      case '--allow-tools': o.tools = value().split(',').map((x) => x.trim()).filter(Boolean); break;
      case '--no-scaffold': o.scaffold = false; break;
      case '--timeout': {
        o.timeout = Number(value());
        if (!(o.timeout > 0)) throw new UsageError('--timeout must be a positive number of seconds');
        break;
      }
      case '--keep': o.keep = true; break;
      case '--skip-if-missing': o.skipIfMissing = true; break;
      case '--json': o.json = true; break;
      default: throw new UsageError(`unknown argument ${a}`);
    }
  }
  return o;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// Windows: prefer the native claude.exe; an npm-installed claude.cmd shim is unwrapped to the
// program it launches so no shell is needed (Node refuses to spawn .cmd without one).
function unwrapCmdShim(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    // npm's cmd-shim also mentions "%dp0%\node.exe" (the interpreter probe): skip it.
    for (const m of text.matchAll(/"%~?dp0%\\?([^"]+\.(?:js|mjs|cjs|exe))"/gi)) {
      if (/^node\.exe$/i.test(path.basename(m[1]))) continue;
      const target = path.join(path.dirname(file), m[1]);
      if (!isFile(target)) continue;
      return /\.exe$/i.test(target) ? { bin: target, pre: [] } : { bin: process.execPath, pre: [target] };
    }
    return null;
  } catch {
    return null;
  }
}

function resolveClaude(env = process.env) {
  const explicit = env.CLAUDE_BIN;
  const win = process.platform === 'win32';
  const candidates = [];
  if (explicit) candidates.push(explicit);
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const dirs = String(env[pathKey] ?? '').split(path.delimiter).filter(Boolean);
  const home = os.homedir();
  dirs.push(path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'));
  const names = win ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
  for (const d of dirs) for (const n of names) candidates.push(path.join(d.replace(/^"|"$/g, ''), n));
  for (const c of candidates) {
    if (!isFile(c)) continue;
    if (!win) {
      try { fs.accessSync(c, fs.constants.X_OK); } catch { continue; }
      return { bin: c, pre: [], shell: false };
    }
    if (/\.exe$/i.test(c)) return { bin: c, pre: [], shell: false };
    if (/\.(cmd|bat)$/i.test(c)) {
      const inner = unwrapCmdShim(c);
      return inner ? { ...inner, shell: false, via: c } : { bin: c, pre: [], shell: true };
    }
  }
  return null;
}

function quoteForCmd(a) {
  return /^[A-Za-z0-9_\-.\\/:=@,+]+$/.test(a) ? a : `"${String(a).replace(/"/g, '""')}"`;
}

function runClaude(claude, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const argv = [...claude.pre, ...args];
    const child = claude.shell
      ? spawn([claude.bin, ...argv].map(quoteForCmd).join(' '), { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(claude.bin, argv, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}${err.message}\n`, spawnError: err }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) { process.stdout.write(USAGE); return 0; }
  const result = { ok: false, root: o.root, claude: null, exit: null, cases: null, claudeVersion: null, signals: [], partialReason: null };
  const finish = (code, message) => {
    if (message) process.stderr.write(`eval-lint: ${message}\n`);
    if (o.json) process.stdout.write(`${JSON.stringify({ ...result, ok: code === 0, message: message ?? null })}\n`);
    return code;
  };
  if (!fs.existsSync(path.join(o.root, '.claude-plugin', 'plugin.json'))) return finish(1, `${o.root} is not a plugin root (.claude-plugin/plugin.json missing)`);
  if (!fs.existsSync(path.join(o.root, 'evals'))) return finish(1, `no evals/ directory under ${o.root}`);

  const claude = resolveClaude();
  if (!claude) {
    const msg = 'claude CLI not found (set CLAUDE_BIN or install: npm install -g @anthropic-ai/claude-code)';
    if (o.skipIfMissing) { result.skipped = true; return finish(0, `${msg}; skipped`); }
    return finish(1, msg);
  }
  result.claude = claude.via ?? claude.bin;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-studio-eval-lint-'));
  const jsonPath = path.join(tmp, 'eval-lint.json');
  // --output-dir keeps the run from dropping evals/results/<timestamp>/ into the repository.
  const args = ['plugin', 'eval', o.root, '--trust-plugin', '--no-publish', '--max-cost-usd', '0',
    '--output-dir', path.join(tmp, 'results')];
  if (o.scaffold) args.push('--scaffold');
  if (o.tools.length) args.push('--allow-tools', ...o.tools);
  args.push('--json', jsonPath);

  process.stderr.write(`eval-lint: ${path.basename(result.claude)} ${args.map(quoteForCmd).join(' ')}\n`);
  const t0 = Date.now();
  const r = await runClaude(claude, args, { cwd: o.root, timeoutMs: o.timeout * 1000 });
  result.exit = r.code;
  result.seconds = Math.round((Date.now() - t0) / 100) / 10;
  if (r.stderr.trim()) process.stderr.write(`${r.stderr.replace(/\s+$/, '')}\n`);

  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { doc = null; }
  const pluginProblems = [];
  if (doc) {
    result.claudeVersion = doc.claudeVersion ?? null;
    result.partialReason = doc.partialReason ?? null;
    result.costUsd = doc.costUsd ?? null;
    for (const p of doc.suite?.plugins ?? []) if (p && p.problem) pluginProblems.push(`${p.name}: ${p.problem}`);
  }
  // A zero-cost run lists no cases in its JSON (nothing ran), so count the case dirs on disk.
  result.cases = countCases(path.join(o.root, 'evals'));
  if (o.keep) result.resultDir = tmp; else fs.rmSync(tmp, { recursive: true, force: true });

  const lines = r.stderr.split(/\r?\n/);
  result.signals = [...lines.filter((l) => SIGNALS.some((re) => re.test(l))).map((l) => l.trim()), ...pluginProblems].slice(0, 50);

  if (r.spawnError) return finish(1, `could not start claude: ${r.spawnError.message}`);
  if (r.timedOut) return finish(1, `claude did not finish within ${o.timeout} s`);
  if (r.code !== 2 && r.code !== 0) return finish(1, `unexpected exit ${r.code} from claude plugin eval (1 = no cases found, untrusted dir or bad option)`);
  if (result.signals.length) return finish(1, `suite has load errors or infeasible graders (${result.signals.length} signal line(s) above)`);
  if (doc && doc.costUsd > 0) return finish(1, `lint run reported cost ${doc.costUsd} USD (expected 0)`);
  if (!doc) return finish(1, 'claude plugin eval wrote no result JSON');
  return finish(0, `OK: ${result.cases} case(s) on disk load cleanly, $0.00, exit ${r.code}${result.partialReason ? ` (${result.partialReason})` : ''}`);
}

// Case = a directory under evals/ holding prompt.md or case.yaml (cases may nest in group dirs).
function countCases(dir) {
  let n = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  if (names.has('prompt.md') || names.has('case.yaml')) return 1;
  for (const e of entries) if (e.isDirectory() && e.name !== 'results' && e.name !== 'node_modules') n += countCases(path.join(dir, e.name));
  return n;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
  const usage = err instanceof UsageError;
  process.stderr.write(`eval-lint: ${err.message}\n${usage ? `\n${USAGE}` : ''}`);
  process.exitCode = usage ? 2 : 1;
});
