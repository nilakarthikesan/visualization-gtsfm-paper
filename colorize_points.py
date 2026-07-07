#!/usr/bin/env python3
"""Bake real photo colors into COLMAP points3D.txt files.

The Brussels exports (C_1/C_2/C_3 and the root merged model) were written with
R G B = 0 0 0 for every 3D point. The color information lives in the source
photographs: each point's TRACK[] lists (IMAGE_ID, POINT2D_IDX) observations,
and images.txt gives the 2D pixel coordinates of each observation. This script
samples the photo pixel at every observation and writes the mean color back
into points3D.txt (the same approach COLMAP uses for its colored exports).

Usage:
    python3 colorize_points.py --images <photo_dir> <reconstruction_dir> [more dirs...]
    python3 colorize_points.py --images <photo_dir> --recursive <dataset_root>

    <photo_dir>            folder containing image_000000.jpg etc.
    <reconstruction_dir>   folder containing images.txt + points3D.txt
    --recursive            colorize every folder under <dataset_root> that has
                           both images.txt and points3D.txt
    --dry-run              report coverage without writing anything

A backup of each points3D.txt is written alongside as points3D.txt.bak
(first run only; reruns keep the original backup).

Requires: pip install pillow numpy
"""

import argparse
import os
import shutil
import sys

import numpy as np
from PIL import Image


def parse_images_txt(path):
    """Returns {image_id: (name, keypoints ndarray of shape (N,2))}."""
    images = {}
    with open(path) as f:
        lines = [l.rstrip('\n') for l in f if not l.startswith('#')]
    # images.txt alternates: header line, then points2D line
    i = 0
    while i + 1 < len(lines):
        header = lines[i].split()
        if len(header) < 10:
            i += 1
            continue
        image_id = int(header[0])
        name = header[9]
        pts_parts = lines[i + 1].split()
        n = len(pts_parts) // 3
        kps = np.empty((n, 2), dtype=np.float64)
        for k in range(n):
            kps[k, 0] = float(pts_parts[k * 3])
            kps[k, 1] = float(pts_parts[k * 3 + 1])
        images[image_id] = (name, kps)
        i += 2
    return images


def load_photos(photo_dir, needed_names):
    """Returns {name: ndarray HxWx3 uint8} for every needed photo found."""
    photos = {}
    for name in sorted(needed_names):
        p = os.path.join(photo_dir, name)
        if not os.path.isfile(p):
            # some pipelines strip subdirectories from names
            p = os.path.join(photo_dir, os.path.basename(name))
        if not os.path.isfile(p):
            continue
        with Image.open(p) as im:
            photos[name] = np.asarray(im.convert('RGB'))
    return photos


def colorize_dir(recon_dir, photo_dir, dry_run=False):
    images_txt = os.path.join(recon_dir, 'images.txt')
    points_txt = os.path.join(recon_dir, 'points3D.txt')
    if not (os.path.isfile(images_txt) and os.path.isfile(points_txt)):
        return None

    images = parse_images_txt(images_txt)
    needed = {name for name, _ in images.values()}
    photos = load_photos(photo_dir, needed)
    missing = needed - set(photos)

    out_lines = []
    total = colored = 0
    with open(points_txt) as f:
        for line in f:
            if line.startswith('#'):
                out_lines.append(line)
                continue
            parts = line.split()
            if len(parts) < 8:
                out_lines.append(line)
                continue
            total += 1
            rs, gs, bs = [], [], []
            # TRACK[] = pairs of (IMAGE_ID, POINT2D_IDX) starting at index 8
            for t in range(8, len(parts) - 1, 2):
                img_id = int(parts[t])
                p2d_idx = int(parts[t + 1])
                entry = images.get(img_id)
                if entry is None:
                    continue
                name, kps = entry
                photo = photos.get(name)
                if photo is None or p2d_idx >= len(kps):
                    continue
                x, y = kps[p2d_idx]
                h, w = photo.shape[:2]
                xi = min(max(int(round(x)), 0), w - 1)
                yi = min(max(int(round(y)), 0), h - 1)
                px = photo[yi, xi]
                rs.append(int(px[0])); gs.append(int(px[1])); bs.append(int(px[2]))
            if rs:
                colored += 1
                parts[4] = str(int(round(sum(rs) / len(rs))))
                parts[5] = str(int(round(sum(gs) / len(gs))))
                parts[6] = str(int(round(sum(bs) / len(bs))))
            out_lines.append(' '.join(parts) + '\n')

    pct = 100.0 * colored / total if total else 0.0
    tag = 'DRY RUN ' if dry_run else ''
    print(f"{tag}{recon_dir}: {colored}/{total} points colored ({pct:.1f}%), "
          f"{len(photos)}/{len(needed)} photos found"
          + (f", missing e.g. {sorted(missing)[:3]}" if missing else ''))

    if not dry_run and colored:
        bak = points_txt + '.bak'
        if not os.path.isfile(bak):
            shutil.copy2(points_txt, bak)
        with open(points_txt, 'w') as f:
            f.writelines(out_lines)
    return colored, total


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--images', required=True, help='folder with source photos')
    ap.add_argument('--recursive', action='store_true',
                    help='walk the given roots for images.txt/points3D.txt pairs')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('roots', nargs='+')
    args = ap.parse_args()

    targets = []
    for root in args.roots:
        if args.recursive:
            for dirpath, dirnames, filenames in os.walk(root):
                if 'images.txt' in filenames and 'points3D.txt' in filenames:
                    targets.append(dirpath)
        else:
            targets.append(root)

    if not targets:
        print('No reconstruction folders found.')
        sys.exit(1)

    for t in sorted(targets):
        colorize_dir(t, args.images, dry_run=args.dry_run)


if __name__ == '__main__':
    main()
