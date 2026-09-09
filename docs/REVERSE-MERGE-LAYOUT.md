# Final-frame reconstruction layout

The viewer plans the final merged reconstruction first, reserves rectangles for
its descendants, and replays the merge timeline inside that fixed frame.
**Show Reserved Regions** is enabled by default and remembers an explicit opt-out;
`?regions=1` / `?regions=0` override the saved setting.
**Lock Final Frame** is enabled by default; `?camera=fixed` overrides saved settings.
Turning it off opts into framing the currently visible clusters.

**Show Node Labels** is off by default and controls long cell/timeline labels.
Region borders and subtle cell fills encode tree depth, with root = 0 and a
shared blue-scale legend. The scale adapts to light/dark themes.

## Planning and containment

- `layout-engine-squareness.js` fits the central 95% of each point cloud and
  the central 95% of camera positions independently. Retained cameras contribute
  their complete wireframes. It sizes the root rectangle from the final reconstruction
  and the usable viewport aspect ratio; the final root transform has scale 1.
- `recursive-floorplan.js` builds candidate horizontal/vertical packing plans
  bottom-up and assigns rectangles top-down. Each reconstruction's aspect ratio
  contributes a unit-area footprint, avoiding comparisons between different SfM
  coordinate scales. Candidate pruning keeps this bounded (32 aspect-diverse
  envelopes per subtree); this is a heuristic, not a globally optimal packing.
  Plans score the geometric mean of fitted footprint areas across all stages,
  weighting each merge by its descendant leaf count. This gives wide merged
  reconstructions a say in the split directions instead of optimizing only the
  space occupied by leaves and leaving later reconstructions in tall cells.
  The final candidate selection scores actual viewport allocations, including
  their aspect changes, rather than just the hypothetical packing envelopes.
- The selected plan balances the shapes of merges and descendants. Short
  children retain their footprint shape rather than stretching into
  long bands beside deep subtrees. Some parent space therefore remains empty.
  Unary merges inherit the parent's rectangle without introducing another split.
- Each reconstruction fits inside its explicit rectangle. Parent rectangles are
  retained throughout the timeline, rather than reconstructed from leaf bounds.
  Camera-frustum size changes and viewport changes rebuild the plan from settled
  geometry and reapply the current timeline state.
- The orthographic camera frames that root rectangle once. Event changes,
  scrubbing, and completion do not change the fixed camera or final transform.
  Automatic orbit and the separate finale rescale/recenter have been removed.

The fitting box uses observations nearest the XY median under an IQR-normalized
maximum-axis distance, retaining at least ceil(0.95 × count) from each population.
This guarantees joint XY coverage, unlike independent 95% per-axis quantiles.
The two boxes are united, so sparse cameras cannot be overwhelmed by point counts.
Tiny populations round up; no source data are deleted. The full Z range is retained
for camera clipping planes, without affecting orthographic XY scale. Outlier tails
outside a cell are clipped during the explanatory view and available during manual
3D inspection. Aspect mismatch and intentional spacing can still leave some air.

## Animation

Leaf reveals expand a compact copy of the reconstruction inside its fitted
bounds. Matched and unmatched merge points interpolate within the parent region.
A straight path between two inlier points in a rectangle stays inside that rectangle;
merging inputs may meet, while unrelated subtrees remain separate. Without point
correspondences, the child and parent crossfade in their allocated regions.

Fragment clipping contains outlier paths, point-sprite edges, frustum lines, and
optional merge particles. It uses the current render-target viewport, including
pixel ratio and postprocessing. Manual orbit suspends this screen-space clipping
and hides the guides; Reset restores the planned front view. The old experimental
`layout`, `tiling`, and `flow` query modes no longer select alternative layouts.

## Verification

Install the pinned local test dependency with `npm ci`. Run from `build`:

```sh
make -j6 testLayout.run
```

The Node regression checks cover extreme outliers and frustums, a deep
caterpillar tree, all 93 Brussels timeline frontiers, independent 95% point/camera coverage, 40
leaf reveals, 53 per-point merges, responsive/frustum re-layout, camera and final
transform stability, reset/scrubbing, and render-target clipping coordinates.
The browser still loads the existing pinned Three.js CDN version; npm is only
needed for these checks.

For visual inspection, serve the repository with the `py312` environment and open
`hierarchy-vggt.html?dataset=BRUSSELS&regions=1&camera=fixed`. Home/End jump to the
first/final event, the arrow keys step, and Space plays/pauses. The faint guides
show future leaf locations; solid guides show the currently reconstructed regions.
The colors use node depth, not point-cloud Z coordinates; photographic point colors
remain unchanged.
