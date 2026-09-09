// Plan from the leaves' shape requirements, then assign rectangles from the root
// down. A candidate records a complete slicing plan, not just the next split.
// Normalizing each footprint to unit area avoids comparing unrelated SfM gauges.
export function planFloorplan(root, aspectOf, rootRect) {
    const prune = candidates => {
        const bins = new Map();
        for (const c of candidates) {
            const key = Math.round(Math.log2(c.w / c.h) * 6);
            const prev = bins.get(key);
            if (!prev || c.w * c.h < prev.w * prev.h) bins.set(key, c);
        }
        return [...bins.values()].sort((a, b) => a.w * a.h - b.w * b.h).slice(0, 32);
    };
    const build = node => {
        const aspect = Math.max(1e-6, aspectOf(node));
        const ownW = Math.sqrt(aspect), ownH = 1 / ownW;
        if (!node.children.length) return [{ node, w: ownW, h: ownH }];
        let packs = buildCached(node.children[0]);
        for (const child of node.children.slice(1)) {
            const next = [];
            for (const a of packs) for (const b of buildCached(child)) {
                next.push({ axis: 'x', a, b, w: a.w + b.w, h: Math.max(a.h, b.h) });
                next.push({ axis: 'y', a, b, w: Math.max(a.w, b.w), h: a.h + b.h });
            }
            packs = prune(next);
        }
        return prune(packs.map(pack => ({
            node, pack, w: Math.max(pack.w, ownW), h: Math.max(pack.h, ownH)
        })));
    };
    const cache = new Map();
    const buildCached = node => {
        if (!cache.has(node)) cache.set(node, build(node));
        return cache.get(node);
    };
    const candidates = buildCached(root);
    const fit = c => Math.min(rootRect.w / c.w, rootRect.h / c.h);
    const chosen = candidates.reduce((best, c) => fit(c) > fit(best) ? c : best);
    const rectangles = new Map();
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
            const w = r.w * c.a.w / (c.a.w + c.b.w);
            assign(c.a, { ...r, w });
            assign(c.b, { ...r, x: r.x + w, w: r.w - w });
        } else {
            const h = r.h * c.a.h / (c.a.h + c.b.h);
            assign(c.a, { ...r, h });
            assign(c.b, { ...r, y: r.y + h, h: r.h - h });
        }
    };
    assign(chosen, rootRect);
    return rectangles;
}
