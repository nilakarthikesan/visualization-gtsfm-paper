// Select a central fraction jointly in XY. Taking 95% independently on X and Y
// can retain only 90% of observations; selecting observations first guarantees
// at least ceil(coverage * count) complete points/cameras inside the final box.
export function centralIndices(count, getX, getY, coverage = 0.95) {
    if (!count) return [];
    const xs = Array.from({ length: count }, (_, i) => getX(i)).sort((a, b) => a - b);
    const ys = Array.from({ length: count }, (_, i) => getY(i)).sort((a, b) => a - b);
    const quantile = (values, p) => values[Math.floor((count - 1) * p)];
    const cx = quantile(xs, 0.5), cy = quantile(ys, 0.5);
    const sx = Math.max(quantile(xs, 0.75) - quantile(xs, 0.25), 1e-9);
    const sy = Math.max(quantile(ys, 0.75) - quantile(ys, 0.25), 1e-9);
    return Array.from({ length: count }, (_, i) => ({ i,
        distance: Math.max(Math.abs(getX(i) - cx) / sx, Math.abs(getY(i) - cy) / sy)
    })).sort((a, b) => a.distance - b.distance || a.i - b.i)
        .slice(0, Math.ceil(count * coverage)).map(entry => entry.i);
}
