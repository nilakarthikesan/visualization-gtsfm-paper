// Plan from every reconstruction's shape, then assign rectangles from the root
// down. A candidate records a complete slicing plan, not just the next split.
// Normalizing each footprint to unit area avoids comparing unrelated SfM gauges.
export function planFloorplan(root, aspectOf, rootRect) {
    // Maximize the geometric mean of displayed footprint area at all stages,
    // relative to the enclosing area. A merge represents all its descendant
    // leaves, so weight it accordingly: many early leaves must not drown out
    // the shape requirements of the few large, late reconstructions.
    const quality = c => c.logAreaSum / c.weight - Math.log(c.w * c.h);
    const prune = candidates => {
        const bins = new Map();
        for (const c of candidates) {
            const key = Math.round(Math.log2(c.w / c.h) * 6);
            const prev = bins.get(key);
            if (!prev || quality(c) > quality(prev)) bins.set(key, c);
        }
        return [...bins.values()].sort((a, b) => quality(b) - quality(a)).slice(0, 32);
    };
    const build = node => {
        const aspect = Math.max(1e-6, aspectOf(node));
        const ownW = Math.sqrt(aspect), ownH = 1 / ownW;
        if (!node.children.length) return [{ node, w: ownW, h: ownH,
            logAreaSum: 0, weight: 1, leafCount: 1 }];
        let packs = buildCached(node.children[0]);
        for (const child of node.children.slice(1)) {
            const next = [];
            for (const a of packs) for (const b of buildCached(child)) {
                const totals = { logAreaSum: a.logAreaSum + b.logAreaSum,
                    weight: a.weight + b.weight, leafCount: a.leafCount + b.leafCount };
                next.push({ ...totals, axis: 'x', a, b, w: a.w + b.w, h: Math.max(a.h, b.h) });
                next.push({ ...totals, axis: 'y', a, b, w: Math.max(a.w, b.w), h: a.h + b.h });
            }
            packs = prune(next);
        }
        return prune(packs.map(pack => {
            const w = Math.max(pack.w, ownW), h = Math.max(pack.h, ownH);
            const ownScale = Math.min(w / ownW, h / ownH);
            return { node, pack, w, h, leafCount: pack.leafCount,
                weight: pack.weight + pack.leafCount,
                logAreaSum: pack.logAreaSum + pack.leafCount * 2 * Math.log(ownScale) };
        }));
    };
    const cache = new Map();
    const buildCached = node => {
        if (!cache.has(node)) cache.set(node, build(node));
        return cache.get(node);
    };
    const candidates = buildCached(root);
    const rectangles = new Map();
    // Candidate packs share cached subtrees. Keep refinements outside the packs
    // so optimizing one candidate cannot change another candidate's layout.
    let fractions = new Map();
    const assign = (c, available, inherit = false) => {
        // Do not stretch a short leaf into a band alongside a deep subtree.
        // Unused cross-axis space remains reserved to the parent. This trades a
        // little empty space for readable, shape-preserving child rectangles.
        const scale = Math.min(available.w / c.w, available.h / c.h);
        const fitted = { x: available.x + (available.w - c.w * scale) / 2,
            y: available.y + (available.h - c.h * scale) / 2,
            w: c.w * scale, h: c.h * scale };
        // Internal nodes retain all their allocated real estate for future merges;
        // only a leaf's unused cross-axis strip can be returned to its parent.
        const r = c.node && !c.node.children.length && !inherit && c.node !== root
            ? fitted : available;
        if (c.node) {
            rectangles.set(c.node, { ...r });
            if (c.pack) assign(c.pack, r, c.node.children.length === 1);
        } else if (c.axis === 'x') {
            const w = r.w * (fractions.get(c) ?? c.a.w / (c.a.w + c.b.w));
            assign(c.a, { ...r, w });
            assign(c.b, { ...r, x: r.x + w, w: r.w - w });
        } else {
            const h = r.h * (fractions.get(c) ?? c.a.h / (c.a.h + c.b.h));
            assign(c.a, { ...r, h });
            assign(c.b, { ...r, y: r.y + h, h: r.h - h });
        }
    };
    // The viewport may stretch the envelope's cross-axis during assignment.
    // Rank the surviving plans using their actual allocated rectangles, so a
    // good hypothetical envelope cannot hide a poorly shaped on-screen cell.
    const score = candidate => {
        rectangles.clear();
        assign(candidate, rootRect);
        let total = 0;
        for (const [node, r] of rectangles) {
            const aspect = Math.max(1e-6, aspectOf(node));
            const scale = Math.min(r.w / Math.sqrt(aspect), r.h * Math.sqrt(aspect));
            const fill = scale * scale / (r.w * r.h);
            const shortfall = Math.max(0, Math.log(0.75 / fill));
            // Keep displayed area valuable, but discourage sacrificing one
            // reconstruction's shape for small gains elsewhere in the tree.
            total += cache.get(node)[0].leafCount * (2 * Math.log(scale) - 4 * shortfall * shortfall);
        }
        return total;
    };
    let bestScore = -Infinity, bestRectangles;
    for (const candidate of candidates) {
        fractions = new Map();
        const cuts = [];
        const collect = c => {
            if (c.pack) collect(c.pack);
            else if (c.axis) { cuts.push(c); collect(c.a); collect(c.b); }
        };
        collect(candidate);
        let current = score(candidate);
        // Coordinate refinement evaluates the whole tree in the real viewport.
        // Split fractions alone change: containment, disjointness, and the
        // inherited rectangles of unary merges remain guaranteed by assign().
        for (const step of [0.2, 0.05, 0.0125]) {
            for (const cut of cuts) {
                const initial = fractions.get(cut) ?? (cut.axis === 'x'
                    ? cut.a.w / (cut.a.w + cut.b.w) : cut.a.h / (cut.a.h + cut.b.h));
                let bestFraction = initial;
                for (const offset of [-2, -1, 1, 2]) {
                    const fraction = initial + offset * step;
                    if (fraction <= 0 || fraction >= 1) continue;
                    fractions.set(cut, fraction);
                    const trial = score(candidate);
                    if (trial > current + 1e-9) { current = trial; bestFraction = fraction; }
                }
                fractions.set(cut, bestFraction);
            }
        }
        if (current > bestScore) {
            bestScore = current;
            score(candidate);
            bestRectangles = new Map(rectangles);
        }
    }
    return bestRectangles;
}
