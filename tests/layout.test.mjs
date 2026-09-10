import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import { SquarenessLayoutEngine } from '../js/layout-engine-squareness.js';
import { planFloorplan } from '../js/recursive-floorplan.js';
import { ConvergenceEngine } from '../js/convergence-engine.js';
import { centralIndices } from '../js/robust-footprint.js';
import { planPlayback, PlaybackClock, formatClock } from '../js/playback-timeline.js';

globalThis.window = { innerHeight: 900, devicePixelRatio: 1, location: { search: '' } };
const { Cluster, VGGTDataLoader } = await import('../js/data-loader-vggt.js');
const { SquarenessAnimationEngine } = await import('../js/animation-engine-squareness.js');
const { FrustumEngine } = await import('../js/frustum-engine.js');
const { createPointMaterial } = await import('../js/point-material.js?v=47');
const { VGGTHierarchyApp } = await import('../js/main-hierarchy-vggt.js');
const { bindRegionClip } = await import('../js/region-clipping.js');

const epsilon = 1e-3;
function isInside(r, x, y) {
    return x >= r.x - epsilon && x <= r.x + r.w + epsilon &&
        y >= r.y - epsilon && y <= r.y + r.h + epsilon;
}
function inside(r, x, y) {
    assert.ok(isInside(r,x,y), `(${x},${y}) escapes ${JSON.stringify(r)}`);
}
function contains(outer, inner) {
    inside(outer, inner.x, inner.y); inside(outer, inner.x + inner.w, inner.y + inner.h);
}
function disjoint(a, b) {
    assert.ok(Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x) < epsilon ||
        Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y) < epsilon, 'unrelated regions overlap');
}
function checkPoints(c, region = c.rect, position = c.pointCloud.geometry.attributes.position) {
    let retained = 0;
    for (let i = 0; i < position.count; ++i) {
        if (isInside(region, c.hierarchyPosition.x + position.getX(i) * c.fitScale,
            c.hierarchyPosition.y + position.getY(i) * c.fitScale)) retained++;
    }
    assert.ok(retained >= Math.ceil(position.count * 0.95),
        `${c.path}: only ${retained}/${position.count} inside the cell`);
}
function synthetic(path, positions) {
    const c = new Cluster(path, 'vggt');
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(positions.map(()=>1), 3));
    c.setPointCloud(g, createPointMaterial());
    return c;
}

test('half-second-per-event schedules preserve event timing without a minimum delay', () => {
    assert.equal(planPlayback([]).duration, 0);
    for (const count of [1, 9, 93, 500]) for (const timed of [false, true]) {
        const events = Array.from({length: count}, (_, i) => ({
            realGapSec: timed && i ? (i % 7 ? 1 : 10000) : 0
        }));
        const plan = planPlayback(events);
        assert.equal(plan.duration, count * 0.5);
        assert.equal(plan.starts.length, count);
        assert.equal(plan.ends[count - 1], count > 1 ? plan.duration : 0);
        for (let i = 0; i < count; i++) {
            assert.ok(plan.animationDurations[i] >= 0);
            assert.ok(plan.animationDurations[i] <= .8 + 1e-9);
            assert.ok(plan.starts[i] >= (plan.ends[i - 1] || 0));
            assert.ok(plan.indexAt(plan.starts[i]) >= i);
        }
        assert.equal(plan.indexAt(plan.duration), count - 1);
        assert.equal(plan.runClock(plan.duration), null, 'must not invent missing run timestamps');
    }
    const burst = planPlayback([{realGapSec:0}, {realGapSec:0}, {realGapSec:1}, {realGapSec:5999}]);
    assert.deepEqual(burst.ends, [0, 0, 1 / 6000 * 2, 2]);
    assert.equal(burst.animationDurations[1], 0);
    assert.equal(burst.animationDurations[2], 1 / 6000 * 2);
});

test('playback clock excludes pauses, supports seeks, and cannot accumulate frame drift', () => {
    const clock = new PlaybackClock(60);
    clock.play(100);
    for (let i = 0; i < 1000; i++) clock.update(100 + i / 100);
    clock.pause(110);
    assert.equal(clock.update(200), 10);
    clock.play(300);
    assert.ok(Math.abs(clock.update(349.999) - 59.999) < 1e-9);
    assert.equal(clock.playing, true);
    assert.equal(clock.update(350), 60);
    assert.equal(clock.playing, false);
    clock.seek(0, 400); clock.play(400);
    assert.equal(clock.update(470), 60, 'a delayed frame must catch up to the deadline');
    clock.seek(40, 500); clock.play(500);
    assert.equal(clock.update(520), 60);
});

