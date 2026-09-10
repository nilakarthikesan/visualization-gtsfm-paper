import test from 'node:test';
import assert from 'node:assert/strict';
import { recordingFilename, drawRecordingFrame } from '../js/canvas-recording.js';
import { LayoutGuides } from '../js/layout-guides.js';

globalThis.window = { innerHeight: 900, devicePixelRatio: 1, location: { search: '' } };
const { VGGTHierarchyApp } = await import('../js/main-hierarchy-vggt.js');

function drawingContext(width = 1600, height = 900) {
    const calls = [];
    const context = { canvas: { width, height }, calls };
    for (const name of ['clearRect', 'drawImage', 'save', 'restore', 'scale', 'translate',
        'fillRect', 'strokeRect', 'beginPath', 'rect', 'clip', 'fillText']) {
        context[name] = (...args) => calls.push({ name, args,
            fill: context.fillStyle, stroke: context.strokeStyle });
    }
    return context;
}

test('filenames identify the selected dataset and actual video format', () => {
    const date = new Date('2026-09-10T01:02:03Z');
    for (const [key, slug] of [['BRUSSELS', 'brussels'], ['THANJAVUR', 'thanjavur'],
        ['original', 'gerrard-hall'], ['C_1', 'c-1']]) {
        assert.equal(recordingFilename(key, date), `${slug}-recording-2026-09-10T01-02-03.webm`);
    }
    assert.equal(recordingFilename('THANJAVUR', date, 'video/mp4;codecs=avc1'),
        'thanjavur-recording-2026-09-10T01-02-03.mp4');
});

test('video copies the scene before overlays and scales CSS boxes to fixed video dimensions', () => {
    const context = drawingContext();
    let bounds = { left: 10, top: 20, width: 800, height: 450 };
    const source = { getBoundingClientRect: () => bounds };
    const guides = { drawToCanvas: ctx => ctx.strokeRect(20, 30, 100, 200) };
    drawRecordingFrame(context, source, guides);
    assert.deepEqual(context.calls.map(c => [c.name, ...c.args]), [
        ['clearRect', 0, 0, 1600, 900], ['drawImage', source, 0, 0, 1600, 900],
        ['save'], ['scale', 2, 2], ['translate', -10, -20],
        ['strokeRect', 20, 30, 100, 200], ['restore']
    ]);
    bounds = { left: 0, top: 0, width: 400, height: 300 };
    context.calls.length = 0;
    drawRecordingFrame(context, source, guides);
    assert.deepEqual(context.calls.find(c => c.name === 'scale').args, [4, 3]);
    assert.deepEqual(context.canvas, { width: 1600, height: 900 });
});

test('recorded regions use current visible borders, fills and optional clipped labels', t => {
    const original = globalThis.getComputedStyle;
    globalThis.getComputedStyle = el => el.style;
    t.after(() => {
        if (original) globalThis.getComputedStyle = original;
        else delete globalThis.getComputedStyle;
    });
    const el = {
        hidden: false,
        getBoundingClientRect: () => ({ left: 20, top: 30, width: 100, height: 80 }),
        style: { borderTopWidth: '1px', borderTopColor: 'rgba(220, 38, 38, 0.95)',
            backgroundColor: 'rgba(220, 38, 38, 0.035)' }
    };
    const label = {
        hidden: false, textContent: 'C_1',
        getBoundingClientRect: () => ({ left: 24, top: 33, width: 30, height: 12 }),
        style: { font: '10px monospace', paddingLeft: '3px', paddingTop: '1px',
            backgroundColor: '#ffffffdd', color: '#24495e' }
    };
    const guides = Object.assign(Object.create(LayoutGuides.prototype), {
        container: { hidden: false }, entries: [{ el, label }, { el: { hidden: true } }]
    });
    const context = drawingContext();
    guides.drawToCanvas(context);
    const stroke = context.calls.find(c => c.name === 'strokeRect');
    assert.deepEqual(stroke.args, [20.5, 30.5, 99, 79]);
    assert.equal(stroke.stroke, el.style.borderTopColor);
    assert.equal(context.calls[0].fill, el.style.backgroundColor);
    assert.deepEqual(context.calls.find(c => c.name === 'fillText').args, ['C_1', 27, 34]);
    assert.ok(context.calls.findIndex(c => c.name === 'clip') < context.calls.findIndex(c => c.name === 'fillText'));

    // Planned parents and theme changes pick up the current on-screen styling.
    el.style.borderTopColor = 'rgba(248, 113, 113, 0.45)';
    label.hidden = true;
    context.calls.length = 0;
    guides.drawToCanvas(context);
    assert.equal(context.calls.find(c => c.name === 'strokeRect').stroke, el.style.borderTopColor);
    assert.equal(context.calls.some(c => c.name === 'fillText'), false);
    guides.container.hidden = true; // Toggle off, or orbit away from the front view.
    context.calls.length = 0;
    guides.drawToCanvas(context);
    assert.equal(context.calls.length, 0);
});

