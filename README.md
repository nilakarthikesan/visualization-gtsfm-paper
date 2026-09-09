# GTSfM Paper Visualization

Interactive Three.js visualization of the GTSfM hierarchical partition-and-merge pipeline for 3D reconstruction. The final merged reconstruction establishes a fixed viewport; its region is recursively allocated to child reconstructions, which then appear and merge within those reserved regions. See [the layout design and verification guide](docs/REVERSE-MERGE-LAYOUT.md).

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

Open [http://localhost:8000/hierarchy-vggt.html](http://localhost:8000/hierarchy-vggt.html) - this loads the full Brussels visualization. Pick other datasets from the Dataset dropdown in Visual Settings, or link directly:

- `hierarchy-vggt.html?dataset=BRUSSELS` - full Brussels merge story
- `hierarchy-vggt.html?dataset=original` - original Gerrard Hall visualization
- `hierarchy-vggt.html?dataset=C_1` (also `C_2`, `C_3`, `C_4`)

## Controls

| Button | Action |
|--------|--------|
| **Play/Pause** | Auto-advance through all timeline events |
| **Prev/Next** | Step through events one at a time |
| **Reset** | Return to the first event |
| **Record** | Start/stop recording the visualization as a `.webm` video |

Brussels is the default dataset. Playback starts automatically after loading,
including when switching datasets in the project-page tabs or the viewer's picker.
Each uninterrupted replay lasts 0.5 seconds times its number of events, including
the final merge: 4.5 seconds for Gerrard Hall (9 events) and 46.5 seconds for Brussels
(93 events). This sets the average pace; individual gaps retain their relative timing. Recorded
event gaps are scaled directly with no minimum delay; animations shorten to fit.
The live run clock shows accelerated elapsed time alongside the dataset's playback
counter. Pause freezes both clocks and animations; scrubbing moves them together.

Point matching runs in a background worker using stable reconstruction coordinates,
with lookahead for the next two animated merges. Loading and playback never wait
for matches: a merge whose matches are not ready uses a crossfade in its assigned
regions, keeping the event-count-based schedule (including during recording). Completed
matches are cached for replay until the viewer reloads. Seeking reprioritizes pending
work; if workers are unavailable, the viewer continues with crossfades.

**Show Reserved Regions** is on by default, with boundaries colored by tree depth. **Show Node Labels** is opt-in. Cells fit the central 95% of points and cameras; the planner considers reconstruction shapes at every merge stage to reduce unused space. **Lock Final Frame** keeps the completed reconstruction’s frame throughout playback. Home/End jump to the first/final event. Click anywhere on the timeline bar to jump to an event. Mouse drag orbits, scroll zooms, right-click drag pans.

## Point colors

The Brussels exports (C_1/C_2/C_3 and the root merge) were written without RGB (all points `0 0 0`). The app detects this and renders a warm height-gradient fallback so the geometry is always visible, including in dark mode.

To bake in real photographic colors once the source photos are available:

```bash
pip install pillow numpy
python3 colorize_points.py --images <photo_dir> --recursive data/gerrard-hall-vggt-v2
```

The script samples each 3D point's track observations from the photos (the same way COLMAP assigns point colors) and rewrites `points3D.txt` in place (backup kept as `.bak`). The app needs no changes afterwards - it uses real colors automatically when they exist.

## Adding the fine optimization-points dataset

Kathir's reconstructions (see [examples](https://kathirgounder.github.io/project.html?id=reconstructions)) use the **dense fine points straight from the GTSFM optimization**, not the sparse sampled points currently in the Brussels exports. GTSFM writes COLMAP `points3D.txt`, so the loader ingests them with no format changes. To add one:

1. Drop the reconstruction under `data/<scene>/` with the standard layout:
   - `<node>/points3D.txt` per cluster node (COLMAP: `id x y z r g b error track…`)
   - `merged/images.txt` (camera extrinsics — used to orient the scene upright)
   - optional `timestamps.json` (per-node timestamps drive the timeline pacing)
2. Generate the manifest: `python3 generate_structure.py data/<scene>`
3. Register it in `DATASETS` (`js/data-loader-vggt.js`). Dense clouds should set a
   small `pointScale` so the fine detail isn't buried under fat points:

   ```js
   BRUSSELS_FINE: { label: 'Brussels (fine)', basePath: 'data/brussels-fine', useManifest: true, pointScale: 0.4 }
   ```

### Point size for fine vs sampled clouds

`pointScale` (per dataset) multiplies every point's on-screen size. Sparse "sampled"
clouds read best as surfaces at `1.0`; dense "fine" clouds want `~0.3–0.5` so
individual points stay crisp. Tune it live without editing code:

- URL override: `hierarchy-vggt.html?dataset=…&psize=0.4`
- Console: `setPointSizeScale(0.4)` (re-applies immediately)

Fine points from the optimization typically carry **real RGB**, which also resolves
the colorless `0 0 0` fallback the current Brussels exports trigger.

## Regenerating dataset manifests

When new reconstruction folders are added, regenerate the `structure.json` manifests the loader consumes:

```bash
python3 generate_structure.py data/gerrard-hall-vggt-v2/C_1        # single branch
python3 generate_structure.py --exclude C_4 data/gerrard-hall-vggt-v2  # combined root over C_1+C_2+C_3
```

## Brussels colored export (current data)

`data/gerrard-hall-vggt-v2` (the `BRUSSELS` / `C_1` / `C_2` / `C_3` datasets) holds Kathir's
colored Brussels export: every node's `points3D.txt` carries real per-point RGB, so the
loader uses it directly and the grayscale `applyFallbackColors()` ramp no longer triggers.
`C_4` is a separate reconstruction not included in that export and is preserved as-is.
To refresh with a newer export, replace the per-node `points3D.txt` / `images.txt` /
`cameras.txt` and rerun `generate_structure.py` (see above).

Data files are fetched with `cache: 'no-cache'` (in `js/data-loader-vggt.js` and
`js/frustum-engine.js`) so an updated export is never masked by a stale browser-cached
copy; a normal reload always revalidates and picks up new colors/points.

### Timestamps (real arrival order)

`data/gerrard-hall-vggt-v2/timestamps.json` now carries the **real pipeline arrival order**
Kathir sent (`cluster_arrival_order.csv`). Each cluster path maps to `{ "epoch": <unix>,
"arrival_rank": <n> }`: `cluster_reconstruction` rows → `<node>/vggt`, `merge` rows →
`<node>/merged`, and the root `merge, root` → `merged`. `initTimeline()` in
`js/animation-engine-squareness.js` sorts by `epoch`, so the viewer plays in true wall-clock
order and shows the real reconstruction time per event.

Raw arrival order is **not** always a valid bottom-up merge order: the run occasionally logs a
parent merge a few seconds before its child merge, which would leave orphan child clusters
visible at the end. When regenerating `timestamps.json`, a post-order pass bumps each parent's
epoch to `max(own, max(child)+1ms)` so every parent is strictly after all descendants while
otherwise preserving real times. Regenerate from the CSV if the run changes.

### Removed dataset

The `C_4` "community photo collection" tab was removed: per Kathir, Dubrovnik was never
reconstructed successfully, so it should not be shown.

## Architecture

- `js/data-loader-vggt.js` - Dataset registry, point cloud + camera loading, scene orientation from COLMAP poses, fallback coloring
- `js/point-matching.js` / `js/point-matching-worker.js` / `js/matching-coordinator.js` - Spatial-hash matching, background computation, and cached merge lookahead
- `js/layout-engine-squareness.js` / `js/recursive-floorplan.js` - Final-frame layout with geometry-aware recursive packing
- `js/layout-guides.js` / `js/region-clipping.js` - Optional reserved-region guides and fragment containment
- `js/animation-engine-squareness.js` - Timeline system with per-point merge interpolation
- `js/convergence-engine.js` - Scatter-to-structure reconstruction reveal effect
- `js/frustum-engine.js` - Camera frustum display per cluster
- `js/main-hierarchy-vggt.js` - App entry point, Three.js scene setup, UI, recording

## Preserved versions

The exact version shown in the April 2026 team recording is tagged [`gerrard-hall-original`](../../tree/gerrard-hall-original). Gerrard Hall remains available through `?dataset=original` or the dataset picker.