test('run clock advances between events and labels compressed idle intervals', () => {
    const plan = planPlayback([
        {effTime:100, realGapSec:0},
        {effTime:200, realGapSec:100},
        {effTime:90200, realGapSec:100, wasStall:true}
    ], 60);
    assert.equal(plan.runClock(0).elapsed, 0);
    assert.equal(plan.runClock(15).elapsed, 50);
    const skipped = plan.runClock(45);
    assert.ok(Math.abs(skipped.elapsed - 45100) < 1e-9);
    assert.equal(skipped.compressedIdle, true);
    assert.equal(plan.runClock(60).elapsed, 90100);
    assert.equal(formatClock(60), '01:00');
    assert.equal(formatClock(90100, true), '25:01:40.0');
    assert.equal(formatClock(4.5, true, false), '00:04.5');
    assert.equal(formatClock(46.5, true, false), '00:46.5');
    assert.equal(formatClock(3600.5, true, false), '01:00:00.5');
});

test('pausing the playback clock freezes an in-progress reconstruction animation', () => {
    const leaf = synthetic('merged', [-1,-1,0, 1,1,0]);
    const clusters = new Map([['merged', leaf]]);
    const layout = new SquarenessLayoutEngine(clusters); layout.computeLayout();
    const engine = new SquarenessAnimationEngine(clusters, layout, new THREE.Group());
    engine.convergenceEngine = new ConvergenceEngine();
    engine.convergenceEngine.prepareAllLeaves([leaf]);
    engine.initTimeline();
    const clock = new PlaybackClock(60);
    engine.now = () => clock.elapsed * 1000;
    clock.play(100); engine.playEvent(0);
    clock.pause(100.2); engine.update(0);
    const halfway = Array.from(leaf.pointCloud.geometry.attributes.position.array);
    clock.update(200); engine.update(0);
    assert.deepEqual(Array.from(leaf.pointCloud.geometry.attributes.position.array), halfway);
    clock.play(200); clock.update(201); engine.update(0);
    assert.notDeepEqual(Array.from(leaf.pointCloud.geometry.attributes.position.array), halfway);
    assert.equal(engine.activeAnimations.length, 0);
});

function verifyDefaultPlayback(clusters, engine, events) {
    const plan = planPlayback(events);
    const app = Object.create(VGGTHierarchyApp.prototype);
    Object.assign(app, { events, animationEngine:engine, playbackPlan:plan,
        playback:new PlaybackClock(plan.duration), currentEventIndex:0, isPlaying:true,
        ui:{playBtn:{textContent:'Pause'}}, frustumEngine:{syncToEventIndex(){}},
        fitCameraToVisible(){}, updateUI(){}, updatePlaybackClock(){}, updateAnnotation(){},
        collapseToFinalView(){this.finalViewActive=true;} });
    if (!engine.preMatchedCloud) engine.initTransitionBuffers('sharp');
    engine.now = () => app.playback.elapsed * 1000;
    app.startScheduledEvent(0);
    app.playback.play(1000);
    for (let i = 0; i < events.length; i++) {
        const elapsed = plan.starts[i] + plan.animationDurations[i] / 2;
        app.advancePlayback(1000 + elapsed);
        engine.update(0);
        assert.equal(app.currentEventIndex, plan.indexAt(app.playback.elapsed));
        assert.equal(app.finalViewActive, undefined);
    }
    app.advancePlayback(1000 + plan.duration - .001); engine.update(0);
    assert.equal(app.isPlaying, true, 'must not finish before the scheduled duration');
    app.advancePlayback(1000 + plan.duration);
    assert.equal(app.playback.elapsed, events.length * 0.5);
    assert.equal(app.isPlaying, false);
    assert.equal(app.finalViewActive, true);
    assert.equal(engine.activeAnimations.length, 0, 'final animation must finish within the replay duration');
    assert.deepEqual([...clusters.values()].filter(c => c.pointCloud?.visible), [clusters.get('merged')]);
}

