const SCATTER_RADIUS_MULT = 3.0;
const CONVERGE_DURATION = 3.0;
const STAGGER_DELAY = 0.8;
const PER_POINT_DELAY_FRAC = 0.3;

export class ConvergenceEngine {
    constructor() {
        this.clusterEntries = [];
        this.startTime = 0;
        this.totalDuration = 0;
        this._active = false;
        this._complete = false;
        this._paused = false;
        this._pauseOffset = 0;
    }

    initConvergence(leafClusters) {
        this.clusterEntries = [];

        const sorted = [...leafClusters].sort((a, b) => {
            return (a.path || '').localeCompare(b.path || '');
        });

        for (let i = 0; i < sorted.length; i++) {
            const cluster = sorted[i];
            if (!cluster.pointCloud || !cluster.pointCloud.geometry) continue;

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

            const entry = {
                cluster,
                finalPositions,
                scatteredPositions,
                perPointDelay,
                count,
                staggerOffset: i * STAGGER_DELAY,
                duration: CONVERGE_DURATION,
                settled: false
            };

            this.clusterEntries.push(entry);
        }

        this.totalDuration = this.clusterEntries.length > 0
            ? (this.clusterEntries.length - 1) * STAGGER_DELAY + CONVERGE_DURATION
            : 0;

        this._active = false;
        this._complete = false;
        this._paused = false;
        this._pauseOffset = 0;

        for (const entry of this.clusterEntries) {
            const posArr = entry.cluster.pointCloud.geometry.attributes.position.array;
            for (let j = 0; j < entry.count * 3; j++) {
                posArr[j] = entry.scatteredPositions[j];
            }
            entry.cluster.pointCloud.geometry.attributes.position.needsUpdate = true;
            entry.cluster.pointCloud.visible = true;
            entry.cluster.pointCloud.material.uniforms.uOpacity.value = 1.0;
        }

        console.log(`ConvergenceEngine: ${this.clusterEntries.length} clusters, ${this.totalDuration.toFixed(1)}s total`);
    }

    start() {
        this.startTime = performance.now() / 1000;
        this._active = true;
        this._complete = false;
        this._paused = false;
        this._pauseOffset = 0;
    }

    pause() {
        if (!this._active || this._paused) return;
        this._paused = true;
        this._pauseTime = performance.now() / 1000;
    }

    resume() {
        if (!this._paused) return;
        this._pauseOffset += (performance.now() / 1000) - this._pauseTime;
        this._paused = false;
    }

    get isActive() { return this._active && !this._complete; }
    get isComplete() { return this._complete; }
    get isPaused() { return this._paused; }

    get progress() {
        if (!this._active || this.totalDuration === 0) return 0;
        const elapsed = this._getElapsed();
        return Math.min(elapsed / this.totalDuration, 1);
    }

    skipToEnd() {
        for (const entry of this.clusterEntries) {
            const posArr = entry.cluster.pointCloud.geometry.attributes.position.array;
            for (let j = 0; j < entry.count * 3; j++) {
                posArr[j] = entry.finalPositions[j];
            }
            entry.cluster.pointCloud.geometry.attributes.position.needsUpdate = true;
            entry.settled = true;
        }
        this._complete = true;
        this._active = false;
    }

    _getElapsed() {
        const now = this._paused ? this._pauseTime : (performance.now() / 1000);
        return now - this.startTime - this._pauseOffset;
    }

    update() {
        if (!this._active || this._complete || this._paused) return;

        const elapsed = this._getElapsed();
        let allSettled = true;

        for (const entry of this.clusterEntries) {
            if (entry.settled) continue;

            const localT = (elapsed - entry.staggerOffset) / entry.duration;

            if (localT <= 0) {
                allSettled = false;
                continue;
            }

            if (localT >= 1.0 + PER_POINT_DELAY_FRAC) {
                if (!entry.settled) {
                    const posArr = entry.cluster.pointCloud.geometry.attributes.position.array;
                    for (let j = 0; j < entry.count * 3; j++) {
                        posArr[j] = entry.finalPositions[j];
                    }
                    entry.cluster.pointCloud.geometry.attributes.position.needsUpdate = true;
                    entry.settled = true;
                }
                continue;
            }

            allSettled = false;
            const posArr = entry.cluster.pointCloud.geometry.attributes.position.array;
            const scattered = entry.scatteredPositions;
            const final = entry.finalPositions;
            const delays = entry.perPointDelay;

            for (let j = 0; j < entry.count; j++) {
                const pointT = Math.max(0, Math.min(1, (localT - delays[j]) / (1.0 - delays[j])));
                const e = this._easeOutExpo(pointT);
                const j3 = j * 3;

                posArr[j3]     = scattered[j3]     + (final[j3]     - scattered[j3])     * e;
                posArr[j3 + 1] = scattered[j3 + 1] + (final[j3 + 1] - scattered[j3 + 1]) * e;
                posArr[j3 + 2] = scattered[j3 + 2] + (final[j3 + 2] - scattered[j3 + 2]) * e;
            }

            entry.cluster.pointCloud.geometry.attributes.position.needsUpdate = true;
        }

        if (allSettled) {
            this._complete = true;
            this._active = false;
        }
    }

    _easeOutExpo(t) {
        return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
    }
}
