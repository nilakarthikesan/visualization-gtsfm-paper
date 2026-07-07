# GTSfM Paper Visualization

Interactive Three.js visualization of the GTSfM hierarchical partition-and-merge pipeline for 3D reconstruction. Individual VGGT cluster reconstructions are laid out with a squareness-optimized recursive subdivision, then progressively merged into the complete model along the partition tree.

Datasets included:

| Dataset | Description | Timeline |
|---|---|---|
| Gerrard Hall (original) | UNC Chapel Hill building, the version shown in the team recording | 9 events |
| Brussels (full: C_1+C_2+C_3) | Complete Brussels reconstruction with the global root merge | 93 events (40 leaves + 53 merges) |
| C_1 / C_2 / C_3 | Individual Brussels partition branches | 66 / 13 / 13 events |
| C_4 (dense) | Community-photo reconstruction, ~600k points with real RGB | 6 events |

## Quick Start

```bash
python3 -m http.server 8000
```

Open [http://localhost:8000/hierarchy-vggt.html](http://localhost:8000/hierarchy-vggt.html) - this loads the original Gerrard Hall visualization. Pick other datasets from the Dataset dropdown in Visual Settings, or link directly:

- `hierarchy-vggt.html?dataset=BRUSSELS` - full Brussels merge story
- `hierarchy-vggt.html?dataset=C_1` (also `C_2`, `C_3`, `C_4`)

## Controls

| Button | Action |
|--------|--------|
| **Play/Pause** | Auto-advance through all timeline events |
| **Prev/Next** | Step through events one at a time |
| **Reset** | Return to the first event |
| **Record** | Start/stop recording the visualization as a `.webm` video |

Click anywhere on the timeline bar to jump to an event. Mouse drag orbits, scroll zooms, right-click drag pans.

## Point colors

The Brussels exports (C_1/C_2/C_3 and the root merge) were written without RGB (all points `0 0 0`). The app detects this and renders a warm height-gradient fallback so the geometry is always visible, including in dark mode.

To bake in real photographic colors once the source photos are available:

```bash
pip install pillow numpy
python3 colorize_points.py --images <photo_dir> --recursive data/gerrard-hall-vggt-v2
```

The script samples each 3D point's track observations from the photos (the same way COLMAP assigns point colors) and rewrites `points3D.txt` in place (backup kept as `.bak`). The app needs no changes afterwards - it uses real colors automatically when they exist.

## Regenerating dataset manifests

When new reconstruction folders are added, regenerate the `structure.json` manifests the loader consumes:

```bash
python3 generate_structure.py data/gerrard-hall-vggt-v2/C_1        # single branch
python3 generate_structure.py --exclude C_4 data/gerrard-hall-vggt-v2  # combined root over C_1+C_2+C_3
```

## Architecture

- `js/data-loader-vggt.js` - Dataset registry, point cloud + camera loading, scene orientation from COLMAP poses, spatial-hash point matching between merge levels, fallback coloring
- `js/layout-engine-squareness.js` - Recursive rectangle subdivision layout optimized for tile squareness
- `js/animation-engine-squareness.js` - Timeline system with per-point merge interpolation
- `js/convergence-engine.js` - Scatter-to-structure reconstruction reveal effect
- `js/frustum-engine.js` - Camera frustum display per cluster
- `js/main-hierarchy-vggt.js` - App entry point, Three.js scene setup, UI, recording

## Preserved versions

The exact version shown in the April 2026 team recording is tagged [`gerrard-hall-original`](../../tree/gerrard-hall-original). The default page (no `?dataset=` parameter) still renders that same Gerrard Hall visualization.
