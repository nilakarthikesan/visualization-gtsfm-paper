# Slab View Visualization - System Design (v3)

## Overview

The Slab View visualizes the GTSfM hierarchical merge process as clusters rising through vertical layers, merging as they ascend until the final complete reconstruction appears at the top. This visualization directly maps to the output structure of the GTSfM pipeline.

---

## GTSfM Pipeline Output Structure

### Directory Hierarchy

The GTSfM pipeline outputs a hierarchical structure of clusters, where each cluster represents a sub-reconstruction from a subset of images:

```
data/gerrard-hall/results/
├── ba_output/              ← Root-level bundle adjustment output
├── merged/                 ← FINAL merged reconstruction (complete Gerrard Hall)
│
├── C_1/                    ← Cluster 1 (sub-region of building)
│   ├── ba_output/          ← C_1's direct bundle adjustment
│   ├── merged/             ← C_1 merged result
│   ├── C_1_1/              ← Sub-cluster of C_1
│   │   ├── ba_output/
│   │   └── merged/
│   └── C_1_2/              ← Another sub-cluster of C_1
│       ├── ba_output/
│       └── merged/
│
├── C_2/                    ← Cluster 2 (another sub-region)
│   ├── ba_output/
│   └── merged/
│
├── C_3/                    ← Cluster 3
│   ├── ba_output/
│   └── merged/
│
└── C_4/                    ← Cluster 4 (largest, with deep hierarchy)
    ├── ba_output/
    ├── merged/
    ├── C_4_1/
    │   ├── ba_output/
    │   ├── merged/
    │   ├── C_4_1_1/
    │   │   ├── ba_output/
    │   │   └── merged/
    │   └── C_4_1_2/
    │       ├── ba_output/
    │       └── merged/
    └── C_4_2/
        ├── ba_output/
        ├── merged/
        ├── C_4_2_1/
        │   ├── ba_output/
        │   └── merged/
        └── C_4_2_2/
            ├── ba_output/
            └── merged/
```

### Key Files in Each Cluster

Each cluster directory contains:
- **`points3D.txt`**: 3D point cloud data with XYZ coordinates and RGB colors
- **`cameras.txt`**: Camera intrinsic parameters
- **`images.txt`**: Camera poses and image associations

### Merge Relationships

The `merged/` folder in each cluster contains the result of combining:
1. The cluster's own `ba_output/`
2. All child cluster `merged/` results

**Example - C_1/merged is formed by:**
```
C_1/merged = C_1/ba_output + C_1/C_1_1/merged + C_1/C_1_2/merged
```

**Final merged reconstruction:**
```
merged = ba_output + C_1/merged + C_2/merged + C_3/merged + C_4/merged
```

---

## Visual Concept

### Hierarchical Tree Structure

```
                        [FINAL MERGED]                    Level 4 (Root)
                              │
           ┌──────────────────┼──────────────────┐
           │                  │                  │
      [C_1/merged]      [C_2/merged]       [C_4/merged]    Level 3
           │            [C_3/merged]             │
     ┌─────┴─────┐                         ┌─────┴─────┐
     │           │                         │           │
[C_1_1/merged] [C_1_2/merged]        [C_4_1/merged] [C_4_2/merged]   Level 2
                                           │           │
                                     ┌─────┴───┐ ┌─────┴───┐
                                     │         │ │         │
                              [C_4_1_1] [C_4_1_2] [C_4_2_1] [C_4_2_2]  Level 1

                         (Leaf clusters at Level 0)
```

### Vertical Layer Visualization

```
CAMERA VIEW (looking at stacked layers):

   Level 4 (Root)      ┌──────────────────────────────┐
                       │      [Final Merged]          │  ← Complete Gerrard Hall
                       └──────────────────────────────┘
                                    ▲
   Level 3             ┌──────────────────────────────┐
                       │   [C_1]  [C_2]  [C_3]  [C_4] │
                       └──────────────────────────────┘
                                    ▲
   Level 2             ┌──────────────────────────────┐
                       │ [C_1_1] [C_1_2] [C_4_1] [C_4_2] │
                       └──────────────────────────────┘
                                    ▲
   Level 1             ┌──────────────────────────────┐
                       │ [C_4_1_1] [C_4_1_2] [C_4_2_1] [C_4_2_2] │
                       └──────────────────────────────┘
                                    ▲
   Level 0 (Leaves)    ┌──────────────────────────────┐
                       │    [Deepest leaf clusters]    │
                       └──────────────────────────────┘
```

