import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import { SquarenessLayoutEngine } from '../js/layout-engine-squareness.js';
import { planFloorplan } from '../js/recursive-floorplan.js';
import { ConvergenceEngine } from '../js/convergence-engine.js';

globalThis.window = { innerHeight: 900, devicePixelRatio: 1, location: { search: '' } };
const { Cluster, VGGTDataLoader } = await import('../js/data-loader-vggt.js');
const { SquarenessAnimationEngine } = await import('../js/animation-engine-squareness.js');
const { FrustumEngine } = await import('../js/frustum-engine.js');
const { createPointMaterial } = await import('../js/point-material.js?v=47');
const { VGGTHierarchyApp } = await import('../js/main-hierarchy-vggt.js');
const { bindRegionClip } = await import('../js/region-clipping.js');

const epsilon = 1e-3;
function inside(r, x, y) {
    assert.ok(x >= r.x - epsilon && x <= r.x + r.w + epsilon &&
        y >= r.y - epsilon && y <= r.y + r.h + epsilon, `(${x},${y}) escapes ${JSON.stringify(r)}`);
}
function contains(outer, inner) {
    inside(outer, inner.x, inner.y); inside(outer, inner.x + inner.w, inner.y + inner.h);
}
function disjoint(a, b) {
    assert.ok(Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x) < epsilon ||
        Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y) < epsilon, 'unrelated regions overlap');
}
function checkPoints(c, region = c.rect, position = c.pointCloud.geometry.attributes.position) {
    for (let i = 0; i < position.count; ++i) {
        inside(region, c.hierarchyPosition.x + position.getX(i) * c.fitScale,
            c.hierarchyPosition.y + position.getY(i) * c.fitScale);
    }
}
function synthetic(path, positions) {
    const c = new Cluster(path, 'vggt');
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(positions.map(()=>1), 3));
    c.setPointCloud(g, createPointMaterial());
    return c;
}

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

test('Brussels: every timeline frontier, full geometry, reveals, and merge trajectories are contained', async t => {
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
        const world = new THREE.Group();
        const frustums = new FrustumEngine(world);
        await frustums.loadForClusters(clusters,loader);
        const layout = new SquarenessLayoutEngine(clusters);
        layout.computeLayout();
        const root = clusters.get('merged');
        assert.equal(layout.treeNodes.length,93);
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
                    for(const [cloud,count] of [[engine.preMatchedCloud,animation.matchedCount],
                        [engine.preChildOnlyCloud,animation.coCount],[engine.preMergedOnlyCloud,animation.moCount]]) {
                        const pos=cloud.geometry.attributes.position;
                        for(let j=0;j<count;j++) inside(event.cluster.rect,pos.getX(j),pos.getY(j));
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
        t.diagnostic('Verified 93 events, 40 reveals, 53 merges, all loaded points and camera wireframes.');
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
