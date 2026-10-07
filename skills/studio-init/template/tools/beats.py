#!/usr/bin/env python3
"""librosa beat analysis for motion-studio (called by tools/beats.mjs, which decodes the track first).

usage: python beats.py <mono.wav> [bpm_hint|0] [beats_per_bar]
prints one JSON object: {source, librosaVersion, bpm, offset, beatsPerBar, duration, beats, downbeats,
downbeatPhase, phaseScores, hits, warnings}

Written for librosa 1.0 (keyword-only arguments, no audioread, librosa.feature.tempo). Downbeats are found by phase
scoring, not beats[::4]: with a pickup bar beats[::4] lands one beat off.
"""
import json
import sys
import warnings


def downbeat_phase(np, librosa, y, sr, beat_frames, hop, meter):
    """Phase p maximizing mean z(low-band onset) + mean z(beat-synchronous chroma novelty) over beats[p::meter]."""
    if len(beat_frames) < 2 * meter or meter < 2:
        return 0, []
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    # STFT bins below 150 Hz (a mel bank with fmax=150 has empty filters)
    low = S[freqs < 150].sum(axis=0)
    low_on = np.maximum(0.0, np.diff(np.log1p(low), prepend=np.log1p(low[:1])))
    lb = np.array([low_on[max(0, b - 2): b + 3].max() for b in beat_frames])
    chroma = librosa.feature.chroma_stft(S=S ** 2, sr=sr, hop_length=hop)
    # sync returns len(beats)+1 segments: [0,b0), [b0,b1), ... so the segment starting at beat j is segs[:, j+1]
    segs = librosa.util.sync(chroma, beat_frames, aggregate=np.median)
    nov = np.array([np.linalg.norm(segs[:, j + 1] - segs[:, j]) for j in range(len(beat_frames))])

    def z(v):
        return (v - v.mean()) / (v.std() + 1e-9)

    score = z(lb) + z(nov)
    scores = [float(score[p::meter].mean()) for p in range(meter)]
    return int(np.argmax(scores)), [round(s, 3) for s in scores]


def main():
    if len(sys.argv) < 2:
        sys.stderr.write(__doc__)
        return 2
    path = sys.argv[1]
    hint = None
    if len(sys.argv) > 2 and sys.argv[2] not in ("", "0", "none", "null"):
        hint = float(sys.argv[2])
    meter = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    warnings.filterwarnings("ignore", category=FutureWarning)

    import numpy as np
    import soundfile as sf
    import librosa

    y, sr = sf.read(path, dtype="float32", always_2d=True)
    y = np.ascontiguousarray(y.mean(axis=1))
    hop = 512
    out = {
        "source": "librosa",
        "librosaVersion": librosa.__version__,
        "beatsPerBar": meter,
        "duration": round(len(y) / sr, 6),
        "bpm": 0.0,
        "offset": 0.0,
        "beats": [],
        "downbeats": [],
        "downbeatPhase": 0,
        "phaseScores": [],
        "hits": [],
        "warnings": [],
    }
    if len(y) < sr // 2 or float(np.max(np.abs(y))) < 1e-5:
        out["warnings"].append("silent or shorter than 0.5 s: no beats")
        json.dump(out, sys.stdout)
        return 0

    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    if not np.any(onset_env > 0):
        out["warnings"].append("no onsets found")
        json.dump(out, sys.stdout)
        return 0
    start_bpm = hint if hint else 120.0
    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env, sr=sr, hop_length=hop, start_bpm=start_bpm, tightness=100, trim=True, units="frames"
    )
    bpm = float(np.atleast_1d(tempo)[0])
    if not bpm > 0:
        bpm = float(np.atleast_1d(librosa.feature.tempo(onset_envelope=onset_env, sr=sr, hop_length=hop, start_bpm=start_bpm))[0])
    beats = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop)
    if len(beats) >= 8:
        # the tempogram estimate is quantized to whole lags; the beat-time regression is finer
        slope = float(np.polyfit(np.arange(len(beats)), beats, 1)[0])
        if slope > 0 and abs(60.0 / slope - bpm) / bpm < 0.1:
            bpm = 60.0 / slope
    phase, scores = downbeat_phase(np, librosa, y, sr, beat_frames, hop, meter)
    if not scores and len(beats):
        out["warnings"].append("too few beats for downbeat detection: assuming the first beat is a downbeat")
    peaks = librosa.util.peak_pick(onset_env, pre_max=3, post_max=3, pre_avg=3, post_avg=5, delta=0.5, wait=10)
    hits = librosa.frames_to_time(peaks, sr=sr, hop_length=hop)

    beat_list = [round(float(t), 4) for t in beats]
    downbeats = beat_list[phase::meter]
    out.update(
        bpm=round(bpm, 3),
        beats=beat_list,
        downbeats=downbeats,
        downbeatPhase=phase,
        phaseScores=scores,
        offset=downbeats[0] if downbeats else (beat_list[0] if beat_list else 0.0),
        hits=[round(float(t), 4) for t in hits],
    )
    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
