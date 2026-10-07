// The two runnable scripts under evals/ start themselves only when they are the main module. Node realpaths the main
// module for import.meta.url but leaves process.argv[1] as typed, so a run through a symlink or junction (a symlinked
// checkout, a junction on Windows, macOS /tmp) used to exit 0 without doing anything. Both compare real paths now.
// Same defect and fix as capture.mjs / roll.mjs / statelist.mjs (crossplatform-security:F1).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVALS = path.join(REPO, 'evals');

// The link directory is removed after the file's tests (and on exit): a leaked ms-* dir per run adds up.
const made = [];
const cleanTmp = () => { for (const p of made.splice(0)) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* still in use */ } } };
after(cleanTmp);
process.on('exit', cleanTmp);

/** A link to `target` in a fresh temp dir, or null when the platform refuses to create one. */
function linkTo(target) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-evals-link-'));
  made.push(dir);
  const link = path.join(dir, 'link');
  try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch { return null; }
  return link;
}

const runNode = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => resolve({ code, out, err }));
});

test('evals/critique-writes-log/make-contact-sheet.mjs --check answers through a symlink or junction, like the real path', async (t) => {
  const dir = path.join(EVALS, 'critique-writes-log');
  const link = linkTo(dir);
  if (!link) { t.skip('cannot create a symlink or junction here'); return; }
  const [direct, viaLink] = await Promise.all([runNode([path.join(dir, 'make-contact-sheet.mjs'), '--check']), runNode([path.join(link, 'make-contact-sheet.mjs'), '--check'])]);
  assert.equal(direct.code, 0, direct.err);
  assert.match(direct.err, /contact\.png: OK/);
  assert.equal(viaLink.code, 0, viaLink.err);
  assert.match(viaLink.err, /contact\.png: OK/, 'the CLI ran (it used to exit 0 with no output)');
});

test('evals/_selftest/selftest.mjs --json prints its summary through a symlink or junction, like the real path', async (t) => {
  const dir = path.join(EVALS, '_selftest');
  const link = linkTo(dir);
  if (!link) { t.skip('cannot create a symlink or junction here'); return; }
  const [direct, viaLink] = await Promise.all([runNode([path.join(dir, 'selftest.mjs'), '--json']), runNode([path.join(link, 'selftest.mjs'), '--json'])]);
  assert.equal(direct.code, 0, direct.err + direct.out);
  assert.equal(JSON.parse(direct.out.trim().split('\n').pop()).ok, true);
  assert.equal(viaLink.code, 0, viaLink.err);
  const summary = JSON.parse(viaLink.out.trim().split('\n').pop());
  assert.equal(summary.ok, true);
  assert.equal(summary.cases, JSON.parse(direct.out.trim().split('\n').pop()).cases);
});
