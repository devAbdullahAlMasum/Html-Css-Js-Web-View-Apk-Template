#!/usr/bin/env python3
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BAND = [(39, 30), (69, 30), (69, 36), (75, 36), (75, 42), (81, 42), (81, 66), (75, 66), (75, 48), (69, 48), (69, 42), (63, 42), (63, 36), (45, 36), (45, 42), (39, 42), (39, 48), (33, 48), (33, 66), (27, 66), (27, 42), (33, 42), (33, 36), (39, 36)]


def inside(x, y, polygon):
    hit = False
    previous = polygon[-1]
    for current in polygon:
        ax, ay = previous
        bx, by = current
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            hit = not hit
        previous = current
    return hit


def pixel(x, y):
    color = (21, 19, 27)
    if inside(x, y, BAND):
        color = (204, 236, 165)
    if 54 <= y < 72 and (33 <= x < 45 or 63 <= x < 75):
        color = (255, 163, 135)
    if (51 <= x < 57 and 48 <= y < 66) or (45 <= x < 63 and 54 <= y < 60):
        color = (201, 181, 239)
    return bytes((*color, 255))


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)


for density, size in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)]:
    raw = b"".join(b"\x00" + b"".join(pixel((x + 0.5) * 108 / size, (y + 0.5) * 108 / size) for x in range(size)) for y in range(size))
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    folder = ROOT / "res" / ("mipmap-" + density)
    folder.mkdir(parents=True, exist_ok=True)
    for name in ["ic_launcher.png", "ic_launcher_round.png"]:
        (folder / name).write_bytes(png)
    print(f"Generated Orbit icon: {density} ({size}px)")
