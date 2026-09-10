import * as THREE from 'three';
import { createMatchingSnapshot, matchCluster } from './point-matching.js?v=1';
import { createPointMaterial } from './point-material.js?v=47';

// pointScale: per-dataset base size multiplier. The v2 Brussels/C_* clouds are
// dense fine optimizations, so they read best with small points (~0.4) that
// preserve detail; Gerrard Hall's sparser sampled cloud keeps the default 1.0.
// Live-overridable via window.setPointSizeScale() or the ?psize= URL param.
// sceneName: friendly name of the actual reconstructed scene, used in viewer
// annotations (e.g. the final "Assembled ... — <scene>" label). Distinct from
// `label`, which is the dataset-picker text.
export const DATASETS = {
    original: { label: 'Gerrard Hall', sceneName: 'Gerrard Hall', basePath: 'data/gerrard-hall-vggt/results', useManifest: false, pointScale: 1.0 },
    // Cold single-session run (2026-09-10; k=120/0.15, Metis 30/70): 2-child root,
    // 25 leaves + 29 merges, real photo colors, real wall-clock timestamps (first leaf to
    // root merge spans 20.2 min). The earlier 3-cluster export lives in git history.
    BRUSSELS: { label: 'Brussels (full: C_1+C_2)', sceneName: 'Grand-Place Brussels', basePath: 'data/brussels-rerun', useManifest: true, pointScale: 0.4 },
    // The diverged C_2 merges (exploded-frame intermediate exports, coords up to 1e75)
    // were re-seated from their sane child exports on 2026-09-09
    // (paperresults/scripts/thanjavur_viz_reseat.py), so Thanjavur is offered again.
    THANJAVUR: { label: 'Thanjavur (temple)', sceneName: 'Thanjavur (Brihadeeswarar Temple)', basePath: 'data/thanjavur-vggt', useManifest: true, pointScale: 0.4 },
    // C_2 of this run is a single leaf (no merges), so only the C_1 branch is offered on its own.
    C_1: { label: 'C_1 (deep tree)', sceneName: 'Grand-Place Brussels', basePath: 'data/brussels-rerun/C_1', useManifest: true, pointScale: 0.4 }
    // C_4 (the "community photo collection") was removed: per Kathir, Dubrovnik
    // was never reconstructed successfully, so it should not be shown.
};

export const DEFAULT_DATASET = 'BRUSSELS';

export class Cluster {
    constructor(path, type, childrenPaths = []) {
        this.path = path;
        this.type = type; // 'vggt' or 'merged'
        this.childrenPaths = childrenPaths;
        
        this.group = new THREE.Group();
        this.pointCloud = null;
        this.pointsCount = 0;
        
        this.slabPosition = new THREE.Vector3();
        this.originalCenter = new THREE.Vector3();
        this.radius = 0;
        this.centroid = new THREE.Vector3();
        
        this.rect = null; // { x, y, w, h }
        
        this.parent = null;
        this.children = [];
    }

    setPointCloud(geometry, material) {
        this.pointCloud = new THREE.Points(geometry, material);
        this.pointCloud.userData = { cluster: this };
        this.group.add(this.pointCloud);
        
        geometry.computeBoundingSphere();
        this.centroid.copy(geometry.boundingSphere.center);
        this.radius = geometry.boundingSphere.radius;
        this.pointsCount = geometry.attributes.position.count;
    }
}

export class VGGTDataLoader {
    constructor(datasetKey = DEFAULT_DATASET) {
        if (!Object.hasOwn(DATASETS, datasetKey)) throw new Error(`Unknown dataset: ${datasetKey}`);
        this.dataset = DATASETS[datasetKey];
        this.datasetKey = datasetKey;
        this.basePath = this.dataset.basePath;
        this.clusters = new Map();
        this.root = null;
        this.globalCenter = new THREE.Vector3();
        this.globalRadius = 0;
        this.scaleFactor = 1.0;
        this.sceneRotation = new THREE.Matrix4();
    }

