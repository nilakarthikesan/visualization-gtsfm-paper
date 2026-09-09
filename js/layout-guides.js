import * as THREE from 'three';

export function depthColor(depth, maxDepth, darkTheme = false) {
    const t = maxDepth > 0 ? Math.max(0, Math.min(1, depth / maxDepth)) : 0;
    const light = darkTheme ? [62, 126, 172] : [107, 174, 214];
    const dark = darkTheme ? [184, 224, 245] : [8, 48, 107];
    return light.map((c, i) => Math.round(c + (dark[i] - c) * t)).join(' ');
}

// DOM guides stay sharp and legible independently of point size and postprocessing.
export class LayoutGuides {
    constructor(layout) {
        this.layout = layout;
        this.container = document.getElementById('layout-guides');
        this.rebuild();
    }

    rebuild() {
        this.container.replaceChildren();
        this.darkTheme = document.body.classList.contains('dark-theme');
        const maxDepth = Math.max(0, ...this.layout.treeNodes.map(node => node.depth));
        const legend = document.getElementById('layout-depth-legend');
        if (legend) {
            legend.querySelector('.depth-end').textContent = `Depth ${maxDepth}`;
            legend.querySelector('.depth-ramp').style.background =
                `linear-gradient(to right, rgb(${depthColor(0, maxDepth, this.darkTheme)}), rgb(${depthColor(maxDepth, maxDepth, this.darkTheme)}))`;
        }
        this.entries = this.layout.treeNodes.map(node => {
            const el = document.createElement('div');
            el.className = 'layout-region';
            const label = document.createElement('span');
            const parts = node.cluster.path.split('/');
            label.textContent = parts.length > 1 ? parts.at(-2) : 'Root';
            label.hidden = true;
            el.style.setProperty('--depth-color', depthColor(node.depth, maxDepth, this.darkTheme));
            el.title = node.cluster.path;
            el.append(label);
            this.container.append(el);
            return { node, el, label };
        });
    }

    update(camera, events, index, enabled, showLabels = false) {
        if (this.darkTheme !== document.body.classList.contains('dark-theme')) this.rebuild();
        // The guides describe the front-on presentation; manual 3D inspection is free.
        const front = camera.getWorldDirection(new THREE.Vector3()).z < -0.99999;
        this.container.hidden = !enabled || !front;
        const legend = document.getElementById('layout-depth-legend');
        if (legend) legend.hidden = !enabled || !front;
        if (!enabled || !front) return;
        const consumed = new Set(), arrived = new Set();
        for (const e of events.slice(0, index + 1)) {
            arrived.add(e.path);
            for (const child of e.children) consumed.add(child);
        }
        for (const { node, el, label } of this.entries) {
            const path = node.cluster.path;
            const plannedParent = node.depth <= 1 && !arrived.has(path);
            const visible = !consumed.has(path) && (!node.children.length || arrived.has(path) || plannedParent);
            el.hidden = !visible;
            if (!visible) continue;
            const r = node.cluster.rect;
            const a = new THREE.Vector3(r.x, r.y + r.h, 0).project(camera);
            const b = new THREE.Vector3(r.x + r.w, r.y, 0).project(camera);
            const w = (b.x - a.x) * window.innerWidth / 2;
            const h = (a.y - b.y) * window.innerHeight / 2;
            Object.assign(el.style, { left: `${(a.x + 1) * window.innerWidth / 2}px`,
                top: `${(1 - a.y) * window.innerHeight / 2}px`, width: `${w}px`, height: `${h}px` });
            el.classList.toggle('arrived', arrived.has(path));
            el.classList.toggle('planned-parent', plannedParent);
            label.hidden = !showLabels || w < 50 || h < 24;
        }
    }
}
