// voice.mjs without ElevenLabs: `synthesize` runs against an injected fetch (unit level) and the CLI runs with a fetch
// mock preloaded through `node --import` (no network, no key). Guards: a repeated line is synthesized (and billed) once,
// the real cause of a network failure is shown, the response body is read inside the retry loop and the timeout, a 200
// that is not audio is never cached, and a cache file that is not audio is dropped instead of failing every run.
// CLI tests that decode audio skip cleanly without ffmpeg (FFMPEG_PATH, or ffmpeg-static resolvable from the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = process.env.MOTION_TEMPLATE_DIR ? path.resolve(process.env.MOTION_TEMPLATE_DIR) : path.join(REPO, 'skills', 'studio-init', 'template');
const tool = (f) => pathToFileURL(path.join(TEMPLATE, 'tools', f)).href;
const V = await import(tool('voice.mjs'));
const A = await import(tool('audio.mjs'));
const S = await import(tool('studio.mjs'));

const FFMPEG = (() => { try { return S.resolveFfmpeg(REPO); } catch { return null; } })();
const NO_FFMPEG = !FFMPEG && 'ffmpeg not found (set FFMPEG_PATH)';

// Every temp dir is removed by its test's finally; this net catches the ones a timed-out or crashed test leaves behind.
const tmpDirs = new Set();
const mkTmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.add(d); return d; };
process.on('exit', () => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function project(prefix, patch = {}) {
  const dir = mkTmp(prefix);
  fs.cpSync(TEMPLATE, dir, { recursive: true, filter: (src) => !/[\\/](node_modules|out)([\\/]|$)/.test(path.relative(TEMPLATE, src)) });
  const cfgPath = path.join(dir, 'studio.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')), ...patch }, null, 2));
  return dir;
}
function runVoice(dir, args, env = {}, preload = null) {
  const node = preload ? ['--import', pathToFileURL(preload).href] : [];
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [...node, path.join(dir, 'tools', 'voice.mjs'), ...args], {
      cwd: dir, env: { ...process.env, ...(FFMPEG ? { FFMPEG_PATH: FFMPEG } : {}), ELEVENLABS_API_KEY: '', ELEVENLABS_VOICE_ID: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
const lastJson = (s) => JSON.parse(s.trim().split('\n').filter((l) => l.startsWith('{')).pop());
const cacheFiles = (dir) => { try { return fs.readdirSync(path.join(dir, 'audio', '.cache')).filter((f) => /^voice-.*\.mp3$/.test(f)); } catch { return []; } };

// A fetch mock preloaded into the CLI: logs every POST body, answers with MOCK_MP3 (audio/mpeg) or, in html mode, a portal page.
const MOCK_SOURCE = [
  "import fs from 'node:fs';",
  'globalThis.fetch = async (url, init) => {',
  "  fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ url: String(url), text: JSON.parse(init.body).text }) + String.fromCharCode(10));",
  "  if (process.env.MOCK_MODE === 'html') return new Response('<html><body>Please sign in to the guest network</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });",
  "  return new Response(fs.readFileSync(process.env.MOCK_MP3), { status: 200, headers: { 'content-type': 'audio/mpeg' } });",
  '};',
].join(String.fromCharCode(10));
const postsOf = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const LINES = [{ t: 0.5, text: 'Meet the new dashboard.' }, { t: 2.5, text: 'Meet the new dashboard.' }, { t: 5, text: '안녕하세요 반갑습니다' }];
const UNIQUE_CHARS = 'Meet the new dashboard.'.length + '안녕하세요 반갑습니다'.length;
const ALL_CHARS = 2 * 'Meet the new dashboard.'.length + '안녕하세요 반갑습니다'.length;

// ---------------------------------------------------------------------------------------------------------------
// synthesize / describeError (injected fetch, no sleeping)

const req = { key: 'k', voiceId: 'V1', model: 'eleven_multilingual_v2', text: 'hi' };
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(300, 1)]);
const audioRes = (bytes = MP3, type = 'audio/mpeg') => new Response(bytes, { status: 200, headers: { 'content-type': type } });
const brokenBody = () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(500)); c.error(new TypeError('terminated')); } }), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
const dnsFailure = () => new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.elevenlabs.io'), { code: 'ENOTFOUND' }) });

test('describeError: the cause of "fetch failed" (DNS, TLS proxy, refused connection) reaches the message', () => {
  assert.equal(V.describeError(dnsFailure()), 'fetch failed (getaddrinfo ENOTFOUND api.elevenlabs.io)');
  const tls = new TypeError('fetch failed', { cause: Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) });
  assert.match(V.describeError(tls), /fetch failed \(UNABLE_TO_VERIFY_LEAF_SIGNATURE: unable to verify the first certificate\).*NODE_EXTRA_CA_CERTS/);
  const refused = new TypeError('fetch failed', { cause: Object.assign(new AggregateError([Object.assign(new Error('connect ECONNREFUSED ::1:443'), { code: 'ECONNREFUSED' })]), { code: 'ECONNREFUSED' }) });
  assert.equal(V.describeError(refused), 'fetch failed (connect ECONNREFUSED ::1:443)');
  assert.equal(V.describeError(new Error('boom')), 'boom');
  assert.equal(V.describeError(Object.assign(new Error('x'), { name: 'AbortError' })), 'timed out after 120 s');
  assert.equal(V.describeError(Object.assign(new Error('x'), { name: 'AbortError' }), 40), 'timed out after 0.04 s');
});

