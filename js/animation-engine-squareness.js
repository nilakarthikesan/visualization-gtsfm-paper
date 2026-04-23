import * as THREE from 'three';
import { createPointMaterial, applyBlendMode } from './point-material.js?v=38';

export class SquarenessAnimationEngine {
    constructor(clusters, layoutEngine, worldGroup) {
        this.clusters = clusters;
        this.layoutEngine = layoutEngine;
        this.worldGroup = worldGroup;
        this.mergeEvents = [];
        this.activeAnimations = [];
        this.mergeDuration = 2.5;
        this.leafFadeDuration = 0.5;

        this.particleEngine = null;
        this.preMatchedCloud = null;
        this.preChildOnlyCloud = null;
        this.preMergedOnlyCloud = null;
        this.matchedStartBuf = null;
        this.matchedEndBuf = null;
        this.coStartBuf = null;
        this.coEndBuf = null;
        this.moStartBuf = null;
        this.moEndBuf = null;
    }

    initTransitionBuffers(blendMode = 'splat', isDark = false) {
        let maxPoints = 0;
        for (const [, cluster] of this.clusters) {
            if (cluster.pointCloud) {
                maxPoints = Math.max(maxPoints, cluster.pointCloud.geometry.attributes.position.count);
            }
        }
        let totalChildPoints = 0;
        for (const [, cluster] of this.clusters) {
            if (cluster.pointCloud) {
                totalChildPoints += cluster.pointCloud.geometry.attributes.position.count;
            }
        }
        const bufSize = Math.max(maxPoints, totalChildPoints);

        this.matchedStartBuf = new Float32Array(bufSize * 3);
        this.matchedEndBuf = new Float32Array(bufSize * 3);
        this.coStartBuf = new Float32Array(bufSize * 3);
        this.coEndBuf = new Float32Array(bufSize * 3);
        this.moStartBuf = new Float32Array(bufSize * 3);
        this.moEndBuf = new Float32Array(bufSize * 3);

        const makeCloud = (opacity) => {
            const geom = new THREE.BufferGeometry();
            const p = new THREE.BufferAttribute(new Float32Array(bufSize * 3), 3);
            p.setUsage(THREE.DynamicDrawUsage);
            const c = new THREE.BufferAttribute(new Float32Array(bufSize * 3), 3);
            c.setUsage(THREE.DynamicDrawUsage);
            geom.setAttribute('position', p);
            geom.setAttribute('color', c);
            geom.setDrawRange(0, 0);
            const mat = createPointMaterial({ opacity, depthWrite: true, blendMode, isDark });
            const cloud = new THREE.Points(geom, mat);
            cloud.visible = false;
            cloud.frustumCulled = false;
            this.worldGroup.add(cloud);
            return cloud;
        };

        this.preMatchedCloud = makeCloud(1.0);
        this.preChildOnlyCloud = makeCloud(1.0);
        this.preMergedOnlyCloud = makeCloud(0.0);

        console.log(`Pre-allocated transition buffers: ${bufSize} points capacity`);
    }

    updateBlendMode(blendMode, isDark = false) {
        const clouds = [this.preMatchedCloud, this.preChildOnlyCloud, this.preMergedOnlyCloud];
        for (const cloud of clouds) {
            if (cloud && cloud.material) {
                applyBlendMode(cloud.material, blendMode, isDark);
            }
        }
    }

