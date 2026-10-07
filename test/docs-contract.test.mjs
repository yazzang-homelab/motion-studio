// Documentation vs code: names and conventions the docs promise must be the ones the code and the other skills use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8').replace(/\r\n/g, '\n');

test('D3: a SKILL.md that says later sections quote "the request above" really does, and none promises it in vain', () => {
  const skills = fs.readdirSync(path.join(REPO, 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.ok(skills.length >= 8);
  for (const name of skills) {
    const text = read('skills', name, 'SKILL.md');
    const promise = /later (?:sections|steps) say "the request above"/.test(text);
    const uses = text.split('\n').filter((l) => /\bthe request above\b/.test(l) && !/later (?:sections|steps) say/.test(l)).length;
    if (promise) assert.ok(uses > 0, `skills/${name}/SKILL.md promises "the request above" in later sections but never uses it`);
  }
});

test('D2: the docs name UI-state crop files the way states.mjs writes them (<viewport>-crop-<NN>-<slug>.png), never "20-crop-"', () => {
  const states = read('skills', 'product-reel', 'scripts', 'states.mjs');
  assert.match(states, /\$\{vp\}-crop-\$\{20 \+ i\}-\$\{slug\(sel\)\}\.png/, 'the file name pattern the docs describe');
  const docs = [['agents', 'asset-scout.md'], ['skills', 'product-reel', 'SKILL.md'], ['skills', 'product-reel', 'references', 'asset-capture.md'], ['skills', 'product-reel', 'scripts', 'states.mjs'], ['CHANGELOG.md'], ['docs', 'ARCHITECTURE.md']];
  for (const d of docs) assert.doesNotMatch(read(...d), /(?<![\w-])2\d-crop-/, `${d.join('/')} still names the crop files "NN-crop-..."`);
  assert.match(read('skills', 'product-reel', 'references', 'asset-capture.md'), /crop-20-<selector>/);
});
