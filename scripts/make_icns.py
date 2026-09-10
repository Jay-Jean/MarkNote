#!/usr/bin/env python3
"""Build a small PNG-backed macOS ICNS file without third-party packages."""

from pathlib import Path
import struct
import sys


def build_icns(iconset: Path, output: Path) -> None:
    entries = [
        ("icp4", "icon_16x16.png"),
        ("icp5", "icon_32x32.png"),
        ("ic07", "icon_128x128.png"),
        ("ic08", "icon_256x256.png"),
        ("ic09", "icon_512x512.png"),
        ("ic10", "icon_512x512@2x.png"),
    ]
    payload = bytearray()
    for kind, filename in entries:
        image = (iconset / filename).read_bytes()
        payload.extend(kind.encode("ascii"))
        payload.extend(struct.pack(">I", len(image) + 8))
        payload.extend(image)
    output.write_bytes(b"icns" + struct.pack(">I", len(payload) + 8) + payload)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: make_icns.py ICONSET OUTPUT")
    build_icns(Path(sys.argv[1]), Path(sys.argv[2]))