    initTimeline() {
        const treeNodes = this.layoutEngine.treeNodes;
        if (!treeNodes || treeNodes.length === 0) {
            console.warn("No tree nodes for timeline");
            return [];
        }

        const allEvents = [];
        for (const node of treeNodes) {
            const isLeaf = node.children.length === 0;
            allEvents.push({
                path: node.cluster.path,
                cluster: node.cluster,
                isLeaf,
                children: isLeaf ? [] : node.children.map(c => c.cluster.path),
                depth: node.depth,
                timestamp: node.cluster.timestamp || 0
            });
        }

        const hasTimestamps = allEvents.some(e => e.timestamp > 0);

        if (hasTimestamps) {
            allEvents.sort((a, b) => {
                if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
                if (a.isLeaf !== b.isLeaf) return a.isLeaf ? -1 : 1;
                return a.cluster.path.localeCompare(b.cluster.path);
            });

            const TOTAL_ANIMATION_SEC = 20;
            const MIN_GAP_SEC = 0.5;
            const MAX_GAP_SEC = 1.2;
            const epochs = allEvents.map(e => e.timestamp);
            const minEpoch = Math.min(...epochs);
            const maxEpoch = Math.max(...epochs);
            const realSpan = maxEpoch - minEpoch;

            for (let i = 0; i < allEvents.length; i++) {
                if (realSpan > 0) {
                    const normalizedT = (allEvents[i].timestamp - minEpoch) / realSpan;
                    allEvents[i].animationTime = normalizedT * TOTAL_ANIMATION_SEC;
                } else {
                    allEvents[i].animationTime = i * 1.0;
                }
            }

            for (let i = 1; i < allEvents.length; i++) {
                const gap = allEvents[i].animationTime - allEvents[i - 1].animationTime;
                if (gap < MIN_GAP_SEC) {
                    allEvents[i].animationTime = allEvents[i - 1].animationTime + MIN_GAP_SEC;
                }
            }

            for (let i = 0; i < allEvents.length; i++) {
                if (i === 0) {
                    allEvents[i].delay = 0.5;
                } else {
                    allEvents[i].delay = Math.min(
                        allEvents[i].animationTime - allEvents[i - 1].animationTime,
                        MAX_GAP_SEC
                    );
                }
            }
        } else {
            const leaves = allEvents.filter(e => e.isLeaf);
            const merges = allEvents.filter(e => !e.isLeaf);
            leaves.sort((a, b) => b.depth - a.depth || a.cluster.path.localeCompare(b.cluster.path));
            merges.sort((a, b) => b.depth - a.depth || a.cluster.path.localeCompare(b.cluster.path));
            allEvents.length = 0;
            allEvents.push(...leaves, ...merges);
            for (const e of allEvents) e.delay = 1.0;
        }

        this.mergeEvents = allEvents;

        const leaves = allEvents.filter(e => e.isLeaf).length;
        const merges = allEvents.filter(e => !e.isLeaf).length;
        console.log(`Timeline: ${this.mergeEvents.length} events (${leaves} leaves + ${merges} merges)`);
        if (hasTimestamps) {
            for (const e of this.mergeEvents) {
                const ts = e.timestamp ? new Date(e.timestamp * 1000).toLocaleTimeString() : '?';
                console.log(`  ${ts} [${e.delay.toFixed(1)}s gap] ${e.isLeaf ? 'LEAF' : 'MERGE'} ${e.path}`);
            }
        }
        return this.mergeEvents;
    }

    hideTransitionClouds() {
        if (this.preMatchedCloud) this.preMatchedCloud.visible = false;
        if (this.preChildOnlyCloud) this.preChildOnlyCloud.visible = false;
        if (this.preMergedOnlyCloud) this.preMergedOnlyCloud.visible = false;
        this.activeAnimations = this.activeAnimations.filter(a => a.type !== 'mergeTransition');
    }

    applyEventInstant(eventIndex) {
        this.hideTransitionClouds();
        this.activeAnimations = [];

        for (const cluster of this.clusters.values()) {
            if (cluster.pointCloud) {
                cluster.pointCloud.visible = false;
                cluster.pointCloud.material.uniforms.uOpacity.value = 1;
                cluster.pointCloud.material.depthWrite = true;
            }
            if (cluster.hierarchyPosition) {
                cluster.group.position.copy(cluster.hierarchyPosition);
            }
            if (cluster.fitScale) {
                cluster.group.scale.setScalar(cluster.fitScale);
            }
        }

        for (let i = 0; i <= eventIndex; i++) {
            const evt = this.mergeEvents[i];
            if (!evt) continue;
            const c = evt.cluster;

            if (evt.isLeaf) {
                if (c.pointCloud) c.pointCloud.visible = true;
            } else {
                if (c.pointCloud) c.pointCloud.visible = true;
                for (const childPath of evt.children) {
                    const child = this.clusters.get(childPath);
                    if (child && child.pointCloud) child.pointCloud.visible = false;
                }
            }
        }
    }

    playEvent(eventIndex, direction = 1) {
        const evt = this.mergeEvents[eventIndex];
        if (!evt) return;

        if (direction > 0) {
            if (evt.isLeaf) {
                if (evt.cluster.pointCloud) {
                    evt.cluster.pointCloud.visible = true;
                    this.animateFadeIn(evt.cluster);
                }
            } else {
                this.playMergeTransition(evt);
            }
        } else {
            this.hideTransitionClouds();
            if (evt.isLeaf) {
                if (evt.cluster.pointCloud) this.animateFadeOut(evt.cluster);
            } else {
                if (evt.cluster.pointCloud) {
                    evt.cluster.pointCloud.visible = false;
                    evt.cluster.pointCloud.material.uniforms.uOpacity.value = 1;
                }
                for (const childPath of evt.children) {
                    const child = this.clusters.get(childPath);
                    if (child && child.pointCloud) {
                        child.pointCloud.visible = true;
                        child.pointCloud.material.uniforms.uOpacity.value = 1;
                        child.pointCloud.material.depthWrite = true;
                        child.group.position.copy(child.hierarchyPosition);
                        if (child.fitScale) child.group.scale.setScalar(child.fitScale);
                    }
                }
            }
        }
    }

