#!/usr/bin/env node
// tools/voice.mjs — ElevenLabs text-to-speech lines placed on the film timeline → audio/voice.wav (48 kHz stereo,
// exactly the film length). The key is read from the environment or .env (ELEVENLABS_API_KEY) and never printed.
// Each rendered line is cached by the sha256 of (text, voice, model, format), so re-runs cost nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, usage, main, loadConfig, projectRoot, loadEnv, readJSON, sha256, writeFileAtomic, log, fmtTime, UsageError } from './studio.mjs';
import { SR, makeBuffer, addAt, writeWav, limiter, decodeAudio } from './audio.mjs';

const API = 'https://api.elevenlabs.io/v1/text-to-speech';
const OUTPUT_FORMAT = 'mp3_44100_128';
const CHARS_PER_SEC = 15; // rough speaking rate, only for the dry-run estimate
const TIMEOUT_MS = 120000; // per attempt: request and body together
const MIN_MP3_BYTES = 100;

export function readScript(file) {
  const j = readJSON(file);
  const lines = Array.isArray(j) ? j : j && Array.isArray(j.lines) ? j.lines : null;
  if (!lines) throw new Error(`${file}: expected [{ "t": 1.5, "text": "Hello", "voiceId"?: "..." }, ...] or { "lines": [...] }`);
  return lines.map((l, i) => {
    const t = Number(l?.t);
    if (!Number.isFinite(t) || t < 0) throw new Error(`${file}: line #${i} needs "t" (seconds, ≥ 0)`);
    if (typeof l.text !== 'string' || !l.text.trim()) throw new Error(`${file}: line #${i} needs non-empty "text"`);
    return { i, t, text: l.text.trim(), voiceId: l.voiceId ?? null };
  }).sort((a, b) => a.t - b.t || a.i - b.i);
}

export const cacheKey = ({ text, voiceId, model }) => sha256(JSON.stringify({ text, voiceId, model, format: OUTPUT_FORMAT }));

// A cache file counts only when it can hold audio: a truncated or empty file is synthesized again.
const isCached = (file) => { try { return fs.statSync(file).size >= MIN_MP3_BYTES; } catch { return false; } };

/** Why a request failed. fetch() puts the reason in err.cause (ENOTFOUND, ECONNRESET, TLS verification); err.message is only "fetch failed". */
export function describeError(err, timeoutMs = TIMEOUT_MS) {
  if (err?.name === 'AbortError') return `timed out after ${timeoutMs / 1000} s`;
  let msg = String(err?.message ?? err);
  let cause = err?.cause;
  if (cause && Array.isArray(cause.errors) && cause.errors.length && !cause.message) cause = cause.errors[0]; // AggregateError: every address refused
  if (cause) {
    const code = cause.code ? String(cause.code) : '';
    const text = cause.message ? String(cause.message) : '';
    const detail = code && text && !text.includes(code) ? `${code}: ${text}` : text || code;
    if (detail && !msg.includes(detail)) msg += ` (${detail})`;
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ISSUER/.test(code)) msg += ' - a TLS-inspecting proxy? Set NODE_EXTRA_CA_CERTS to its root certificate file';
  }
  return msg;
}

/** MP3 data has an ID3 tag or a frame-sync word (0xFF 0xEx/0xFx) near the start; an HTML or JSON error page never contains a 0xFF byte. */
export function looksLikeMp3(buf) {
  if (buf.length >= 3 && buf.toString('latin1', 0, 3) === 'ID3') return true;
  const end = Math.min(buf.length - 1, 4096);
  for (let i = 0; i < end; i++) if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) return true;
  return false;
}

/**
 * One text-to-speech request → the MP3 bytes. The body is read inside the timeout and the retry loop (3 attempts on
 * network errors, 429 and 5xx). A 200 that is not audio (captive portal, proxy page) is an error and is never cached.
 * `fetchImpl`, `sleep` and `timeoutMs` are injectable for tests.
 */
export async function synthesize({ key, voiceId, model, text }, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = TIMEOUT_MS } = {}) {
  const url = `${API}/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`;
  for (let attempt = 1; ; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    let buf;
    try {
      res = await fetchImpl(url, { method: 'POST', signal: ctl.signal, headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, body: JSON.stringify({ text, model_id: model }) });
      buf = Buffer.from(res.ok ? await res.arrayBuffer() : await res.arrayBuffer().catch(() => new ArrayBuffer(0))); // an error body only feeds the message
    } catch (err) {
      if (attempt < 3) { log(`voice: request failed (${describeError(err, timeoutMs)}) - retrying`); await sleep(1500 * attempt); continue; }
      throw new Error(`ElevenLabs request failed: ${describeError(err, timeoutMs)}`);
    } finally { clearTimeout(timer); }
    if (res.ok) {
      const type = String(res.headers?.get?.('content-type') ?? '');
      if (type && !/^(audio\/|application\/octet-stream|binary\/)/i.test(type)) {
        const peek = buf.toString('utf8', 0, 120).replace(/\s+/g, ' ').trim();
        throw new Error(`ElevenLabs answered 200 with ${type} instead of audio${peek ? ` ("${peek}")` : ''}: a proxy or captive portal in the way? Nothing was cached.`);
      }
      return buf;
    }
    const body = buf.toString('utf8');
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(2000 * attempt); continue; }
    let msg = body.slice(0, 300);
    try { const j = JSON.parse(body); msg = j?.detail?.message ?? j?.detail?.status ?? (typeof j?.detail === 'string' ? j.detail : msg); } catch { /* plain-text error */ }
    const hint = res.status === 401 ? ' (check ELEVENLABS_API_KEY)' : res.status === 404 ? ' (unknown voice id?)' : res.status === 422 ? ' (bad request: model id or text?)' : '';
    throw new Error(`ElevenLabs ${res.status}${hint}: ${msg}`);
  }
}

