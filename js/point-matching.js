/**
 * Uniform spatial hash grid for approximate nearest-neighbor lookups.
 * Points are registered by index; nearest() expands search rings outward
 * from the query cell until a candidate is found (plus one safety ring).
 */
class SpatialGrid {
    constructor(count) {
        this.xs = new Float32Array(count);
        this.ys = new Float32Array(count);
        this.zs = new Float32Array(count);
        this.count = 0;
        this.cells = new Map();
    }

    add(x, y, z) {
        const i = this.count++;
        this.xs[i] = x; this.ys[i] = y; this.zs[i] = z;
    }

    build() {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < this.count; i++) {
            const x = this.xs[i], y = this.ys[i], z = this.zs[i];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        this.minX = minX; this.minY = minY; this.minZ = minZ;
        const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
        const diag = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        // Aim for ~1 point per cell on average
        this.cellSize = Math.max(diag / Math.max(Math.cbrt(this.count), 1), 1e-6);

        for (let i = 0; i < this.count; i++) {
            const key = this._key(this.xs[i], this.ys[i], this.zs[i]);
            let arr = this.cells.get(key);
            if (!arr) { arr = []; this.cells.set(key, arr); }
            arr.push(i);
        }
    }

    _key(x, y, z) {
        const ix = Math.floor((x - this.minX) / this.cellSize);
        const iy = Math.floor((y - this.minY) / this.cellSize);
        const iz = Math.floor((z - this.minZ) / this.cellSize);
        return ix * 73856093 ^ iy * 19349663 ^ iz * 83492791;
    }

    /** Returns { index, distSq } of (approximate) nearest point. */
    nearest(x, y, z) {
        const cx = Math.floor((x - this.minX) / this.cellSize);
        const cy = Math.floor((y - this.minY) / this.cellSize);
        const cz = Math.floor((z - this.minZ) / this.cellSize);

        let bestIdx = -1, bestSq = Infinity;
        const MAX_R = 64;
        let foundAt = -1;

        for (let r = 0; r <= MAX_R; r++) {
            // Once found, search one extra ring to catch closer diagonal neighbors
            if (foundAt >= 0 && r > foundAt + 1) break;

            for (let ix = cx - r; ix <= cx + r; ix++) {
                for (let iy = cy - r; iy <= cy + r; iy++) {
                    for (let iz = cz - r; iz <= cz + r; iz++) {
                        // Only cells on the shell of the current ring
                        if (Math.max(Math.abs(ix - cx), Math.abs(iy - cy), Math.abs(iz - cz)) !== r) continue;
                        const key = ix * 73856093 ^ iy * 19349663 ^ iz * 83492791;
                        const arr = this.cells.get(key);
                        if (!arr) continue;
                        for (const i of arr) {
                            const dx = this.xs[i] - x;
                            const dy = this.ys[i] - y;
                            const dz = this.zs[i] - z;
                            const sq = dx * dx + dy * dy + dz * dz;
                            if (sq < bestSq) { bestSq = sq; bestIdx = i; }
                        }
                    }
                }
            }
            if (bestIdx >= 0 && foundAt < 0) foundAt = r;
        }

        return { index: bestIdx, distSq: bestSq };
    }
}

/** Copy normalized geometry before reveals mutate it. Only these copies may be transferred. */
export function createMatchingSnapshot(clusters) {
    return [...clusters.values()].map(cluster => ({
        path: cluster.path,
        type: cluster.type,
        childrenPaths: [...cluster.childrenPaths],
        center: { x: cluster.originalCenter.x, y: cluster.originalCenter.y, z: cluster.originalCenter.z },
        positions: cluster.pointCloud
            ? new Float32Array(cluster.pointCloud.geometry.attributes.position.array) : null
    }));
}

