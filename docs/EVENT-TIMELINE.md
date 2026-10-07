# GTSfM Timeline View - Complete 38-Event Breakdown

This document describes all 38 events in the Timeline View visualization, showing how GTSfM hierarchically reconstructs Gerrard Hall.

## Event Types

| Type | Events | Description | Animation |
|------|--------|-------------|-----------|
| **fade_in** | 1-19 | Raw `ba_output` reconstructions appear | Point cloud fades in at bottom level |
| **leaf_promotion** | 20-30 | Leaf clusters promote to `merged` | Single cluster rises and transforms |
| **parent_merge** | 31-37 | Parent clusters combine children | Multiple clusters converge and combine |
| **final_merge** | 38 | Root merge creates complete building | Grand finale with camera zoom |

---

## Phase 1: ba_output Events (Raw Reconstructions Appear)

Events 1-19 show individual bundle adjustment outputs appearing. Order is randomized to simulate async compute cluster processing.

| Event | Path | Type | Animation |
|-------|------|------|-----------|
| **1** | `C_4/C_4_1/C_4_1_1/C_4_1_1_1/ba_output` | fade_in | Point cloud fades in at bottom level |
| **2** | `C_4/C_4_1/C_4_1_1/C_4_1_1_1/C_4_1_1_1_2/ba_output` | fade_in | Point cloud fades in at bottom level |
| **3** | `C_4/C_4_1/C_4_1_1/C_4_1_1_2/C_4_1_1_2_2/ba_output` | fade_in | Point cloud fades in at bottom level |
| **4** | `C_1/ba_output` | fade_in | Point cloud fades in at bottom level |
| **5** | `C_4/C_4_1/ba_output` | fade_in | Point cloud fades in at bottom level |
| **6** | `C_3/ba_output` | fade_in | Point cloud fades in at bottom level |
| **7** | `C_4/C_4_1/C_4_1_2/ba_output` | fade_in | Point cloud fades in at bottom level |
| **8** | `ba_output` | fade_in | Point cloud fades in at bottom level |
| **9** | `C_1/C_1_2/ba_output` | fade_in | Point cloud fades in at bottom level |
| **10** | `C_4/ba_output` | fade_in | Point cloud fades in at bottom level |
| **11** | `C_4/C_4_1/C_4_1_1/C_4_1_1_2/ba_output` | fade_in | Point cloud fades in at bottom level |
| **12** | `C_4/C_4_1/C_4_1_1/C_4_1_1_2/C_4_1_1_2_1/ba_output` | fade_in | Point cloud fades in at bottom level |
| **13** | `C_4/C_4_1/C_4_1_1/C_4_1_1_1/C_4_1_1_1_1/ba_output` | fade_in | Point cloud fades in at bottom level |
| **14** | `C_4/C_4_2/C_4_2_1/ba_output` | fade_in | Point cloud fades in at bottom level |
| **15** | `C_4/C_4_2/C_4_2_2/ba_output` | fade_in | Point cloud fades in at bottom level |
| **16** | `C_4/C_4_2/ba_output` | fade_in | Point cloud fades in at bottom level |
| **17** | `C_2/ba_output` | fade_in | Point cloud fades in at bottom level |
| **18** | `C_1/C_1_1/ba_output` | fade_in | Point cloud fades in at bottom level |
| **19** | `C_4/C_4_1/C_4_1_1/ba_output` | fade_in | Point cloud fades in at bottom level |

---

## Phase 2: merged Events (Hierarchical Merges)

Events 20-38 show the hierarchical merge process. Order respects dependencies: children must complete before parents.

### Leaf Promotions (Events 20-30)

These clusters have no children - they simply "promote" their `ba_output` to `merged`.

| Event | Path | Inputs | Type | Animation |
|-------|------|--------|------|-----------|
| **20** | `C_2/merged` | `C_2/ba_output` | leaf_promotion | Rises up, glows, becomes merged |
| **21** | `C_1/C_1_1/merged` | `C_1/C_1_1/ba_output` | leaf_promotion | Rises and transforms |
| **22** | `C_4/C_4_2/C_4_2_1/merged` | `C_4/C_4_2/C_4_2_1/ba_output` | leaf_promotion | Rises and transforms |
| **23** | `C_4/C_4_2/C_4_2_2/merged` | `C_4/C_4_2/C_4_2_2/ba_output` | leaf_promotion | Rises and transforms |
| **24** | `C_4/C_4_1/C_4_1_2/merged` | `C_4/C_4_1/C_4_1_2/ba_output` | leaf_promotion | Rises and transforms |
| **25** | `C_4/C_4_1/C_4_1_1/C_4_1_1_2/C_4_1_1_2_1/merged` | ba_output | leaf_promotion | Rises and transforms |
| **26** | `C_1/C_1_2/merged` | `C_1/C_1_2/ba_output` | leaf_promotion | Rises and transforms |
| **27** | `C_4/C_4_1/C_4_1_1/C_4_1_1_2/C_4_1_1_2_2/merged` | ba_output | leaf_promotion | Rises and transforms |
| **28** | `C_4/C_4_1/C_4_1_1/C_4_1_1_1/C_4_1_1_1_2/merged` | ba_output | leaf_promotion | Rises and transforms |
| **29** | `C_3/merged` | `C_3/ba_output` | leaf_promotion | Rises and transforms |
| **30** | `C_4/C_4_1/C_4_1_1/C_4_1_1_1/C_4_1_1_1_1/merged` | ba_output | leaf_promotion | Rises and transforms |