test('looksLikeMp3: ID3 tag or frame sync; a portal page or JSON error is not MP3', () => {
  assert.ok(V.looksLikeMp3(Buffer.from('ID3\x04\x00 rest')));
  assert.ok(V.looksLikeMp3(Buffer.concat([Buffer.alloc(40), Buffer.from([0xff, 0xfb, 0x90, 0x00])])), 'sync word after leading padding');
  assert.ok(!V.looksLikeMp3(Buffer.from('<html><body>Please sign in</body></html>')));
  assert.ok(!V.looksLikeMp3(Buffer.from('{"detail":{"status":"quota_exceeded"}}')));
  assert.ok(!V.looksLikeMp3(Buffer.alloc(0)));
});

test('synthesize: a network failure is retried 3 times and reports its cause', async () => {
  let calls = 0;
  const sleeps = [];
  await assert.rejects(V.synthesize(req, { fetchImpl: async () => { calls++; throw dnsFailure(); }, sleep: async (ms) => { sleeps.push(ms); } }),
    /^Error: ElevenLabs request failed: fetch failed \(getaddrinfo ENOTFOUND api\.elevenlabs\.io\)$/);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1500, 3000]);
});

test('synthesize: the body is read inside the retry loop (a stream that dies mid-download is retried, not a bare "terminated")', async () => {
  let n = 0;
  const buf = await V.synthesize(req, { fetchImpl: async () => (++n === 1 ? brokenBody() : audioRes()), sleep: async () => {} });
  assert.equal(n, 2);
  assert.equal(buf.length, MP3.length);
  let calls = 0;
  await assert.rejects(V.synthesize(req, { fetchImpl: async () => { calls++; return brokenBody(); }, sleep: async () => {} }), /^Error: ElevenLabs request failed: terminated$/);
  assert.equal(calls, 3);
});

test('synthesize: the timeout covers the body, not just the headers', async () => {
  let calls = 0;
  const hang = (init) => new Response(new ReadableStream({
    start(c) { init.signal.addEventListener('abort', () => c.error(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))); },
  }), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  await assert.rejects(V.synthesize(req, { fetchImpl: async (u, init) => { calls++; return hang(init); }, sleep: async () => {}, timeoutMs: 40 }), /ElevenLabs request failed: timed out after 0\.04 s/);
  assert.equal(calls, 3, 'a stalled body is retried like a stalled request');
});

