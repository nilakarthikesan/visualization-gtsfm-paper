# GTSfM Hierarchical Reconstruction Visualization
## Presentation for Frank

---

## 1. The Problem We're Solving

### What GTSfM Produces
GTSfM (Georgia Tech Structure from Motion) outputs a hierarchical reconstruction:
- **19 `ba_output/` folders** - Raw cluster reconstructions from different image subsets
- **19 `merged/` folders** - Hierarchical merges combining clusters into larger reconstructions
- **Final `merged/`** - The complete Gerrard Hall point cloud

### The Challenge
- GTSfM produces results but **no visual explanation** of:
  - When each merge happens
  - Which clusters combine together
  - How the final building is assembled step-by-step
- The merge tree is **implicit** in the directory structure but not visualized

### Our Solution
A **38-event timeline visualization** that shows:
1. Every cluster appearing
2. Every merge operation
3. The complete assembly process from fragments to final building

---

## 2. Understanding the Cluster Hierarchy

### Directory Structure = Merge Tree
```
results/
├── ba_output/          ← Root's direct reconstruction
├── merged/             ← FINAL (Event 38)
├── C_1/
│   ├── ba_output/      ← C_1's reconstruction
│   ├── merged/         ← C_1 merge (Event 32)
│   ├── C_1_1/
│   │   ├── ba_output/
│   │   └── merged/     ← Leaf promotion
│   └── C_1_2/
│       ├── ba_output/
│       └── merged/     ← Leaf promotion
├── C_2/
│   ├── ba_output/
│   └── merged/         ← Leaf promotion (no children)
├── C_3/
│   ├── ba_output/
│   └── merged/         ← Leaf promotion (no children)
└── C_4/                ← Deepest branch (7 levels)
    ├── ba_output/
    ├── merged/         ← Event 37
    ├── C_4_1/
    │   ├── merged/     ← Event 36
    │   └── C_4_1_1/
    │       └── C_4_1_1_1/
    │           └── C_4_1_1_1_1/  ← Deepest level
    └── C_4_2/
        └── merged/     ← Event 34
```

### Key Insight
**The merge formula at each level:**
```
parent/merged = parent/ba_output + child_1/merged + child_2/merged + ...
```

For example:
- `C_1/merged = C_1/ba_output + C_1_1/merged + C_1_2/merged`
- `merged (root) = ba_output + C_1/merged + C_2/merged + C_3/merged + C_4/merged`

---

## 3. The 38-Event Timeline

### Phase 1: Raw Reconstructions Appear (Events 1-19)
**Animation Type: FADE IN**

Each `ba_output` cluster fades into view at the bottom level of the visualization.

| Event | Path | What Appears |
|-------|------|--------------|
| 1 | `C_4/C_4_1/C_4_1_1/C_4_1_1_1/ba_output` | Deepest C_4 cluster |
| 4 | `C_1/ba_output` | C_1's portion of Gerrard Hall |
| 6 | `C_3/ba_output` | C_3's portion |
| 8 | `ba_output` (root) | Top-level direct reconstruction |
| 17 | `C_2/ba_output` | C_2's portion |
| ... | ... | ... |

**After Event 19:** All 19 point clouds visible - scattered fragments of Gerrard Hall.

### Phase 2: Leaf Promotions (Events 20-30)
**Animation Type: LEAF PROMOTION**

Leaf clusters (no children) transform their `ba_output` into `merged`:

| Event | Path | Transformation |
|-------|------|----------------|
| 20 | `C_2/merged` | `C_2/ba_output` → `C_2/merged` |
| 21 | `C_1/C_1_1/merged` | Rises and transforms |
| 29 | `C_3/merged` | `C_3/ba_output` → `C_3/merged` |

**Visual:** The `ba_output` rises upward, glows, and becomes a `merged` cluster at a higher level.

### Phase 3: Parent Merges (Events 31-37)
**Animation Type: PARENT MERGE**

Parent clusters combine their `ba_output` with children's `merged` results:

| Event | Path | Formula |
|-------|------|---------|
| 32 | `C_1/merged` | `= ba_output + C_1_1/merged + C_1_2/merged` |
| 34 | `C_4/C_4_2/merged` | `= ba_output + C_4_2_1/merged + C_4_2_2/merged` |
| 37 | `C_4/merged` | `= ba_output + C_4_1/merged + C_4_2/merged` |

**Visual:** Multiple clusters rise simultaneously, converge toward center, combine into one.

### Phase 4: Final Merge (Event 38)
**Animation Type: FINAL MERGE**

The grand finale - all top-level clusters combine:

```
merged (ROOT) = ba_output + C_1/merged + C_2/merged + C_3/merged + C_4/merged
```

**Visual:**
1. All 5 remaining clusters rise and converge
2. Complete Gerrard Hall point cloud appears
3. Camera zooms in
4. 360° rotation around the final building

---

## 4. Technical Implementation

### Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                      TimelineApp                             │
│                   (main-timeline.js)                         │
├─────────────────────────────────────────────────────────────┤
│  • Three.js scene setup                                      │
│  • Camera controls (OrbitControls)                           │
│  • UI: Prev/Next/Play/Reset buttons                          │
│  • Timeline scrubber                                         │
└─────────────────────────────────────────────────────────────┘
              │                              │
              ▼                              ▼
