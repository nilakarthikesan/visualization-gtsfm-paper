import { createMatchingSnapshot } from './point-matching.js?v=1';

/** Current animated merge, then the next two animated merges (including cached ones). */
export function matchingPriorities(events, plan, index, includeCurrent = true) {
    const paths = [];
    const animatedMerge = i => !events[i].isLeaf && plan.animationDurations[i] > 0;
    if (includeCurrent && events[index] && animatedMerge(index)) paths.push(events[index].path);
    let upcoming = 0;
    for (let i = index + 1; i < events.length && upcoming < 2; i++) {
        if (animatedMerge(i)) {
            paths.push(events[i].path);
            upcoming++;
        }
    }
    return paths;
}

/** One in-flight job; seek replaces queued priorities without interrupting that job. */
export class MatchingCoordinator {
    constructor(clusters, {
        workerFactory = () => new Worker(new URL('./point-matching-worker.js?v=1', import.meta.url), { type: 'module' }),
        warn = (...args) => console.warn(...args)
    } = {}) {
        this.clusters = clusters;
        this.workerFactory = workerFactory;
        this.warn = warn;
        this.worker = null;
        this.queue = [];
        this.inFlight = null;
        this.completed = new Set();
        this.failed = new Set();
        this.disabled = false;
    }

    initialize() {
        if (this.worker || this.disabled) return;
        try {
            this.worker = this.workerFactory();
            this.worker.onmessage = event => this.receive(event.data);
            this.worker.onerror = event => {
                event.preventDefault?.();
                this.disable(event.message || 'Worker runtime failure');
            };
            this.worker.onmessageerror = () => this.disable('Worker message could not be decoded');
            const snapshots = createMatchingSnapshot(this.clusters);
            this.worker.postMessage({ type: 'init', snapshots },
                snapshots.filter(c => c.positions).map(c => c.positions.buffer));
        } catch (error) {
            this.disable(error);
        }
    }

    prioritize(paths) {
        if (this.disabled) return;
        this.queue = [...new Set(paths)].filter(path => {
            const cluster = this.clusters.get(path);
            return cluster?.type === 'merged' && cluster.pointCloud && cluster.childrenPaths.length
                && !cluster.matchData && !this.completed.has(path) && !this.failed.has(path)
                && path !== this.inFlight;
        });
        this.dispatch();
    }

    dispatch() {
        if (this.disabled || !this.worker || this.inFlight !== null || !this.queue.length) return;
        this.inFlight = this.queue.shift();
        try {
            this.worker.postMessage({ type: 'match', path: this.inFlight });
        } catch (error) {
            this.disable(error);
        }
    }

    receive(data) {
        if (this.disabled || this.inFlight === null || data.path !== this.inFlight) return;
        if (data.type !== 'result' && data.type !== 'failed') return;
        const path = this.inFlight;
        this.inFlight = null;
        if (data.type === 'failed') {
            this.failed.add(path);
            this.warn(`Point matching failed for ${path}; using fallback animation.`, data.error);
        } else {
            this.completed.add(path);
            if (data.matches) this.clusters.get(path).matchData = data.matches;
        }
        // Cache only: never restart or replace a currently playing animation.
        this.dispatch();
    }

    disable(error) {
        if (this.disabled) return;
        this.warn('Background point matching unavailable; using fallback animations.', error);
        this.dispose();
    }

    dispose() {
        this.disabled = true;
        this.queue = [];
        this.inFlight = null;
        if (this.worker) {
            this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
            this.worker.terminate();
            this.worker = null;
        }
    }
}
