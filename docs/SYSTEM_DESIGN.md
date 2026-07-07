# Gerrard Hall 3D Reconstruction Visualization — System Design

## Overview

This project visualizes the hierarchical 3D reconstruction of Gerrard Hall (UNC Chapel Hill) produced by the GTSfM pipeline. The visualization renders point cloud data in a web browser using Three.js, animating the progressive assembly of the building from individual VGGT clusters through hierarchical merges into a final unified reconstruction.

## Architecture

### Data Flow

```
COLMAP/GTSfM Output (points3D.txt, images.txt, timestamps.json)
        |
        v
  VGGTDataLoader — parses point clouds, cameras, timestamps
        |
        v
  SquarenessLayoutEngine — assigns spatial positions via recursive rectangle subdivision
        |
        v
  SquarenessAnimationEngine — builds merge timeline, handles transitions
        |
        v
  Three.js Scene — renders point clouds, frustums, post-processing
        |
        v
  Browser Canvas — user sees the interactive visualization
```

### Module Responsibilities

| Module | File | Purpose |
|--------|------|---------|
| **App Shell** | `js/main-hierarchy-vggt.js` | Orchestrates all engines, manages UI, animation loop, post-processing pipeline |
| **Data Loader** | `js/data-loader-vggt.js` | Loads COLMAP-format point clouds, camera extrinsics, timestamps; normalizes geometry; computes point matching between parent/child clusters |
| **Layout Engine** | `js/layout-engine-squareness.js` | Recursive treemap algorithm that assigns screen-space rectangles to leaf clusters, optimizing for squareness |
| **Animation Engine** | `js/animation-engine-squareness.js` | Builds event timeline from tree structure; handles fade-in, fade-out, and merge transition animations with pre-allocated GPU buffers |
| **Camera Engine** | `js/camera-engine.js` | Auto-orbit, flythrough paths, user interaction tracking |
| **Frustum Engine** | `js/frustum-engine.js` | Loads per-cluster camera data, builds wireframe frustum visualizations, manages visibility with fade transitions |
| **Interaction Engine** | `js/interaction-engine.js` | Raycaster-based hover detection for point clouds |
| **Point Material** | `js/point-material.js` | Custom ShaderMaterial with 3 render modes (Gaussian Splat, Sharp Dense, Glowing Particles), blend configuration per mode |
| **EDL Pass** | `js/edl-pass.js` | Eye-Dome Lighting post-processing for depth-aware edge enhancement |
| **Particle Engine** | `js/particle-engine.js` | Ambient particle effects during merge transitions |

### File Structure

```
gerrard-hall-v3-2/
├── hierarchy-vggt.html          # Main entry point (HTML + CSS + UI)
├── index.html                   # Menu/landing page
├── js/
│   ├── main-hierarchy-vggt.js   # App shell
│   ├── data-loader-vggt.js      # Data loading + normalization
│   ├── layout-engine-squareness.js  # Spatial layout
│   ├── animation-engine-squareness.js  # Timeline + transitions
│   ├── camera-engine.js         # Camera control
│   ├── frustum-engine.js        # Camera frustum visualization
│   ├── interaction-engine.js    # Hover/click interaction
│   ├── point-material.js        # Custom shaders + blend modes
│   ├── edl-pass.js              # Eye-Dome Lighting pass
│   └── particle-engine.js       # Merge particle effects
├── data/
│   └── gerrard-hall-vggt/
│       └── results/             # GTSfM output (points3D.txt, images.txt per cluster)
├── docs/                        # Documentation
└── assets/                      # Static assets
```

## Completed Features

### Core Visualization
- **Point Cloud Rendering**: COLMAP-format point cloud loading with RGB colors from `points3D.txt`
- **Hierarchical Structure**: Tree of VGGT leaf clusters and merged parent clusters reflecting GTSfM pipeline structure
- **Scene Normalization**: Global centering, scaling to TARGET_SIZE=300, camera-derived scene orientation rotation
- **PCA Front Alignment**: Principal Component Analysis on merged cluster's XZ coordinates to orient the building facade toward the viewer

### Layout System
- **Squareness-Optimized Treemap**: Recursive rectangle subdivision that evaluates all possible partitions of children into contiguous groups, scoring by worst-case squareness ratio
- **Weight-Proportional Sizing**: Leaf tile areas proportional to squared radius of cluster point clouds
- **Merge Region Computation**: Non-leaf nodes get merge regions spanning the bounding box of their descendant leaf rectangles

### Animation System
- **Timeline Events**: Ordered sequence of leaf appearances and merge transitions, supporting both timestamp-based and structural ordering
- **Timestamp Integration**: File modification times used as pipeline execution timestamps; gaps compressed into a 20-second animation window with configurable min/max delays
- **Merge Transitions**: Point-matched interpolation between child clusters and merged parent using pre-allocated GPU buffers (matched pairs, child-only fly targets, merged-only fly sources)
- **Pre-allocated Buffers**: Three reusable `Points` objects with `DynamicDrawUsage` avoid per-merge GPU allocation, eliminating frame spikes
- **Fade In/Out**: Smooth opacity transitions for leaf cluster appearance/disappearance

### Render Styles
- **Gaussian Splat**: Soft Gaussian falloff (`exp(-dist^2 * 2)`) with normal blending
- **Sharp Dense**: Hard-edged circles via `smoothstep(0.5, 0.42, dist)` — default style
- **Glowing Particles**: Core + halo with premultiplied alpha; additive blending on dark theme for glow effect

