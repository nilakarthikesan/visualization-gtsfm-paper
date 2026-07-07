#!/usr/bin/env python3
"""Generate a structure.json manifest for a VGGT partition tree.

Walks a dataset root (e.g. data/gerrard-hall-vggt-v2/C_1) whose folders follow the
GTSFM recursive partition layout:

    <node>/vggt/points3D.txt       leaf reconstruction (COLMAP text)
    <node>/merged/points3D.txt     merged result of the node's children
    <node>/metrics/*.json          merge / reconstruction metrics
    <node>/C_x_y.../               child partition folders

Rules:
  - A node is INTERNAL if it has merged/points3D.txt and at least one child folder
    that (recursively) contains point data. Its cluster is "<path>/merged" with the
    children's clusters as merge children. The node's own vggt/ is NOT a merge child
    (merging_metrics.json child counts match the subfolder count only).
  - Otherwise the node is a LEAF using vggt/points3D.txt (or merged/ as fallback).
  - Folders with no point data anywhere are skipped.

Cluster paths are relative to the dataset root, so the root cluster is "merged",
matching what the web app's layout engine expects.

Usage:
    python3 generate_structure.py data/gerrard-hall-vggt-v2/C_1 [more roots...]
    python3 generate_structure.py --exclude C_4 --exclude foo data/gerrard-hall-vggt-v2

--exclude skips the named top-level child folders of each root (useful when a
dataset root contains sibling folders that are not part of the partition tree).
"""

import json
import os
import sys

# Folder names that are never partition children at any depth
NON_PARTITION_DIRS = {
    'vggt', 'merged', 'metrics', 'plots',
    'vggt_pre_ba', 'merged_pre_ba', 'merged_retriangulated',
    'processed_images', 'images',
}


def has_points(d):
    return os.path.isfile(os.path.join(d, 'points3D.txt'))


def subtree_has_data(node_dir):
    for dirpath, dirnames, filenames in os.walk(node_dir):
        if 'points3D.txt' in filenames:
            return True
    return False


def load_merge_metrics(node_dir):
    p = os.path.join(node_dir, 'metrics', 'merging_metrics.json')
    if not os.path.isfile(p):
        return None
    try:
        with open(p) as f:
            mm = json.load(f).get('merging_metrics', {})
        return {
            'merge_child_count': mm.get('merge_child_count'),
            'number_cameras_merged': mm.get('number_cameras_merged'),
            'number_tracks_merged': mm.get('number_tracks_merged'),
        }
    except (json.JSONDecodeError, OSError):
        return None


def build(node_dir, rel_path, entries, timestamps, exclude=()):
    """Returns the cluster path representing this node, or None if it has no data."""
    child_dirs = sorted(
        d for d in os.listdir(node_dir)
        if os.path.isdir(os.path.join(node_dir, d))
        and d not in NON_PARTITION_DIRS
        and not (rel_path == '' and d in exclude)
        and subtree_has_data(os.path.join(node_dir, d))
    )

    vggt_dir = os.path.join(node_dir, 'vggt')
    merged_dir = os.path.join(node_dir, 'merged')
    prefix = rel_path + '/' if rel_path else ''

    def record(cluster_path, ctype, children, points_file, metrics=None):
        entry = {'path': cluster_path, 'type': ctype, 'children': children}
        if metrics:
            entry['metrics'] = metrics
        entries.append(entry)
        return cluster_path

    if child_dirs and has_points(merged_dir):
        children = []
        for d in child_dirs:
            child_cluster = build(os.path.join(node_dir, d), prefix + d, entries, timestamps, exclude)
            if child_cluster:
                children.append(child_cluster)
        if len(children) == 0:
            # children had no representable clusters; degrade to leaf
            if has_points(vggt_dir):
                return record(prefix + 'vggt', 'vggt', [], os.path.join(vggt_dir, 'points3D.txt'))
            return record(prefix + 'merged', 'merged', [], os.path.join(merged_dir, 'points3D.txt'))
        return record(prefix + 'merged', 'merged', children,
                      os.path.join(merged_dir, 'points3D.txt'),
                      load_merge_metrics(node_dir))

    if has_points(vggt_dir):
        return record(prefix + 'vggt', 'vggt', [], os.path.join(vggt_dir, 'points3D.txt'))
    if has_points(merged_dir):
        return record(prefix + 'merged', 'merged', [], os.path.join(merged_dir, 'points3D.txt'))
    return None


def main():
    args = sys.argv[1:]
    exclude = []
    roots = []
    i = 0
    while i < len(args):
        if args[i] == '--exclude':
            exclude.append(args[i + 1])
            i += 2
        else:
            roots.append(args[i])
            i += 1

    if not roots:
        print(__doc__)
        sys.exit(1)

    for root in roots:
        root = root.rstrip('/')
        if not os.path.isdir(root):
            print(f"skip {root}: not a directory")
            continue

        entries = []
        timestamps = {}
        root_cluster = build(root, '', entries, timestamps, tuple(exclude))
        if root_cluster != 'merged':
            print(f"WARNING {root}: root cluster is '{root_cluster}', layout engine expects 'merged'")

        with open(os.path.join(root, 'structure.json'), 'w') as f:
            json.dump({'root': root_cluster, 'clusters': entries}, f, indent=1)

        leaves = sum(1 for e in entries if not e['children'])
        merges = len(entries) - leaves
        print(f"{root}: {len(entries)} clusters ({leaves} leaves, {merges} merges), root={root_cluster}")


if __name__ == '__main__':
    main()
