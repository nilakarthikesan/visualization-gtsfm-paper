import * as THREE from 'three';
import { planFloorplan } from './recursive-floorplan.js?v=1';

/** Final composition first; every node owns a rectangle throughout the build. */
export class SquarenessLayoutEngine {
    constructor(clusters) {
        this.clusters = clusters;
        this.rootCluster = clusters.get('merged');
        this.treeNodes = [];
        this.PADDING_FRAC = 0.05;
        this.FIT_FRAC = 0.82;
        this.viewportAspect = 16 / 9;
        this.bounds = null;
    }

    // Include ALL displayed points and camera wireframes, not percentile samples.
    // Geometry is local to cluster.group; frustums share that same local frame.
    measureCluster(cluster) {
        const box = new THREE.Box3();
        for (const geometry of [cluster.pointCloud?.geometry, cluster.frustumGeometry]) {
            if (!geometry) continue;
            geometry.computeBoundingBox();
            box.union(geometry.boundingBox);
        }
        if (box.isEmpty()) {
            const r = cluster.radius || 1;
            box.set(new THREE.Vector3(-r, -r, -r), new THREE.Vector3(r, r, r));
        }
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        return { box, center, w: Math.max(size.x, 1e-3), h: Math.max(size.y, 1e-3) };
    }

    computeLayout() {
        if (!this.rootCluster) throw new Error('No root reconstruction (merged) found');
        this.FIT_FRAC = THREE.MathUtils.clamp(this.FIT_FRAC || 0.82, 0.1, 1);
        this.PADDING_FRAC = THREE.MathUtils.clamp(this.PADDING_FRAC || 0, 0, 0.4);
        this.treeNodes = [];
        const visited = new Set();
        const build = (cluster, depth = 0) => {
            if (visited.has(cluster.path)) throw new Error(`Repeated cluster in merge tree: ${cluster.path}`);
            visited.add(cluster.path);
            const node = { cluster, depth, extent: this.measureCluster(cluster), children: [] };
            this.treeNodes.push(node);
            node.children = (cluster.children || []).map(c => build(c, depth + 1));
            return node;
        };
        const root = build(this.rootCluster);
        const aspect = Math.max(0.1, this.viewportAspect);
        // Reserve the usable viewport around the final reconstruction at scale 1.
        // Descendants inherit this frame; neither leaf count nor leaf gauges size it.
        const h = Math.max(root.extent.h, root.extent.w / aspect) / this.FIT_FRAC;
        const w = h * aspect;
        const rootRect = { x: -w / 2, y: -h / 2, w, h };
        const rectangles = planFloorplan(root, n => n.extent.w / n.extent.h, rootRect);
        let maxDepth = 0;
        for (const node of this.treeNodes) {
            const c = node.cluster;
            const r = rectangles.get(node);
            c.rect = r;
            c.mergeRegion = r;
            // Parent rectangles remain authoritative (including for unary merges).
            const gap = node === root ? 0 : Math.min(r.w, r.h) * this.PADDING_FRAC;
            const content = { x: r.x + gap / 2, y: r.y + gap / 2, w: r.w - gap, h: r.h - gap };
            const scale = Math.min(content.w / node.extent.w, content.h / node.extent.h) * this.FIT_FRAC;
            c.fitScale = scale;
            c.hierarchyPosition = new THREE.Vector3(
                content.x + content.w / 2 - node.extent.center.x * scale,
                content.y + content.h / 2 - node.extent.center.y * scale,
                -node.extent.center.z * scale
            );
            c.mergeTargetPosition = c.hierarchyPosition.clone();
            c.group.position.copy(c.hierarchyPosition);
            c.group.scale.setScalar(scale);
            c.group.visible = true;
            c.layoutExtent = node.extent;
            // These local bounds also constrain reconstruction reveals.
            c.revealBox = node.extent.box.clone();
            maxDepth = Math.max(maxDepth, (node.extent.box.max.z - node.extent.box.min.z) * scale / 2);
        }
        this.bounds = { minX: rootRect.x, maxX: -rootRect.x, minY: rootRect.y,
            maxY: -rootRect.y, width: w, height: h, maxDepth };
        for (const [path, c] of this.clusters) if (!visited.has(path)) c.group.visible = false;
    }
}
