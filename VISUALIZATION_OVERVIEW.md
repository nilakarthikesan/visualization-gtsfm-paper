# Gerrard Hall 3D Reconstruction - Visualization Overview

## What This Visualization Shows

This visualization demonstrates the **hierarchical clustering pipeline** used by GTSfM to reconstruct Gerrard Hall from photographs. It shows how small VGGT point cloud reconstructions are progressively merged bottom-up into a complete 3D model of the building.

---

## Data: Cluster Hierarchy

The reconstruction produces a binary tree of 17 clusters (12 leaf VGGT clusters + 5 merged clusters):

```
merged (root)
├── vggt                          (1 leaf)
├── C_1/vggt                      (1 leaf)
├── C_2/merged                    (3 leaves)
│   ├── C_2/vggt
│   ├── C_2/C_2_1/vggt
│   └── C_2/C_2_2/vggt
└── C_3/merged                    (7 leaves)
    ├── C_3/vggt
    ├── C_3/C_3_1/merged          (5 leaves)
    │   ├── C_3/C_3_1/vggt
    │   ├── C_3/C_3_1/C_3_1_1/merged  (3 leaves)
    │   │   ├── C_3/C_3_1/C_3_1_1/vggt
    │   │   ├── C_3/C_3_1/C_3_1_1/C_3_1_1_1/vggt
    │   │   └── C_3/C_3_1/C_3_1_1/C_3_1_1_2/vggt
    │   └── C_3/C_3_1/C_3_1_2/vggt
    └── C_3/C_3_2/vggt
```

Each **leaf** node is a VGGT reconstruction from a subset of images. Each **merged** node is the result of running Sim3+Karcher alignment to combine its children into a single coordinate frame.

Each cluster has a `points3D.txt` file (COLMAP format) containing 3D point positions.

---

## Layout Algorithm: Proportional Rectangle Subdivision

### Goal

Arrange all 12 leaf clusters on screen so that:
- Every cluster is visible simultaneously at the start
- Subtrees that will merge together are spatially adjacent
- Larger subtrees (more leaves) get proportionally more space

### How It Works

1. **Compute root rectangle**: A 16:9 aspect ratio rectangle is sized so each leaf gets roughly `(2.2 * maxRadius)^2 * 1.1` area, where `maxRadius` is the bounding radius of the largest cluster's point cloud.

2. **Recursive proportional subdivision**: At each internal node, the rectangle is divided among children proportionally to their **descendant leaf count**:

   - At the root (4 children): `vggt` gets 1/12, `C_1/vggt` gets 1/12, `C_2/merged` gets 3/12, `C_3/merged` gets 7/12
   - The split direction is chosen based on the rectangle's aspect ratio: wider rectangles split into columns (left-to-right), taller ones into rows (top-to-bottom)
   - Each subtree's sub-rectangle is recursively subdivided the same way
   - 3% padding between tiles prevents clusters from touching

3. **Fit each cluster into its tile**: Each leaf cluster's point cloud is scaled to fill 72% of its tile's smaller dimension:
   ```
   fitScale = min(tile.width, tile.height) * 0.72 / cluster.boundingRadius
   ```

4. **Merge regions**: For each merged (non-leaf) node, a **merge region** is computed as the bounding box of all its descendant leaf tiles. The merged cluster is positioned at the center of this region and scaled to fit within it.

### Why Proportional (Not Equal-Area)

The tree is highly unbalanced: the root's children have 1, 1, 3, and 7 leaves respectively. Equal-area partitioning would give each child 25% of the space, wasting area on 1-leaf children and cramming 7 leaves into 25%. Proportional allocation eliminates this gap.

---

## Timeline / Animation Sequence

The visualization plays 17 events in sequence:

### Phase 1: Leaf Appearance (Events 1-12)