test('95% means joint XY coverage, including tiny and degenerate populations', () => {
    const points = Array.from({length:100}, (_, i) => [i % 10, Math.floor(i / 10)]);
    const selected = centralIndices(points.length, i=>points[i][0], i=>points[i][1]);
    assert.equal(new Set(selected).size,95);
    const loX=Math.min(...selected.map(i=>points[i][0])), hiX=Math.max(...selected.map(i=>points[i][0]));
    const loY=Math.min(...selected.map(i=>points[i][1])), hiY=Math.max(...selected.map(i=>points[i][1]));
    assert.ok(points.filter(([x,y])=>x>=loX&&x<=hiX&&y>=loY&&y<=hiY).length>=95);
    assert.deepEqual(centralIndices(0,()=>0,()=>0),[]);
    assert.equal(centralIndices(3,()=>0,()=>0).length,3);
    assert.equal(centralIndices(100,()=>1,()=>1).length,95);
});

test('point and camera outliers are trimmed separately, retaining whole camera wireframes', () => {
    const points=[];
    for(let i=0;i<2000;i++) points.push(...(i<1900 ? [i%19/10, Math.floor(i/19)/50, 0] : [10000,10000,0]));
    const root=synthetic('merged',points);
    const clusters=new Map([['merged',root]]);
    const frustums=new FrustumEngine(new THREE.Group()); frustums.clusters=clusters;
    const cameras=Array.from({length:20},(_,i)=>({position:new THREE.Vector3(i<19?i/10:20000,0,1),
        look:new THREE.Vector3(0,0,1), up:new THREE.Vector3(0,1,0),right:new THREE.Vector3(1,0,0)}));
    frustums.buildFrustumGroup(cameras,'merged');
    const layout=new SquarenessLayoutEngine(clusters); layout.computeLayout();
    checkPoints(root); checkPoints(root,root.rect,root.frustumGeometry.attributes.position);
    const box=root.layoutExtent.box;
    assert.ok(box.max.x<1000 && box.max.y<1000,'extreme outliers still control the footprint');
    let completeCameras=0;
    const pos=root.frustumGeometry.attributes.position;
    for(let i=0;i<20;i++) {
        if(Array.from({length:16},(_,j)=>i*16+j).every(j=>
            box.containsPoint(new THREE.Vector3().fromBufferAttribute(pos,j)))) completeCameras++;
    }
    assert.equal(completeCameras,19);
    assert.equal(points.length,root.pointCloud.geometry.attributes.position.count*3,'source data were deleted');
});

test('full geometry, extreme outliers, and frustums fit; root frame ignores leaf gauges', () => {
    const root = synthetic('merged', [-5,-2,-2,5,2,2]);
    const leaf = synthetic('leaf', [-1,-1,-20,1,1,20,10000,0,0]);
    root.children = [leaf];
    leaf.frustumGeometry = new THREE.BufferGeometry();
    leaf.frustumGeometry.setAttribute('position', new THREE.Float32BufferAttribute([-20000,5,10],3));
    const layout = new SquarenessLayoutEngine(new Map([['merged',root],['leaf',leaf]]));
    for (const aspect of [16/9, 1, 9/16]) {
        layout.viewportAspect = aspect; layout.computeLayout();
        assert.ok(Math.abs(root.fitScale - 1) < 1e-9);
        assert.deepEqual(root.rect, leaf.rect); // unary merge inherits its region
        for (const c of [root, leaf]) checkPoints(c);
        checkPoints(leaf, leaf.rect, leaf.frustumGeometry.attributes.position);
        const before = {...layout.bounds};
        leaf.pointCloud.geometry.scale(100,100,100);
        layout.computeLayout();
        assert.equal(layout.bounds.width,before.width);
        assert.equal(layout.bounds.height,before.height);
    }
});

test('look-ahead packing avoids leaf-count slivers in a 16-leaf caterpillar', () => {
    let root = {children:[]};
    for(let i=1;i<16;i++) root={children:[{children:[]},root]};
    const rectangles = planFloorplan(root,()=>1,{x:0,y:0,w:1600,h:900});
    for(const [node,r] of rectangles) {
        for(const child of node.children) contains(r,rectangles.get(child));
        if(!node.children.length) assert.ok(Math.max(r.w/r.h,r.h/r.w)<3);
    }
});

