import * as THREE from 'three';

/**
 * Squareness-Based Recursive Rectangle Layout Engine
 * 
 * Only LEAF nodes get spatial positions. Merged (non-leaf) nodes
 * get a mergeTargetPosition and mergeRegion used during merge animations.
 */
export class SquarenessLayoutEngine {
    constructor(clusters) {
        this.clusters = clusters;
        this.rootCluster = clusters.get('merged');
        this.bounds = null;
        this.treeNodes = [];
        // Gap between sibling tiles (fraction of the parent's short side). Keeps a
        // clear lane between clusters so they read as distinct and don't touch.
        // Loosened from 0.02 so the build reads less crowded by default (Frank/Nila:
        // clusters felt too on-top-of-each-other). Live-tunable via the Cluster Gap
        // slider.
        this.PADDING_FRAC = 0.05;
        // Fraction of a tile that a cluster's XY footprint fills (per-axis, whichever
        // dimension binds first). Below 1 so the small tail of points beyond the
        // fitted percentile box still stays inside the cell rather than crossing
        // into a neighbor. Loosened from 0.88 to leave more air around each cluster.
        // Live-tunable via the Cluster Fill slider.
        this.FIT_FRAC = 0.82;
        this.leafRadiusMap = new Map();

        // --- Coherent (single world-scale) layout tunables ---
        // Every cluster is rendered at the SAME world scale (GLOBAL_SCALE) so the
        // reconstruction reads at its true relative sizes instead of each cluster
        // being independently blown up to fill a treemap tile (the old behavior that
        // produced ~18x scale variance and overlaps). Because the geometry is already
        // normalized into one shared, consistently scaled frame, cluster.originalCenter
        // is each cluster's TRUE center in that frame. We place every node at a purely
        // radial "explosion" of its true center about the root center:
        //     displayPos(node) = rootCenter + SPREAD * (node.originalCenter - rootCenter)
        // Offsets telescope, so this is a uniform radial spread of the real model:
        // clusters read as pieces of the true reconstruction pushed apart, and as they
        // merge the parent cloud (which already contains its subtree assembled at true
        // positions) collapses that explosion back toward the real model. SPREAD = 1
        // would be the fully assembled model with zero gaps.
        this.POSITION_SPREAD = 2.2;
        this.GLOBAL_SCALE = 1.0;
        // Optional per-axis damping of the explosion on Z (depth toward camera). Kept
        // at 1.0 = same spread on all axes; lower it if depth overlap looks bad.
        this.Z_SPREAD_FACTOR = 1.0;
    }

    compositions(n) {
        const result = [];
        const generate = (remaining, current) => {
            if (remaining === 0) { result.push([...current]); return; }
            for (let first = 1; first <= remaining; first++) {
                current.push(first);
                generate(remaining - first, current);
                current.pop();
            }
        };
        generate(n, []);
        return result;
    }

    squarenessForRow(W, H, n, m) {
        const rho = (H * m * m) / (W * n);
        return rho <= 1 ? rho : 1 / rho;
    }

    bestEqualAreaPartition(W, H, n) {
        if (n === 1) {
            return {
                squareness: Math.min(W, H) / Math.max(W, H),
                mode: 'rows', groups: [1],
                layout: [{ x: 0, y: 0, w: W, h: H }]
            };
        }

        const allComps = this.compositions(n);
        let bestS = -1, bestMode = 'rows', bestGroups = null;

        for (const ms of allComps) {
            const s = Math.min(...ms.map(m => this.squarenessForRow(W, H, n, m)));
            if (s > bestS) { bestS = s; bestMode = 'rows'; bestGroups = ms; }
        }
        for (const ms of allComps) {
            const s = Math.min(...ms.map(m => this.squarenessForRow(H, W, n, m)));
            if (s > bestS) { bestS = s; bestMode = 'cols'; bestGroups = ms; }
        }

        const layout = this.buildTiles(W, H, bestMode, bestGroups, n);
        return { squareness: bestS, mode: bestMode, groups: bestGroups, layout };
    }

