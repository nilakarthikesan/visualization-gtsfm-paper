#!/usr/bin/env python3
"""Build a dataset's timestamps.json from GTSFM's cluster_timestamps.csv.

The CSV (produced by the pipeline run, one row per exported artifact) is the
authoritative record of when each cluster reconstruction landed. It carries more
rows than the viewer animates, because every node also exports pre-BA and
retriangulated variants; only the `vggt` (leaf/child reconstruction) and `merged`
(parent fusion) exports correspond to timeline events, and their `node_export`
paths match structure.json's cluster paths verbatim.

Two clocks come out of the CSV and both are recorded per node:
  epoch  - true wall-clock (epoch_mtime). This is what "real time" means, and it
           includes idle stretches where Dask was simply waiting to schedule.
  vizSec - Kathir's viz_time_s, the same run with idle stretches squeezed out.

The viewer paces on `epoch` so a long bundle-adjustment genuinely feels long, and
detects idle stalls itself (see the animation engine), so keeping the true clock
here loses nothing while staying faithful to the run.

Usage:
    python3 scripts/build_timestamps.py <cluster_timestamps.csv> <dataset_dir>
"""
import csv
import json
import sys
from pathlib import Path

# Exports that correspond to an animated timeline event.
EVENT_KINDS = ("vggt", "merged")


def load_csv(csv_path):
    """node_export -> (epoch, viz_sec), keeping only animated event kinds."""
    rows = {}
    with open(csv_path, newline="") as fh:
        for r in csv.DictReader(fh):
            node = r["node_export"].strip()
            if node.rsplit("/", 1)[-1] not in EVENT_KINDS:
                continue
            rows[node] = (int(r["epoch_mtime"]), float(r["viz_time_s"]))
    return rows


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    csv_path, dataset_dir = Path(sys.argv[1]), Path(sys.argv[2])

    structure = json.loads((dataset_dir / "structure.json").read_text())
    paths = [c["path"] for c in structure["clusters"]]
    stamps = load_csv(csv_path)

    matched, missing = {}, []
    for p in paths:
        if p in stamps:
            matched[p] = stamps[p]
        else:
            missing.append(p)

    if not matched:
        sys.exit(f"No cluster path in {dataset_dir} matched the CSV's node_export column.")

    # arrival_rank orders the animated events among themselves (the CSV's own
    # order_rank counts pre-BA rows the viewer never shows).
    ordered = sorted(matched.items(), key=lambda kv: (kv[1][0], len(kv[0])))
    out = {
        path: {"epoch": float(epoch), "vizSec": viz, "arrival_rank": rank}
        for rank, (path, (epoch, viz)) in enumerate(ordered)
    }
    (dataset_dir / "timestamps.json").write_text(json.dumps(out, indent=1))

    epochs = [e for e, _ in matched.values()]
    vizs = [v for _, v in matched.values()]
    print(f"{dataset_dir}: matched {len(matched)}/{len(paths)} clusters")
    if missing:
        print(f"  unmatched ({len(missing)}): {missing[:3]}{' ...' if len(missing) > 3 else ''}")
    print(f"  wall-clock span {(max(epochs) - min(epochs)) / 3600:.2f}h")
    print(f"  viz_time span   {(max(vizs) - min(vizs)) / 3600:.2f}h")


if __name__ == "__main__":
    main()
