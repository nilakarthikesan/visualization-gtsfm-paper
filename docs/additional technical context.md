# Visualization References and Design Decisions

Reconstruction viewers provide useful display patterns: point clouds with camera frustums, hierarchy overviews, progressive reveal, stable scene framing, and recorded camera paths. These patterns can inform a viewer without implying it implements the reference system's SfM algorithm.

## References

- [Building Rome in a Day](http://grail.cs.washington.edu/rome/): large-scale reconstruction and accompanying visual material.
- [GTSfM](https://github.com/borglab/gtsfm): reconstruction pipeline and export source.
- [COLMAP](https://colmap.github.io/): reconstruction formats and inspection tools.
- [Nerfstudio](https://docs.nerf.studio/): interactive visualization and camera-path tooling.
- [Three.js](https://threejs.org/): rendering, scene groups, raycasting, and interpolation primitives.

References in the original planning notes to Progressive SfM, Photo Tourism, and Cycle-Sync were reading leads. Their particular animation choices should be attributed only after checking the relevant paper or accompanying material.

## Decisions for this project

Use a hierarchy-aware layout to show merge relationships. Keep display transforms separate from source geometry. Animate children-to-parent transitions with interpolation or crossfades. Maintain stable overview framing, with optional final camera motion. Local inspection transforms should be reversible.

The current viewer adds reserved-region layout, background spatial matching, and playback controls. Those implementation choices are documented in [the current README](../README.md) and [REVERSE-MERGE-LAYOUT.md](REVERSE-MERGE-LAYOUT.md).

## Interpretation

Neither smooth animation nor a complete-looking point cloud validates reconstruction accuracy. Evaluation of the underlying method requires its own geometric metrics and original exports. Any repaired intermediate export, adjusted timestamp, fallback color, or display correspondence must be described as preprocessing or presentation behavior.
