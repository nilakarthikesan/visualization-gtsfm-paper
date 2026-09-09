#!/usr/bin/env python3
"""
Strip COLMAP images.txt 2D-track lines for the web build.

Both viz parsers (frustum-engine.js loadClusterCameras, data-loader-vggt.js camera
extrinsics) read a pose line (>=10 whitespace fields: IMAGE_ID QW QX QY QZ TX TY TZ
CAMERA_ID NAME) and then do `i++` to SKIP the following POINTS2D line. The viz never
uses the 2D tracks, but that skip means the track line must still EXIST or the parser
would eat the next pose. So we replace every track line with an empty line: same line
pairing, ~all the bytes gone. Comments (#...) and blank lines are preserved as-is.
"""
import os
import sys

def strip_file(path):
    with open(path, 'r') as f:
        lines = f.read().split('\n')
    out = []
    i = 0
    n = len(lines)
    while i < n:
        raw = lines[i]
        s = raw.strip()
        if s.startswith('#') or s == '':
            out.append(raw)
            i += 1
            continue
        parts = s.split()
        if len(parts) >= 10:
            # pose line -> keep; blank the following track line (mirror parser i++)
            out.append(raw)
            if i + 1 < n:
                out.append('')  # blanked POINTS2D
            i += 2
        else:
            # not a pose line (shouldn't happen in COLMAP output); keep, advance 1
            out.append(raw)
            i += 1
    with open(path, 'w') as f:
        f.write('\n'.join(out))

def main(root):
    total_before = 0
    total_after = 0
    count = 0
    for dirpath, _, filenames in os.walk(root):
        # skip datasets excluded from the web build
        if '/C_4' in dirpath or 'merged_retriangulated' in dirpath:
            continue
        for name in filenames:
            if name != 'images.txt':
                continue
            p = os.path.join(dirpath, name)
            before = os.path.getsize(p)
            strip_file(p)
            after = os.path.getsize(p)
            total_before += before
            total_after += after
            count += 1
    mb = 1024 * 1024
    print(f"stripped {count} images.txt files")
    print(f"before: {total_before/mb:.1f}MB  after: {total_after/mb:.1f}MB  saved: {(total_before-total_after)/mb:.1f}MB")

if __name__ == '__main__':
    root = sys.argv[1] if len(sys.argv) > 1 else 'data/gerrard-hall-vggt-v2'
    main(root)
