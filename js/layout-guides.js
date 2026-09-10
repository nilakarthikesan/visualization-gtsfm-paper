import * as THREE from 'three';

export function depthColor(depth, maxDepth, darkTheme = false) {
    const t = maxDepth > 0 ? Math.max(0, Math.min(1, depth / maxDepth)) : 0;
    // Red at the root, then orange, yellow, green, blue, indigo, and violet.
    const stops = darkTheme
        ? [[248,113,113], [251,146,60], [250,204,21], [74,222,128], [56,189,248], [129,140,248], [192,132,252]]
        : [[220,38,38], [234,88,12], [218,179,0], [22,163,74], [2,132,199], [79,70,229], [147,51,234]];
    const position = t * (stops.length - 1);
    const index = Math.min(stops.length - 2, Math.floor(position));
    const fraction = position - index;
    return stops[index].map((c, i) => Math.round(c + (stops[index + 1][i] - c) * fraction)).join(' ');
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
            legend.querySelector('.depth-end').textContent = `Depth ${maxDepth} → root`;
            const colors = Array.from({length: 7}, (_, i) =>
                `rgb(${depthColor(maxDepth * (6 - i) / 6, maxDepth, this.darkTheme)})`);
            legend.querySelector('.depth-ramp').style.background =
                `linear-gradient(to right, ${colors.join(', ')})`;
            legend.querySelector('.depth-ticks').replaceChildren(...Array.from({length: maxDepth + 1}, (_, depth) => {
                const tick = document.createElement('span');
                tick.textContent = maxDepth - depth;
                return tick;
            }));
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

    // The on-screen guides are DOM overlays, so canvas.captureStream cannot see
    // them. Reuse their current geometry and computed styles in the video layer.
    drawToCanvas(context) {
        if (this.container.hidden) return;
        for (const { el, label } of this.entries) {
            if (el.hidden) continue;
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            const border = parseFloat(style.borderTopWidth);
            context.fillStyle = style.backgroundColor;
            context.fillRect(rect.left, rect.top, rect.width, rect.height);
            context.strokeStyle = style.borderTopColor;
            context.lineWidth = border;
            if (border > 0) context.strokeRect(rect.left + border / 2, rect.top + border / 2,
                Math.max(0, rect.width - border), Math.max(0, rect.height - border));
            if (label.hidden) continue;
            const labelRect = label.getBoundingClientRect();
            const labelStyle = getComputedStyle(label);
            context.save();
            context.beginPath();
            context.rect(labelRect.left, labelRect.top, labelRect.width, labelRect.height);
            context.clip();
            context.fillStyle = labelStyle.backgroundColor;
            context.fillRect(labelRect.left, labelRect.top, labelRect.width, labelRect.height);
            context.font = labelStyle.font;
            context.textBaseline = 'top';
            context.fillStyle = labelStyle.color;
            context.fillText(label.textContent,
                labelRect.left + parseFloat(labelStyle.paddingLeft),
                labelRect.top + parseFloat(labelStyle.paddingTop));
            context.restore();
        }
    }
}