test('Gerrard Hall selection loads its own data and completes its nine-event hierarchy', async () => {
    assert.throws(() => new VGGTDataLoader('missing-scene'), /Unknown dataset/);
    assert.throws(() => new VGGTDataLoader('toString'), /Unknown dataset/);
    assert.equal(new VGGTDataLoader().datasetKey, 'BRUSSELS');
    const oldFetch = globalThis.fetch, oldLog = console.log;
    const requested = [];
    console.log = () => {};
    globalThis.fetch = async path => {
        requested.push(path);
        return new Response(await fs.readFile(new URL('../' + path, import.meta.url)));
    };
    try {
        const loader = new VGGTDataLoader('original');
        assert.equal(loader.dataset.sceneName, 'Gerrard Hall');
        loader.computePointMatching = () => { throw new Error('Loading must not compute matches'); };
        const clusters = await loader.load();
        assert.ok([...clusters.values()].every(c => !c.matchData));
        const world = new THREE.Group();
        const frustums = new FrustumEngine(world);
        await frustums.loadForClusters(clusters, loader);
        assert.ok(requested.every(path => path.startsWith('data/gerrard-hall-vggt/results/')));
        const layout = new SquarenessLayoutEngine(clusters);
        layout.computeLayout();
        const engine = new SquarenessAnimationEngine(clusters, layout, world);
        const events = engine.initTimeline();
        assert.equal(events.length, 9);
        assert.equal(events.filter(e => e.isLeaf).length, 6);
        for (const event of events) {
            assert.ok(event.cluster.pointCloud);
            checkPoints(event.cluster);
            for (const child of event.cluster.children) contains(event.cluster.rect, child.rect);
        }
        engine.applyEventInstant(events.length - 1);
        assert.deepEqual([...clusters.values()].filter(c => c.pointCloud?.visible), [clusters.get('merged')]);
        verifyDefaultPlayback(clusters, engine, events);
    } finally { globalThis.fetch = oldFetch; console.log = oldLog; }
});

