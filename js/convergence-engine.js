const CONVERGE_DURATION = 0.8;
const PER_POINT_DELAY_FRAC = 0.3;

export class ConvergenceEngine {
    constructor() {
        this.clusterData = new Map();
        // Writable so the playback-speed control can scale it live.
        this.convergeDuration = CONVERGE_DURATION;
    }

    prepareCluster(cluster) {
        if (!cluster.pointCloud || !cluster.pointCloud.geometry) return null;

        const geom = cluster.pointCloud.geometry;
        const posAttr = geom.attributes.position;
        const count = posAttr.count;

        const finalPositions = new Float32Array(count * 3);
        for (let j = 0; j < count * 3; j++) {
            finalPositions[j] = posAttr.array[j];
        }

        const scatteredPositions = new Float32Array(count * 3);
        // Reveal from a compact copy about the footprint center. Both endpoints
        // are inside the fitted box, so every interpolated point stays in its tile.
        // The fallback is for older viewers that do not use the rectangle layout.
        const box = cluster.revealBox;
        const center = box ? {
            x: (box.min.x + box.max.x) / 2,
            y: (box.min.y + box.max.y) / 2,
            z: (box.min.z + box.max.z) / 2
        } : { x: 0, y: 0, z: 0 };

        for (let j = 0; j < count; j++) {
            const j3 = j * 3;
            scatteredPositions[j3]     = center.x + (finalPositions[j3] - center.x) * 0.2;
            scatteredPositions[j3 + 1] = center.y + (finalPositions[j3 + 1] - center.y) * 0.2;
            scatteredPositions[j3 + 2] = center.z + (finalPositions[j3 + 2] - center.z) * 0.2;
        }

        const perPointDelay = new Float32Array(count);
        for (let j = 0; j < count; j++) {
            perPointDelay[j] = Math.random() * PER_POINT_DELAY_FRAC;
        }

        const data = { cluster, finalPositions, scatteredPositions, perPointDelay, count };
        this.clusterData.set(cluster.path, data);
        return data;
    }

    prepareAllLeaves(leafClusters) {
        for (const cluster of leafClusters) {
            this.prepareCluster(cluster);
        }
    }

    scatterCluster(cluster) {
        const data = this.clusterData.get(cluster.path);
        if (!data) return;

        const posArr = cluster.pointCloud.geometry.attributes.position.array;
        for (let j = 0; j < data.count * 3; j++) {
            posArr[j] = data.scatteredPositions[j];
        }
        cluster.pointCloud.geometry.attributes.position.needsUpdate = true;
        cluster.pointCloud.visible = true;
        cluster.pointCloud.material.uniforms.uOpacity.value = 1.0;
    }

    settleClusterInstant(cluster) {
        const data = this.clusterData.get(cluster.path);
        if (!data) return;

        const posArr = cluster.pointCloud.geometry.attributes.position.array;
        for (let j = 0; j < data.count * 3; j++) {
            posArr[j] = data.finalPositions[j];
        }
        cluster.pointCloud.geometry.attributes.position.needsUpdate = true;
        cluster.pointCloud.visible = true;
        cluster.pointCloud.material.uniforms.uOpacity.value = 1.0;
    }

    updateConvergence(data, t) {
        const posArr = data.cluster.pointCloud.geometry.attributes.position.array;
        const scattered = data.scatteredPositions;
        const final = data.finalPositions;
        const delays = data.perPointDelay;

        const clampedT = Math.min(t, 1.0 + PER_POINT_DELAY_FRAC);

        if (clampedT >= 1.0 + PER_POINT_DELAY_FRAC) {
            for (let j = 0; j < data.count * 3; j++) {
                posArr[j] = final[j];
            }
        } else {
            for (let j = 0; j < data.count; j++) {
                const pointT = Math.max(0, Math.min(1, (clampedT - delays[j]) / (1.0 - delays[j])));
                const e = this._easeOutExpo(pointT);
                const j3 = j * 3;

                posArr[j3]     = scattered[j3]     + (final[j3]     - scattered[j3])     * e;
                posArr[j3 + 1] = scattered[j3 + 1] + (final[j3 + 1] - scattered[j3 + 1]) * e;
                posArr[j3 + 2] = scattered[j3 + 2] + (final[j3 + 2] - scattered[j3 + 2]) * e;
            }
        }

        data.cluster.pointCloud.geometry.attributes.position.needsUpdate = true;
    }

    _easeOutExpo(t) {
        return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
    }
}