    playMergeTransition(evt) {
        const merged = evt.cluster;
        const matchData = merged.matchData;

        if (!matchData || !merged.pointCloud) {
            if (merged.pointCloud) {
                merged.pointCloud.visible = true;
                this.animateFadeIn(merged);
            }
            for (const childPath of evt.children) {
                const child = this.clusters.get(childPath);
                if (child && child.pointCloud && child.pointCloud.visible) {
                    this.animateFallbackMerge(child, merged.hierarchyPosition);
                }
            }
            return;
        }

        const { matchedPairs, childOnlyPoints, mergedOnlyIndices } = matchData;

        const fadingChildren = [];
        for (const childPath of evt.children) {
            const child = this.clusters.get(childPath);
            if (child && child.pointCloud && child.pointCloud.visible) {
                fadingChildren.push(child);
            }
        }

        const mLen = matchedPairs.length;
        const coLen = childOnlyPoints.length;
        const moLen = mergedOnlyIndices.length;

        const mStart = this.matchedStartBuf;
        const mEnd = this.matchedEndBuf;
        const mPos = this.preMatchedCloud.geometry.attributes.position.array;
        const mCol = this.preMatchedCloud.geometry.attributes.color.array;

        for (let i = 0; i < mLen; i++) {
            const pair = matchedPairs[i];
            const child = this.clusters.get(pair.childPath);
            if (!child || !child.pointCloud) continue;
            this.writeWorldPos(child, pair.childIdx, mStart, i * 3);
            this.writeWorldPos(merged, pair.mergedIdx, mEnd, i * 3);
            this.writeColor(child, pair.childIdx, mCol, i * 3);
            mPos[i * 3] = mStart[i * 3];
            mPos[i * 3 + 1] = mStart[i * 3 + 1];
            mPos[i * 3 + 2] = mStart[i * 3 + 2];
        }
        this.preMatchedCloud.geometry.attributes.position.needsUpdate = true;
        this.preMatchedCloud.geometry.attributes.color.needsUpdate = true;
        this.preMatchedCloud.geometry.setDrawRange(0, mLen);
        this.preMatchedCloud.material.uniforms.uOpacity.value = 1.0;
        this.preMatchedCloud.visible = true;

        const coStart = this.coStartBuf;
        const coEnd = this.coEndBuf;
        const coPos = this.preChildOnlyCloud.geometry.attributes.position.array;
        const coCol = this.preChildOnlyCloud.geometry.attributes.color.array;

        for (let i = 0; i < coLen; i++) {
            const cp = childOnlyPoints[i];
            const child = this.clusters.get(cp.childPath);
            if (!child || !child.pointCloud) continue;
            this.writeWorldPos(child, cp.childIdx, coStart, i * 3);
            this.writeColor(child, cp.childIdx, coCol, i * 3);
            if (cp.flyToMergedIdx !== undefined) {
                this.writeWorldPos(merged, cp.flyToMergedIdx, coEnd, i * 3);
            } else {
                coEnd[i * 3] = coStart[i * 3];
                coEnd[i * 3 + 1] = coStart[i * 3 + 1];
                coEnd[i * 3 + 2] = coStart[i * 3 + 2];
            }
            coPos[i * 3] = coStart[i * 3];
            coPos[i * 3 + 1] = coStart[i * 3 + 1];
            coPos[i * 3 + 2] = coStart[i * 3 + 2];
        }
        this.preChildOnlyCloud.geometry.attributes.position.needsUpdate = true;
        this.preChildOnlyCloud.geometry.attributes.color.needsUpdate = true;
        this.preChildOnlyCloud.geometry.setDrawRange(0, coLen);
        this.preChildOnlyCloud.material.uniforms.uOpacity.value = 1.0;
        this.preChildOnlyCloud.visible = true;

        const moStart = this.moStartBuf;
        const moEnd = this.moEndBuf;
        const moPos = this.preMergedOnlyCloud.geometry.attributes.position.array;
        const moCol = this.preMergedOnlyCloud.geometry.attributes.color.array;

        for (let i = 0; i < moLen; i++) {
            const entry = mergedOnlyIndices[i];
            const mIdx = typeof entry === 'object' ? entry.mergedIdx : entry;
            this.writeWorldPos(merged, mIdx, moEnd, i * 3);
            this.writeColor(merged, mIdx, moCol, i * 3);
            if (typeof entry === 'object' && entry.flyFromChildPath) {
                const srcChild = this.clusters.get(entry.flyFromChildPath);
                if (srcChild && srcChild.pointCloud) {
                    this.writeWorldPos(srcChild, entry.flyFromChildIdx, moStart, i * 3);
                } else {
                    moStart[i * 3] = moEnd[i * 3];
                    moStart[i * 3 + 1] = moEnd[i * 3 + 1];
                    moStart[i * 3 + 2] = moEnd[i * 3 + 2];
                }
            } else {
                moStart[i * 3] = moEnd[i * 3];
                moStart[i * 3 + 1] = moEnd[i * 3 + 1];
                moStart[i * 3 + 2] = moEnd[i * 3 + 2];
            }
            moPos[i * 3] = moStart[i * 3];
            moPos[i * 3 + 1] = moStart[i * 3 + 1];
            moPos[i * 3 + 2] = moStart[i * 3 + 2];
        }
        this.preMergedOnlyCloud.geometry.attributes.position.needsUpdate = true;
        this.preMergedOnlyCloud.geometry.attributes.color.needsUpdate = true;
        this.preMergedOnlyCloud.geometry.setDrawRange(0, moLen);
        this.preMergedOnlyCloud.material.uniforms.uOpacity.value = 0.0;
        this.preMergedOnlyCloud.visible = true;

        for (const child of fadingChildren) {
            if (child.pointCloud) {
                child.pointCloud.material.uniforms.uOpacity.value = 0;
                child.pointCloud.material.depthWrite = false;
            }
        }
        merged.pointCloud.visible = false;

        if (this.particleEngine && merged.hierarchyPosition) {
            const mergeRadius = merged.radius * (merged.fitScale || 1);
            this.particleEngine.trigger(merged.hierarchyPosition, mergeRadius);
        }

        this.activeAnimations.push({
            type: 'mergeTransition',
            matchedCount: mLen,
            coCount: coLen,
            moCount: moLen,
            mergedCluster: merged,
            childPaths: evt.children,
            fadingChildren,
            startTime: performance.now(),
            duration: this.mergeDuration * 1000,
            onComplete: () => {
                this.preMatchedCloud.visible = false;
                this.preChildOnlyCloud.visible = false;
                this.preMergedOnlyCloud.visible = false;
                for (const child of fadingChildren) {
                    if (child.pointCloud) {
                        child.pointCloud.visible = false;
                        child.pointCloud.material.uniforms.uOpacity.value = 1;
                        child.pointCloud.material.depthWrite = true;
                    }
                }
                merged.pointCloud.visible = true;
                merged.pointCloud.material.uniforms.uOpacity.value = 1;
            }
        });
    }

