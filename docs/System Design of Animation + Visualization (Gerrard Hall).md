# Early Gerrard Hall Viewer Design

This historical design describes the modular slab-view approach. Current layout and playback use the modules listed in [README.md](../README.md); earlier pages retain their own implementations.

## Inputs

Each reconstruction has a point cloud, optional camera files, a hierarchy path, and child paths. The initial merge-tree viewer encoded these relationships directly. Manifest-based loaders use `structure.json` and event timestamps instead.

## Layout

Compute per-cluster geometry bounds and assign a stable display position. In the slab design, leaves occupy separate horizontal positions and parents are centered over their children. Shallow depth preserves an overview of the tree.

Keep source coordinates separate from presentation transforms. Freeze layout between events so merges move toward known parent positions rather than triggering a new layout every frame.

## Interaction

Each reconstruction belongs to a `THREE.Group`. Raycasting identifies selected geometry; drag events update only the selected group's inspection transform. Disable global orbit rotation during local manipulation and restore it on release. Selection highlighting should be reversible.

## Animation

For a merge from children to parent, interpolate display position using `p(u) = (1-u)p_start + u p_parent`, optionally with easing or a curved path. Crossfade children out and the parent in, then commit the final visibility state. This interpolates the display; it does not solve geometric alignment.

## Camera

Use a stable overview during merge playback. An optional final orbit or spline tour should have a clear start/end state and restore interactive camera controls afterwards. Its center and scale come from the final reconstruction's bounds.

## Engineering constraints

Pause and seek must restore deterministic visibility and transforms. Dataset switching must dispose of obsolete geometry and cancel work associated with the prior dataset. References to point size, density, colors, and timing should identify their source or display convention.

Related sources: [Three.js](https://threejs.org/), [GTSfM](https://github.com/borglab/gtsfm), and [COLMAP file conventions](https://colmap.github.io/format.html).