    async load() {
        let flatPaths;
        if (this.dataset.useManifest) {
            flatPaths = await this.loadStructureManifest();
        } else {
            flatPaths = this.flattenStructure(this.getStructure());
        }

        let loaded = 0;
        const total = flatPaths.length;

        for (const item of flatPaths) {
            const cluster = new Cluster(item.path, item.type, item.children);
            if (item.metrics) cluster.mergeMetrics = item.metrics;
            this.clusters.set(item.path, cluster);
        }

        // Link parents/children
        for (const [path, cluster] of this.clusters) {
            for (const childPath of cluster.childrenPaths) {
                const child = this.clusters.get(childPath);
                if (child) {
                    cluster.children.push(child);
                    child.parent = cluster;
                }
            }
        }

        // Load geometry
        const promises = flatPaths.map(async (item, index) => {
            await this.loadPointCloud(item.path, index);
            loaded++;
            if (this.onProgress) this.onProgress(loaded, total);
        });

        await Promise.all(promises);
        
        await this.loadTimestamps();
        for (const [path, cluster] of this.clusters) {
            if (this.timestamps[path] !== undefined) {
                cluster.timestamp = this.timestamps[path];
            }
        }

        await this.loadCameraExtrinsics();
        this.computeSceneOrientation();
        this.computeGlobalBoundsAndNormalize();
        
        return this.clusters;
    }

    async loadStructureManifest() {
        const response = await fetch(`${this.basePath}/structure.json`, { cache: 'no-cache' });
        if (!response.ok) {
            throw new Error(`Failed to fetch ${this.basePath}/structure.json`);
        }
        const manifest = await response.json();
        return manifest.clusters.map(c => ({
            path: c.path,
            type: c.type,
            children: c.children || [],
            metrics: c.metrics || null
        }));
    }

    async loadPointCloud(path, colorIndex) {
        try {
            const fullPath = `${this.basePath}/${path}`;
            // no-cache forces revalidation so updated exports (e.g. recolorized
            // points) are never masked by a stale browser-cached copy.
            const response = await fetch(`${fullPath}/points3D.txt`, { cache: 'no-cache' });
            if (!response.ok) throw new Error(`Failed to fetch ${fullPath}`);
            const text = await response.text();

            const positions = [];
            const colors = [];
            let hasRealColor = false;

            // Reject numerically diverged points. Some intermediate GTSFM merges (bundle
            // adjustment can blow up) export a large fraction of points at astronomically
            // large coordinates (1e18..1e75). A single such point poisons the global
            // bounds so scaleFactor -> 0 and the ENTIRE scene collapses to the origin.
            // VGGT/COLMAP metric coords are ~unit scale, so anything past OUTLIER_CAP is
            // non-physical divergence, not signal, and is dropped here.
            const OUTLIER_CAP = 1e7;

            const lines = text.split('\n');
            for (let line of lines) {
                if (line.startsWith('#') || line.trim() === '') continue;
                
                const parts = line.trim().split(/\s+/);
                if (parts.length < 8) continue;
                
                const x = parseFloat(parts[1]);
                const y = parseFloat(parts[2]);
                const z = parseFloat(parts[3]);
                if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
                if (Math.abs(x) > OUTLIER_CAP || Math.abs(y) > OUTLIER_CAP || Math.abs(z) > OUTLIER_CAP) continue;
                const r = parseInt(parts[4]);
                const g = parseInt(parts[5]);
                const b = parseInt(parts[6]);
                if (r || g || b) hasRealColor = true;

                positions.push(x, y, z);
                colors.push(r / 255, g / 255, b / 255);
            }

            // Some exports (e.g. Brussels C_1/C_2/C_3) write 0 0 0 for every
            // point's RGB. Synthesize a warm height gradient so they render
            // visibly until real photo colors are baked in (colorize_points.py).
            if (!hasRealColor && positions.length > 0) {
                this.applyFallbackColors(positions, colors);
            }

            if (positions.length > 0) {
                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
                geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
                
                geometry.computeBoundingSphere();
                const originalRadius = geometry.boundingSphere.radius;
                
                const posAttr = geometry.attributes.position;
                let sumX = 0, sumY = 0, sumZ = 0;
                for (let i = 0; i < posAttr.count; i++) {
                    sumX += posAttr.getX(i);
                    sumY += posAttr.getY(i);
                    sumZ += posAttr.getZ(i);
                }
                const originalCenter = new THREE.Vector3(
                    sumX / posAttr.count,
                    sumY / posAttr.count,
                    sumZ / posAttr.count
                );

                const material = createPointMaterial({ pointSize: 12.0 });

                const cluster = this.clusters.get(path);
                if (cluster) {
                    cluster.setPointCloud(geometry, material);
                    cluster.originalCenter.copy(originalCenter);
                    cluster.centroid.copy(originalCenter);
                    cluster.radius = originalRadius;
                }
            }
        } catch (e) {
            console.warn(`Error loading ${path}:`, e);
        }
    }
    