test('Brussels: disjoint frontiers, 95% coverage, reveals, and clipped merge trajectories', async t => {
    const oldFetch = globalThis.fetch;
    const oldLog = console.log;
    console.log = () => {};
    globalThis.fetch = async path => {
        try { return new Response(await fs.readFile(new URL('../'+path, import.meta.url))); }
        catch(err) { if(err.code === 'ENOENT') return new Response('',{status:404}); throw err; }
    };
    try {
        const loader = new VGGTDataLoader('BRUSSELS');
        const clusters = await loader.load();
        assert.ok([...clusters.values()].every(c => !c.matchData));
        loader.computePointMatching(); // Explicit preparation for trajectory assertions below.
        const world = new THREE.Group();
        const frustums = new FrustumEngine(world);
        await frustums.loadForClusters(clusters,loader);
        const layout = new SquarenessLayoutEngine(clusters);
        layout.computeLayout();
        const root = clusters.get('merged');
        assert.equal(layout.treeNodes.length,93);
        // This wide, intermediate reconstruction previously inherited a tall
        // cell: its footprint occupied only about 24% of the reserved area.
        // Score merge stages as well as leaves, without changing the geometry.
        const wideMerge = clusters.get('C_1/C_1_1/merged');
        const footprintAspect = wideMerge.layoutExtent.w / wideMerge.layoutExtent.h;
        const cellAspect = wideMerge.rect.w / wideMerge.rect.h;
        assert.ok(Math.min(cellAspect / footprintAspect, footprintAspect / cellAspect) > .75,
            'wide merged reconstruction still inherits a tall cell');
        const engine = new SquarenessAnimationEngine(clusters,layout,world);
        const events = engine.initTimeline();
        const convergence = new ConvergenceEngine();
        engine.convergenceEngine = convergence;
        convergence.prepareAllLeaves(engine.getLeafClusters());
        engine.initTransitionBuffers('sharp');
        const active = new Set();
        for(let i=0;i<events.length;i++) {
            const event = events[i];
            for(const path of event.children) active.delete(clusters.get(path));
            active.add(event.cluster);
            const frontier=[...active];
            for(let a=0;a<frontier.length;a++) for(let b=a+1;b<frontier.length;b++) disjoint(frontier[a].rect,frontier[b].rect);
            checkPoints(event.cluster);
            if(event.cluster.frustumGeometry) checkPoints(event.cluster,event.cluster.rect,event.cluster.frustumGeometry.attributes.position);
            for(const child of event.cluster.children) contains(event.cluster.rect,child.rect);
            if(event.isLeaf) {
                const data = convergence.clusterData.get(event.path);
                for(const time of [0,.1,.5,1.3]) {
                    convergence.updateConvergence(data,time); checkPoints(event.cluster);
                }
                convergence.settleClusterInstant(event.cluster);
            } else {
                engine.applyEventInstant(i-1);
                engine.playEvent(i);
                const animation = engine.activeAnimations.find(a=>a.type==='mergeTransition');
                assert.ok(animation, 'real dataset uses per-point merges');
                for(const time of [0,.25,.5,.75,1]) {
                    animation.startTime = performance.now() - time * animation.duration;
                    engine.update(0);
                    for(const [cloud,count,start,end] of [[engine.preMatchedCloud,animation.matchedCount,engine.matchedStartBuf,engine.matchedEndBuf],
                        [engine.preChildOnlyCloud,animation.coCount,engine.coStartBuf,engine.coEndBuf],
                        [engine.preMergedOnlyCloud,animation.moCount,engine.moStartBuf,engine.moEndBuf]]) {
                        const pos=cloud.geometry.attributes.position;
                        for(let j=0;j<count;j++) {
                            // Inlier paths stay inside geometrically; outlier paths
                            // are contained by the same tested fragment clip as clouds.
                            if(isInside(event.cluster.rect,start[j*3],start[j*3+1]) &&
                               isInside(event.cluster.rect,end[j*3],end[j*3+1])) {
                                inside(event.cluster.rect,pos.getX(j),pos.getY(j));
                            }
                        }
                        assert.equal(engine.transitionRegion,event.cluster.rect);
                    }
                }
            }
        }
        assert.deepEqual([...active],[root]);
        engine.applyEventInstant(events.length-1);
        assert.equal([...clusters.values()].filter(c=>c.pointCloud?.visible).length,1);
        root.group.updateMatrix();
        const before = root.group.matrix.clone();
        engine.applyEventInstant(0); engine.applyEventInstant(events.length-1); root.group.updateMatrix();
        assert.deepEqual(root.group.matrix.elements,before.elements);
        // Re-layout after responsive changes and live frustum-size changes must
        // measure the new geometry without retaining bounds from an earlier frame.
        for (const [aspect, size] of [[9/16, .06], [16/9, 0]]) {
            frustums.setFrustumSize(size);
            layout.viewportAspect=aspect; layout.computeLayout();
            for (const c of clusters.values()) {
                checkPoints(c);
                if (c.frustumGeometry) checkPoints(c,c.rect,c.frustumGeometry.attributes.position);
                for (const child of c.children) contains(c.rect,child.rect);
            }
            if (size===0) assert.ok([...clusters.values()].every(c=>!c.frustumGeometry));
        }
        t.diagnostic('Verified 93 events, 40 reveals, 53 merges, and at least 95% point and camera-wireframe coverage.');
        verifyDefaultPlayback(clusters, engine, events);
    } finally { globalThis.fetch = oldFetch; console.log = oldLog; }
});