test('synthesize: a 200 that is not audio is an error and is not retried; API errors keep their hints; 429 is retried', async () => {
  let calls = 0;
  await assert.rejects(V.synthesize(req, { fetchImpl: async () => { calls++; return audioRes('<html>Please sign in</html>', 'text/html; charset=utf-8'); }, sleep: async () => {} }),
    /answered 200 with text\/html; charset=utf-8 instead of audio \("<html>Please sign in<\/html>"\).*Nothing was cached/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(V.synthesize(req, { fetchImpl: async () => { calls++; return new Response(JSON.stringify({ detail: { message: 'Invalid API key' } }), { status: 401 }); }, sleep: async () => {} }),
    /ElevenLabs 401 \(check ELEVENLABS_API_KEY\): Invalid API key/);
  assert.equal(calls, 1);
  calls = 0;
  const sleeps = [];
  const buf = await V.synthesize(req, { fetchImpl: async () => (++calls === 1 ? new Response('slow down', { status: 429 }) : audioRes()), sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(buf.length, MP3.length);
  assert.deepEqual(sleeps, [2000]);
});

// ---------------------------------------------------------------------------------------------------------------
// CLI: repeated lines are billed once

test('voice CLI dry run: a repeated line is planned once (billable = unique characters), marked "repeat"', async () => {
  const dir = project('ms-voice-dry-');
  try {
    fs.writeFileSync(path.join(dir, 'audio', 'voice.json'), JSON.stringify(LINES));
    const r = await runVoice(dir, ['--dry-run', '--voice-id', 'V1', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const j = lastJson(r.stdout);
    assert.equal(j.chars, ALL_CHARS, 'characters in the script');
    assert.equal(j.billableChars, UNIQUE_CHARS, 'characters to synthesize: the repeat is not billed');
    assert.deepEqual(j.lines.map((l) => l.repeatOf), [undefined, 0, undefined]);
    assert.match(r.stderr, /#1\s.*repeat/);
    assert.match(r.stderr, new RegExp(`${UNIQUE_CHARS} to synthesize`));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('voice CLI: an identical line is fetched once; the second run is fully cached', { skip: NO_FFMPEG, timeout: 300000 }, async (t) => {
  const dir = project('ms-voice-dup-', { duration: 8 });
  try {
    fs.writeFileSync(path.join(dir, 'audio', 'voice.json'), JSON.stringify(LINES));
    const mock = path.join(dir, 'mock-fetch.mjs');
    fs.writeFileSync(mock, MOCK_SOURCE);
    const mp3 = path.join(dir, 'mock.mp3');
    const enc = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=300:d=1', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', mp3], { windowsHide: true });
    if (enc.status !== 0) return t.skip('this ffmpeg build has no libmp3lame');
    const log = path.join(dir, 'mock.log');
    const env = { ELEVENLABS_API_KEY: 'fake-key', MOCK_LOG: log, MOCK_MP3: mp3 };
    const r = await runVoice(dir, ['--voice-id', 'V1', '--json'], env, mock);
    assert.equal(r.code, 0, r.stderr);
    const posts = postsOf(log);
    assert.deepEqual(posts.map((p) => p.text), ['Meet the new dashboard.', '안녕하세요 반갑습니다'], 'one POST per distinct text');
    const j = lastJson(r.stdout);
    assert.equal(j.synthesizedChars, UNIQUE_CHARS);
    assert.equal(j.chars, ALL_CHARS);
    assert.equal(cacheFiles(dir).length, 2);
    const wav = A.readWav(path.join(dir, 'audio', 'voice.wav'));
    assert.equal(wav.channels[0].length, 8 * 48000, 'exact film length');
    for (const [from, to] of [[0.5, 1.5], [2.5, 3.5], [5, 6]]) assert.ok(A.peak([wav.channels[0].subarray(Math.round(from * 48000), Math.round(to * 48000))]) > 0.01, `line at ${from} s is placed`);
    const again = await runVoice(dir, ['--voice-id', 'V1', '--json'], env, mock);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(postsOf(log).length, 2, 'nothing fetched on the second run');
    assert.equal(lastJson(again.stdout).synthesizedChars, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------------
// CLI: a response or cache file that is not audio

test('voice CLI: a 200 HTML page (proxy, captive portal) fails clearly and is never cached', async () => {
  const dir = project('ms-voice-html-');
  try {
    fs.writeFileSync(path.join(dir, 'audio', 'voice.json'), JSON.stringify([{ t: 0.5, text: 'Meet the new dashboard.' }]));
    const mock = path.join(dir, 'mock-fetch.mjs');
    fs.writeFileSync(mock, MOCK_SOURCE);
    const log = path.join(dir, 'mock.log');
    const r = await runVoice(dir, ['--voice-id', 'V1'], { ELEVENLABS_API_KEY: 'fake-key', MOCK_LOG: log, MOCK_MODE: 'html', MOCK_MP3: path.join(dir, 'unused.mp3') }, mock);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ElevenLabs answered 200 with text\/html instead of audio.*Nothing was cached/);
    assert.deepEqual(cacheFiles(dir), [], 'no cache file');
    assert.equal(postsOf(log).length, 1, 'not retried');
    const dry = await runVoice(dir, ['--dry-run', '--voice-id', 'V1', '--json']);
    assert.equal(lastJson(dry.stdout).billableChars, 'Meet the new dashboard.'.length, 'still planned as new');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('voice CLI: a cache file that is not audio is deleted with an explanation, then synthesized again; a stub under 100 bytes never counts as cached', { skip: NO_FFMPEG, timeout: 300000 }, async () => {
  const dir = project('ms-voice-poison-');
  try {
    fs.writeFileSync(path.join(dir, 'audio', 'voice.json'), JSON.stringify([{ t: 0.5, text: 'Meet the new dashboard.' }]));
    const cache = path.join(dir, 'audio', '.cache', `voice-${V.cacheKey({ text: 'Meet the new dashboard.', voiceId: 'V1', model: 'eleven_multilingual_v2' })}.mp3`);
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, '<html><body>Please sign in to the guest network. '.padEnd(320, 'x') + '</body></html>');
    const dryPoisoned = await runVoice(dir, ['--dry-run', '--voice-id', 'V1', '--json']);
    assert.equal(lastJson(dryPoisoned.stdout).lines[0].cached, true, 'a page-sized file looks cached until it is decoded');
    const r = await runVoice(dir, ['--voice-id', 'V1']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /line #0: audio\/\.cache\/voice-[0-9a-f]+\.mp3 is not audio.*deleted it; run voice\.mjs again/);
    assert.ok(!fs.existsSync(cache), 'the poisoned file is gone');
    const next = await runVoice(dir, ['--voice-id', 'V1']);
    assert.equal(next.code, 1);
    assert.match(next.stderr, /ELEVENLABS_API_KEY is not set/, 'the next run tries to synthesize the line (it asks for the key)');
    fs.writeFileSync(cache, 'tiny');
    const dryStub = await runVoice(dir, ['--dry-run', '--voice-id', 'V1', '--json']);
    assert.equal(lastJson(dryStub.stdout).lines[0].cached, false, 'a 4-byte stub is not a cache hit');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