/** Match one merge using immutable normalized positions and reconstruction centers. */
export function matchCluster(path, snapshots) {
    const cluster = snapshots.get(path);
    if (!cluster || cluster.type !== 'merged' || !cluster.childrenPaths.length || !cluster.positions?.length) return null;
    const mergedPos = cluster.positions;
    const mc = cluster.center;
    const mCount = mergedPos.length / 3;

    const mergedX = new Float32Array(mCount);
    const mergedY = new Float32Array(mCount);
    const mergedZ = new Float32Array(mCount);
    for (let i = 0; i < mCount; i++) {
        mergedX[i] = mergedPos[i * 3 + 0] + mc.x;
        mergedY[i] = mergedPos[i * 3 + 1] + mc.y;
        mergedZ[i] = mergedPos[i * 3 + 2] + mc.z;
    }

    const childEntries = [];
    for (const childPath of cluster.childrenPaths) {
        const child = snapshots.get(childPath);
        if (!child || !child.positions) continue;
        const cPos = child.positions;
        const cc = child.center;
        for (let i = 0; i < cPos.length / 3; i++) {
            childEntries.push({
                childPath,
                childIdx: i,
                nx: cPos[i * 3 + 0] + cc.x,
                ny: cPos[i * 3 + 1] + cc.y,
                nz: cPos[i * 3 + 2] + cc.z
            });
        }
    }

    if (childEntries.length === 0) return null;

    // Spatial grids make nearest-neighbor queries ~O(1) instead of O(N),
    // which is required for the dense datasets (hundreds of thousands of points).
    const mergedGrid = new SpatialGrid(mCount);
    for (let j = 0; j < mCount; j++) mergedGrid.add(mergedX[j], mergedY[j], mergedZ[j]);
    mergedGrid.build();

    const childGrid = new SpatialGrid(childEntries.length);
    for (const ce of childEntries) childGrid.add(ce.nx, ce.ny, ce.nz);
    childGrid.build();

    const candidates = [];
    const nearestMergedByEntry = new Int32Array(childEntries.length);
    for (let k = 0; k < childEntries.length; k++) {
        const ce = childEntries[k];
        const { index: bestIdx, distSq: bestSq } = mergedGrid.nearest(ce.nx, ce.ny, ce.nz);
        nearestMergedByEntry[k] = bestIdx;
        candidates.push({
            childPath: ce.childPath,
            childIdx: ce.childIdx,
            mergedIdx: bestIdx,
            distSq: bestSq
        });
    }

    candidates.sort((a, b) => a.distSq - b.distSq);

    const p90Idx = Math.floor(candidates.length * 0.9);
    const thresholdSq = candidates[p90Idx].distSq * 4;

    const mergedClaimed = new Set();
    const childMatched = new Set();
    const matchedPairs = [];

    for (const c of candidates) {
        if (c.distSq > thresholdSq) continue;
        if (mergedClaimed.has(c.mergedIdx)) continue;
        const key = `${c.childPath}:${c.childIdx}`;
        if (childMatched.has(key)) continue;

        matchedPairs.push({
            childPath: c.childPath,
            childIdx: c.childIdx,
            mergedIdx: c.mergedIdx
        });
        mergedClaimed.add(c.mergedIdx);
        childMatched.add(key);
    }

    // Unmatched child points: fly to nearest merged point (many-to-one allowed)
    const childOnlyPoints = [];
    for (let k = 0; k < childEntries.length; k++) {
        const ce = childEntries[k];
        const key = `${ce.childPath}:${ce.childIdx}`;
        if (!childMatched.has(key)) {
            // Reuse the nearest-merged index computed above (same query)
            childOnlyPoints.push({
                childPath: ce.childPath,
                childIdx: ce.childIdx,
                flyToMergedIdx: Math.max(nearestMergedByEntry[k], 0)
            });
        }
    }

    // Unmatched merged points: fly from nearest child point (many-to-one allowed)
    const mergedOnlyIndices = [];
    for (let i = 0; i < mCount; i++) {
        if (!mergedClaimed.has(i)) {
            const { index: nearIdx } = childGrid.nearest(mergedX[i], mergedY[i], mergedZ[i]);
            const bestCE = nearIdx >= 0 ? childEntries[nearIdx] : null;
            mergedOnlyIndices.push({
                mergedIdx: i,
                flyFromChildPath: bestCE ? bestCE.childPath : null,
                flyFromChildIdx: bestCE ? bestCE.childIdx : -1
            });
        }
    }

    return { matchedPairs, childOnlyPoints, mergedOnlyIndices };
}