Each leaf VGGT cluster fades in one at a time, deepest-first:
- Deepest leaves appear first (e.g., `C_3/C_3_1/C_3_1_1/C_3_1_1_1/vggt`)
- Shallowest leaves appear last (e.g., `vggt`, `C_1/vggt`)

### Phase 2: Merge Events (Events 13-17)

Bottom-up merges, also deepest-first:

| Event | Merge Node                       | Action                                                |
|-------|----------------------------------|-------------------------------------------------------|
| 13    | C_3/C_3_1/C_3_1_1/merged        | Hides 3 leaf children, shows merged result            |
| 14    | C_3/C_3_1/merged                 | Hides C_3_1/vggt + C_3_1_1/merged + C_3_1_2/vggt     |
| 15    | C_2/merged                       | Hides 3 C_2 leaf children                             |
| 16    | C_3/merged                       | Hides C_3/vggt + C_3_1/merged + C_3_2/vggt            |
| 17    | merged (root)                    | Hides all 4 children, shows final reconstruction      |

### Current Merge Animation

During each merge event:
- Child clusters **slide toward** the merge target position and **fade out** (opacity 1 -> 0.15, scale shrinks 50%)
- The merged result **fades in** simultaneously
- Animation uses quadratic ease-in-out over 0.8 seconds

---

## Point Cloud Processing

### Normalization

All 17 point clouds are normalized to a common coordinate frame:

1. **Center**: Translated so the global centroid (computed from the root merged cluster) is at the origin
2. **Scale**: Scaled so the global bounding diagonal maps to a target size of 300 units
3. **Rotate**: `rotateX(-PI/2)` then `rotateY(PI/2)` to orient the building upright (width horizontal, height vertical, depth into screen)
4. **Re-center geometry**: Each cluster's geometry is translated so its own centroid is at (0,0,0) within its Three.js group, ensuring symmetric scaling

### Colors

The current dataset has an RGB bug (all values are 0,0,0). A uniform gray fallback `(0.55, 0.55, 0.60)` is used. Once Akshay provides the corrected dataset with real RGB values, the actual building colors will appear automatically.

---

## Pending Work

### Alpha Blending (Per-Point Interpolation)

**Decided approach**: During each merge event, instead of simple fade in/out, individual points will interpolate between their child-cluster positions and their merged-cluster positions:

- **Matched points** (exist in both child and merged): Fly smoothly from child position to merged position using nearest-neighbor matching
- **Child-only points** (exist in child but not merged): Fade out over the transition
- **Merged-only points** (exist in merged but not child): Fade in over the transition
- Cubic ease-in-out for smooth motion

### Final Assembled View

After the last merge event (event 17), a clean "assembled view" where:
- The layout grid collapses
- The completed building fills the screen
- Camera repositions for a front-on view

### RGB Colors

Waiting for Akshay's corrected dataset (`metis_vggt_gerrard_nocalpriorshared_sim3_3px_filter`) with real RGB values. The visualization will automatically use them once the data is swapped in.

---

## Tech Stack

- **Three.js** (r160) for WebGL rendering
- **ES6 modules** for code organization
- **OrbitControls** for interactive camera (mouse drag to rotate, scroll to zoom)
- **Python HTTP server** (`python3 -m http.server 8080`) for local development

### File Structure

```
js/
  data-loader-vggt.js         - Loads points3D.txt files, normalizes geometry
  layout-engine-squareness.js - Proportional rectangle subdivision layout
  animation-engine-squareness.js - Timeline and merge animations
  interaction-engine.js       - Mouse picking / cluster selection
  camera-engine.js            - Programmatic camera movements
  main-hierarchy-vggt.js      - App entry point, Three.js setup, UI
hierarchy-vggt.html           - Main visualization page
data/gerrard-hall-vggt/results/ - Point cloud data (17 folders)
```

### Running Locally

```bash
cd gerrard-hall-v3-2
python3 -m http.server 8080
# Open http://localhost:8080/hierarchy-vggt.html
```
