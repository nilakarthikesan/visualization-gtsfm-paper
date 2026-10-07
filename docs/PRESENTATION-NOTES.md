# GTSfM Visualization - Presentation Notes

## Meeting Agenda

### 1. Introduction (2 min)
- Goal: Visualize GTSfM's hierarchical reconstruction process
- Target: Gerrard Hall dataset
- Output: Interactive 3D web visualization

---

### 2. GTSfM Pipeline Recap (3 min)

**Input:** Multiple images of Gerrard Hall

**Process:**
1. Images divided into clusters (C_1, C_2, C_3, C_4)
2. Each cluster runs bundle adjustment → `ba_output`
3. Clusters merged hierarchically → `merged`
4. Final complete reconstruction

**Output:** 3D point cloud with camera positions

---

### 3. Directory Structure Deep Dive (5 min)

```
results/
├── merged/              ← FINAL (complete Gerrard Hall)
├── ba_output/           ← Root's direct reconstruction
├── C_1/
│   ├── ba_output/       ← C_1's direct reconstruction
│   ├── merged/          ← C_1 + children combined
│   ├── C_1_1/merged/
│   └── C_1_2/merged/
├── C_2/merged/          ← Leaf (no children)
├── C_3/merged/          ← Leaf
└── C_4/                 ← Complex subtree
    ├── C_4_1/C_4_1_1/C_4_1_1_1/...  (deepest)
    └── ...
```

**Key Insight:** 
- `merged = ba_output + all_children_merged`
- 19 ba_output folders, 19 merged folders = 38 total events

---

### 4. Three Visualization Approaches (5 min)

#### A. Slab View (Frank's Vision)
- Horizontal layers like "sheets of glass"
- Clusters rise upward and merge
- Camera follows action
- **Demo:** http://localhost:8086/slab.html

#### B. Hierarchy View
- Traditional tree layout
- Parent-child relationships clear
- **Demo:** http://localhost:8086/hierarchy.html

#### C. Puzzle View
- Real 3D spatial positions
- Pieces assemble like puzzle
- **Demo:** http://localhost:8086/puzzle.html

---

### 5. Animation Timeline Logic (5 min)

**Phase 1: ba_output events (1-19)**
- Order: Random (simulating async compute)
- All can run in parallel (no dependencies)

**Phase 2: merged events (20-38)**
- Order: Children before parents (dependency constraint)
- Random within constraint (async simulation)
- Root `merged` always LAST

**Example:**
```
Event 20: C_4/C_4_1/C_4_1_1/merged  (deep leaf)
Event 21: C_1/C_1_1/merged          (leaf)
...
Event 36: C_4/merged                (after all C_4 children)
Event 37: C_1/merged                (after all C_1 children)
Event 38: merged                    (ROOT - requires all above)
```

---

### 6. Technical Implementation (3 min)

**Stack:**
- Three.js for 3D rendering
- Vanilla JavaScript (ES6 modules)
- Python HTTP server for development

**Key Files:**
- `data-loader.js` - Parses GTSfM output
- `layout-engine-*.js` - Positions clusters
- `animation-engine-*.js` - Handles timing
- `main-*.js` - Wires everything together

---

### 7. Current Challenges (3 min)

1. **Cluster Positioning:** How to place clusters so merges look natural?
2. **Animation Clarity:** Ensure users can see what's merging with what
3. **Scale:** Final building should fill most of screen
4. **Orientation:** Building should appear right-side up

---

### 8. Demo (5 min)

Live walkthrough of:
1. Slab View animation (primary)
2. Quick look at Hierarchy View
3. Final merged Gerrard Hall

---

### 9. Discussion / Feedback (5 min)

**Questions:**
1. Does animation clearly convey merge process?
2. Which view best serves Frank's vision?
3. What improvements are highest priority?
4. Should we add labels/annotations?

---

## Key Talking Points

### Why Three Views?
- Different mental models for different audiences
- Slab = temporal/process view
- Hierarchy = structural/tree view
- Puzzle = spatial/physical view

### The Merge Constraint
```
A parent merged folder can only be created
AFTER all its children merged folders exist.
```
This is fundamental to how GTSfM works and our animation respects this.

### Frank's "Sheets of Glass"
- Each horizontal layer is a "sheet"
- Clusters sit on sheets at their level
- Animation shows clusters rising through sheets
- Final sheet holds complete reconstruction

---

## Backup Material

### Point Cloud Stats
- ~24,000 points in final reconstruction
- Each `points3D.txt` contains: ID, X, Y, Z, R, G, B, error
- Colors from original images (not synthetic)

### Cluster Counts
| Level | Description | Count |
|-------|-------------|-------|
| Root | Final merged | 1 |
| Top clusters | C_1, C_2, C_3, C_4 | 4 |
| Second level | C_1_1, C_1_2, C_4_1, C_4_2 | 4+ |
| Deepest | C_4_1_1_1_1, etc. | many |

### Repository
https://github.com/nilakarthikesan/visualization-gtsfm-paper
