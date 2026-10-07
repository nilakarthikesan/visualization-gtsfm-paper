# GTSfM Reconstruction Visualization

Interactive Three.js visualization of exported reconstructions from the GTSfM hierarchical partition-and-merge pipeline. The viewer loads point clouds, camera poses, merge hierarchies, and event timestamps to show how partial reconstructions combine.

My contribution is the browser visualization and its supporting layout, playback, data-loading, and recording software. The reconstructions and reconstruction methods come from the GTSfM team and collaborators.

## Current viewer

```bash
python3 -m http.server 8000
```

Open [hierarchy-vggt.html](http://localhost:8000/hierarchy-vggt.html). The current registry in [js/data-loader-vggt.js](js/data-loader-vggt.js) provides:

- `BRUSSELS`: the current Grand-Place run under `data/brussels-rerun`, with C_1 and C_2 branches. The run has 25 leaves and 29 merges.
- `original`: Gerrard Hall under `data/gerrard-hall-vggt/results`.
- `THANJAVUR`: Brihadeeswarar Temple under `data/thanjavur-vggt`.
- `C_1`: the deep branch of the current Brussels run.

Select a dataset in the viewer or use `?dataset=BRUSSELS`, `?dataset=original`, `?dataset=THANJAVUR`, or `?dataset=C_1`. Historical C_2/C_3/C_4 viewer links do not correspond to the current dataset registry.

## Controls and playback

Play/Pause advances the event timeline; Prev/Next steps between events; Reset returns to the beginning. Record exports the canvas as WebM. Mouse drag orbits, scrolling zooms, and right drag pans. Home/End jump to the first/final event; the timeline supports seeking.

The completed reconstruction defines a fixed frame. The layout allocates regions recursively to descendants, then replays merges within those regions. Reserved-region guides show tree depth. Point matching runs in a background worker with merge lookahead and caching; playback uses crossfades when matches are unavailable. See [REVERSE-MERGE-LAYOUT.md](docs/REVERSE-MERGE-LAYOUT.md) for implementation and verification details.

Playback compresses recorded time for presentation. Parent timestamps can be adjusted to preserve child-before-parent order. Displayed event order and animation timing should not be treated as an unmodified execution trace.

## Data format and preparation

Each reconstruction uses COLMAP text files:

- `points3D.txt`: point IDs, coordinates, RGB, and error.
- `cameras.txt`: camera intrinsics.
- `images.txt`: camera poses and image names.
- `structure.json`: hierarchy for datasets using manifests.
- `timestamps.json`: event timing where available.

The web exports omit observation tracks to reduce transfer size. Preserve the first eight fields of each point row and the empty second row after each image pose. [scripts/strip_image_tracks.py](scripts/strip_image_tracks.py) handles image-track removal. Colorization requires the original observations and source images; run [colorize_points.py](colorize_points.py) before stripping tracks.

The viewer uses stored RGB when available and fallback colors for colorless exports. `pointScale` in the dataset registry controls point size; `?psize=0.4` provides a URL override.

To add a dataset, supply reconstruction files, generate its manifest with [generate_structure.py](generate_structure.py), and register the export in `DATASETS`. Keep the reconstruction source and any preprocessing documented.

## Architecture

- [js/data-loader-vggt.js](js/data-loader-vggt.js): dataset registry, hierarchy and geometry loading, orientation, and colors.
- [js/recursive-floorplan.js](js/recursive-floorplan.js) and [js/layout-engine-squareness.js](js/layout-engine-squareness.js): region allocation and layout.
- [js/point-matching.js](js/point-matching.js), worker, and coordinator: spatial matching and cached lookahead.
- [js/animation-engine-squareness.js](js/animation-engine-squareness.js): merge playback.
- [js/frustum-engine.js](js/frustum-engine.js): camera visualization.
- [js/main-hierarchy-vggt.js](js/main-hierarchy-vggt.js): viewer UI, rendering, and recording.

## Interpretation and limitations

This application visualizes supplied exports; it does not run SfM or independently validate reconstruction quality. Spatial point matching is a display correspondence heuristic, rather than a measurement of track identity. Some Thanjavur intermediate exports were reseated from their child exports to repair divergent coordinate frames; those display repairs are documented in the dataset-loader comments and should not be interpreted as original pipeline outputs.

Historical design notes and earlier viewer pages remain in the repository. Their event counts and controls may differ from the current viewer. The Gerrard Hall version shown in the team recording is preserved by the `gerrard-hall-original` tag.

## References and credit

- [GTSfM](https://github.com/borglab/gtsfm): reconstruction pipeline and collaborators' data.
- [COLMAP format](https://colmap.github.io/format.html): reconstruction export conventions.
- [Three.js](https://threejs.org/): browser rendering.
- [Building Rome in a Day](http://grail.cs.washington.edu/rome/): visualization reference.

The visualization contribution is distinct from authorship of the underlying reconstruction algorithms. Preserve source attribution and applicable code/data licenses when reusing exports.
