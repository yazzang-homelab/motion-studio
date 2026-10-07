// Small, conservative shell-command reader for the render gate. It does not execute anything:
// it tokenizes Bash, PowerShell and cmd.exe syntax well enough to find the commands a line runs,
// the directory each one runs in (cd / Set-Location / pushd chains, subshells), and whether one
// of them is a final render. Unknown constructs degrade to "not a final render" (fail open).
import { normPath, resolvePath, parentDir, isAbs } from './common.mjs';
import { tokenize } from './shell-tokens.mjs';

export { tokenize };

const MAX_DEPTH = 5;
const MAX_COMMANDS = 400;

// ---------------------------------------------------------------------------------------------
// Command walker: splits tokens into simple commands and tracks the working directory.

const CD_NAMES = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
const POP_NAMES = new Set(['popd', 'pop-location']);

export function commandName(word) {
  if (typeof word !== 'string') return '';
  const n = normPath(word) ?? word;
  const base = n.slice(n.lastIndexOf('/') + 1).toLowerCase();
  return base.replace(/\.(exe|cmd|bat|ps1|com)$/, '');
}

function cdTarget(argv, dialect) {
  const args = argv.slice(1);
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (dialect === 'powershell' && /^-(path|literalpath|lp|psPath)$/i.test(a)) return args[k + 1] ?? null;
    if (dialect === 'powershell' && /^-(stackname|passthru)$/i.test(a)) { if (/^-stackname$/i.test(a)) k++; continue; }
    if (dialect === 'cmd' && /^\/d$/i.test(a)) continue;
    if (dialect === 'bash' && /^-[LPe@]+$/.test(a)) continue;
    if (a === '--') return args[k + 1] ?? null;
    return a;
  }
  return undefined; // no argument
}

// → [{ argv, cwd }] where cwd is the directory the command starts in (null = unknown).
export function parseScript(src, opts = {}) {
  const dialect = opts.dialect ?? 'bash';
  const home = opts.home ?? null;
  const env = opts.env ?? process.env;
  let cwd = opts.cwd ? normPath(opts.cwd) : null;
  const out = [];
  const stack = []; // pushd stack
  const subshells = []; // bash ( ... ) saved cwds

  const { tokens, subs } = tokenize(src, { dialect, env, home, cwd });
  let argv = [];
  let skipNext = false;
  const flush = () => {
    if (!argv.length) return;
    const cmd = argv;
    argv = [];
    out.push({ argv: cmd, cwd });
    const name = commandName(cmd[0]);
    if (CD_NAMES.has(name)) {
      const t = cdTarget(cmd, dialect);
      if (name === 'pushd' || name === 'push-location') stack.push(cwd);
      if (t === undefined) {
        if (dialect === 'bash' && (name === 'cd' || name === 'chdir')) cwd = home;
      } else if (t === null || t === '-') {
        cwd = null;
      } else {
        const expanded = t === '~' ? home : t.startsWith('~/') && home ? `${home}/${t.slice(2)}` : t;
        cwd = expanded ? (isAbs(normPath(expanded) ?? '') ? normPath(expanded) : resolvePath(cwd, expanded)) : null;
      }
    } else if (POP_NAMES.has(name)) {
      cwd = stack.length ? stack.pop() : null;
    }
  };
  for (const tok of tokens) {
    if (tok.t === 'w') {
      if (skipNext) { skipNext = false; continue; }
      if (tok.v.includes('\u0000sub\u0000')) {
        // Unknown value from a command substitution; keep a marker that never matches a path.
        argv.push(tok.v.replace(/\u0000sub\u0000/g, '<sub>'));
        continue;
      }
      argv.push(tok.v);
      continue;
    }
    if (tok.t === 'asg') {
      // PowerShell `$x = cmd ...`: at command position the assignment is only a prefix. Elsewhere it is
      // an ordinary argument, kept verbatim (and never a command boundary).
      if (skipNext) skipNext = false;
      else if (argv.length) argv.push(tok.v);
      continue;
    }
    const v = tok.v;
    if (v === 'redir') { skipNext = true; continue; }
    skipNext = false;
    if (v === '&' && dialect === 'powershell' && argv.length === 0) continue; // call operator
    flush();
    if (dialect === 'bash' && v === '(') subshells.push(cwd);
    else if (dialect === 'bash' && v === ')' && subshells.length) cwd = subshells.pop();
    if (out.length > MAX_COMMANDS) break;
  }
  flush();
  // Substitutions run in the directory current at the start of the line (approximation).
  const depth = opts.depth ?? 0;
  if (depth < MAX_DEPTH) {
    for (const sub of subs.slice(0, 32)) {
      for (const c of parseScript(sub, { ...opts, cwd: opts.cwd, depth: depth + 1 })) out.push(c);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Final-render detection

const FINAL_SCRIPTS = new Set(['render:final', 'build']);
const NODE_VALUE_OPTS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions',
  '--input-type', '--inspect-port', '--title', '--env-file', '--env-file-if-exists', '--stack-size', '--max-old-space-size',
  '--disable-warning', '--watch-path', '--experimental-config-file']);
// Package-manager options that take a value (skipped, with the value, ahead of the script name).
// npm -w/--workspace are handled separately (they redirect the script to another directory); npm -f is a boolean.
const PM_VALUE_FLAGS = new Set(['--filter', '--loglevel', '--userconfig', '--cache', '--registry', '--scope', '--script-shell', '--reporter']);
const PREFIX_FLAGS = new Set(['--prefix', '-C', '--dir', '--cwd']);
const RUN_SUBS = new Set(['run', 'run-script', 'rum', 'urn']);
const EXEC_SUBS = new Set(['exec', 'x', 'dlx']);
const PM_BUILTINS = new Set(['install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'un', 'up', 'update', 'upgrade', 'exec', 'x',
  'dlx', 'create', 'init', 'link', 'unlink', 'publish', 'pack', 'list', 'ls', 'outdated', 'why', 'audit', 'store', 'config',
  'info', 'view', 'import', 'rebuild', 'prune', 'patch', 'env', 'setup', 'help', 'version', 'cache', 'bin', 'root', 'prefix',
  'doctor', 'explain', 'dedupe', 'fund', 'login', 'logout', 'whoami', 'set', 'get', 'workspaces', 'workspace', 'plugin', 'node']);
const SHELL_KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'coproc']);
const WRAPPERS = new Set(['env', 'time', 'nohup', 'exec', 'command', 'builtin', 'nice', 'sudo', 'timeout', 'cross-env',
  'cross-env-shell', 'npx', 'pnpx', 'bunx', 'caffeinate', 'stdbuf', 'xvfb-run', 'call']);