    /**
     * Warm sandstone gradient by height for colorless exports.
     * Raw VGGT coordinates have up ~= -Y, so smaller Y means higher up.
     */
    applyFallbackColors(positions, colors) {
        let minY = Infinity, maxY = -Infinity;
        for (let i = 1; i < positions.length; i += 3) {
            const y = positions[i];
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        const range = maxY - minY || 1;

        // Colorless exports (Brussels 0 0 0) render as a neutral gray height ramp so
        // they read on the white "paper" background, matching Kathir's grayscale look.
        // Wider low->high range than before gives the final model more legible
        // structure instead of a flat dull-gray blob while we wait on real RGB.
        // (Real RGB, when present, is used directly and never hits this path.)
        const lo = [0.24, 0.24, 0.27];
        const hi = [0.66, 0.66, 0.70];

        const count = positions.length / 3;
        for (let i = 0; i < count; i++) {
            const t = 1 - (positions[i * 3 + 1] - minY) / range; // invert: -Y is up
            // mild deterministic jitter so surfaces don't look flat
            const j = ((i * 2654435761) % 1000) / 1000 * 0.08 - 0.04;
            colors[i * 3]     = Math.min(1, Math.max(0, lo[0] + (hi[0] - lo[0]) * t + j));
            colors[i * 3 + 1] = Math.min(1, Math.max(0, lo[1] + (hi[1] - lo[1]) * t + j));
            colors[i * 3 + 2] = Math.min(1, Math.max(0, lo[2] + (hi[2] - lo[2]) * t + j));
        }
    }

    computeGlobalBoundsAndNormalize() {
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        let hasPoints = false;
        
        for (const [path, cluster] of this.clusters) {
            if (cluster.pointCloud && cluster.pointCloud.geometry) {
                const pos = cluster.pointCloud.geometry.attributes.position;
                for (let i = 0; i < pos.count; i++) {
                    const x = pos.getX(i);
                    const y = pos.getY(i);
                    const z = pos.getZ(i);
                    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
                    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
                    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
                    hasPoints = true;
                }
            }
        }

        if (!hasPoints) {
            console.warn("No points loaded, skipping normalization");
            return;
        }
        
        const mergedCluster = this.clusters.get('merged');
        // Bounds of the canonical root ("merged") cluster, gathered alongside its mean.
        let rootBounds = null; // [minX, maxX, minY, maxY, minZ, maxZ]
        if (mergedCluster && mergedCluster.pointCloud && mergedCluster.pointCloud.geometry) {
            const pos = mergedCluster.pointCloud.geometry.attributes.position;
            let sumX = 0, sumY = 0, sumZ = 0;
            let mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity, mnZ = Infinity, mxZ = -Infinity;
            for (let i = 0; i < pos.count; i++) {
                const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
                sumX += x; sumY += y; sumZ += z;
                if (x < mnX) mnX = x; if (x > mxX) mxX = x;
                if (y < mnY) mnY = y; if (y > mxY) mxY = y;
                if (z < mnZ) mnZ = z; if (z > mxZ) mxZ = z;
            }
            this.globalCenter.set(sumX / pos.count, sumY / pos.count, sumZ / pos.count);
            rootBounds = [mnX, mxX, mnY, mxY, mnZ, mxZ];
        } else {
            this.globalCenter.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
        }
        
        // Base the shared world scale on the canonical root cluster, which is always in
        // the final aligned, sanely-scaled frame. Intermediate merges can live in wildly
        // different local gauges (or diverge); using the global min/max would let one such
        // cluster shrink the whole scene toward a point. Per-cluster tile fitting is
        // scale-independent, so this only sets the world scale used for point/frustum sizing.
        const rb = rootBounds || [minX, maxX, minY, maxY, minZ, maxZ];
        const sizeX = rb[1] - rb[0];
        const sizeY = rb[3] - rb[2];
        const sizeZ = rb[5] - rb[4];
        this.globalRadius = Math.sqrt(sizeX*sizeX + sizeY*sizeY + sizeZ*sizeZ) / 2;
        
        const TARGET_SIZE = 300;
        this.scaleFactor = this.globalRadius > 0 ? TARGET_SIZE / this.globalRadius : 1.0;
        
        for (const [path, cluster] of this.clusters) {
            if (cluster.pointCloud && cluster.pointCloud.geometry) {
                const geometry = cluster.pointCloud.geometry;
                
                geometry.translate(-this.globalCenter.x, -this.globalCenter.y, -this.globalCenter.z);
                geometry.applyMatrix4(this.sceneRotation);
                geometry.scale(this.scaleFactor, this.scaleFactor, this.scaleFactor);
            }
        }

        const alignRotation = this.computeFrontAlignment();
        // Store so the frustum engine can apply the exact same yaw the points got.
        this.alignRotation = alignRotation;

        for (const [path, cluster] of this.clusters) {
            if (cluster.pointCloud && cluster.pointCloud.geometry) {
                const geometry = cluster.pointCloud.geometry;

                if (alignRotation) {
                    geometry.applyMatrix4(alignRotation);
                }

                geometry.computeBoundingSphere();

                const center = geometry.boundingSphere.center.clone();
                geometry.translate(-center.x, -center.y, -center.z);
                geometry.computeBoundingSphere();
                
                cluster.originalCenter.copy(center);
                cluster.radius = geometry.boundingSphere.radius;
                
                cluster.pointCloud.material.uniforms.uPointSize.value = 12.0;
            }
        }
    }

    computeFrontAlignment() {
        const mergedCluster = this.clusters.get('merged');
        if (!mergedCluster || !mergedCluster.pointCloud) return null;

        const pos = mergedCluster.pointCloud.geometry.attributes.position;
        const n = pos.count;
        if (n < 3) return null;

        let sumX = 0, sumZ = 0;
        for (let i = 0; i < n; i++) {
            sumX += pos.getX(i);
            sumZ += pos.getZ(i);
        }
        const meanX = sumX / n;
        const meanZ = sumZ / n;

        let covXX = 0, covXZ = 0, covZZ = 0;
        for (let i = 0; i < n; i++) {
            const dx = pos.getX(i) - meanX;
            const dz = pos.getZ(i) - meanZ;
            covXX += dx * dx;
            covXZ += dx * dz;
            covZZ += dz * dz;
        }
        covXX /= n;
        covXZ /= n;
        covZZ /= n;

        const angle = 0.5 * Math.atan2(2 * covXZ, covXX - covZZ);

        console.log(`PCA front alignment: rotating ${THREE.MathUtils.radToDeg(-angle).toFixed(1)} degrees around Y`);

        const rotMatrix = new THREE.Matrix4().makeRotationY(-angle);
        return rotMatrix;
    }

    async loadCameraExtrinsics() {
        this.cameraPositions = [];
        this.cameraUps = [];
        this.cameraLooks = [];

        try {
            const response = await fetch(`${this.basePath}/merged/images.txt`, { cache: 'no-cache' });
            if (!response.ok) throw new Error('Failed to fetch images.txt');
            const text = await response.text();
            const lines = text.split('\n');

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (line.startsWith('#') || line === '') continue;

                const parts = line.split(/\s+/);
                if (parts.length < 10) continue;

                const qw = parseFloat(parts[1]);
                const qx = parseFloat(parts[2]);
                const qy = parseFloat(parts[3]);
                const qz = parseFloat(parts[4]);
                const tx = parseFloat(parts[5]);
                const ty = parseFloat(parts[6]);
                const tz = parseFloat(parts[7]);

                // Rotation matrix R (world-to-camera) from quaternion
                const R = [
                    [1 - 2*(qy*qy + qz*qz), 2*(qx*qy - qz*qw),   2*(qx*qz + qy*qw)],
                    [2*(qx*qy + qz*qw),      1 - 2*(qx*qx + qz*qz), 2*(qy*qz - qx*qw)],
                    [2*(qx*qz - qy*qw),      2*(qy*qz + qx*qw),   1 - 2*(qx*qx + qy*qy)]
                ];

                // R^T (transpose = camera-to-world)
                const RT = [
                    [R[0][0], R[1][0], R[2][0]],
                    [R[0][1], R[1][1], R[2][1]],
                    [R[0][2], R[1][2], R[2][2]]
                ];

                // Camera world position: C = -R^T * t
                const cx = -(RT[0][0]*tx + RT[0][1]*ty + RT[0][2]*tz);
                const cy = -(RT[1][0]*tx + RT[1][1]*ty + RT[1][2]*tz);
                const cz = -(RT[2][0]*tx + RT[2][1]*ty + RT[2][2]*tz);
                this.cameraPositions.push(new THREE.Vector3(cx, cy, cz));

                // Camera up in world: R^T * [0, -1, 0] (COLMAP Y points down)
                const ux = -RT[0][1];
                const uy = -RT[1][1];
                const uz = -RT[2][1];
                this.cameraUps.push(new THREE.Vector3(ux, uy, uz));

                // Camera look direction in world: R^T * [0, 0, 1]
                const lx = RT[0][2];
                const ly = RT[1][2];
                const lz = RT[2][2];
                this.cameraLooks.push(new THREE.Vector3(lx, ly, lz));

                i++; // skip POINTS2D line
            }

            console.log(`Loaded ${this.cameraPositions.length} camera extrinsics from merged/images.txt`);
        } catch (e) {
            console.warn('Could not load camera extrinsics, using identity rotation:', e);
        }
    }