    buildTiles(W, H, mode, groups, n) {
        const tiles = [];
        if (mode === 'rows') {
            let yOff = 0;
            for (const m of groups) {
                const rowH = H * m / n;
                const tileW = W / m;
                for (let i = 0; i < m; i++)
                    tiles.push({ x: i * tileW, y: yOff, w: tileW, h: rowH });
                yOff += rowH;
            }
        } else {
            let xOff = 0;
            for (const m of groups) {
                const colW = W * m / n;
                const tileH = H / m;
                for (let i = 0; i < m; i++)
                    tiles.push({ x: xOff, y: i * tileH, w: colW, h: tileH });
                xOff += colW;
            }
        }
        return tiles;
    }

    /**
     * Robust XY footprint of a cluster's point cloud (the screen-facing extent,
     * since the camera looks down +Z). Uses percentiles so a few stray outlier
     * points don't inflate the box and shrink the whole cluster. Returns the
     * center and half-width/height in the cloud's local (pre-scale) coordinates.
     */
    robustXYExtent(cluster, lowP = 0.01, highP = 0.99) {
        const geom = cluster.pointCloud && cluster.pointCloud.geometry;
        if (!geom || !geom.attributes.position) return null;
        const pos = geom.attributes.position;
        const n = pos.count;
        if (n === 0) return null;

        const maxSamples = 20000;
        const step = Math.max(1, Math.floor(n / maxSamples));
        const xs = [], ys = [];
        for (let i = 0; i < n; i += step) {
            xs.push(pos.getX(i));
            ys.push(pos.getY(i));
        }
        xs.sort((a, b) => a - b);
        ys.sort((a, b) => a - b);
        const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))];
        const xlo = q(xs, lowP), xhi = q(xs, highP);
        const ylo = q(ys, lowP), yhi = q(ys, highP);
        return {
            cx: (xlo + xhi) / 2,
            cy: (ylo + yhi) / 2,
            halfW: Math.max((xhi - xlo) / 2, 1e-3),
            halfH: Math.max((yhi - ylo) / 2, 1e-3)
        };
    }

    /**
     * Scale a cluster to fill the given rect (fraction FIT_FRAC) based on its XY
     * footprint, and return the tile-centered world position (footprint centered
     * in the rect). Falls back to bounding-sphere fit if the footprint is missing.
     */
    fitClusterToRect(cluster, rectCenterX, rectCenterY, rectW, rectH) {
        const ext = this.robustXYExtent(cluster);
        if (ext) {
            const sx = (rectW * this.FIT_FRAC) / (2 * ext.halfW);
            const sy = (rectH * this.FIT_FRAC) / (2 * ext.halfH);
            cluster.fitScale = Math.min(sx, sy);
            cluster.group.scale.setScalar(cluster.fitScale);
            return new THREE.Vector3(
                rectCenterX - ext.cx * cluster.fitScale,
                rectCenterY - ext.cy * cluster.fitScale,
                0
            );
        }
        if (cluster.radius > 0) {
            const fitDim = Math.min(rectW, rectH) * this.FIT_FRAC;
            cluster.fitScale = fitDim / (2 * cluster.radius);
            cluster.group.scale.setScalar(cluster.fitScale);
        }
        return new THREE.Vector3(rectCenterX, rectCenterY, 0);
    }

    /**
     * Placement scheme selector. Default is the treemap ("own real estate") layout
     * that Frank prefers; ?layout=coherent switches to the exploded single-scale
     * layout for comparison. Timing/timestamps are unaffected by this choice.
     */
    computeLayout() {
        let mode = 'treemap';
        try {
            const p = new URLSearchParams(window.location.search);
            if (p.get('layout') === 'coherent') mode = 'coherent';
        } catch (e) { /* non-browser context */ }
        return mode === 'coherent'
            ? this.computeLayoutCoherent()
            : this.computeLayoutTreemap();
    }

    /**
     * TREEMAP LAYOUT (default). Recursive squareness-optimized rectangle subdivision:
     * every leaf cluster gets its own non-overlapping tile sized to its footprint, and
     * merged nodes sit at the centroid of their children's tiles. This is the "each
     * cluster has its own real estate" arrangement.
     */
    computeLayoutTreemap() {
        if (!this.rootCluster) {
            console.error("No root cluster (merged) found!");
            return;
        }

        console.log("\n=== COMPUTING SQUARENESS LAYOUT ===");

        const visited = new Set();
        const buildTree = (cluster, depth = 0) => {
            if (!cluster || visited.has(cluster.path)) return null;
            visited.add(cluster.path);
            const node = { cluster, depth, children: [] };
            this.treeNodes.push(node);
            for (const child of (cluster.children || [])) {
                const cn = buildTree(child, depth + 1);
                if (cn) node.children.push(cn);
            }
            return node;
        };
        const rootNode = buildTree(this.rootCluster);

        const leaves = this.treeNodes.filter(n => n.children.length === 0);
        const leafCount = leaves.length;

        this.leafRadiusMap.clear();
        for (const leaf of leaves) {
            const r = leaf.cluster.radius > 0 ? leaf.cluster.radius : 1;
            this.leafRadiusMap.set(leaf.cluster.path, r);
        }

        let totalArea = 0;
        for (const leaf of leaves) {
            const r = this.leafRadiusMap.get(leaf.cluster.path);
            totalArea += (2.0 * r) * (2.0 * r);
        }
        totalArea *= 1.0;
        const aspect = 16 / 9;
        const ROOT_H = Math.sqrt(totalArea / aspect);
        const ROOT_W = ROOT_H * aspect;

        console.log(`Leaves: ${leafCount}, radii: [${leaves.map(l => this.leafRadiusMap.get(l.cluster.path).toFixed(1)).join(', ')}]`);
        console.log(`Root rect: ${ROOT_W.toFixed(0)} x ${ROOT_H.toFixed(0)}`);

        const rootRect = { x: -ROOT_W / 2, y: -ROOT_H / 2, w: ROOT_W, h: ROOT_H };
        // Default: squarified tiling. The old recursive per-node slicing
        // (assignLeafTiles) followed the tree depth, so Brussels' deep unbalanced
        // C_1 chain (32/40 leaves, depth 12) got peeled into a vertical ladder of
        // flat bands - extreme-aspect slivers (up to 28:1), an 8x fitScale swing,
        // and even a negative-width tile (frame 77 -> mirror-inverted cluster).
        // Squarified tiling gives every leaf a near-square tile regardless of the
        // tree's shape, while each top-level subtree still keeps its own contiguous
        // region so sections build in order and merges stay compact.
        // ?tiling=recursive restores the old behavior for comparison.
        let tiling = 'squarified';
        try {
            const p = new URLSearchParams(window.location.search);
            if (p.get('tiling') === 'recursive') tiling = 'recursive';
        } catch (e) { /* non-browser context */ }
        if (tiling === 'recursive') this.assignLeafTiles(rootNode, rootRect);
        else this.assignLeafTilesSquarified(rootNode, rootRect);
        this.computeMergePositions(rootNode);

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

        for (const node of this.treeNodes) {
            const c = node.cluster;
            const isLeaf = node.children.length === 0;

            if (isLeaf && c.rect) {
                const cx = c.rect.x + c.rect.w / 2;
                const cy = c.rect.y + c.rect.h / 2;
                c.hierarchyPosition = this.fitClusterToRect(c, cx, cy, c.rect.w, c.rect.h);
                c.group.position.copy(c.hierarchyPosition);

                minX = Math.min(minX, c.rect.x);
                maxX = Math.max(maxX, c.rect.x + c.rect.w);
                minY = Math.min(minY, c.rect.y);
                maxY = Math.max(maxY, c.rect.y + c.rect.h);

            } else if (!isLeaf) {
                const pos = c.mergeTargetPosition;
                const reg = c.mergeRegion;
                if (pos && reg) {
                    c.hierarchyPosition = this.fitClusterToRect(
                        c, pos.x, pos.y, reg.w, reg.h
                    );
                    c.group.position.copy(c.hierarchyPosition);
                } else if (pos) {
                    c.hierarchyPosition = pos.clone();
                    c.group.position.copy(c.hierarchyPosition);
                }
            }
        }

        if (minX === Infinity) {
            this.bounds = { minX: -10, maxX: 10, minY: -10, maxY: 10, width: 60, height: 60 };
        } else {
            this.bounds = {
                minX, maxX, minY, maxY,
                width: maxX - minX + 2,
                height: maxY - minY + 2
            };
        }

        for (const [path] of this.clusters) {
            if (!visited.has(path)) this.clusters.get(path).group.visible = false;
        }

        console.log(`Bounds: ${this.bounds.width.toFixed(0)} x ${this.bounds.height.toFixed(0)}`);
        console.log("=== SQUARENESS LAYOUT COMPLETE ===\n");
    }

    /**
     * COHERENT SINGLE-SCALE LAYOUT.
     *
     * Replaces the old treemap (which rescaled every cluster independently to fill a
     * tile, producing ~18x scale variance and an incoherent "exploded junk" look).
     * Here every cluster is rendered at ONE world scale, and positioned by a purely
     * radial explosion of its TRUE center about the root center:
     *     displayPos = rootCenter + SPREAD * (originalCenter - rootCenter)
     * so the arrangement is literally the real reconstruction spread apart, and merges
     * collapse it back to the true model. Camera-framing rects (cluster.rect /
     * mergeRegion, consumed by fitCameraToVisible/AllLeaves) are still populated as the
     * XY screen box around each cluster's display position.
     */
    computeLayoutCoherent() {
        if (!this.rootCluster) {
            console.error("No root cluster (merged) found!");
            return;
        }

        console.log("\n=== COMPUTING COHERENT LAYOUT ===");

        // Live tuning without editing: ?spread= and ?gscale= URL params.
        let SPREAD = this.POSITION_SPREAD;
        let GLOBAL = this.GLOBAL_SCALE;
        try {
            const p = new URLSearchParams(window.location.search);
            const s = parseFloat(p.get('spread'));
            const g = parseFloat(p.get('gscale'));
            if (isFinite(s) && s > 0) SPREAD = s;
            if (isFinite(g) && g > 0) GLOBAL = g;
        } catch (e) { /* non-browser context */ }

        const visited = new Set();
        const buildTree = (cluster, depth = 0) => {
            if (!cluster || visited.has(cluster.path)) return null;
            visited.add(cluster.path);
            const node = { cluster, depth, children: [] };
            this.treeNodes.push(node);
            for (const child of (cluster.children || [])) {
                const cn = buildTree(child, depth + 1);
                if (cn) node.children.push(cn);
            }
            return node;
        };
        buildTree(this.rootCluster);

        const rootCenter = (this.rootCluster.originalCenter
            ? this.rootCluster.originalCenter.clone()
            : new THREE.Vector3());

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

        for (const node of this.treeNodes) {
            const c = node.cluster;
            const center = (c.originalCenter ? c.originalCenter.clone() : new THREE.Vector3());

            // Radial explosion of the true center about the root center. Z can be
            // damped independently so depth overlap toward the camera stays readable.
            const off = center.clone().sub(rootCenter);
            const disp = new THREE.Vector3(
                rootCenter.x + off.x * SPREAD,
                rootCenter.y + off.y * SPREAD,
                rootCenter.z + off.z * SPREAD * this.Z_SPREAD_FACTOR
            );

            c.fitScale = GLOBAL;
            c.group.scale.setScalar(GLOBAL);
            c.hierarchyPosition = disp;
            c.group.position.copy(disp);
            // Kept for any animation/particle code that references them.
            c.mergeTargetPosition = disp.clone();

            // XY screen box around the display position, used for camera framing.
            let halfW = (c.radius || 1) * GLOBAL;
            let halfH = halfW;
            let bcx = 0, bcy = 0;
            const geom = c.pointCloud && c.pointCloud.geometry;
            if (geom) {
                if (!geom.boundingBox) geom.computeBoundingBox();
                const bb = geom.boundingBox;
                if (bb) {
                    halfW = ((bb.max.x - bb.min.x) / 2) * GLOBAL;
                    halfH = ((bb.max.y - bb.min.y) / 2) * GLOBAL;
                    bcx = ((bb.max.x + bb.min.x) / 2) * GLOBAL;
                    bcy = ((bb.max.y + bb.min.y) / 2) * GLOBAL;
                }
            }
            const rect = {
                x: disp.x + bcx - halfW,
                y: disp.y + bcy - halfH,
                w: Math.max(halfW * 2, 1e-3),
                h: Math.max(halfH * 2, 1e-3)
            };
            c.rect = rect;
            c.mergeRegion = { ...rect };

            minX = Math.min(minX, rect.x);
            maxX = Math.max(maxX, rect.x + rect.w);
            minY = Math.min(minY, rect.y);
            maxY = Math.max(maxY, rect.y + rect.h);
        }

        if (minX === Infinity) {
            this.bounds = { minX: -10, maxX: 10, minY: -10, maxY: 10, width: 60, height: 60 };
        } else {
            this.bounds = {
                minX, maxX, minY, maxY,
                width: maxX - minX + 2,
                height: maxY - minY + 2
            };
        }

        for (const [path] of this.clusters) {
            if (!visited.has(path)) this.clusters.get(path).group.visible = false;
        }

        console.log(`Coherent layout: ${this.treeNodes.length} nodes, SPREAD=${SPREAD}, GLOBAL=${GLOBAL}`);
        console.log(`Bounds: ${this.bounds.width.toFixed(0)} x ${this.bounds.height.toFixed(0)}`);
        console.log("=== COHERENT LAYOUT COMPLETE ===\n");
    }

    sumLeafWeights(node) {
        if (!node) return 0;
        if (node.children.length === 0) {
            const r = this.leafRadiusMap.get(node.cluster.path) || 1;
            return r * r;
        }
        let sum = 0;
        for (const child of node.children) sum += this.sumLeafWeights(child);
        return sum;
    }

    assignLeafTiles(node, rect) {
        if (!node) return;
        if (node.children.length === 0) {
            node.cluster.rect = { ...rect };
            return;
        }

        const children = node.children;
        const n = children.length;
        const weights = children.map(c => this.sumLeafWeights(c));
        const totalWeight = weights.reduce((a, b) => a + b, 0);
        const pad = Math.min(rect.w, rect.h) * this.PADDING_FRAC;

        // Generate all possible partitions of children into contiguous groups.
        // For n children, there are 2^(n-1) ways to split (each gap is break or not).
        const partitions = [];
        const numSplits = 1 << (n - 1);
        for (let mask = 0; mask < numSplits; mask++) {
            const groups = [];
            let start = 0;
            for (let bit = 0; bit < n - 1; bit++) {
                if (mask & (1 << bit)) {
                    groups.push({ from: start, to: bit + 1 });
                    start = bit + 1;
                }
            }
            groups.push({ from: start, to: n });
            partitions.push(groups);
        }

        // Evaluate each partition in both row and column orientations.
        let bestScore = -1;
        let bestPartition = null;
        let bestOrientation = 'rows';

        for (const groups of partitions) {
            for (const orientation of ['rows', 'cols']) {
                const primaryDim = orientation === 'rows' ? rect.h : rect.w;
                const crossDim = orientation === 'rows' ? rect.w : rect.h;
                let worst = 1;

                for (const g of groups) {
                    let groupWeight = 0;
                    for (let i = g.from; i < g.to; i++) groupWeight += weights[i];
                    const groupPrimary = primaryDim * (groupWeight / totalWeight);

                    for (let i = g.from; i < g.to; i++) {
                        const childCross = crossDim * (weights[i] / groupWeight);
                        const w = (orientation === 'rows' ? childCross : groupPrimary) - pad;
                        const h = (orientation === 'rows' ? groupPrimary : childCross) - pad;
                        if (w > 0 && h > 0) {
                            worst = Math.min(worst, Math.min(w, h) / Math.max(w, h));
                        } else {
                            worst = 0;
                        }
                    }
                }

                if (worst > bestScore) {
                    bestScore = worst;
                    bestPartition = groups;
                    bestOrientation = orientation;
                }
            }
        }

        // Apply the best partition.
        let primaryOff = 0;
        const primaryTotal = bestOrientation === 'rows' ? rect.h : rect.w;
        const crossTotal = bestOrientation === 'rows' ? rect.w : rect.h;

        for (const g of bestPartition) {
            let groupWeight = 0;
            for (let i = g.from; i < g.to; i++) groupWeight += weights[i];
            const groupPrimary = primaryTotal * (groupWeight / totalWeight);

            let crossOff = 0;
            for (let i = g.from; i < g.to; i++) {
                const childCross = crossTotal * (weights[i] / groupWeight);
                let childRect;
                if (bestOrientation === 'rows') {
                    childRect = {
                        x: rect.x + crossOff + pad / 2,
                        y: rect.y + primaryOff + pad / 2,
                        w: childCross - pad,
                        h: groupPrimary - pad
                    };
                } else {
                    childRect = {
                        x: rect.x + primaryOff + pad / 2,
                        y: rect.y + crossOff + pad / 2,
                        w: groupPrimary - pad,
                        h: childCross - pad
                    };
                }
                this.assignLeafTiles(children[i], childRect);
                crossOff += childCross;
            }
            primaryOff += groupPrimary;
        }
    }

    /**
     * Shrink a rect inward to leave a clean lane between neighbors. The gap is a
     * fraction of the tile's SHORT side, so big and small tiles get proportional
     * air. Guarded so padding can never invert a tile (the old code did
     * `childCross - pad` and produced a negative-width, mirror-flipped cluster on
     * Brussels frame 77).
     */
    padRect(r) {
        const pad = Math.min(r.w, r.h) * this.PADDING_FRAC;
        return {
            x: r.x + pad / 2,
            y: r.y + pad / 2,
            w: Math.max(r.w - pad, r.w * 0.5),
            h: Math.max(r.h - pad, r.h * 0.5)
        };
    }

    /**
     * Worst (largest) aspect ratio in a candidate squarified row, given the row's
     * fixed side length. Standard Bruls/Huizing/van Wijk squarify metric.
     */
    worstAspect(row, side) {
        let sum = 0, rmax = -Infinity, rmin = Infinity;
        for (const n of row) {
            sum += n.area;
            if (n.area > rmax) rmax = n.area;
            if (n.area < rmin) rmin = n.area;
        }
        const s2 = sum * sum;
        const side2 = side * side;
        return Math.max((side2 * rmax) / s2, s2 / (side2 * rmin));
    }

    /**
     * Squarified treemap of a weighted item list into `rect`. Items are consumed in
     * order (so a subtree's leaves, gathered in DFS order, stay spatially contiguous
     * and their merges stay compact). Returns [{ it, x, y, w, h }] with tiles that
     * are as close to square as the areas allow - no dependence on tree depth, so no
     * vertical ladders or extreme slivers.
     */
    squarifyTiles(items, rect) {
        const total = items.reduce((a, b) => a + b.weight, 0) || 1;
        const scale = (rect.w * rect.h) / total;
        const nodes = items.map(it => ({ it, area: Math.max(it.weight * scale, 1e-9) }));

        const out = [];
        let free = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
        let i = 0;

        while (i < nodes.length && free.w > 1e-6 && free.h > 1e-6) {
            const side = Math.min(free.w, free.h);
            const row = [nodes[i]];
            i++;
            // Extend the row while it keeps tiles more square.
            while (i < nodes.length) {
                const cur = this.worstAspect(row, side);
                const next = this.worstAspect(row.concat([nodes[i]]), side);
                if (next <= cur) { row.push(nodes[i]); i++; }
                else break;
            }

            const rowArea = row.reduce((a, b) => a + b.area, 0);
            if (free.w <= free.h) {
                // Horizontal strip across the top of the free area.
                const thick = rowArea / free.w;
                let cx = free.x;
                for (const n of row) {
                    const cw = n.area / thick;
                    out.push({ it: n.it, x: cx, y: free.y, w: cw, h: thick });
                    cx += cw;
                }
                free = { x: free.x, y: free.y + thick, w: free.w, h: free.h - thick };
            } else {
                // Vertical strip down the left of the free area.
                const thick = rowArea / free.h;
                let cy = free.y;
                for (const n of row) {
                    const ch = n.area / thick;
                    out.push({ it: n.it, x: free.x, y: cy, w: thick, h: ch });
                    cy += ch;
                }
                free = { x: free.x + thick, y: free.y, w: free.w - thick, h: free.h };
            }
        }
        // Any leftover (numeric slack) gets the remaining free area.
        for (; i < nodes.length; i++) {
            out.push({ it: nodes[i].it, x: free.x, y: free.y, w: free.w, h: free.h });
        }
        return out;
    }

    /** DFS-order leaves under a tree node. */
    gatherLeafNodes(node) {
        const leaves = [];
        const walk = (n) => {
            if (n.children.length === 0) leaves.push(n);
            else for (const ch of n.children) walk(ch);
        };
        walk(node);
        return leaves;
    }

    /** Squarify one top-level subtree's leaves into its allocated region. */
    tileSubtree(node, region) {
        const leaves = this.gatherLeafNodes(node);
        if (leaves.length === 0) return;
        if (leaves.length === 1) {
            leaves[0].cluster.rect = this.padRect(region);
            return;
        }
        const items = leaves.map(l => ({
            node: l,
            weight: Math.max(Math.pow(this.leafRadiusMap.get(l.cluster.path) || 1, 2), 1e-6)
        }));
        const tiles = this.squarifyTiles(items, region);
        for (const t of tiles) t.it.node.cluster.rect = this.padRect(t);
    }

    /**
     * Squarified placement (default). Each top-level subtree (root's direct
     * children) gets its own contiguous region, sized by its leaf-weight and placed
     * squarified so sections don't smear into thin strips. Inside each region the
     * subtree's leaves are squarified too. Replaces the depth-following recursive
     * slicing that produced the Brussels vertical line.
     */
    assignLeafTilesSquarified(rootNode, rootRect) {
        const topChildren = rootNode.children.length ? rootNode.children : [rootNode];
        const topItems = topChildren.map(ch => ({
            node: ch,
            weight: Math.max(this.sumLeafWeights(ch), 1e-6)
        }));
        const topTiles = this.squarifyTiles(topItems, rootRect);
        for (const t of topTiles) {
            const region = this.padRect(t);
            this.tileSubtree(t.it.node, region);
        }
    }

    computeMergePositions(node) {
        if (!node || node.children.length === 0) return;

        for (const child of node.children) this.computeMergePositions(child);

        const leafRects = [];
        const gatherLeaves = (n) => {
            if (n.children.length === 0 && n.cluster.rect) {
                leafRects.push(n.cluster.rect);
            }
            for (const ch of n.children) gatherLeaves(ch);
        };
        gatherLeaves(node);

        if (leafRects.length === 0) return;

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const r of leafRects) {
            minX = Math.min(minX, r.x);
            maxX = Math.max(maxX, r.x + r.w);
            minY = Math.min(minY, r.y);
            maxY = Math.max(maxY, r.y + r.h);
        }

        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;

        node.cluster.mergeTargetPosition = new THREE.Vector3(cx, cy, 0);
        node.cluster.mergeRegion = {
            x: minX, y: minY,
            w: maxX - minX,
            h: maxY - minY
        };
    }
}