### Parent Merges (Events 31-37)

These clusters combine their `ba_output` with children's `merged` results.

| Event | Path | Inputs | Type | Animation |
|-------|------|--------|------|-----------|
| **31** | `C_4/C_4_1/C_4_1_1/C_4_1_1_2/merged` | ba_output + C_4_1_1_2_1/merged + C_4_1_1_2_2/merged | parent_merge | 3 clusters rise and combine |
| **32** | `C_1/merged` | C_1/ba_output + C_1_1/merged + C_1_2/merged | parent_merge | 3 clusters combine |
| **33** | `C_4/C_4_1/C_4_1_1/C_4_1_1_1/merged` | ba_output + C_4_1_1_1_1/merged + C_4_1_1_1_2/merged | parent_merge | 3 clusters combine |
| **34** | `C_4/C_4_2/merged` | C_4/C_4_2/ba_output + C_4_2_1/merged + C_4_2_2/merged | parent_merge | 3 clusters combine |
| **35** | `C_4/C_4_1/C_4_1_1/merged` | ba_output + C_4_1_1_1/merged + C_4_1_1_2/merged | parent_merge | 3 clusters combine |
| **36** | `C_4/C_4_1/merged` | ba_output + C_4_1_1/merged + C_4_1_2/merged | parent_merge | 3 clusters combine |
| **37** | `C_4/merged` | C_4/ba_output + C_4_1/merged + C_4_2/merged | parent_merge | 3 clusters combine |

### Final Merge (Event 38)

| Event | Path | Inputs | Type | Animation |
|-------|------|--------|------|-----------|
| **38** | `merged` | ba_output + C_1/merged + C_2/merged + C_3/merged + C_4/merged | final_merge | 5 clusters converge, camera zooms to complete Gerrard Hall |

---

## Animation Details

### Type A: Fade In
```
[empty] → [point cloud appears]
Duration: 500ms
Effect: Opacity 0 → 1
```

### Type B: Leaf Promotion
```
[ba_output at level N] → [merged at level N+1]
Duration: 800ms
Effect: Rise upward + glow + transform
```

### Type C: Parent Merge
```
[ba_output + child_1/merged + child_2/merged] → [parent/merged]
Duration: 1500ms
Effect: Multiple rise + converge + combine
```

### Type D: Final Merge
```
[5 top-level clusters] → [complete Gerrard Hall]
Duration: 2500ms
Effect: Grand convergence + camera zoom
```

---

## Visual Timeline

```
TIME →

Events 1-19:  ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○
              (19 ba_output clusters fade in at bottom)

Events 20-30: ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑
              (11 leaf clusters rise up / promote)

Events 31-37: ⊕ ⊕ ⊕ ⊕ ⊕ ⊕ ⊕
              (7 parent merges - multiple children combine)

Event 38:      FINAL MERGE →  GERRARD HALL
              (5 clusters become complete building)
```

---

## Dependency Graph

```
                              merged (Event 38)
                                    │
         ┌──────────┬───────────┬───┴───┬──────────┐
         │          │           │       │          │
    ba_output   C_1/merged  C_2/merged C_3/merged C_4/merged
     (E8)        (E32)       (E20)     (E29)      (E37)
                   │                                │
           ┌───────┼───────┐                ┌───────┴───────┐
           │       │       │                │               │
        ba_out  C_1_1   C_1_2          ba_output      C_4_1/merged
         (E4)  /merged /merged          (E10)          (E36)
               (E21)   (E26)                              │
                                               ┌──────────┼──────────┐
                                               │          │          │
                                           ba_output  C_4_1_1/    C_4_1_2/
                                            (E5)      merged       merged
                                                      (E35)        (E24)
                                                         │
                                              ┌──────────┼──────────┐
                                              │          │          │
                                          ba_output  C_4_1_1_1/  C_4_1_1_2/
                                           (E19)     merged      merged
                                                     (E33)       (E31)
```

This graph continues deeper for the C_4 branch, which has the most complex hierarchy.
