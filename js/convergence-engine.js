const SCATTER_RADIUS_MULT = 3.0;
const CONVERGE_DURATION = 3.0;
const PER_POINT_DELAY_FRAC = 0.3;

export class ConvergenceEngine {
    constructor() {
        this.clusterData = new Map();
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
        const scatterRadius = (cluster.radius || 10) * SCATTER_RADIUS_MULT;

        for (let j = 0; j < count; j++) {
            const j3 = j * 3;
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);
            const dist = scatterRadius * (0.5 + Math.random() * 0.5);

            scatteredPositions[j3]     = finalPositions[j3]     + dist * Math.sin(phi) * Math.cos(theta);
            scatteredPositions[j3 + 1] = finalPositions[j3 + 1] + dist * Math.sin(phi) * Math.sin(theta);
            scatteredPositions[j3 + 2] = finalPositions[j3 + 2] + dist * Math.cos(phi);
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

    get convergeDuration() {
        return CONVERGE_DURATION;
    }

    _easeOutExpo(t) {
        return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
    }
}
