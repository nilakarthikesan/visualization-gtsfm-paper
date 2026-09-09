import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Worker as NodeWorker } from 'node:worker_threads';
import * as THREE from 'three';
import { createMatchingSnapshot, matchCluster } from '../js/point-matching.js';
import { MatchingCoordinator, matchingPriorities } from '../js/matching-coordinator.js';
import { SquarenessLayoutEngine } from '../js/layout-engine-squareness.js';
import { ConvergenceEngine } from '../js/convergence-engine.js';
import { planPlayback, PlaybackClock } from '../js/playback-timeline.js';

globalThis.window = { innerHeight: 900, devicePixelRatio: 1, location: { search: '' } };
const { Cluster, VGGTDataLoader } = await import('../js/data-loader-vggt.js');
const { SquarenessAnimationEngine } = await import('../js/animation-engine-squareness.js');
const { VGGTHierarchyApp } = await import('../js/main-hierarchy-vggt.js');
const { createPointMaterial } = await import('../js/point-material.js?v=47');

function cluster(path, points, childrenPaths = []) {
    const c = new Cluster(path, childrenPaths.length ? 'merged' : 'vggt', childrenPaths);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(points.map(() => 1), 3));
    c.setPointCloud(geometry, createPointMaterial());
    c.originalCenter.set(10.1, 0, 0);
    return c;
}
function fixture() {
    const a = cluster('a', [0,0,0, 1,0,0, 1,0,0]);
    const b = cluster('b', [0,1,0, 0,2,0]);
    const m = cluster('m', [0,0,0, 1,0,0, 0,1,0, 0,3,0], ['a', 'b']);
    const root = cluster('merged', [0,0,0, 1,0,0, 0,1,0, 0,3,0], ['m']);
    m.children = [a,b]; root.children = [m]; a.parent = b.parent = m; m.parent = root;
    return new Map([a,b,m,root].map(c => [c.path,c]));
}
// Captured from main's original synchronous algorithm, including ties and nonzero centers.
const expected = {
    matchedPairs: [{childPath:'a',childIdx:0,mergedIdx:0}, {childPath:'a',childIdx:1,mergedIdx:1}, {childPath:'b',childIdx:0,mergedIdx:2}],
    childOnlyPoints: [{childPath:'a',childIdx:2,flyToMergedIdx:1}, {childPath:'b',childIdx:1,flyToMergedIdx:2}],
    mergedOnlyIndices: [{mergedIdx:3,flyFromChildPath:'b',flyFromChildIdx:1}]
};
class FakeWorker {
    messages = [];
    postMessage(data, transfer = []) {
        this.messages.push(structuredClone(data, { transfer }));
    }
    reply(data) { this.onmessage?.({data}); }
    terminate() { this.terminated = true; }
    get jobs() { return this.messages.filter(m => m.type === 'match').map(m => m.path); }
}
function coordinator(clusters = fixture()) {
    const worker = new FakeWorker(), warnings = [];
    const service = new MatchingCoordinator(clusters, { workerFactory: () => worker, warn: (...args) => warnings.push(args) });
    service.initialize();
    return { service, worker, clusters, warnings };
}

test('pure matching preserves baseline indices, ties, missing inputs and empty children', () => {
    const snapshots = new Map(createMatchingSnapshot(fixture()).map(c => [c.path,c]));
    assert.deepEqual(matchCluster('m', snapshots), expected);
    assert.equal(matchCluster('a', snapshots), null);
    assert.equal(matchCluster('missing', snapshots), null);
    snapshots.delete('a'); snapshots.delete('b');
    assert.equal(matchCluster('m', snapshots), null);
});

test('worker snapshots transfer copies and survive live reveal mutations', () => {
    const {service, worker, clusters} = coordinator();
    const snapshots = new Map(worker.messages[0].snapshots.map(c => [c.path,c]));
    for (const c of clusters.values()) {
        assert.ok(c.pointCloud.geometry.attributes.position.array.byteLength > 0, 'renderer buffer was detached');
        c.pointCloud.geometry.attributes.position.array.fill(999);
        c.originalCenter.set(999,999,999);
    }
    assert.deepEqual(matchCluster('m', snapshots), expected);
    service.dispose();
});

