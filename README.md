# Gerrard Hall 3D Reconstruction Visualization

Interactive Three.js visualization of the GTSfM hierarchical clustering pipeline for 3D reconstruction of Gerrard Hall at UNC Chapel Hill. The visualization shows how individual VGGT cluster reconstructions are progressively merged into a complete building model.

## Quick Start

### 1. Add the reconstruction data

Place the GTSfM results folder at:

```
data/gerrard-hall-vggt/results/
```

The folder must contain the hierarchical cluster structure with `points3D.txt`, `images.txt`, and `cameras.txt` files in each `vggt/` and `merged/` subdirectory.

### 2. Start the server

```bash
python3 -m http.server 8080
```

### 3. Open the visualization

Navigate to [http://localhost:8080/hierarchy-vggt.html](http://localhost:8080/hierarchy-vggt.html) in your browser.

## Controls

| Button | Action |
|--------|--------|
| **Play/Pause** | Auto-advance through all timeline events |
| **Prev/Next** | Step through events one at a time |
| **Reset** | Return to the first event |
| **Record** | Start/stop recording the visualization as a `.webm` video |

You can also click anywhere on the timeline progress bar to jump to a specific event, and use mouse drag to orbit, scroll to zoom, and right-click drag to pan.

## Recording

Click the **Record** button to start capturing the visualization. The button turns red and pulses while recording. Click **Stop** to end the recording -- the video file will automatically download to your browser's default download location. Move recorded files to the `recordings/` folder in this repo for safekeeping.

## Architecture

- `js/data-loader-vggt.js` -- Loads point cloud data and camera extrinsics, computes scene orientation from COLMAP camera poses
- `js/layout-engine-squareness.js` -- Recursive rectangle subdivision layout optimized for tile squareness
- `js/animation-engine-squareness.js` -- Timeline system with per-point merge interpolation (alpha blending)
- `js/main-hierarchy-vggt.js` -- App entry point, Three.js scene setup, UI, and recording