export function hasFinalFlag(args) {
  let final = false;
  for (const a of args) {
    if (a === '--final') final = true;
    else if (a === '--no-final') final = false;
    else if (a.startsWith('--final=')) final = !/^(false|0|no|off)$/i.test(a.slice(8));
  }
  return final;
}

function unwrap(argv, cwd) {
  let a = argv.slice();
  let dir = cwd;
  for (let guard = 0; a.length && guard < 16; guard++) {
    const first = a[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) { a.shift(); continue; } // FOO=bar cmd
    if (first === '.' || first === '&') { a.shift(); continue; } // PowerShell dot-source / call
    if (SHELL_KEYWORDS.has(first)) { a.shift(); continue; } // if npm run build; then ... / { cmd; }
    const name = commandName(first);
    if (!WRAPPERS.has(name)) break;
    a.shift();
    // Drop the wrapper's own options (and the values of the few that take one).
    while (a.length) {
      const x = a[0];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(x)) { a.shift(); continue; }
      if (name === 'env' && (x === '-C' || x === '--chdir')) { dir = resolvePath(dir, a[1]) ?? null; a.splice(0, 2); continue; }
      if (name === 'env' && x.startsWith('--chdir=')) { dir = resolvePath(dir, x.slice(8)) ?? null; a.shift(); continue; }
      if (name === 'env' && (x === '-S' || x === '--split-string') && a[1]) { a.splice(0, 2, ...a[1].split(/\s+/).filter(Boolean)); continue; }
      if (['-u', '--unset', '-n', '-g', '-p', '--package', '-s', '-k', '--kill-after', '--signal'].includes(x)) { a.splice(0, 2); continue; }
      if (x === '--') { a.shift(); break; }
      if (x.startsWith('-')) { a.shift(); continue; }
      if (name === 'timeout' && /^\d+(\.\d+)?[smhd]?$/.test(x)) { a.shift(); break; }
      break;
    }
  }
  return { argv: a, cwd: dir };
}