test('priority replacement, in-flight caching, deduplication and disposal', () => {
    const {service, worker, clusters} = coordinator();
    service.prioritize(['m','m','merged']);
    assert.deepEqual(worker.jobs, ['m']);
    service.prioritize(['merged']); // Seek: in-flight m finishes, then new priority.
    worker.reply({type:'result',path:'m',matches:expected});
    assert.equal(clusters.get('m').matchData, expected);
    assert.deepEqual(worker.jobs, ['m','merged']);
    worker.reply({type:'result',path:'merged',matches:expected});
    service.prioritize(['m','merged']);
    assert.deepEqual(worker.jobs, ['m','merged'], 'replay must use cache');
    const lateCallback = worker.onmessage;
    service.dispose();
    lateCallback({data:{type:'result',path:'m',matches:{bad:true}}});
    assert.equal(clusters.get('m').matchData, expected);
    assert.equal(worker.terminated, true);
});

test('seeking drops obsolete queued work; completions do not expand lookahead', () => {
    const {service, worker} = coordinator();
    service.prioritize(['m','merged']);
    service.prioritize([]);
    worker.reply({type:'result',path:'m',matches:expected});
    assert.deepEqual(worker.jobs,['m']);
    assert.equal(service.inFlight,null);
    service.dispose();
});

test('job failures are not retried; worker failures disable gracefully', () => {
    const {service, worker, warnings} = coordinator();
    service.prioritize(['m','merged']);
    worker.reply({type:'failed',path:'m',error:'bad input'});
    assert.deepEqual(worker.jobs,['m','merged']);
    worker.reply({type:'result',path:'merged',matches:null});
    service.prioritize(['m','merged']);
    assert.deepEqual(worker.jobs,['m','merged']);
    worker.onerror({message:'crashed',preventDefault(){}});
    assert.equal(service.disabled,true);
    assert.equal(worker.terminated,true);
    assert.equal(warnings.length,2);
    const unavailable = new MatchingCoordinator(fixture(), {workerFactory(){throw new Error('unavailable');}, warn(){}});
    unavailable.initialize(); unavailable.prioritize(['m']);
    assert.equal(unavailable.disabled,true);
    const broken = coordinator();
    broken.worker.postMessage = () => { throw new Error('post failed'); };
    broken.service.prioritize(['m']);
    assert.equal(broken.service.disabled,true);
    const undecodable = coordinator(); undecodable.worker.onmessageerror();
    assert.equal(undecodable.service.disabled,true);
});

test('lookahead covers current plus two upcoming animated merges, skipping leaves and zero durations', () => {
    const events = [true,false,true,false,false,false,false].map((isLeaf,i) => ({isLeaf,path:String(i)}));
    const plan = {animationDurations:[0,1,1,0,1,1,1]};
    assert.deepEqual(matchingPriorities(events,plan,0),['1','4']);
    assert.deepEqual(matchingPriorities(events,plan,1),['1','4','5']);
    assert.deepEqual(matchingPriorities(events,plan,1,false),['4','5']);
    assert.deepEqual(matchingPriorities(events,plan,6,false),[]);
});

test('real worker uses relative imports and delivers baseline matches from transferred snapshots', async t => {
    const workerURL = new URL('../js/point-matching-worker.js', import.meta.url).href;
    // Adapt only the browser messaging surface; run the actual production worker module.
    const boot = `import {parentPort} from 'node:worker_threads';
        globalThis.self = {postMessage: data => parentPort.postMessage(data)};
        await import(${JSON.stringify(workerURL)});
        parentPort.on('message', data => self.onmessage({data}));`;
    const worker = new NodeWorker(new URL('data:text/javascript,' + encodeURIComponent(boot)), {type:'module'});
    t.after(() => worker.terminate());
    const snapshots = createMatchingSnapshot(fixture());
    const result = new Promise((resolve,reject) => { worker.once('message',resolve); worker.once('error',reject); });
    worker.postMessage({type:'init',snapshots}, snapshots.map(c => c.positions.buffer));
    assert.ok(snapshots.every(c => c.positions.byteLength === 0));
    worker.postMessage({type:'match',path:'m'});
    assert.deepEqual(await result,{type:'result',path:'m',matches:expected});
});

