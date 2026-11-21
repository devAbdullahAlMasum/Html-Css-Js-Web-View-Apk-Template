#!/usr/bin/env python3
import array
import math
import random
import wave
from pathlib import Path

RATE = 16000
SECONDS = 24
ROOT = Path(__file__).resolve().parents[1] / "app" / "assets"


def frequency(note):
    return 440 * 2 ** ((note - 69) / 12)


def make_loop(name, chords, melody, seed):
    samples = array.array("f", [0]) * (RATE * SECONDS)
    rng = random.Random(seed)

    def tone(note, start, duration, gain, soft=False):
        begin = int(start * RATE)
        count = min(int(duration * RATE), len(samples) - begin)
        hz = frequency(note)
        for i in range(count):
            t = i / RATE
            envelope = min(t / 0.025, 1) * min((duration - t) / 0.15, 1)
            if not soft:
                envelope *= math.exp(-t * 2.5)
            phase = 2 * math.pi * hz * t
            value = math.sin(phase) + 0.18 * math.sin(phase * 2) + 0.05 * math.sin(phase * 3)
            samples[begin + i] += value * envelope * gain

    def drum(start, kind):
        begin = int(start * RATE)
        duration = 0.18 if kind == "kick" else 0.10
        for i in range(min(int(duration * RATE), len(samples) - begin)):
            t = i / RATE
            if kind == "kick":
                value = math.sin(2 * math.pi * (58 * t + 1.6 * (1 - math.exp(-t * 35))))
                value *= 0.20 * math.exp(-t * 24)
            else:
                value = (rng.random() * 2 - 1) * math.exp(-t * (70 if kind == "hat" else 36))
                value *= 0.025 if kind == "hat" else 0.065
            samples[begin + i] += value

    beat = 0.75
    for bar in range(8):
        chord = chords[bar % len(chords)]
        start = bar * 4 * beat
        for note in chord:
            tone(note, start, 2.95, 0.04, soft=True)
        for step in range(4):
            tone(chord[0] - 12, start + step * beat, 0.6, 0.075)
            note = melody[(bar * 4 + step) % len(melody)]
            tone(note, start + step * beat + 0.04, 0.68, 0.09)
            drum(start + step * beat, "kick" if step % 2 == 0 else "snare")
            drum(start + step * beat + beat / 2, "hat")
    delay = int(RATE * 0.375)
    for i in range(len(samples) - 1, delay - 1, -1):
        samples[i] += samples[i - delay] * 0.12
    peak = max(abs(value) for value in samples) or 1
    pcm = array.array("h")
    for i, value in enumerate(samples):
        fade = min(i / (RATE * 0.025), (len(samples) - 1 - i) / (RATE * 0.05), 1)
        pcm.append(int(value / peak * 23000 * max(fade, 0)))
    ROOT.mkdir(parents=True, exist_ok=True)
    with wave.open(str(ROOT / (name + ".wav")), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(pcm.tobytes())
    print(f"Generated original loop: {name}.wav ({SECONDS}s)")


if __name__ == "__main__":
    make_loop("moon", [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], [72, 76, 79, 76, 69, 72, 76, 72], 7)
    make_loop("peach", [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]], [76, 79, 81, 79, 76, 72, 74, 76], 11)
    make_loop("cloud", [[50, 53, 57], [58, 62, 65], [53, 57, 60], [48, 52, 55]], [77, 76, 74, 69, 72, 74, 77, 74], 17)
    make_loop("after", [[52, 55, 59], [48, 52, 55], [57, 60, 64], [59, 62, 66]], [71, 74, 78, 74, 72, 71, 67, 71], 23)