function nodeScript(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') return { script: args[k + 1], rest: args.slice(k + 2) };
    // Inline code, syntax check, test runner: no render script is executed.
    if (['-e', '--eval', '-p', '--print', '-c', '--check', '--test', '-v', '--version', '-h', '--help'].includes(a)) return null;
    if (a === '--run') return { run: args[k + 1], rest: args.slice(k + 2) };
    if (a.startsWith('--run=')) return { run: a.slice(6), rest: args.slice(k + 1) };
    if (NODE_VALUE_OPTS.has(a)) { k++; continue; }
    if (a.startsWith('-')) continue;
    return { script: a, rest: args.slice(k + 1) };
  }
  return null;
}

// → { name, extra, prefix, workspaces } | { exec: argv, prefix, workspaces } | null
// npm reads its options anywhere before a lone "--" (`npm run build --prefix film` == `npm --prefix film run build`),
// so --prefix / -C / --dir / --cwd and npm's -w / --workspace are collected from the whole argument list. Only the
// tokens that are neither a package-manager option nor the sub-command / script name are kept in `rest`.
function packageScript(pm, args) {
  let prefix = null;
  const workspaces = [];
  const rest = [];
  const nameCount = () => (RUN_SUBS.has(rest[0]) ? 2 : 1); // rest[nameCount() - 1] = script name (or the exec'd command)
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { rest.push(...args.slice(k)); break; } // everything after belongs to the script / exec'd command
    // `npm exec <cmd> ...`: after the command starts, its own options are not ours.
    if (EXEC_SUBS.has(rest[0]) && rest.length > 1) { rest.push(a); continue; }
    if (PREFIX_FLAGS.has(a)) { prefix = args[k + 1] ?? null; k++; continue; }
    let m = /^--(prefix|dir|cwd)=(.*)$/.exec(a);
    if (m) { prefix = m[2]; continue; }
    if (pm === 'npm') {
      if (a === '-w' || a === '--workspace') { if (args[k + 1] !== undefined) workspaces.push(args[k + 1]); k++; continue; }
      m = /^--workspace=(.*)$/.exec(a);
      if (m) { workspaces.push(m[1]); continue; }
    }
    if (rest.length < nameCount()) { // before the script name: options are ours, not the script's
      const low = a.toLowerCase();
      if (PM_VALUE_FLAGS.has(low) || (pm !== 'npm' && low === '-f')) { k++; continue; }
      if (a.startsWith('-')) continue;
    }
    rest.push(a);
  }
  const sub = rest[0];
  if (!sub) return null;
  const tail = rest.slice(1);
  const afterDashes = (list) => { const d = list.indexOf('--'); return d < 0 ? [] : list.slice(d + 1); };
  const scriptArgs = (list) => (pm === 'npm' ? afterDashes(list) : list.filter((x, idx) => !(x === '--' && idx === 0)));
  if (RUN_SUBS.has(sub)) {
    const name = tail.find((x) => !x.startsWith('-'));
    if (!name) return null;
    return { name, extra: scriptArgs(tail.slice(tail.indexOf(name) + 1)), prefix, workspaces };
  }
  if (EXEC_SUBS.has(sub)) {
    const d = tail.indexOf('--');
    const argv = d < 0 ? tail.slice() : tail.slice(d + 1);
    while (argv.length && argv[0].startsWith('-')) argv.shift();
    return { exec: argv, prefix, workspaces };
  }
  if (pm === 'npm') {
    const alias = { start: 'start', test: 'test', t: 'test', tst: 'test', stop: 'stop', restart: 'restart' }[sub];
    return alias ? { name: alias, extra: afterDashes(tail), prefix, workspaces } : null;
  }
  if (pm === 'bun') return null; // bun <x> without "run" is a bun built-in (build = bundler)
  if (PM_BUILTINS.has(sub)) return null;
  return { name: sub, extra: scriptArgs(tail), prefix, workspaces };
}

