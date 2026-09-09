# Final-frame reconstruction layout

The viewer plans the final merged reconstruction first, reserves rectangles for
its descendants, and replays the merge timeline inside that fixed frame. Enable
**Show Reserved Regions**, or use `?regions=1`, to inspect the allocation.
**Lock Final Frame** is enabled by default; `?camera=fixed` overrides saved settings.
Turning it off opts into framing the currently visible clusters.

## Planning and containment

- `layout-engine-squareness.js` measures the full XY bounds of each point cloud and
  its camera wireframes. It sizes the root rectangle from the final reconstruction
  and the usable viewport aspect ratio; the final root transform has scale 1.
- `recursive-floorplan.js` builds candidate horizontal/vertical packing plans
  bottom-up and assigns rectangles top-down. Each reconstruction's aspect ratio
  contributes a unit-area footprint, avoiding comparisons between different SfM
  coordinate scales. Candidate pruning keeps this bounded (32 aspect-diverse
  envelopes per subtree); this is a heuristic, not a globally optimal packing.
- The selected plan balances the requirements of descendants, not just the next
  cut. Short children retain their footprint shape rather than stretching into
  long bands beside deep subtrees. Some parent space therefore remains empty.
  Unary merges inherit the parent's rectangle without introducing another split.
- Each reconstruction fits inside its explicit rectangle. Parent rectangles are
  retained throughout the timeline, rather than reconstructed from leaf bounds.
  Camera-frustum size changes and viewport changes rebuild the plan from settled
  geometry and reapply the current timeline state.
- The orthographic camera frames that root rectangle once. Event changes,
  scrubbing, and completion do not change the fixed camera or final transform.
  Automatic orbit and the separate finale rescale/recenter have been removed.

The full data bounds include outliers; a dataset with distant outliers can leave
extra space around its dense reconstruction. No point data are trimmed to make
this fit. Point size, color, timing, and manual 3D inspection remain adjustable.

## Animation

Leaf reveals expand a compact copy of the reconstruction inside its fitted
bounds. Matched and unmatched merge points interpolate within the parent region.
A straight path between two points in a rectangle stays inside that rectangle;
merging inputs may meet, while unrelated subtrees remain separate. Without point
correspondences, the child and parent crossfade in their allocated regions.

Fragment clipping additionally contains point-sprite edges, frustum lines, and
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
caterpillar tree, all 93 Brussels timeline frontiers, all loaded geometry, 40
leaf reveals, 53 per-point merges, responsive/frustum re-layout, camera and final
transform stability, reset/scrubbing, and render-target clipping coordinates.
The browser still loads the existing pinned Three.js CDN version; npm is only
needed for these checks.

For visual inspection, serve the repository with the `py312` environment and open
`hierarchy-vggt.html?dataset=BRUSSELS&regions=1&camera=fixed`. Home/End jump to the
first/final event, the arrow keys step, and Space plays/pauses. The faint guides
show future leaf locations; solid guides show the currently reconstructed regions.