    writeWorldPos(cluster, localIdx, out, offset) {
        const pos = cluster.pointCloud.geometry.attributes.position;
        const s = cluster.fitScale || 1;
        const hp = cluster.hierarchyPosition;
        out[offset]     = hp.x + pos.getX(localIdx) * s;
        out[offset + 1] = hp.y + pos.getY(localIdx) * s;
        out[offset + 2] = hp.z + pos.getZ(localIdx) * s;
    }

    writeColor(cluster, localIdx, out, offset) {
        const col = cluster.pointCloud.geometry.attributes.color;
        out[offset]     = col.getX(localIdx);
        out[offset + 1] = col.getY(localIdx);
        out[offset + 2] = col.getZ(localIdx);
    }

    animateFadeIn(cluster) {
        if (!cluster.pointCloud) return;
        cluster.pointCloud.material.uniforms.uOpacity.value = 0;
        cluster.pointCloud.material.transparent = true;
        this.activeAnimations.push({
            type: 'fadeIn', cluster,
            startTime: performance.now(),
            duration: this.leafFadeDuration * 1000
        });
    }

    animateFadeOut(cluster) {
        if (!cluster.pointCloud) return;
        cluster.pointCloud.material.transparent = true;
        this.activeAnimations.push({
            type: 'fadeOut', cluster,
            startTime: performance.now(),
            duration: this.leafFadeDuration * 1000,
            onComplete: () => {
                cluster.pointCloud.visible = false;
                cluster.pointCloud.material.uniforms.uOpacity.value = 1;
            }
        });
    }