test('recording captures composite frames and saves the starting dataset with isolated chunks', t => {
    const context = drawingContext();
    const downloads = [], blobs = [];
    let stopped = 0, captures = 0;
    const stream = { getTracks: () => [{ stop: () => stopped++ }] };
    Object.assign(context.canvas, {
        getContext: () => context,
        captureStream: fps => { assert.equal(fps, 30); captures++; return stream; }
    });
    const previousDocument = globalThis.document;
    const previousRecorder = globalThis.MediaRecorder;
    globalThis.document = {
        body: { appendChild() {} },
        createElement: tag => {
            if (tag === 'canvas') return context.canvas;
            assert.equal(tag, 'a');
            return { click() { downloads.push(this.download); }, remove() {} };
        }
    };
    globalThis.MediaRecorder = class {
        static isTypeSupported(type) { return type === 'video/webm;codecs=vp8'; }
        constructor(input, options) {
            assert.equal(input, stream);
            assert.equal(options.mimeType, 'video/webm;codecs=vp8');
            this.mimeType = options.mimeType;
            this.state = 'inactive';
        }
        start() { this.state = 'recording'; }
        stop() { this.state = 'inactive'; }
    };
    t.after(() => {
        if (previousDocument) globalThis.document = previousDocument;
        else delete globalThis.document;
        if (previousRecorder) globalThis.MediaRecorder = previousRecorder;
        else delete globalThis.MediaRecorder;
    });
    t.mock.method(URL, 'createObjectURL', blob => { blobs.push(blob); return 'blob:recording'; });
    t.mock.method(URL, 'revokeObjectURL', () => {});
    t.mock.method(globalThis, 'setTimeout', callback => { callback(); return 1; });
    const app = Object.assign(Object.create(VGGTHierarchyApp.prototype), {
        datasetKey: 'THANJAVUR',
        renderer: { domElement: { width: 1600, height: 900,
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 450 }) } },
        composer: { render: () => context.calls.push({ name: 'render' }) },
        layoutGuides: { update() {}, drawToCanvas: ctx => ctx.strokeRect(1, 2, 3, 4) },
        ui: { recordBtn: { classList: { add() {}, remove() {} } } },
        orbitControls: { update() {} }, advancePlayback() {}
    });
    app.toggleRecording();
    const recorder = app.mediaRecorder;
    assert.equal(captures, 1);
    assert.equal(app.ui.recordBtn.textContent, 'Stop');
    assert.equal(context.calls[0].name, 'render');
    assert.ok(context.calls.some(c => c.name === 'strokeRect'));
    context.calls.length = 0;
    app.tick();
    assert.equal(context.calls[0].name, 'render');
    assert.ok(context.calls.some(c => c.name === 'drawImage'));
    assert.ok(context.calls.some(c => c.name === 'strokeRect'));
    app.datasetKey = 'BRUSSELS';
    app.toggleRecording();
    assert.equal(app.ui.recordBtn.disabled, true);
    recorder.ondataavailable({ data: new Blob(['video']) });
    recorder.onstop();
    assert.match(downloads[0], /^thanjavur-recording-.*\.webm$/);
    assert.equal(blobs[0].size, 5);
    assert.equal(blobs[0].type, 'video/webm;codecs=vp8');
    assert.equal(stopped, 1);
    assert.equal(app.recordingContext, null);
    assert.equal(app.ui.recordBtn.disabled, false);
    assert.equal(app.ui.recordBtn.textContent, 'Record');
    app.toggleRecording();
    const next = app.mediaRecorder;
    app.toggleRecording();
    next.ondataavailable({ data: new Blob(['new']) });
    next.onstop();
    assert.match(downloads[1], /^brussels-recording-.*\.webm$/);
    assert.equal(blobs[1].size, 3);
    assert.equal(stopped, 2);
});