const SPEC = {
  script: { type: 'string', default: 'audio/voice.json', desc: 'voice lines [{ t, text, voiceId? }]' },
  'dry-run': { type: 'boolean', desc: 'print the plan and character count; no network, no key needed' },
  'voice-id': { type: 'string', desc: 'default ElevenLabs voice id (else studio.json audio.voiceId or ELEVENLABS_VOICE_ID)' },
  model: { type: 'string', default: 'eleven_multilingual_v2', desc: 'ElevenLabs model id' },
  out: { type: 'string', default: 'audio/voice.wav', desc: 'output WAV (film length, 48 kHz stereo)' },
  json: { type: 'boolean', desc: 'print one JSON result line on stdout' },
};

async function cli() {
  const title = 'node tools/voice.mjs [--script audio/voice.json] [--dry-run] [--voice-id ID] [--model eleven_multilingual_v2] [--out audio/voice.wav] [--json]';
  const extra = 'Key: ELEVENLABS_API_KEY in the environment or .env (see .env.example). Never paste the key into a prompt.\n' +
    'Characters are billed by ElevenLabs; cached lines (audio/.cache/voice-<sha>.mp3) are free. Then set studio.json\n' +
    'audio.voice to the output path so mix.mjs includes it and ducks the music under it.';
  const { flags, positionals } = parseArgs(process.argv.slice(2), SPEC);
  if (flags.help) { process.stdout.write(usage(title, SPEC, extra)); return 0; }
  if (positionals.length) throw new UsageError(`unexpected argument "${positionals[0]}"`, usage(title, SPEC, extra));
  const root = projectRoot();
  const cfg = loadConfig(root);
  const env = loadEnv(root);
  const rel = (p) => path.relative(root, p).replace(/\\/g, '/');
  const scriptPath = path.resolve(root, flags.script);
  if (!fs.existsSync(scriptPath)) throw new Error(`${rel(scriptPath)} not found. Create it, e.g. [{ "t": 0.5, "text": "Meet the new dashboard." }]`);
  const model = flags.model;
  const fallbackVoice = flags['voice-id'] || cfg.audio.voiceId || process.env.ELEVENLABS_VOICE_ID || env.ELEVENLABS_VOICE_ID || null;
  const lines = readScript(scriptPath).map((l) => {
    const voiceId = l.voiceId || fallbackVoice;
    const cache = voiceId ? path.join(root, 'audio', '.cache', `voice-${cacheKey({ text: l.text, voiceId, model })}.mp3`) : null;
    return { ...l, voiceId, cache, cached: !!cache && isCached(cache), repeatOf: undefined };
  });
  // Lines with the same text, voice and model share one cache file: the first occurrence pays, the others reuse it.
  const firstOf = new Map();
  for (const l of lines) {
    if (!l.cache) continue;
    if (firstOf.has(l.cache)) l.repeatOf = firstOf.get(l.cache); else firstOf.set(l.cache, l.i);
  }
  const duration = cfg.duration;
  const chars = lines.reduce((s, l) => s + l.text.length, 0);
  const billable = lines.filter((l) => !l.cached && l.repeatOf === undefined).reduce((s, l) => s + l.text.length, 0);
  const missingVoice = lines.filter((l) => !l.voiceId);
  const warnings = [];
  for (const l of lines) {
    if (l.t >= duration) warnings.push(`line #${l.i} starts at ${fmtTime(l.t)}, after the film ends (${fmtTime(duration)})`);
    else if (l.t + l.text.length / CHARS_PER_SEC > duration) warnings.push(`line #${l.i} may run past the end (~${(l.text.length / CHARS_PER_SEC).toFixed(1)} s from ${fmtTime(l.t)})`);
    if (l.text.length > 5000) warnings.push(`line #${l.i} has ${l.text.length} characters; split it (ElevenLabs request limit)`);
  }
  if (flags['dry-run']) {
    for (const l of lines) log(`  #${String(l.i).padEnd(3)} ${fmtTime(l.t)}  ${String(l.text.length).padStart(5)} ch  ${(l.voiceId ?? '(no voice id)').padEnd(22)} ${l.cached ? 'cached' : l.repeatOf !== undefined ? 'repeat' : 'new   '}  ${l.text.length > 60 ? l.text.slice(0, 57) + '…' : l.text}`);
    log(`voice (dry run): ${lines.length} line(s) · ${chars} characters · ${billable} to synthesize with ${model} · output ${rel(path.resolve(root, flags.out))} (${duration} s)`);
    for (const w of warnings) log(`voice: warning: ${w}`);
    if (missingVoice.length) log(`voice: warning: ${missingVoice.length} line(s) have no voice id — pass --voice-id, set studio.json audio.voiceId or ELEVENLABS_VOICE_ID`);
    const hasKey = !!(process.env.ELEVENLABS_API_KEY || env.ELEVENLABS_API_KEY);
    log(`voice: ELEVENLABS_API_KEY is ${hasKey ? 'present' : 'absent'}`);
    if (flags.json) {
      process.stdout.write(JSON.stringify({ dryRun: true, model, lines: lines.map(({ i, t, text, voiceId, cached, repeatOf }) => ({ i, t, chars: text.length, voiceId, cached, ...(repeatOf !== undefined ? { repeatOf } : {}) })),
        chars, billableChars: billable, keyPresent: hasKey, out: rel(path.resolve(root, flags.out)), duration, warnings }) + '\n');
    }
    return 0;
  }
  if (missingVoice.length) throw new UsageError(`no voice id for line(s) ${missingVoice.map((l) => `#${l.i}`).join(', ')} — pass --voice-id ID, set "voiceId" per line, studio.json audio.voiceId, or ELEVENLABS_VOICE_ID`);
  const key = process.env.ELEVENLABS_API_KEY || env.ELEVENLABS_API_KEY;
  if (lines.some((l) => !l.cached) && !key) {
    throw new Error('ELEVENLABS_API_KEY is not set. Add it to .env in the film project (see .env.example) or export it in your shell;\n' +
      'never paste the key into chat. Preview the plan without a key: node tools/voice.mjs --dry-run');
  }
  for (const l of lines) {
    if (l.cached || l.repeatOf !== undefined) continue; // a repeat reads the file its first occurrence writes
    log(`voice: synthesizing #${l.i} (${l.text.length} ch, ${l.voiceId})…`);
    const mp3 = await synthesize({ key, voiceId: l.voiceId, model, text: l.text });
    if (mp3.length < MIN_MP3_BYTES) throw new Error(`ElevenLabs returned ${mp3.length} bytes for line #${l.i}`);
    writeFileAtomic(l.cache, mp3);
  }
  const bus = makeBuffer(duration, 2, SR);
  let lastEnd = -Infinity;
  for (const l of lines) {
    let channels;
    try { ({ channels } = await decodeAudio(root, l.cache, { sr: SR, channels: 2 })); } catch (err) {
      // A cached file that is not MP3 data (an older run cached a proxy page) would fail on every run: drop it. A
      // plausible MP3 that fails to decode is kept: it was paid for and the cause lies elsewhere (ffmpeg, disk).
      if (/^ffmpeg could not decode/.test(err.message) && !looksLikeMp3(fs.readFileSync(l.cache))) {
        fs.rmSync(l.cache, { force: true });
        throw new Error(`line #${l.i}: ${rel(l.cache)} is not audio (a proxy or captive portal answered instead of ElevenLabs?) - deleted it; run voice.mjs again to synthesize the line`);
      }
      throw err;
    }
    const len = channels[0].length / SR;
    if (l.t < lastEnd - 0.01) warnings.push(`line #${l.i} at ${fmtTime(l.t)} overlaps the previous line (ends ${fmtTime(lastEnd)})`);
    if (l.t + len > duration) warnings.push(`line #${l.i} is cut at the film end (${len.toFixed(2)} s from ${fmtTime(l.t)})`);
    lastEnd = Math.max(lastEnd, l.t + len);
    addAt(bus, channels, l.t, { sr: SR });
  }
  limiter(bus, { ceilingDb: -1, truePeak: true, sr: SR });
  const out = path.resolve(root, flags.out);
  writeWav(out, bus, SR, { bits: 16 });
  for (const w of warnings) log(`voice: warning: ${w}`);
  log(`voice: ${lines.length} line(s) · ${chars} characters (${billable} synthesized now) → ${rel(out)} (${duration} s)`);
  if (cfg.audio.voice !== rel(out)) log(`voice: set studio.json "audio": { "voice": "${rel(out)}" } so mix.mjs includes it (music ducks under the voice)`);
  if (flags.json) process.stdout.write(JSON.stringify({ out: rel(out), lines: lines.length, chars, synthesizedChars: billable, duration, warnings }) + '\n');
  return 0;
}

const isMain = () => {
  try {
    const x = fs.realpathSync.native(process.argv[1] ?? '');
    const y = fs.realpathSync.native(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
  } catch { return false; }
};
if (isMain()) main(cli);
