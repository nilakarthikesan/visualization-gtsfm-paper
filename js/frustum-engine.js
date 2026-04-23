import * as THREE from 'three';

export class FrustumEngine {
    constructor(worldGroup) {
        this.worldGroup = worldGroup;
        this.frustumGroups = new Map();
        this.frustumAspect = 4 / 3;
        this.frustumFovY = 50;
        this.frustumRelativeSize = 0.15;
        this.activeFades = [];
    }

    async loadForClusters(clusters, dataLoader) {
        this.clusters = clusters;
        this.dataLoader = dataLoader;

        const clusterPaths = [];
        for (const [path, cluster] of clusters) {
            if (cluster.pointCloud) clusterPaths.push(path);
        }

        for (const path of clusterPaths) {
            const cameras = await this.loadClusterCameras(path);
            if (cameras.length === 0) continue;

            const transformed = this.transformCameras(cameras);
            const group = this.buildFrustumGroup(transformed, path);
            group.visible = false;
            this.frustumGroups.set(path, group);
        }

        console.log(`FrustumEngine: loaded frustums for ${this.frustumGroups.size} clusters`);
    }

    async loadClusterCameras(clusterPath) {
        const cameras = [];
        const filePath = `data/gerrard-hall-vggt/results/${clusterPath}/images.txt`;

        try {
            const response = await fetch(filePath);
            if (!response.ok) return cameras;
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

                const R = [
                    [1 - 2*(qy*qy + qz*qz), 2*(qx*qy - qz*qw),   2*(qx*qz + qy*qw)],
                    [2*(qx*qy + qz*qw),      1 - 2*(qx*qx + qz*qz), 2*(qy*qz - qx*qw)],
                    [2*(qx*qz - qy*qw),      2*(qy*qz + qx*qw),   1 - 2*(qx*qx + qy*qy)]
                ];

                const RT = [
                    [R[0][0], R[1][0], R[2][0]],
                    [R[0][1], R[1][1], R[2][1]],
                    [R[0][2], R[1][2], R[2][2]]
                ];

                const cx = -(RT[0][0]*tx + RT[0][1]*ty + RT[0][2]*tz);
                const cy = -(RT[1][0]*tx + RT[1][1]*ty + RT[1][2]*tz);
                const cz = -(RT[2][0]*tx + RT[2][1]*ty + RT[2][2]*tz);

                const lx = RT[0][2], ly = RT[1][2], lz = RT[2][2];
                const ux = -RT[0][1], uy = -RT[1][1], uz = -RT[2][1];
                const rx = RT[0][0], ry = RT[1][0], rz = RT[2][0];

                cameras.push({
                    position: new THREE.Vector3(cx, cy, cz),
                    look: new THREE.Vector3(lx, ly, lz).normalize(),
                    up: new THREE.Vector3(ux, uy, uz).normalize(),
                    right: new THREE.Vector3(rx, ry, rz).normalize()
                });

                i++;
            }
        } catch (e) {
            // silently skip clusters without camera data
        }