    animateFallbackMerge(child, targetPos) {
        if (!child.pointCloud || !targetPos) return;
        const startPos = child.group.position.clone();
        const endPos = targetPos.clone();
        const startScale = child.group.scale.x;
        this.activeAnimations.push({
            type: 'fallbackMerge', cluster: child,
            startPos, endPos, startScale,
            startTime: performance.now(),
            duration: this.mergeDuration * 1000,
            onComplete: () => {
                child.pointCloud.visible = false;
                child.pointCloud.material.uniforms.uOpacity.value = 1;
                child.group.position.copy(child.hierarchyPosition);
                child.group.scale.setScalar(startScale);
            }
        });
    }

    update(dt) {
        const now = performance.now();
        for (let i = this.activeAnimations.length - 1; i >= 0; i--) {
            const a = this.activeAnimations[i];
            const t = Math.min((now - a.startTime) / a.duration, 1);
            const e = this.easeInOutCubic(t);

            switch (a.type) {
                case 'fadeIn':
                    a.cluster.pointCloud.material.uniforms.uOpacity.value = e;
                    break;

                case 'fadeOut':
                    a.cluster.pointCloud.material.uniforms.uOpacity.value = 1 - e;
                    break;

                case 'fallbackMerge':
                    a.cluster.group.position.lerpVectors(a.startPos, a.endPos, e);
                    a.cluster.group.scale.setScalar(a.startScale * (1 - e * 0.5));
                    a.cluster.pointCloud.material.uniforms.uOpacity.value = 1 - e * 0.85;
                    break;

                case 'mergeTransition': {
                    const mArr = this.preMatchedCloud.geometry.attributes.position.array;
                    const ms = this.matchedStartBuf, me = this.matchedEndBuf;
                    for (let j = 0; j < a.matchedCount; j++) {
                        const j3 = j * 3;
                        mArr[j3]     = ms[j3]     + (me[j3]     - ms[j3])     * e;
                        mArr[j3 + 1] = ms[j3 + 1] + (me[j3 + 1] - ms[j3 + 1]) * e;
                        mArr[j3 + 2] = ms[j3 + 2] + (me[j3 + 2] - ms[j3 + 2]) * e;
                    }
                    this.preMatchedCloud.geometry.attributes.position.needsUpdate = true;

                    const coArr = this.preChildOnlyCloud.geometry.attributes.position.array;
                    const cs = this.coStartBuf, ce = this.coEndBuf;
                    for (let j = 0; j < a.coCount; j++) {
                        const j3 = j * 3;
                        coArr[j3]     = cs[j3]     + (ce[j3]     - cs[j3])     * e;
                        coArr[j3 + 1] = cs[j3 + 1] + (ce[j3 + 1] - cs[j3 + 1]) * e;
                        coArr[j3 + 2] = cs[j3 + 2] + (ce[j3 + 2] - cs[j3 + 2]) * e;
                    }
                    this.preChildOnlyCloud.geometry.attributes.position.needsUpdate = true;

                    const moArr = this.preMergedOnlyCloud.geometry.attributes.position.array;
                    const mos = this.moStartBuf, moe = this.moEndBuf;
                    for (let j = 0; j < a.moCount; j++) {
                        const j3 = j * 3;
                        moArr[j3]     = mos[j3]     + (moe[j3]     - mos[j3])     * e;
                        moArr[j3 + 1] = mos[j3 + 1] + (moe[j3 + 1] - mos[j3 + 1]) * e;
                        moArr[j3 + 2] = mos[j3 + 2] + (moe[j3 + 2] - mos[j3 + 2]) * e;
                    }
                    this.preMergedOnlyCloud.geometry.attributes.position.needsUpdate = true;

                    this.preMatchedCloud.material.uniforms.uOpacity.value = 1.0;
                    this.preChildOnlyCloud.material.uniforms.uOpacity.value = 1.0 - t;
                    this.preMergedOnlyCloud.material.uniforms.uOpacity.value = t;
                    break;
                }
            }

            if (t >= 1) {
                if (a.onComplete) a.onComplete();
                this.activeAnimations.splice(i, 1);
            }
        }
    }

    getLeafClusters() {
        return this.mergeEvents
            .filter(e => e.isLeaf)
            .map(e => e.cluster);
    }

    easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }
}