function playbackApp() {
    const clusters = fixture(), layout = new SquarenessLayoutEngine(clusters);
    layout.computeLayout();
    const engine = new SquarenessAnimationEngine(clusters,layout,new THREE.Group());
    engine.initTransitionBuffers('sharp');
    const events = [...clusters.values()].map((c,i) => ({path:c.path,cluster:c,isLeaf:!c.children.length,children:c.childrenPaths,realGapSec:i?1:0}));
    engine.mergeEvents = events;
    engine.convergenceEngine = new ConvergenceEngine();
    engine.convergenceEngine.prepareAllLeaves(engine.getLeafClusters());
    const {service,worker} = coordinator(clusters);
    const app = Object.create(VGGTHierarchyApp.prototype);
    Object.assign(app,{events,animationEngine:engine,matchingCoordinator:service,currentEventIndex:0,
        playbackPlan:planPlayback(events),playback:new PlaybackClock(30),isPlaying:false,
        ui:{playBtn:{textContent:'Play'},eventLabel:{textContent:''}},
        frustumEngine:{syncToEventIndex(){}},fitCameraToVisible(){},updateUI(){},updateAnnotation(){},updatePlaybackClock(){}
    });
    engine.now = () => app.playback.elapsed * 1000;
    return {app,engine,worker,service,clusters};
}

test('late results do not replace fallback; pause, seek, replay and completion keep clock semantics', () => {
    const {app,engine,worker,service,clusters} = playbackApp();
    app.seekPlayback(app.playbackPlan.starts[2]);
    assert.deepEqual(worker.jobs,['m']);
    assert.ok(engine.activeAnimations.some(a => a.type === 'fadeIn'));
    const animations = [...engine.activeAnimations];
    worker.reply({type:'result',path:'m',matches:expected});
    assert.deepEqual(engine.activeAnimations,animations);
    app.playback.play(100); app.playback.pause(100.2); engine.update(0);
    const opacity = clusters.get('m').pointCloud.material.uniforms.uOpacity.value;
    app.advancePlayback(200); engine.update(0);
    assert.equal(clusters.get('m').pointCloud.material.uniforms.uOpacity.value,opacity);
    app.seekPlayback(app.playbackPlan.starts[2]);
    assert.ok(engine.activeAnimations.some(a => a.type === 'mergeTransition'), 'replay should use ready matches');
    app.jumpTo(3); app.jumpTo(0); app.seekPlayback(app.playbackPlan.starts[3]);
    assert.ok(engine.activeAnimations.some(a => a.type === 'fadeIn'));
    app.playback.play(300); app.advancePlayback(301); engine.update(0);
    assert.equal(app.playback.elapsed,30);
    assert.equal(app.finalViewActive,true);
    assert.deepEqual([...clusters.values()].filter(c => c.pointCloud.visible),[clusters.get('merged')]);
    service.dispose();
});

test('fallback-only playback keeps its deadline even while recording and after worker failure', () => {
    const {app,engine,service,clusters,worker} = playbackApp();
    worker.onerror({message:'unavailable'});
    app.mediaRecorder = {state:'recording'};
    app.isPlaying = true; app.playback.play(100);
    for (const elapsed of [0,10,19.3,19.7,20,29.3,29.7,30]) {
        app.advancePlayback(100+elapsed); engine.update(0);
    }
    assert.equal(app.playback.elapsed,30);
    assert.equal(app.isPlaying,false);
    assert.equal(app.mediaRecorder.state,'recording');
    assert.deepEqual([...clusters.values()].filter(c => c.pointCloud.visible),[clusters.get('merged')]);
    assert.equal(service.disabled,true);
});

test('real dataset matching preserves hashes captured from main before extraction', async () => {
    const oldFetch = globalThis.fetch, oldLog = console.log;
    globalThis.fetch = async path => {try {return new Response(await fs.readFile(new URL('../'+path,import.meta.url)));} catch {return new Response('',{status:404});}};
    console.log = () => {};
    try {
        const cases = [
            ['original', [['merged','3de6288634b597ccdd134c20a3398a8aea4d18a30a48d4ccb7d20d19b7b0faa3']]],
            ['BRUSSELS', [['merged','e4360c2aed896f52015ad5c3ea1ea13c049397469192431a6d6532e24439b8fe'],
                ['C_1/C_1_2/merged','044a303830bcbc5d0e096820ab32eb8838d98e22a05236c4c52ef5f1c46aec2f']]]
        ];
        for (const [key, merges] of cases) {
            const loader = new VGGTDataLoader(key);
            loader.computePointMatching = () => assert.fail('load must not match');
            const clusters = await loader.load();
            assert.ok([...clusters.values()].every(c => !c.matchData));
            const snapshots = new Map(createMatchingSnapshot(clusters).map(c => [c.path,c]));
            for (const [path,hash] of merges) {
                assert.equal(createHash('sha256').update(JSON.stringify(matchCluster(path,snapshots))).digest('hex'),hash,`${key}/${path}`);
            }
        }
    } finally {globalThis.fetch=oldFetch;console.log=oldLog;}
});