// First word that is not an option (a prefix option consumes its value).
function firstPositional(list) {
  for (let k = 0; k < list.length; k++) {
    if (PREFIX_FLAGS.has(list[k])) { k++; continue; }
    if (!list[k].startsWith('-')) return list[k];
  }
  return undefined;
}

// Directories a package-manager command runs in: cwd, moved by --prefix, then by each npm workspace.
function packageDirs(spec, cwd) {
  const base = spec.prefix ? resolvePath(cwd, spec.prefix) : cwd;
  if (!base) return [];
  if (!spec.workspaces || !spec.workspaces.length) return [base];
  return spec.workspaces.map((w) => resolvePath(base, w)).filter(Boolean);
}

// Start-Process [-FilePath] npm [-ArgumentList] "run build" -Wait → ['npm', 'run', 'build'] (+ working directory)
const START_PROCESS_PARAMS = [['filepath', 1], ['argumentlist', 1], ['args', 1], ['workingdirectory', 1], ['verb', 1], ['windowstyle', 1],
  ['redirectstandarderror', 1], ['redirectstandardinput', 1], ['redirectstandardoutput', 1], ['credential', 1], ['environment', 1],
  ['wait', 0], ['nonewwindow', 0], ['passthru', 0], ['loaduserprofile', 0], ['usenewenvironment', 0]];
function startProcessCommand(args) {
  let file = null;
  let list = null;
  let wd = null;
  const positional = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const low = a.startsWith('-') && a.length > 1 ? a.slice(1).replace(/:.*$/, '').toLowerCase() : '';
    const param = low ? START_PROCESS_PARAMS.find(([n]) => n.startsWith(low)) : null;
    if (!param) { positional.push(a); continue; }
    const inline = a.includes(':') ? a.slice(a.indexOf(':') + 1) : null;
    if (!param[1]) continue; // switch
    const value = inline !== null && inline !== '' ? inline : args[++k];
    if (param[0] === 'filepath') file = value ?? null;
    else if (param[0] === 'argumentlist' || param[0] === 'args') list = value ?? null;
    else if (param[0] === 'workingdirectory') wd = value ?? null;
  }
  if (file === null) file = positional.shift() ?? null;
  if (list === null) list = positional.shift() ?? null;
  if (!file) return null;
  // An array ("run","build") reaches us as one comma-joined word; a single string keeps its spaces.
  const parts = list ? (/\s/.test(list) ? list.split(/\s+/) : list.split(',')).filter(Boolean) : [];
  return { argv: [file, ...parts], wd };
}