    computeSceneOrientation() {
        if (!this.cameraPositions || this.cameraPositions.length === 0) {
            console.warn('No camera data available, using identity rotation');
            return;
        }

        const n = this.cameraPositions.length;

        // --- Find "up" via PCA plane fit on camera positions ---
        const camCentroid = new THREE.Vector3();
        for (const p of this.cameraPositions) camCentroid.add(p);
        camCentroid.divideScalar(n);

        // Build 3x3 covariance matrix
        const cov = [[0,0,0],[0,0,0],[0,0,0]];
        for (const p of this.cameraPositions) {
            const dx = p.x - camCentroid.x;
            const dy = p.y - camCentroid.y;
            const dz = p.z - camCentroid.z;
            cov[0][0] += dx*dx; cov[0][1] += dx*dy; cov[0][2] += dx*dz;
            cov[1][0] += dy*dx; cov[1][1] += dy*dy; cov[1][2] += dy*dz;
            cov[2][0] += dz*dx; cov[2][1] += dz*dy; cov[2][2] += dz*dz;
        }

        // Power iteration to find smallest eigenvector of the covariance matrix.
        // Use inverse iteration: repeatedly solve (cov - sigma*I)^-1 * v to find
        // the eigenvector closest to sigma=0 (smallest eigenvalue).
        // Simpler approach: find largest eigenvector, deflate, find next largest,
        // then the remaining is the smallest. But even simpler: use the average
        // camera up vector since our analysis showed 0.9998 agreement with PCA.
        const avgUp = new THREE.Vector3();
        for (const u of this.cameraUps) avgUp.add(u);
        avgUp.divideScalar(n).normalize();

        // Verify consistency: check that individual ups agree with average
        let agreement = 0;
        for (const u of this.cameraUps) agreement += u.dot(avgUp);
        agreement /= n;
        console.log(`Camera up consistency: ${agreement.toFixed(4)} (1.0 = perfect)`);

        // --- Find "front" via camera centroid → building centroid ---
        const bldgCentroid = new THREE.Vector3();
        let pointCount = 0;
        const mergedCluster = this.clusters.get('merged');
        if (mergedCluster && mergedCluster.pointCloud) {
            const pos = mergedCluster.pointCloud.geometry.attributes.position;
            for (let i = 0; i < pos.count; i++) {
                bldgCentroid.x += pos.getX(i);
                bldgCentroid.y += pos.getY(i);
                bldgCentroid.z += pos.getZ(i);
            }
            bldgCentroid.divideScalar(pos.count);
            pointCount = pos.count;
        }

        let frontDir = new THREE.Vector3();
        if (pointCount > 0) {
            frontDir.subVectors(bldgCentroid, camCentroid).normalize();
        } else {
            // Fallback: use average camera look direction
            for (const l of this.cameraLooks) frontDir.add(l);
            frontDir.divideScalar(n).normalize();
        }

        // --- Build orthonormal scene basis ---
        // scene_Y = up direction
        const sceneY = avgUp.clone();

        // scene_Z = toward viewer, orthogonalized against up
        let sceneZ = frontDir.clone();
        // Remove component along sceneY to make perpendicular
        sceneZ.sub(sceneY.clone().multiplyScalar(sceneZ.dot(sceneY))).normalize();

        // scene_X = right axis
        const sceneX = new THREE.Vector3().crossVectors(sceneY, sceneZ).normalize();

        // Re-orthogonalize Z
        sceneZ.crossVectors(sceneX, sceneY).normalize();

        // The rotation matrix M has these as ROWS (transforms world → scene):
        // M * v = [v·sceneX, v·sceneY, v·sceneZ]
        this.sceneRotation.set(
            sceneX.x, sceneX.y, sceneX.z, 0,
            sceneY.x, sceneY.y, sceneY.z, 0,
            sceneZ.x, sceneZ.y, sceneZ.z, 0,
            0,         0,         0,       1
        );

        console.log(`Scene orientation computed:`);
        console.log(`  Up (scene Y):    ${sceneY.x.toFixed(4)}, ${sceneY.y.toFixed(4)}, ${sceneY.z.toFixed(4)}`);
        console.log(`  Right (scene X): ${sceneX.x.toFixed(4)}, ${sceneX.y.toFixed(4)}, ${sceneX.z.toFixed(4)}`);
        console.log(`  Front (scene Z): ${sceneZ.x.toFixed(4)}, ${sceneZ.y.toFixed(4)}, ${sceneZ.z.toFixed(4)}`);
    }