---

## Cluster-to-Level Mapping

| Level | Description | Clusters Displayed |
|-------|-------------|-------------------|
| **Level 0** | Leaf clusters (deepest in tree) | Smallest sub-reconstructions |
| **Level 1** | First merge level | Results of merging leaf pairs |
| **Level 2** | Second merge level | `C_1_1`, `C_1_2`, `C_4_1`, `C_4_2` merged results |
| **Level 3** | Third merge level | `C_1`, `C_2`, `C_3`, `C_4` merged results |
| **Level 4** | Root (final) | Complete `merged` Gerrard Hall |

### Level Assignment Algorithm

```javascript
// Depth: 0 = root, increases going down to leaves
// Level: Inverted so leaves are at bottom, root at top
node.level = maxDepth - node.depth;
```

This ensures:
- **Leaves (highest depth) → Level 0 (bottom of screen)**
- **Root (depth 0) → Level maxDepth (top of screen)**

---

## Animation Sequence

### Event 1: Show Leaves
- **Duration**: 800ms fade-in
- **Action**: All leaf clusters (Level 0) fade in simultaneously
- **Camera**: Centered at Y=0 to see all levels
- **User sees**: Multiple small clusters appearing at the bottom

### Event 2: Merge Level 0 → Level 1
- **Duration**: 2.5 seconds total
  - 0.0s - 1.5s: Children animate upward toward parent positions
  - 1.5s - 2.5s: Children fade out, parents fade in
  - After: Camera remains centered
- **Action**: 
  1. Level 0 clusters move UP (Y increases)
  2. Clusters converge horizontally toward parent X positions
  3. Children fade out as they reach destination
  4. Parent clusters fade in
- **User sees**: Clusters rising and combining into fewer, larger clusters

### Event 3-5: Continue Merging
- Same animation pattern repeated for each level
- Fewer clusters visible at each successive level
- Clusters progressively combine

### Event 6: Complete
- **Action**: Zoom in on final merged reconstruction
- **Zoom factor**: 0.12 (very close)
- **User sees**: Complete Gerrard Hall filling ~80% of screen

---

## Layout Parameters

```javascript
// Vertical spacing between levels
VISUAL_SPACING = 25;  // Units between each level

// Horizontal spacing between clusters at same level
CLUSTER_SPACING = 10;  // Units between sibling clusters

// Animation timing
MERGE_DURATION = 2500;   // How long clusters take to rise (ms)
CAMERA_DELAY = 2000;     // When camera moves (after merge mostly done)
CAMERA_DURATION = 800;   // Camera pan duration (ms)

// Final zoom
FINAL_ZOOM_FACTOR = 0.12;  // Camera distance multiplier for final view
```

### Level Y Positions (Centered around Y=0)

For a tree with maxDepth=4:

| Level | Y Position | Calculation |
|-------|------------|-------------|
| 0 | -50 | `0 * 25 - 50` |
| 1 | -25 | `1 * 25 - 50` |
| 2 | 0 | `2 * 25 - 50` |
| 3 | +25 | `3 * 25 - 50` |
| 4 | +50 | `4 * 25 - 50` |

---

## Data Loading Process

### 1. Structure Definition
The `DataLoader` class defines the hierarchy matching the GTSfM output:

```javascript
getStructure() {
    return {
        'merged': { 
            type: 'merged', 
            children: ['ba_output', 'C_1/merged', 'C_2/merged', 'C_3/merged', 'C_4/merged'] 
        },
        'C_1': {
            'merged': { 
                type: 'merged', 
                children: ['C_1/ba_output', 'C_1/C_1_1/merged', 'C_1/C_1_2/merged'] 
            },
            // ... sub-clusters
        },
        // ... other clusters
    };
}
```

### 2. Point Cloud Loading
Each cluster's `points3D.txt` is parsed:
```javascript
// Format: POINT3D_ID X Y Z R G B ERROR TRACK[]
const x = parseFloat(parts[1]);
const y = parseFloat(parts[2]);
const z = parseFloat(parts[3]);
const r = parseInt(parts[4]) / 255;  // Normalize to 0-1
const g = parseInt(parts[5]) / 255;
const b = parseInt(parts[6]) / 255;
```