┌─────────────────────────┐    ┌─────────────────────────────┐
│  EventTimelineEngine    │    │  TimelineAnimationEngine    │
├─────────────────────────┤    ├─────────────────────────────┤
│  • Generates 38 events  │    │  • animateFadeIn()          │
│  • Topological sort     │    │  • animateLeafPromotion()   │
│  • Dependency tracking  │    │  • animateParentMerge()     │
│                         │    │  • animateFinalMerge()      │
│                         │    │  • focusCameraOnCluster()   │
└─────────────────────────┘    └─────────────────────────────┘
```

### Key Algorithms

**1. Topological Sort for Merge Events**
Ensures children are merged before parents:
```javascript
while (pendingMerged.length > 0) {
  const ready = pendingMerged.filter(p => allChildrenCompleted(p));
  const chosen = selectNext(ready);
  events.push(chosen);
  completed.add(chosen);
}
```

**2. Dynamic Camera Focus**
Camera automatically zooms to the cluster(s) being animated:
```javascript
focusCameraOnCluster(cluster, zoomFactor = 1.0) {
  const targetPosition = cluster.group.position.clone();
  const zoomDistance = cluster.radius * 3 / zoomFactor;
  // Smooth camera transition to focus on this cluster
}
```

**3. Hierarchical Layout**
Clusters positioned by level:
- **Y-axis:** Level in merge tree (leaves at bottom, root at top)
- **X-axis:** Spread within level (Reingold-Tilford algorithm)
- **Z-axis:** 0 (flat viewing plane)

### Data Loading
- PLY files loaded using Three.js `PLYLoader`
- Point clouds normalized to fit visualization space
- Colors preserved from original reconstruction (sRGB color space)

---

## 5. Visualization Views

We developed multiple views to explore the reconstruction:

### Timeline View (Primary)
- **38 discrete events**
- **4 animation types**
- **Dynamic camera focus**
- Step through or auto-play
- Shows merge process from start to finish

### Slab View
- Clusters on transparent "glass sheets"
- Vertical stacking by merge level
- Good for understanding hierarchy spatially

### Hierarchy View
- Traditional tree visualization
- Parent-child relationships explicit
- Good for understanding structure

### Puzzle View
- Clusters positioned by actual spatial coordinates
- Shows how pieces fit together geographically
- Good for understanding spatial relationships

---

## 6. Key Insights from Visualization

### What We Can Now See:
1. **Merge order matters** - Some branches (C_4) are much deeper than others
2. **Reconstruction coverage** - Each cluster covers different parts of the building
3. **Assembly process** - How 19 fragments become 1 complete model
4. **Hierarchical structure** - Why GTSfM uses divide-and-conquer

### Potential Applications:
- **Debugging** - See where merges might fail
- **Quality assessment** - Identify sparse regions
- **Education** - Understand SfM pipeline visually
- **Presentation** - Demonstrate GTSfM capabilities

---

## 7. Demo Walkthrough

### Starting Point
- Open `http://localhost:8086/timeline.html`
- See empty scene with UI controls at bottom

### Phase 1 Demo (Events 1-19)
- Click "Play Sequence" or step with "Next"
- Watch 19 point clouds fade in
- Camera focuses on each new cluster
- Notice scattered fragments at bottom level

### Phase 2 Demo (Events 20-30)
- Leaf clusters rise and transform
- `ba_output` → `merged` transitions
- Clusters move up to higher levels

### Phase 3 Demo (Events 31-37)
- Watch multiple clusters converge
- Parent merges combine 2-3 inputs each
- Tree collapses toward root

### Phase 4 Demo (Event 38)
- Final 5 clusters combine
- Complete Gerrard Hall appears
- 360° rotation showcase

---

## 8. Future Directions

### Potential Enhancements:
1. **Color-coded clusters** - Different colors per original cluster
2. **Playback speed control** - Adjust animation timing
3. **Cluster inspection** - Click to see metadata
4. **Comparison mode** - Side-by-side with ground truth
5. **Export capabilities** - Save animations as video

### Integration Ideas:
1. **GLOMAP integration** - Use for better global optimization visualization
2. **Real-time updates** - Show reconstruction as it happens
3. **Error visualization** - Highlight registration errors
4. **Camera pose display** - Show where images were taken

---

## 9. Summary

### What We Built
A complete visualization system for GTSfM's hierarchical reconstruction:
- **38-event timeline** following exact merge sequence
- **4 animation types** (fade-in, promotion, merge, final)
- **Dynamic camera** that focuses on active clusters
- **Multiple views** for different perspectives

### Key Achievement
**Made the implicit merge tree explicit and animated** - you can now see exactly how GTSfM builds the final reconstruction from image subsets.

### Demo Available
```bash
cd gerrard-hall-v3
python3 -m http.server 8086
# Open http://localhost:8086/timeline.html
```

---

## Questions?

Contact: [Nila Karthikesan](https://github.com/nilakarthikesan)
Repository: visualization-gtsfm-paper
