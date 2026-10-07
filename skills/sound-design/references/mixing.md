# Mixing and loudness

`tools/mix.mjs` turns the stems into one master (`out/score.wav`) and muxes it into every rendered format. This page
explains what it does, so you can read its report and fix a mix that misses the targets.

## Targets (studio.json `audio`)

| Key | Default | Meaning |
|---|---|---|
| `lufs` | -14 | integrated loudness target (EBU R128 / ITU-R BS.1770 measurement); `mix.mjs` accepts -70 to -5 (loudnorm's own limit) and stops with a usage error that names `audio.lufs` or `--lufs` outside it |
| `lufsTolerance` | 0.5 | pass band: -14.5 to -13.5 LUFS |
| `truePeak` | -1 | ceiling in dBTP, measured with 4x oversampling (`ebur128=peak=true`); -20 to 0 works. loudnorm itself cannot go below -9, so a lower ceiling skips the linear pass and the oversampled limiter enforces it |
| `musicGainDb` / `sfxGainDb` / `voiceGainDb` | -2 / 0 / 0 | stem levels before the sum |
| `duck` | true | music ducks under the voice (sidechain compression) when a voice stem exists |
| `music` / `sfx` / `voice` | `audio/music.wav` / `audio/sfx.wav` / null | stem paths; null or `"none"` skips the stem |
| `master` | `out/score.wav` | the normalized master |

-14 LUFS with at most -1 dBTP is the course's target and a common one for social video. Change it in `studio.json`,
not in code, if a platform or client asks for another number.

## What mix.mjs does

1. Length: exactly `frames / fps` from `out/<primaryFormat>/render.json` (studio `duration` if there is no render yet).
   Every stem is first decoded once (48 kHz stereo) and measured: decoded duration and peak. A music, voice or sfx stem
   shorter than the film by more than 0.25 s, empty, or with a peak below -80 dBFS stops the mix before anything is
   written (`--allow-short-stems` turns that into a warning and mixes the silence). A silent sfx stem only warns, and a
   stem longer than the film warns that its end is cut with no fade. Then every stem is padded or trimmed to the
   exact length (`apad,atrim=end=<len>`).
2. Sum: per-stem `volume`, optional `sidechaincompress` (music keyed by voice), then
   `amix=inputs=n:normalize=0:duration=longest`. `normalize=0` matters: the default scales every input down.
3. Loudness, pass 1: `loudnorm=I=-14:TP=-1:LRA=11:print_format=json` measures the sum. The JSON is the last `{...}`
   block on stderr.
4. Loudness, pass 2: the same filter with `measured_I`, `measured_TP`, `measured_LRA`, `measured_thresh`, `offset`
   and `linear=true`, followed by `aresample=48000`. The master is measured again with `ebur128=peak=true`.
5. The linear result is kept only when it stayed linear, its true peak is at or under the ceiling and its loudness
   is within half the tolerance of the target (`|I - lufs| <= lufsTolerance / 2`, so +-0.25 LU by default).
   Peaky material (a music-only stem, click-heavy SFX) has its linear gain capped by the true-peak budget and lands
   short, for example at -14.4, which would leave no margin for the AAC encode. Anything else takes the fallback:
   `aresample=192000,volume=<G>dB,alimiter=limit=<10^((tp-0.5)/20)>:attack=1:release=50:level=false:latency=true,aresample=48000`,
   re-measured and re-gained (up to 8 attempts, bracketing the target) until the master sits within +-0.1 LU with the
   true peak under the ceiling; a true-peak overshoot lowers the limiter ceiling. `method` in the JSON report says
   which path won: `loudnorm-linear`, `alimiter` or `silent` (no audio above -70 LUFS).
6. Write `out/score.wav`, then mux into each format: `-map 0:v:0 -map 1:a:0 -c:v copy -af apad=whole_dur=<len> -c:a aac
   -b:a 256k -ar 48000 -t <len> -movflags +faststart` into `out/<fmt>/final.mp4`. Never `-shortest`.
7. Measure the muxed AAC again and report integrated loudness and true peak; warn if the true peak exceeds the target.
8. Copy the primary format's `final.mp4` to `out/final.mp4` and its poster to `out/poster.png`. If a player holds
   `out/final.mp4` open the copy is retried briefly, then skipped with a warning (`out/final.mp4 is open in another
   program ... the finished file is out/<fmt>/final.mp4`) and the JSON `final` names the per-format file. The temp folder
   `out/.mix` is removed on every exit path.
9. No stems at all: mux a silent AAC track of the exact length and warn.
10. A premix that integrates above about -1 LUFS (gains stacked too hot) is scaled to -20 LUFS in a float copy before
   loudnorm and re-measured; the report warns and carries `preAttenuationDb`. `gainDb` stays relative to the original
   premix. Lower `musicGainDb`, `sfxGainDb` or `voiceGainDb` instead.

## Why each step exists

| Step | Failure it prevents |
|---|---|
| exact length + `-t` | `-shortest` with `-c:v copy` left audio at 2.986 s against 3.000 s of video |
| `normalize=0` | `amix` default scales every input by 1/n, so levels drift with the stem count |
| linear pass 2 | dynamic loudnorm changes the sound (it compresses) and outputs 192 kHz |
| fallback chain | loudnorm falls back to dynamic when the source LRA is 0 (a steady synth), when the source is shorter than 3 s, or when the gain would push peaks over the ceiling; on click-heavy SFX it stopped at -17.2 LUFS against a -14 target. The half-tolerance rule sends a linear master that lands at the edge of the window (-14.4) to the limiter path as well |
| `level=false:latency=true` on `alimiter` | the defaults re-level the output and delay it by the lookahead |
| 192 kHz around the limiter | true-peak control needs oversampling; sample peaks under-read inter-sample peaks |
| post-AAC measure | AAC encoding can add inter-sample overshoot (upstream reports about +1.5 dB); the WAV can pass while the MP4 fails |
| `aresample=48000` last | every stage after loudnorm must end at the delivery rate |

## Reading the report

`node tools/mix.mjs --json` prints one JSON line; the stderr log shows per-format integrated loudness (I) and true
peak (TP) measured on `final.mp4`. `npm run deliver` repeats the measurement and fails outside the targets.

| Report says | Cause | Fix |
|---|---|---|
| I below -14.5 after the fallback | very peaky material: the limiter ceiling caps the gain | lower `sfxGainDb` a few dB, soften click/hit transients, or add a sustained music bed |
| TP above -1 dBTP on `final.mp4` but not on `score.wav` | AAC overshoot | re-run with `--tp -1.5` (keeps the master 0.5 dB lower) |
| voice buried | music too loud under speech | keep `duck: true`, lower `musicGainDb` to -4 to -6 |
| music pumping | ducking on dense speech | lower `musicGainDb` instead and set `duck: false` |
| SFX masked by music | hits and music share the same band | move the SFX pitch up (`pitch` per cue) or cut `musicGainDb` |
| audio length warning | no `out/<primary>/render.json` yet (range renders do not write one) | run the full render first (`npm run render` or `npm run render:final`) |
| `refusing to mix: ... stem problem(s) do not fit the N s film` | a stem is shorter than the film by over 0.25 s, empty or silent, usually a `music.wav` or `voice.wav` from an earlier duration | regenerate it (`npm run score`, `npm run sfx`, `npm run voice`); `--allow-short-stems` only for a stem that is meant to be short |
| critique `--video` lists a P1 `audio-gap`, or `deliver` fails `silence` (`silence 2.2 s at 00:02.1`) | the mix is silent for 1 s or more below -50 dB (not counting an intro that starts in the first 0.3 s or a fade-out in the last 1.0 s): a stem ends early or a bed plays under nothing, and loudness still reads -14 LUFS | regenerate the stem (`npm run score`, `npm run sfx`, `npm run voice`) and mix again; an intended silence goes in `studio.json` `critique.allowSilence: [[from, to], ...]`, but this build's config validation rejects that key (CHANGELOG), so fix the stem |
| `out/final.mp4 is open in another program` warning | a player holds the copy of the primary format | close the player and mix again, or use `out/<fmt>/final.mp4` |
| `cannot replace <path>: open in another program` error | a player holds `out/score.wav` or `out/<fmt>/final.mp4` | close it and mix again |
| `master misses the target` warning at a low `--tp` | very peaky material cannot reach -14 LUFS under a ceiling such as -12 dBTP | raise the ceiling or soften the transients |

## Flags

| Flag | Effect |
|---|---|
| `--format f\|all` | which formats to mux (default: `primaryFormat`; `npm run mix` passes `all`); only formats with `out/<fmt>/silent.mp4` are muxed |
| `--music P\|none`, `--sfx P\|none`, `--voice P\|none` | override stem paths for one run |
| `--lufs -14`, `--tp -1` | override targets for one run (`--lufs` -70 to -5, `--tp` -20 to 0) |
| `--no-duck` | no sidechain ducking |
| `--allow-short-stems` | mix a short, empty or silent stem anyway (warns; the missing part is silence) |
| `--json` | one JSON result line on stdout |

## Checking without a player

Claude cannot listen, so it checks numbers and alignment:
- `node tools/critique.mjs --format 9x16 --video out/9x16/final.mp4` reports integrated LUFS, true peak, duration, frames and
  every silent span of 1 s or more (in `out/review/9x16/video/metrics.md`; the live pass keeps its own files).
- `metrics.md` `sync` lists cues more than 25 ms from a beat; each one should be an intentional hit.
- Ask the user to listen to `out/final.mp4` once before delivery, and log what they report as problems in the next
  critique round.