### Camera System
- **OrbitControls**: Standard Three.js orbit/pan/zoom with damping
- **Auto-Orbit**: Slow automatic rotation when user is not interacting
- **Dynamic Camera Reframing**: `fitCameraToVisible()` computes bounding box of currently visible clusters and smoothly animates camera to frame them; uses layout rectangles for intermediate events and geometry bounding boxes for the final merged view
- **Animated Transitions**: Ease-in-out-quad interpolation between camera positions

### Camera Frustums
- **Wireframe Pyramids**: Per-cluster camera frustum visualization from COLMAP extrinsics
- **Coordinated Visibility**: Frustums sync with timeline events via `syncToEventIndex()`
- **Fade Transitions**: Smooth opacity fade-in/fade-out when clusters appear/merge

### UI & Controls
- **Timeline Playback**: Play/Pause, Prev/Next, Reset, scrubbar click-to-seek
- **Keyboard Shortcuts**: Space (play/pause), Arrow keys (step), R (reset)
- **Render Style Dropdown**: Switch between 3 point rendering modes
- **Dark/Light Theme**: Toggle with localStorage persistence; adjusts scene background, bloom parameters, tone mapping
- **Recording**: MediaRecorder API captures canvas at 30fps VP9 WebM, ~5Mbps
- **Stats Display**: Live cluster count and point count

### Post-Processing (Existing)
- **Bloom**: UnrealBloomPass with theme-dependent strength/threshold (dark: 0.5/0.6, light: 0.15/0.9)
- **Tone Mapping**: ACESFilmicToneMapping on dark theme, NoToneMapping on light

## Planned Enhancements

### Post-Processing Pipeline Expansion
- **Vignette**: Subtle edge darkening to focus viewer attention on the building
- **Color Grading**: Adjustable brightness, contrast, saturation with UI sliders
- **Eye-Dome Lighting (EDL)**: Screen-space depth-aware edge enhancement that darkens depth discontinuities, making point cloud structure dramatically more readable (inspired by Potree)
- **Depth of Field (removed)**: BokehPass was implemented but removed — the massive depth discontinuities inherent in point cloud data caused visual "spasming" artifacts that degraded the final view

### Background Options
- **Gradient Backgrounds**: Switchable presets (Warm Sunset, Cool Blue, Neutral Gray) implemented as fullscreen quads with gradient shaders
- **Ground Grid**: Semi-transparent grid plane below the point cloud for spatial reference, fading at edges

### Camera Fly-Through System
- **Orbit Tour**: Smooth 360-degree orbit around the building at fixed elevation
- **Cinematic Tour**: Multi-keyframe camera path with Catmull-Rom spline interpolation (front → side → top-down → back → sweep)
- **UI Integration**: Camera mode dropdown (Free, Orbit Tour, Cinematic Tour), available on final assembled view

### Ambient Merge Particles (Experimental)
- Small semi-transparent particles that appear in the merge region during transitions
- Drift toward merge center with gentle wobble, fade in/out over ~1.5s
- Toggleable via UI checkbox

## Technical Decisions

### Why Squareness Layout
The squareness-optimized treemap was chosen over alternatives (grid, force-directed, spiral) because it:
- Guarantees non-overlapping placements without collision detection
- Naturally represents the hierarchical merge tree structure
- Produces visually balanced layouts where each cluster gets proportional space
- Allows merge regions to be computed as bounding boxes of descendant leaves

### Why Sharp Dense as Default
After testing all three render modes with the denser dataset, Sharp Dense was selected as the default because:
- `smoothstep(0.5, 0.42, dist)` produces clean, anti-aliased circular points without excessive softness
- Point size of 6.0 (vs 18.0 for splat, 14.0 for glow) gives the densest, most solid appearance
- Normal blending avoids the visual complexity of premultiplied alpha or additive blending

### Why Pre-allocated Transition Buffers
Creating new `BufferGeometry`/`Float32Array`/`ShaderMaterial` on each merge caused frame spikes on integrated GPUs. Pre-allocating three reusable transition clouds with `DynamicDrawUsage` and updating via `setDrawRange()` eliminates GPU allocation overhead during animations.

### Why PCA for Front Alignment
Simple camera-to-building centroid direction could leave the building at an angle. PCA on the merged cluster's XZ coordinates finds the principal horizontal axis of the building's footprint. Rotating to align this with the X-axis ensures the widest facade faces the camera directly.

## Inspiration Sources

- **Potree** (potree.org): Eye-Dome Lighting, LOD rendering, measurement tools for massive point clouds
- **SuperSplat** (superspl.at): Post-processing pipeline (vignette, color grading, bloom), annotations, camera path authoring
- **Nerfstudio** (nerf.studio): Real-time web viewer, camera path export, adaptive rendering quality
- **Rerun** (rerun.io): SfM pipeline visualization with camera frames, reprojection error, temporal ordering
- **Codrops/Three.js Community**: Particle effects, dreamy GPGPU particles, atmospheric dust techniques
- **Eric Brachmann** (twitter.com/eric_brachmann): 3D reconstruction research and visual storytelling

## Dependencies

- **Three.js 0.160.0** (via unpkg CDN): Core 3D rendering, including `EffectComposer`, `RenderPass`, `UnrealBloomPass`, `ShaderPass`, `OrbitControls`
- **ES6 Modules**: Native browser module system, no build step required
- **Python HTTP Server**: `python3 -m http.server 8080` for local development