function quoteArg(a) {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`;
}

function decodePowerShellEncoded(b64) {
  try { return Buffer.from(b64, 'base64').toString('utf16le'); } catch { return ''; }
}

// ctx: { dialect, cwd, env, home, findRoot(dir) → root|null, readScripts(root) → object|null }
// → [{ root, via, cwd }]
export function detectFinalRenders(command, ctx = {}, depth = 0, seen = new Set()) {
  const hits = [];
  if (typeof command !== 'string' || !command.trim() || depth > MAX_DEPTH) return hits;
  const findRoot = ctx.findRoot ?? (() => null);
  const readScripts = ctx.readScripts ?? (() => null);
  const dialect = ctx.dialect ?? 'bash';
  const cmds = parseScript(command, { dialect, cwd: ctx.cwd, env: ctx.env, home: ctx.home });
  const scriptDialect = process.platform === 'win32' ? 'cmd' : 'bash';

  const recurse = (text, d, cwd) => {
    for (const h of detectFinalRenders(text, { ...ctx, dialect: d, cwd }, depth + 1, seen)) hits.push(h);
  };

  const viaScript = (runner, spec, cwd) => {
    for (const dir of packageDirs(spec, cwd)) viaScriptIn(runner, spec, dir);
  };

  const viaScriptIn = (runner, spec, dir) => {
    const root = findRoot(dir);
    if (!root) return;
    const label = `${runner} ${spec.name}${spec.extra.length ? ` -- ${spec.extra.join(' ')}` : ''}`;
    if (FINAL_SCRIPTS.has(spec.name)) { hits.push({ root, via: label, cwd: dir }); return; }
    const scripts = readScripts(root);
    if (!scripts || typeof scripts !== 'object') return;
    for (const key of [`pre${spec.name}`, spec.name, `post${spec.name}`]) {
      const body = scripts[key];
      if (typeof body !== 'string') continue;
      const tag = `${root}\u0000${key}\u0000${spec.extra.join(' ')}`;
      if (seen.has(tag)) continue;
      seen.add(tag);
      const text = key === spec.name && spec.extra.length ? `${body} ${spec.extra.map(quoteArg).join(' ')}` : body;
      const inner = detectFinalRenders(text, { ...ctx, dialect: scriptDialect, cwd: root }, depth + 1, seen);
      if (inner.length) { hits.push({ root, via: `${label} (runs: ${body})`, cwd: dir }); return; }
    }
  };

  const classify = (argv0, cwd0) => {
    const { argv, cwd } = unwrap(argv0, cwd0);
    if (!argv.length) return;
    const name = commandName(argv[0]);
    const args = argv.slice(1);
    const bunSub = name === 'bun' ? firstPositional(args) : null; // bun --cwd film run build
    if (name === 'node' || name === 'nodejs' || (name === 'bun' && bunSub !== 'run' && !PM_BUILTINS.has(bunSub ?? ''))) {
      const spec = nodeScript(args);
      if (!spec) return;
      if (spec.run) { viaScript('node --run', { name: spec.run, extra: spec.rest, prefix: null }, cwd); return; }
      if (!spec.script || commandName(spec.script) !== 'render.mjs' || !/\.mjs$/i.test(spec.script)) return;
      if (!hasFinalFlag(spec.rest)) return;
      const scriptPath = resolvePath(cwd, spec.script);
      const root = (scriptPath && findRoot(parentDir(scriptPath) ?? scriptPath)) || (cwd && findRoot(cwd));
      if (root) hits.push({ root, via: `node ${spec.script} ${spec.rest.join(' ')}`.trim(), cwd });
      return;
    }
    if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') {
      const spec = packageScript(name, args);
      if (!spec) return;
      if (spec.exec) {
        for (const dir of packageDirs(spec, cwd)) classify(spec.exec, dir);
        return;
      }
      // bun run <file> executes the file directly.
      if (name === 'bun' && /\.(m?js|cjs|ts)$/i.test(spec.name)) { classify(['node', spec.name, ...spec.extra], cwd); return; }
      viaScript(`${name} run`, spec, cwd);
      return;
    }
    // Commands that run a string / another command: the text they receive is a command line too.
    if (dialect === 'powershell' && (name === 'invoke-expression' || name === 'iex')) {
      recurse(args.filter((a) => !/^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(a)).join(' '), 'powershell', cwd);
      return;
    }
    if (dialect === 'bash' && name === 'eval') { recurse(args.join(' '), 'bash', cwd); return; }
    if (dialect === 'powershell' && (name === 'start-process' || name === 'saps' || name === 'start')) {
      const sp = startProcessCommand(args);
      if (sp) classify(sp.argv, sp.wd ? (resolvePath(cwd, sp.wd) ?? cwd) : cwd);
      return;
    }
    if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(name)) {
      const k = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
      if (k >= 0 && args[k + 1]) recurse(args[k + 1], 'bash', cwd);
      return;
    }
    if (name === 'cmd') {
      const k = args.findIndex((a) => /^\/[ck]$/i.test(a));
      if (k >= 0) recurse(args.slice(k + 1).join(' '), 'cmd', cwd);
      return;
    }
    if (name === 'powershell' || name === 'pwsh') {
      let dir = cwd;
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (/^-(workingdirectory|wd)$/i.test(a)) { dir = resolvePath(cwd, args[k + 1]) ?? dir; k++; continue; }
        if (/^-(e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)$/i.test(a)) {
          recurse(decodePowerShellEncoded(args[k + 1] ?? ''), 'powershell', dir);
          return;
        }
        if (/^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(a)) { recurse(args.slice(k + 1).join(' '), 'powershell', dir); return; }
        if (/^-(f|file|ex|ep|executionpolicy|w|windowstyle|o|outputformat|if|inputformat|v|version|configurationname|settingsfile)$/i.test(a)) { k++; continue; }
        if (!a.startsWith('-')) { recurse(args.slice(k).join(' '), 'powershell', dir); return; }
      }
    }
  };

  for (const { argv, cwd } of cmds) classify(argv, cwd);
  return hits;
}