    // Explicit synchronous helper for tests/offline callers, before geometry is animated.
    computePointMatching() {
        const snapshots = new Map(createMatchingSnapshot(this.clusters).map(c => [c.path, c]));
        for (const [path, cluster] of this.clusters) {
            const matches = matchCluster(path, snapshots);
            if (matches) cluster.matchData = matches;
        }
    }

    flattenStructure(structure) {
        const flatPaths = [];
        
        const traverse = (obj, prefix = '') => {
            for (const [key, value] of Object.entries(obj)) {
                if (value && typeof value === 'object' && value.type) {
                    const path = prefix ? `${prefix}/${key}` : key;
                    flatPaths.push({
                        path,
                        type: value.type,
                        children: value.children || []
                    });
                } 
                
                if (value && typeof value === 'object') {
                     const path = prefix ? `${prefix}/${key}` : key;
                     if (!value.type) {
                         traverse(value, path);
                     }
                }
            }
        };
        
        traverse(structure);
        return flatPaths;
    }

    async loadTimestamps() {
        this.timestamps = {};
        try {
            const response = await fetch(`${this.basePath}/timestamps.json`, { cache: 'no-cache' });
            if (!response.ok) throw new Error('timestamps.json not found');
            const data = await response.json();
            for (const [path, info] of Object.entries(data)) {
                this.timestamps[path] = info.epoch;
            }
            console.log(`Loaded timestamps for ${Object.keys(this.timestamps).length} clusters`);
        } catch (e) {
            console.warn('Could not load timestamps, using structural ordering:', e);
        }
    }

    getStructure() {
        return {
            'vggt': { type: 'vggt', children: [] },

            'C_1': {
                'vggt': { type: 'vggt', children: [] },
                'C_1_1': {
                    'vggt': { type: 'vggt', children: [] }
                },
                'merged': { type: 'merged', children: ['C_1/vggt', 'C_1/C_1_1/vggt'] }
            },

            'C_2': {
                'vggt': { type: 'vggt', children: [] }
            },

            'C_3': {
                'C_3_1': {
                    'vggt': { type: 'vggt', children: [] }
                },
                'C_3_2': {
                    'vggt': { type: 'vggt', children: [] }
                },
                'vggt': { type: 'vggt', children: [] },
                'merged': { type: 'merged', children: ['C_3/C_3_1/vggt', 'C_3/C_3_2/vggt', 'C_3/vggt'] }
            },

            'merged': { type: 'merged', children: ['C_1/merged', 'C_2/vggt', 'C_3/merged'] }
        };
    }
}
