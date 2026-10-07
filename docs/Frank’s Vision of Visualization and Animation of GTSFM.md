# Visualization Requirements from Project Discussions

This note records the earlier design requirements discussed with Frank for making the reconstruction hierarchy visible and inspectable. It is a requirements record rather than a checklist of current features; the current viewer is described in [README.md](../README.md).

## Hierarchy layout

Display partial reconstructions in a shallow presentation plane so child/parent relationships remain legible. A layout should reserve space for each group, avoid abrupt reframing, and preserve a consistent overview as the merge timeline advances.

The shallow layout is a display convention. It should not be interpreted as slicing the reconstructed building or changing the source geometry.

## Independent inspection

Treat each reconstruction as a separate Three.js group. Selection should identify a group, highlight it, and apply any inspection transform locally. Global camera controls and local group manipulation must not compete for the same drag event. Reset must restore the display transform without modifying source point coordinates.

## Merge animation

Represent a merge as a scheduled transition from child groups to a parent group. Position interpolation and opacity changes can make this transition continuous. The hierarchy determines which children are replaced; presentation motion does not represent measured forces or physical movement.

## Camera behavior

Maintain stable overview framing during hierarchy playback. Optional camera tours around the final reconstruction require explicit modes, a continuous path, and a way to restore user control. Camera motion should not obscure the merge relationships being shown.

## Verification

- Verify that source hierarchy relationships match displayed parent/child transitions.
- Inspect selection and reset without altering stored geometry.
- Exercise pause, seek, replay, and dataset switching.
- State whether timing comes from measured logs or presentation defaults.

GTSfM supplies the reconstruction pipeline and collaborators' exports. Three.js supplies rendering primitives. [Building Rome in a Day](http://grail.cs.washington.edu/rome/) is a visual reference; this viewer does not implement its reconstruction algorithm.