test('fixed camera and final transform survive stepping, completion, scrubbing and viewport changes', () => {
    const root = synthetic('merged', [-5,-2,-50,5,2,50]);
    const leaf = synthetic('leaf', [-1,-1,-100,1,1,100]); root.children=[leaf];
    const clusters=new Map([['merged',root],['leaf',leaf]]);
    const layout=new SquarenessLayoutEngine(clusters);
    const app=Object.create(VGGTHierarchyApp.prototype);
    Object.assign(app,{layoutEngine:layout, dataLoader:{clusters}, fixedFrame:true,
        autoFrameEnabled:true, userCameraOverride:false, camera:new THREE.OrthographicCamera(),
        ui:{eventLabel:{textContent:''},playBtn:{}}, updateUI(){}, updateAnnotation(){},
        frustumEngine:{syncToEventIndex(){}}, cameraAnimTarget:null});
    app.orbitControls={target:new THREE.Vector3(),update(){
        app.camera.lookAt(this.target); app.camera.updateMatrixWorld();
    }};
    let panelVisible=false;
    // Fixed-position settings panels have no offsetParent in a real browser.
    globalThis.document={getElementById(){return panelVisible ? {
        offsetParent:null, getClientRects(){return [{}];}, getBoundingClientRect(){return {width:220};}
    } : null;},body:{classList:{contains(){return false;}}}};
    globalThis.getComputedStyle=()=>({display:'block'});
    try {
        for(const [width,height,withPanel] of [[1280,720,true],[720,1000,false]]) {
            panelVisible=withPanel;
            window.innerWidth=width; window.innerHeight=height;
            layout.viewportAspect=app.usableViewportAspect(); layout.computeLayout();
            app.animationEngine=new SquarenessAnimationEngine(clusters,layout,new THREE.Group());
            app.events=app.animationEngine.initTimeline();
            app.fitCameraToLayoutBounds(true);
            const matrix=app.camera.matrixWorld.toArray();
            const projection=app.camera.projectionMatrix.toArray();
            const rootPos=root.group.position.toArray(), rootScale=root.group.scale.toArray();
            for(const index of [0,1,0,1]) {
                app.jumpTo(index);
                if(index===1) app.collapseToFinalView();
                assert.deepEqual(app.camera.matrixWorld.toArray(),matrix);
                assert.deepEqual(app.camera.projectionMatrix.toArray(),projection);
                assert.deepEqual(root.group.position.toArray(),rootPos);
                assert.deepEqual(root.group.scale.toArray(),rootScale);
            }
            app.camera.position.x += 100;
            app.userCameraOverride=true;
            app.fitCameraToVisible();
            assert.notEqual(app.camera.position.x,matrix[12]);
            app.reset();
            assert.deepEqual(app.camera.matrixWorld.toArray(),matrix);
            const viewport=app.usableViewport();
            for(const c of clusters.values()) {
                const pos=c.pointCloud.geometry.attributes.position;
                for(let i=0;i<pos.count;i++) {
                    const p=new THREE.Vector3().fromBufferAttribute(pos,i).multiplyScalar(c.fitScale)
                        .add(c.hierarchyPosition).project(app.camera);
                    const x=(p.x+1)*width/2, y=(1-p.y)*height/2;
                    inside({x:viewport.left,y:viewport.top,w:viewport.width,h:viewport.height},x,y);
                    assert.ok(p.z>=-1&&p.z<=1,'depth clipping');
                }
            }
        }
    } finally { delete globalThis.document; delete globalThis.getComputedStyle; }
});

test('fragment clipping uses the actual render-target viewport and releases on manual orbit', () => {
    const cloud = new THREE.Points(new THREE.BufferGeometry(),createPointMaterial());
    const region={x:-10,y:-5,w:20,h:10}; bindRegionClip(cloud,()=>region);
    const shader={uniforms:{},fragmentShader:'void main() { gl_FragColor = vec4(1.0); }'};
    cloud.material.onBeforeCompile(shader);
    assert.match(shader.fragmentShader,/gl_FragCoord/);
    const camera=new THREE.OrthographicCamera(-20,20,10,-10,.1,1000);
    camera.position.z=100;camera.updateMatrixWorld();
    const renderer={getCurrentViewport(out){out.set(100,50,800,400);}};
    cloud.onBeforeRender(renderer,null,camera);
    assert.equal(shader.uniforms.uRegionClipEnabled.value,1);
    assert.deepEqual(shader.uniforms.uRegionClip.value.toArray(),[300,150,700,350]);
    camera.position.set(100,0,0);camera.lookAt(0,0,0);camera.updateMatrixWorld();
    cloud.onBeforeRender(renderer,null,camera);
    assert.equal(shader.uniforms.uRegionClipEnabled.value,0);
});

test('frustums hidden on initial load can be enabled later', () => {
    const cluster=synthetic('merged',[-1,-1,0,1,1,0]);
    const frustums=new FrustumEngine(new THREE.Group());
    frustums.clusters=new Map([['merged',cluster]]);
    frustums.frustumRelativeSize=0;
    const cameras=[{position:new THREE.Vector3(2,2,2),look:new THREE.Vector3(0,0,1),
        up:new THREE.Vector3(0,1,0),right:new THREE.Vector3(1,0,0)}];
    const group=frustums.buildFrustumGroup(cameras,'merged');
    frustums.frustumGroups.set('merged',group);
    frustums.camerasByPath.set('merged',cameras);
    assert.equal(group.parent,cluster.group);
    assert.equal(group.children.length,0);
    frustums.setFrustumSize(.02);
    assert.equal(group.children.length,1);
    assert.equal(group.parent,cluster.group);
    assert.ok(cluster.frustumGeometry);
});
