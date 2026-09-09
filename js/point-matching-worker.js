import { matchCluster } from './point-matching.js?v=1';

let snapshots = new Map();
self.onmessage = ({ data }) => {
    if (data.type === 'init') {
        snapshots = new Map(data.snapshots.map(cluster => [cluster.path, cluster]));
        return;
    }
    if (data.type !== 'match') return;
    try {
        const matches = matchCluster(data.path, snapshots);
        self.postMessage({ type: 'result', path: data.path, matches });
    } catch (error) {
        self.postMessage({ type: 'failed', path: data.path, error: String(error) });
    }
};
