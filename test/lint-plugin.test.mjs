// scripts/lint-plugin.mjs: the checks that catch skills-only breakage and leaked test temp dirs.
// Builds a tiny throw-away plugin in os.tmpdir() and runs the real CLI on it (two spawns, --json).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const LINT = path.join(REPO, 'scripts', 'lint-plugin.mjs');

let BASE;
function removeTree(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ }
}
before(() => {
  BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-lintplugin-'));
  process.once('exit', () => removeTree(BASE));
});
after(() => removeTree(BASE));

function put(root, rel, text) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const skill = (name, body) => `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n\n${body}\n\nNext: nothing.\n`;
const filler = (n) => Array.from({ length: n }, (_, i) => `filler line ${i}`).join('\n');

function makePlugin() {
  const root = path.join(BASE, 'plugin');
  put(root, '.claude-plugin/plugin.json', JSON.stringify({ name: 'tmp-plugin', version: '0.1.0', description: 'x', author: { name: 'me' } }));
  put(root, '.claude-plugin/marketplace.json', JSON.stringify({ name: 'tmp-plugin', owner: { name: 'me' }, description: 'x', plugins: [{ name: 'tmp-plugin', source: './', description: 'x' }] }));
  for (const s of ['bare', 'covered', 'far', 'refs']) put(root, `skills/${s}/scripts/x.mjs`, 'export {};\n');
  // No skills-only wording at all: warns.
  put(root, 'skills/bare/SKILL.md', skill('bare', 'Run:\n\n```bash\nnode "${CLAUDE_PLUGIN_ROOT}/skills/bare/scripts/x.mjs"\n```'));
  // The wording sits a few lines away from the command: clean.
  put(root, 'skills/covered/SKILL.md', skill('covered', 'Run:\n\n```bash\nnode "${CLAUDE_PLUGIN_ROOT}/skills/covered/scripts/x.mjs"\n```\n\nSkills-only install: `node "${CLAUDE_SKILL_DIR}/scripts/x.mjs"`.'));
  // The wording exists, but far from the command: warns.
  put(root, 'skills/far/SKILL.md', skill('far', `Run \`node "\${CLAUDE_PLUGIN_ROOT}/skills/far/scripts/x.mjs"\`.\n\n${filler(30)}\n\nIn a skills-only install use the skill directory.`));
  // References are checked too; a skill with no plugin-root use stays clean.
  put(root, 'skills/refs/SKILL.md', skill('refs', 'See [notes](references/notes.md). Run `node "${CLAUDE_SKILL_DIR}/scripts/x.mjs"`.'));
  put(root, 'skills/refs/references/notes.md', 'Command: `node "${CLAUDE_PLUGIN_ROOT}/skills/refs/scripts/x.mjs"`\n');
  // Test files: one leaks its temp dir, one cleans up.
  put(root, 'test/leaky.test.mjs', "import fs from 'node:fs';\nconst d = fs.mkdtempSync('x-');\nconsole.log(d);\n");
  put(root, 'test/tidy.test.mjs', "import fs from 'node:fs';\nconst d = fs.mkdtempSync('x-');\nprocess.on('exit', () => fs.rmSync(d, { recursive: true, force: true }));\n");
  return root;
}

function lint(root, ...flags) {
  const r = spawnSync(process.execPath, [LINT, '--root', root, '--json', ...flags], { encoding: 'utf8' });
  const last = r.stdout.trim().split('\n').pop();
  return { code: r.status, stderr: r.stderr, json: last && last.startsWith('{') ? JSON.parse(last) : null };
}

test('lint-plugin warns about ${CLAUDE_PLUGIN_ROOT} without a nearby skills-only fallback, and about leaked temp dirs', () => {
  const root = makePlugin();
  const res = lint(root);
  assert.equal(res.code, 0, `warnings do not fail a normal run:\n${res.stderr}`);
  assert.deepEqual(res.json.errors, []);
  const warned = res.json.warnings.map((w) => `${w.file}${w.line ? `:${w.line}` : ''}`).sort();
  assert.deepEqual(warned, [
    'skills/bare/SKILL.md:9',
    'skills/far/SKILL.md:6',
    'skills/refs/references/notes.md:1',
    'test/leaky.test.mjs',
  ], res.stderr);
  const bare = res.json.warnings.find((w) => w.file === 'skills/bare/SKILL.md');
  assert.match(bare.msg, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.match(bare.msg, /skills-only/);
  assert.match(bare.msg, /\$\{CLAUDE_SKILL_DIR\}/);
  const leaky = res.json.warnings.find((w) => w.file === 'test/leaky.test.mjs');
  assert.match(leaky.msg, /mkdtemp/);
  assert.equal(res.json.warnings.filter((w) => /tidy|covered/.test(w.file)).length, 0);
});

test('lint-plugin --strict turns those warnings into a failure', () => {
  const res = lint(makePlugin(), '--strict');
  assert.equal(res.code, 1);
  assert.equal(res.json.ok, false);
  assert.ok(res.json.warnings.length >= 4);
});

test('the hooks / init / lint-plugin test files themselves pass the plugin lint', () => {
  const res = lint(REPO);
  const mine = (x) => /^test\/(hooks|init|lint-plugin)\.test\.mjs$/.test(x.file);
  assert.deepEqual([...res.json.errors, ...res.json.warnings].filter(mine), []);
});
