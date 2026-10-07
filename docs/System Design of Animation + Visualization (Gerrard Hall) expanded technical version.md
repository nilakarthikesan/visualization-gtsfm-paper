# Early Viewer Design: Technical Details

Historical implementation notes for a slab layout and event-driven merge visualization. The current final-frame layout is documented in [REVERSE-MERGE-LAYOUT.md](REVERSE-MERGE-LAYOUT.md).

## Data model

A reconstruction node needs its path, type, geometry, children, parent, source centroid, bounds, and display group. Keep source geometry and display state separate. Parent/child relationships come from the export hierarchy rather than geometric proximity.

## Layout calculation

For an early tree layout, assign leaves consecutive horizontal slots. Place each parent at the mean of its child slots and use tree depth for the vertical coordinate. Scale spacing by geometry bounds to reduce overlap. A fixed shallow depth creates the slab presentation.

The current layout uses reserved regions and geometry-aware packing; the early mean-position algorithm should not be described as the current production path.

## Local group transforms

Center the geometry within a display group and use the group transform for placement and inspection. A local rotation acts on that group without modifying stored coordinates. Raycasting selects a group; drag ownership must be explicit so the camera does not rotate during the same operation.

## Merge state

Each event identifies visible children and a parent output. At normalized progress `u`, apply a position interpolation or a chosen Bézier path, reduce child opacity, and increase parent opacity. At completion, hide children and retain the parent. Seeking requires rebuilding the state from event history or deterministic snapshots rather than relying on the last animation callback.

Spatial point matching can provide a display correspondence. It is not proof of shared feature tracks. Use a crossfade when correspondence computation fails or is unavailable.

## Camera state

Overview, inspection, and optional tour modes should each own camera position, target, and controls explicitly. Camera tours use final-scene bounds and continuous paths; returning to free controls should preserve a usable view.

## Validation

Check leaf/merge event ordering, child visibility after parent completion, deterministic reset/seek, and stable geometry coordinates across layout changes. Compare timing annotations with the export source and document any adjustment made for playback.

References: [GTSfM](https://github.com/borglab/gtsfm), [Three.js](https://threejs.org/), [COLMAP format](https://colmap.github.io/format.html), and [Building Rome in a Day](http://grail.cs.washington.edu/rome/) as a visual reference.