        return cameras;
    }

    transformCameras(cameras) {
        const dl = this.dataLoader;
        const center = dl.globalCenter;
        const rot = dl.sceneRotation;
        const scale = dl.scaleFactor;

        return cameras.map(cam => {
            const pos = cam.position.clone().sub(center);
            pos.applyMatrix4(rot);
            pos.multiplyScalar(scale);

            const look = cam.look.clone().applyMatrix4(rot).normalize();
            const up = cam.up.clone().applyMatrix4(rot).normalize();
            const right = cam.right.clone().applyMatrix4(rot).normalize();

            return { position: pos, look, up, right };
        });
    }

    buildFrustumGroup(cameras, clusterPath) {
        const group = new THREE.Group();
        group.userData.clusterPath = clusterPath;

        const cluster = this.clusters.get(clusterPath);
        const clusterRadius = cluster ? cluster.radius : 1;

        const frustumLength = clusterRadius * this.frustumRelativeSize;
        const halfH = Math.tan(THREE.MathUtils.degToRad(this.frustumFovY / 2)) * frustumLength;
        const halfW = halfH * this.frustumAspect;

        const vertices = [];
        const colors = [];

        const hue = this.pathToHue(clusterPath);
        const color = new THREE.Color().setHSL(hue, 0.7, 0.6);

        for (const cam of cameras) {
            const localPos = cam.position.clone();

            const fc = localPos.clone().add(cam.look.clone().multiplyScalar(frustumLength));
            const r = cam.right.clone().multiplyScalar(halfW);
            const u = cam.up.clone().multiplyScalar(halfH);

            const tl = fc.clone().sub(r).add(u);
            const tr = fc.clone().add(r).add(u);
            const bl = fc.clone().sub(r).sub(u);
            const br = fc.clone().add(r).sub(u);

            const apex = localPos;

            const edges = [
                [apex, tl], [apex, tr], [apex, bl], [apex, br],
                [tl, tr], [tr, br], [br, bl], [bl, tl]
            ];

            for (const [a, b] of edges) {
                vertices.push(a.x, a.y, a.z, b.x, b.y, b.z);
                colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
            }
        }

        if (vertices.length === 0) return group;

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

        const mat = new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: 0.6,
            depthWrite: false
        });

        const lines = new THREE.LineSegments(geom, mat);
        group.add(lines);

        this.worldGroup.add(group);
        return group;
    }

    pathToHue(path) {
        let hash = 0;
        for (let i = 0; i < path.length; i++) {
            hash = path.charCodeAt(i) + ((hash << 5) - hash);
        }
        return (Math.abs(hash) % 360) / 360;
    }

    showForCluster(clusterPath) {
        const group = this.frustumGroups.get(clusterPath);
        if (!group) return;

        const cluster = this.clusters.get(clusterPath);
        if (cluster && cluster.hierarchyPosition) {
            group.position.copy(cluster.hierarchyPosition);
        }
        if (cluster && cluster.fitScale) {
            group.scale.setScalar(cluster.fitScale);
        }
        group.visible = true;
    }

    hideForCluster(clusterPath) {
        const group = this.frustumGroups.get(clusterPath);
        if (group) group.visible = false;
    }

    hideAll() {
        for (const group of this.frustumGroups.values()) {
            group.visible = false;
        }
    }

    fadeOutCluster(clusterPath, duration = 500) {
        const group = this.frustumGroups.get(clusterPath);
        if (!group || !group.visible) return;

        const lineMat = group.children[0]?.material;
        if (!lineMat) return;

        this.activeFades.push({
            group,
            material: lineMat,
            startOpacity: lineMat.opacity,
            startTime: performance.now(),
            duration
        });
    }

    fadeInCluster(clusterPath, duration = 400) {
        const group = this.frustumGroups.get(clusterPath);
        if (!group) return;

        const cluster = this.clusters.get(clusterPath);
        if (cluster && cluster.hierarchyPosition) {
            group.position.copy(cluster.hierarchyPosition);
        }
        if (cluster && cluster.fitScale) {
            group.scale.setScalar(cluster.fitScale);
        }

        const lineMat = group.children[0]?.material;
        if (lineMat) {
            lineMat.opacity = 0;
        }
        group.visible = true;

        this.activeFades.push({
            group,
            material: lineMat,
            startOpacity: 0,
            targetOpacity: 0.6,
            startTime: performance.now(),
            duration,
            fadeIn: true
        });
    }

    update() {
        const now = performance.now();
        for (let i = this.activeFades.length - 1; i >= 0; i--) {
            const fade = this.activeFades[i];
            const t = Math.min((now - fade.startTime) / fade.duration, 1);

            if (fade.fadeIn) {
                fade.material.opacity = fade.startOpacity + (fade.targetOpacity - fade.startOpacity) * t;
            } else {
                fade.material.opacity = fade.startOpacity * (1 - t);
            }

            if (t >= 1) {
                if (!fade.fadeIn) {
                    fade.group.visible = false;
                    fade.material.opacity = fade.startOpacity;
                }
                this.activeFades.splice(i, 1);
            }
        }
    }

    syncWithEvent(event, visible) {
        if (event.isLeaf) {
            if (visible) {
                this.showForCluster(event.path);
            } else {
                this.hideForCluster(event.path);
            }
        } else {
            for (const childPath of event.children) {
                this.hideForCluster(childPath);
            }
            if (visible) {
                this.showForCluster(event.path);
            } else {
                this.hideForCluster(event.path);
            }
        }
    }

    syncToEventIndex(events, currentIndex, animate = false) {
        this.activeFades = [];

        const shouldBeVisible = new Set();
        const fadeInPaths = new Set();
        const fadeOutPaths = new Set();

        for (let i = 0; i <= currentIndex; i++) {
            const evt = events[i];
            if (evt.isLeaf) {
                shouldBeVisible.add(evt.path);
                if (animate && i === currentIndex) {
                    fadeInPaths.add(evt.path);
                }
            } else {
                for (const childPath of evt.children) {
                    shouldBeVisible.delete(childPath);
                    if (animate && i === currentIndex) {
                        fadeOutPaths.add(childPath);
                    }
                }
                shouldBeVisible.add(evt.path);
                if (animate && i === currentIndex) {
                    fadeInPaths.add(evt.path);
                }
            }
        }

        for (const [path, group] of this.frustumGroups) {
            if (shouldBeVisible.has(path)) {
                if (fadeInPaths.has(path)) {
                    this.fadeInCluster(path, 800);
                } else if (!group.visible) {
                    this.showForCluster(path);
                }
            } else if (fadeOutPaths.has(path)) {
                this.fadeOutCluster(path, 600);
            } else if (group.visible) {
                group.visible = false;
            }
        }
    }
}
