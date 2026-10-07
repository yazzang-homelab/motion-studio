// Shell tokenizer for the render gate: splits Bash, PowerShell and cmd.exe command lines into
// words (quotes removed, variables expanded where the dialect would) and operators, and collects
// command substitutions. Heredoc and here-string bodies are data and never become commands.
// Tokens: { t: 'w', v } word, { t: 'op', v } operator (';' '|' '&&' 'redir' ...), and, for PowerShell only,
// { t: 'asg', v } an assignment prefix ("$out =", "[string]$x +=", "$env:A =") that the parser drops at command
// position so that `$out = npm run build` is read as `npm run build`.

// Match re at exactly position pos of s (no substring copies).
function at(re, s, pos) {
  re.lastIndex = pos;
  return re.exec(s);
}

const RE = {
  psEnvBraced: /\$\{env:([A-Za-z0-9_]+)\}/iy,
  psEnv: /\$env:([A-Za-z0-9_]+)/iy,
  psVar: /\$([A-Za-z_][A-Za-z0-9_]*)/y,
  shBraced: /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/y,
  shVar: /\$([A-Za-z_][A-Za-z0-9_]*)/y,
  newline: /\r?\n/y,
  percent: /%([A-Za-z0-9_]+)%/y,
  heredocDelim: /(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()]+))/y,
  dupFd: /&(\d+|-)/y,
  // PowerShell assignment prefix at the start of a word: [type]$name = / $env:X = / ${a b} += / $o.p = / $a[0] =
  // (also glued: $out=cmd). Bounded quantifiers keep a hostile 256 KB command linear.
  psAssign: /(?:\[[A-Za-z_][\w.,[\]]{0,80}\])*\$(?:\{[^}\r\n]{0,200}\}|[A-Za-z_?][\w:?]{0,200})(?:\.[A-Za-z_]\w{0,200}|\[[^\]\r\n]{0,200}\]){0,8}[ \t]*(?:\?\?|[-+*/%])?=(?!=)/y,
};

// process.env reads are native calls (slow on Windows), so snapshot each env object once into a
// Map; Windows variable names are case-insensitive.
const ENV_CACHE = new WeakMap();
function envLookup(env, name) {
  if (env == null || typeof env !== 'object') return undefined;
  let map = ENV_CACHE.get(env);
  if (!map) {
    map = new Map();
    for (const [k, v] of Object.entries(env)) map.set(process.platform === 'win32' ? k.toLowerCase() : k, v);
    ENV_CACHE.set(env, map);
  }
  return map.get(process.platform === 'win32' ? name.toLowerCase() : name);
}

