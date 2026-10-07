# GTSfM Pipeline and Visualization Inputs

GTSfM estimates camera poses and scene geometry from image collections. The exact processing stages depend on the reconstruction configuration. This note explains the exported artifacts consumed by the viewer; it is not an implementation specification for every GTSfM variant.

## Reconstruction stages

An SfM pipeline typically identifies overlapping images, establishes correspondences, estimates relative geometry, associates tracks, initializes camera poses and points, and refines them through bundle adjustment. A hierarchical configuration partitions the problem and combines partial reconstructions.

The feed-forward reconstruction workflow visualized here supplies cluster reconstructions and a merge hierarchy. The browser consumes those outputs rather than executing image matching, triangulation, or bundle adjustment.

## Exported data

- `points3D.txt`: 3D coordinates, RGB, and per-point error.
- `cameras.txt`: camera model and intrinsic parameters.
- `images.txt`: camera orientation, translation, and image identity.
- `structure.json`: child/parent reconstruction relationships for manifest-based datasets.
- `timestamps.json`: reconstruction and merge timing where available.

Camera rotations and translations require the correct COLMAP convention. A camera's position is not simply the translation vector; conversion depends on the world-to-camera transform. The viewer normalizes and orients the display without changing the original source files.

## Viewer mapping

[data-loader-vggt.js](../js/data-loader-vggt.js) loads the registry, hierarchy, geometry, and timestamps. Layout engines place reconstruction groups for presentation. The animation engine schedules child-to-parent display transitions. The frustum engine displays cameras.

Cluster positions during playback are presentation transforms. Point interpolation and crossfades illustrate hierarchy changes; they do not describe optimization trajectories or certify reconstruction accuracy. Timeline preprocessing may adjust event order to keep children before parents.

## References

- [GTSfM source](https://github.com/borglab/gtsfm)
- [COLMAP output format](https://colmap.github.io/format.html)
- [Current viewer README](../README.md)