### 3. Global Normalization
All clusters are:
1. Centered around the merged cluster's centroid
2. Scaled uniformly to fit the visualization
3. Colors preserved from original RGB values

---

## File Structure

```
gerrard-hall-v3/
├── slab.html                    # Entry point for Slab View
├── js/
│   ├── data-loader.js           # Loads point clouds, builds cluster hierarchy
│   ├── layout-engine-slab.js    # Computes X,Y positions using tree layout
│   ├── animation-engine-slab.js # Handles merge animations and timeline
│   └── main-slab.js             # Main app, camera, rendering, UI
└── data/
    └── gerrard-hall/
        └── results/             # GTSfM pipeline output
            ├── merged/          # Final reconstruction
            ├── C_1/, C_2/, ...  # Cluster hierarchies
            └── cluster_tree.pkl # Serialized tree structure
```

---

## Key Implementation Details

### 1. Tree Traversal (Layout Engine)
```javascript
// Start from root (merged), traverse to leaves
const traverse = (cluster, depth = 0) => {
    const node = { cluster, depth, children: [], level: 0 };
    
    for (const child of cluster.children) {
        const childNode = traverse(child, depth + 1);
        node.children.push(childNode);
    }
    
    return node;
};

// Invert depth to level (leaves at bottom)
node.level = maxDepth - node.depth;
```

### 2. X Position Assignment (Reingold-Tilford)
```javascript
const assignX = (node) => {
    if (node.children.length === 0) {
        // Leaf: assign next available X
        node.x = nextX;
        nextX += CLUSTER_SPACING;
    } else {
        // Internal: center over children
        for (const child of node.children) assignX(child);
        node.x = (firstChild.x + lastChild.x) / 2;
    }
};
```

### 3. Merge Animation
```javascript
animateMerge(fromLevel, toLevel) {
    // Phase 1: Children rise and converge
    for (const cluster of fromClusters) {
        const targetX = cluster.parent.slabPosition.x;
        const targetY = toLevel * VISUAL_SPACING + yOffset;
        
        // Animate position from current to target
        // Fade out in last 40% of animation
    }
    
    // Phase 2: Parents fade in (at 60% of animation)
    setTimeout(() => {
        for (const cluster of toClusters) {
            // Fade in parent clusters
        }
    }, MERGE_DURATION * 0.6);
}
```

### 4. Camera Behavior
- Camera stays FIXED at center (Y=0) during animations
- All levels visible simultaneously due to compact spacing
- Final zoom-in on complete reconstruction

---

## Alignment with Frank's Vision

This implementation follows Frank's "sheets of glass" concept:

| Requirement | Implementation |
|-------------|----------------|
|  Clusters on horizontal layers | Y position based on level |
|  Layers stacked vertically | Levels 0-4 from bottom to top |
|  Sequential merging | Animation shows clusters rising and combining |
|  Visual merge representation | Children physically move toward parents |
|  Hierarchical reconstruction | Tree structure from GTSfM preserved |
|  Final merged building | Zoom-in on complete Gerrard Hall at end |

### Key Insight
Users should **SEE** the merging happen - clusters physically moving upward and combining - not just appearing/disappearing. This makes the GTSfM pipeline's hierarchical reconstruction process tangible and understandable.

---

## Console Debug Output

When running, the console shows:
```
=== SLAB LAYOUT ENGINE ===
Total clusters loaded: 24
Root cluster found: YES

=== CLUSTERS PER LEVEL ===
Level 0: 6 clusters
  - C_1/C_1_1/merged
  - C_1/C_1_2/merged
  - C_4/C_4_1/C_4_1_1/merged
  - C_4/C_4_1/C_4_1_2/merged
  - C_4/C_4_2/C_4_2_1/merged
  - C_4/C_4_2/C_4_2_2/merged
Level 1: 4 clusters
  - C_4/C_4_1/merged
  - C_4/C_4_2/merged
  ...
Level 4: 1 cluster
  - merged
```

This confirms the visualization correctly represents the GTSfM output structure.