export function tokenize(src, { dialect = 'bash', env = process.env, home = null, cwd = null } = {}) {
  const s = String(src ?? '');
  const n = s.length;
  const tokens = [];
  const subs = []; // command substitutions: $( ... ) and `...`
  let word = null;
  let i = 0;
  let pendingHeredocs = [];

  const add = (t) => { word = (word ?? '') + t; };
  const push = () => { if (word !== null) tokens.push({ t: 'w', v: word }); word = null; };
  const op = (v) => { push(); tokens.push({ t: 'op', v }); };
  const special = (name) => {
    if (dialect === 'powershell') {
      const low = name.toLowerCase();
      if (low === 'home') return home ?? undefined;
      if (low === 'pwd') return cwd ?? undefined;
      return undefined;
    }
    if (name === 'PWD' && cwd) return cwd;
    if (name === 'HOME') return envLookup(env, 'HOME') ?? home ?? undefined;
    return envLookup(env, name);
  };

  // Reads a balanced $( ... ) starting at the '(' index; returns index after ')'.
  const readParenSub = (start) => {
    let depth = 0;
    let j = start;
    for (; j < n; j++) {
      const c = s[j];
      if (c === '\\' && dialect === 'bash') { j++; continue; }
      if (c === "'") { const k = s.indexOf("'", j + 1); j = k < 0 ? n : k; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) break; }
    }
    subs.push(s.slice(start + 1, Math.min(j, n)));
    return Math.min(j + 1, n);
  };

  // $VAR / ${VAR} / $( ... ) (bash) and $env:VAR / ${env:VAR} / $( ... ) (PowerShell).
  const readDollar = (j) => {
    const next = s[j + 1];
    if (next === '(') {
      const end = readParenSub(j + 1);
      add('\u0000sub\u0000');
      return end;
    }
    if (dialect === 'powershell') {
      let m = at(RE.psEnvBraced, s, j);
      if (!m) m = at(RE.psEnv, s, j);
      if (m) { const v = envLookup(env, m[1]); add(v ?? m[0]); return j + m[0].length; }
      m = at(RE.psVar, s, j);
      if (m) { const v = special(m[1]); add(v ?? m[0]); return j + m[0].length; }
      add('$');
      return j + 1;
    }
    let m = at(RE.shBraced, s, j);
    if (!m) m = at(RE.shVar, s, j);
    if (m) { const v = special(m[1]); add(v ?? m[0]); return j + m[0].length; }
    add('$');
    return j + 1;
  };

  const readHeredocBodies = (j) => {
    // j points just past a newline; consume each pending heredoc body in order.
    for (const h of pendingHeredocs) {
      while (j < n) {
        const eol = s.indexOf('\n', j);
        const line = s.slice(j, eol < 0 ? n : eol).replace(/\r$/, '');
        j = eol < 0 ? n : eol + 1;
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
      }
    }
    pendingHeredocs = [];
    return j;
  };

  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { push(); i++; continue; }
    if (c === '\n') {
      op('\n');
      i++;
      if (pendingHeredocs.length) i = readHeredocBodies(i);
      continue;
    }
    if (c === '#' && word === null && dialect !== 'cmd') {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }

    if (dialect === 'bash') {
      if (c === '\\') {
        if (s[i + 1] === '\n') { i += 2; continue; }
        if (s[i + 1] === '\r' && s[i + 2] === '\n') { i += 3; continue; }
        if (i + 1 < n) add(s[i + 1]);
        i += 2;
        continue;
      }
      if (c === "'") {
        const k = s.indexOf("'", i + 1);
        add(s.slice(i + 1, k < 0 ? n : k));
        i = k < 0 ? n : k + 1;
        continue;
      }
      if (c === '"') {
        add('');
        let j = i + 1;
        while (j < n && s[j] !== '"') {
          const d = s[j];
          if (d === '\\' && j + 1 < n && '"\\$`\n'.includes(s[j + 1])) {
            if (s[j + 1] !== '\n') add(s[j + 1]);
            j += 2;
            continue;
          }
          if (d === '$') { j = readDollar(j); continue; }
          if (d === '`') {
            const k = s.indexOf('`', j + 1);
            subs.push(s.slice(j + 1, k < 0 ? n : k));
            j = k < 0 ? n : k + 1;
            continue;
          }
          add(d);
          j++;
        }
        i = j + 1;
        continue;
      }
      if (c === '$') { i = readDollar(i); continue; }
      if (c === '`') {
        const k = s.indexOf('`', i + 1);
        subs.push(s.slice(i + 1, k < 0 ? n : k));
        add('\u0000sub\u0000');
        i = k < 0 ? n : k + 1;
        continue;
      }
      if (c === '~' && word === null && (i + 1 >= n || /[\s/;&|)]/.test(s[i + 1]))) {
        add(home ?? '~');
        i++;
        continue;
      }
    } else if (dialect === 'powershell') {
      if ((c === '$' || c === '[') && word === null) {
        // `$out = npm run build 2>&1`, `$null = ...`, `[string]$x += ...`: the target and operator are not
        // part of the command. Emitted as one token so the parser can drop it at command position (and
        // keep it as a plain word when it is only an argument) instead of treating `$out` as the command.
        const m = at(RE.psAssign, s, i);
        if (m) {
          tokens.push({ t: 'asg', v: m[0] });
          i += m[0].length;
          continue;
        }
      }
      if (c === '`') {
        if (s[i + 1] === '\n') { i += 2; continue; }
        if (s[i + 1] === '\r' && s[i + 2] === '\n') { i += 3; continue; }
        if (i + 1 < n) add(s[i + 1]);
        i += 2;
        continue;
      }
      if (c === '@' && word === null && (s[i + 1] === "'" || s[i + 1] === '"') && at(RE.newline, s, i + 2)) {
        // here-string: @' ... '@ / @" ... "@ — its content is data, never commands.
        const q = s[i + 1];
        const close = s.indexOf(`\n${q}@`, i + 2);
        const body = s.slice(s.indexOf('\n', i) + 1, close < 0 ? n : close);
        add(body.replace(/\r$/, ''));
        i = close < 0 ? n : close + 3;
        continue;
      }
      if (c === "'") {
        let j = i + 1;
        add('');
        while (j < n) {
          if (s[j] === "'") { if (s[j + 1] === "'") { add("'"); j += 2; continue; } break; }
          add(s[j]);
          j++;
        }
        i = j + 1;
        continue;
      }
      if (c === '"') {
        let j = i + 1;
        add('');
        while (j < n) {
          const d = s[j];
          if (d === '`' && j + 1 < n) { add(s[j + 1]); j += 2; continue; }
          if (d === '"') { if (s[j + 1] === '"') { add('"'); j += 2; continue; } break; }
          if (d === '$') { j = readDollar(j); continue; }
          add(d);
          j++;
        }
        i = j + 1;
        continue;
      }
      if (c === '$') { i = readDollar(i); continue; }
      if (c === '~' && word === null && (i + 1 >= n || /[\s/\\;|)]/.test(s[i + 1]))) {
        add(home ?? '~');
        i++;
        continue;
      }
      if (c === '{' || c === '}') { op(c); i++; continue; }
    } else {
      // cmd.exe
      if (c === '^') { if (i + 1 < n && s[i + 1] !== '\n') add(s[i + 1]); i += 2; continue; }
      if (c === '"') {
        const k = s.indexOf('"', i + 1);
        add(expandPercent(s.slice(i + 1, k < 0 ? n : k), env));
        i = k < 0 ? n : k + 1;
        continue;
      }
      if (c === '%') {
        const m = at(RE.percent, s, i);
        if (m) { const v = envLookup(env, m[1]); add(v ?? m[0]); i += m[0].length; continue; }
      }
      // cmd passes the raw line to external programs, so ';' ',' '=' stay inside arguments.
      if (c === ';') { add(c); i++; continue; }
    }

    // Operators shared by the three dialects.
    if (c === '&') {
      if (s[i + 1] === '&') { op('&&'); i += 2; continue; }
      if (dialect === 'bash' && s[i + 1] === '>') {
        // &> file / &>> file
        push();
        i += s[i + 2] === '>' ? 3 : 2;
        tokens.push({ t: 'op', v: 'redir' });
        continue;
      }
      op('&');
      i++;
      continue;
    }
    if (c === '|') {
      if (s[i + 1] === '|') { op('||'); i += 2; continue; }
      op('|');
      i += s[i + 1] === '&' && dialect === 'bash' ? 2 : 1;
      continue;
    }
    if (c === ';') { op(';'); i++; continue; }
    if (c === '(' || c === ')') { op(c); i++; continue; }
    if (c === '>' || c === '<') {
      // Redirection. A pure-digit (or PowerShell '*') word right before it is a stream number.
      if (word !== null && /^(\d+|\*)$/.test(word)) word = null;
      push();
      let j = i + 1;
      if (c === '<' && s[j] === '<') {
        if (s[j + 1] === '<') { // here-string <<< word
          tokens.push({ t: 'op', v: 'redir' });
          i = j + 2;
          continue;
        }
        if (dialect === 'bash') {
          // heredoc << DELIM / <<- DELIM ; the body lines are skipped after the next newline.
          let k = j + 1;
          const strip = s[k] === '-';
          if (strip) k++;
          while (s[k] === ' ' || s[k] === '\t') k++;
          const m = at(RE.heredocDelim, s, k);
          if (m) {
            pendingHeredocs.push({ delim: (m[1] ?? m[2] ?? m[3]).replace(/\\/g, ''), strip });
            i = k + m[0].length;
            continue;
          }
        }
      }
      if (s[j] === '>' || s[j] === '|') j++;
      if (s[j] === '&') {
        // >&2, 2>&1, <&- : duplication, no file target
        const m = at(RE.dupFd, s, j);
        if (m) { i = j + m[0].length; continue; }
      }
      tokens.push({ t: 'op', v: 'redir' });
      i = j;
      continue;
    }
    add(c);
    i++;
  }
  push();
  return { tokens, subs };
}

function expandPercent(text, env) {
  return text.replace(/%([A-Za-z0-9_]+)%/g, (m, name) => envLookup(env, name) ?? m);
}
