import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { VGGTDataLoader } from './data-loader-vggt.js?v=39';
import { SquarenessLayoutEngine } from './layout-engine-squareness.js?v=39';
import { InteractionEngine } from './interaction-engine.js?v=5';
import { SquarenessAnimationEngine } from './animation-engine-squareness.js?v=39';
import { CameraEngine } from './camera-engine.js?v=39';
import { updatePointScale, applyBlendMode, BLEND_MODES } from './point-material.js?v=39';
import { FrustumEngine } from './frustum-engine.js?v=29';
import { EDLPass } from './edl-pass.js?v=39';
import { ParticleEngine } from './particle-engine.js?v=39';
import { ConvergenceEngine } from './convergence-engine.js?v=39';

const VignetteShader = {
    uniforms: {
        tDiffuse: { value: null },
        uStrength: { value: 0.35 },
        uEnabled: { value: 1.0 }
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float uStrength;
        uniform float uEnabled;
        varying vec2 vUv;
        void main() {
            vec4 color = texture2D(tDiffuse, vUv);
            if (uEnabled < 0.5) {
                gl_FragColor = color;
                return;
            }
            float dist = distance(vUv, vec2(0.5));
            float vignette = smoothstep(0.45, 0.85, dist);
            color.rgb *= 1.0 - vignette * uStrength;
            gl_FragColor = color;
        }
    `
};

const ColorGradingShader = {
    uniforms: {
        tDiffuse: { value: null },
        uBrightness: { value: 0.0 },
        uContrast: { value: 1.0 },
        uSaturation: { value: 1.1 }
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float uBrightness;
        uniform float uContrast;
        uniform float uSaturation;
        varying vec2 vUv;
        void main() {
            vec4 color = texture2D(tDiffuse, vUv);
            color.rgb += uBrightness;
            color.rgb = (color.rgb - 0.5) * uContrast + 0.5;
            float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
            color.rgb = mix(vec3(gray), color.rgb, uSaturation);
            color.rgb = clamp(color.rgb, 0.0, 1.0);
            gl_FragColor = color;
        }
    `
};

class VGGTHierarchyApp {
    constructor() {
        this.blendMode = localStorage.getItem('gh-blend-mode') || 'sharp';
        this.cameraAnimTarget = null;
        this.gradientBg = localStorage.getItem('gh-bg') || 'none';
        this.groundGridEnabled = localStorage.getItem('gh-grid') === 'true';
        this.edlEnabled = localStorage.getItem('gh-edl') !== 'false';
        this.vignetteEnabled = localStorage.getItem('gh-vignette') !== 'false';
        this.particlesEnabled = localStorage.getItem('gh-particles') === 'true';
        this.cameraMode = 'free';
        this.phase = 'loading';
        this.initThree();
        this.initUI();
    }

    initThree() {
        this.container = document.getElementById('canvas-container');
        
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xffffff);
        
        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 50000);
        this.camera.position.set(0, 0, 200);
        
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.0;
        this.container.appendChild(this.renderer.domElement);
        
        this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
        this.orbitControls.enableDamping = true;
        this.orbitControls.dampingFactor = 0.05;
        this.orbitControls.autoRotate = false;
        
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.9);
        this.scene.add(ambientLight);
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.4);
        dirLight.position.set(10, 10, 10);
        this.scene.add(dirLight);

        this.worldGroup = new THREE.Group();
        this.scene.add(this.worldGroup);

        this.initGradientBackground();
        this.initGroundGrid();
        this.initPostProcessing();
        this.initTheme();

        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
            this.composer.setSize(window.innerWidth, window.innerHeight);
            if (this.edlPass) this.edlPass.setSize(window.innerWidth, window.innerHeight);
            updatePointScale();
        });
    }

    initGradientBackground() {
        const gradients = {
            sunset: { top: new THREE.Color(0x1a0a2e), bottom: new THREE.Color(0x8b3a1f) },
            cool: { top: new THREE.Color(0x0a1628), bottom: new THREE.Color(0x1a3a5c) },
            gray: { top: new THREE.Color(0x2a2a2a), bottom: new THREE.Color(0x4a4a4a) }
        };
        this.gradientPresets = gradients;

        const geom = new THREE.PlaneGeometry(2, 2);
        this.gradientMaterial = new THREE.ShaderMaterial({
            uniforms: {
                uTopColor: { value: new THREE.Color(0x0a1628) },
                uBottomColor: { value: new THREE.Color(0x1a3a5c) }
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = vec4(position.xy, 0.9999, 1.0);
                }
            `,
            fragmentShader: `
                uniform vec3 uTopColor;
                uniform vec3 uBottomColor;
                varying vec2 vUv;
                void main() {
                    gl_FragColor = vec4(mix(uBottomColor, uTopColor, vUv.y), 1.0);
                }
            `,
            depthTest: false,
            depthWrite: false
        });
        this.gradientMesh = new THREE.Mesh(geom, this.gradientMaterial);
        this.gradientMesh.renderOrder = -1000;
        this.gradientMesh.frustumCulled = false;
        this.gradientMesh.visible = false;
        this.scene.add(this.gradientMesh);
    }

    initGroundGrid() {
        const size = 600;
        const divisions = 40;
        this.groundGrid = new THREE.GridHelper(size, divisions, 0x888888, 0x888888);
        this.groundGrid.material.transparent = true;
        this.groundGrid.material.opacity = 0.15;
        this.groundGrid.material.depthWrite = false;
        this.groundGrid.position.y = -80;
        this.groundGrid.visible = this.groundGridEnabled;
        this.scene.add(this.groundGrid);
    }

    applyGradientBackground(preset) {
        this.gradientBg = preset;
        localStorage.setItem('gh-bg', preset);

        if (preset === 'none') {
            this.gradientMesh.visible = false;
            this.scene.background = new THREE.Color(this.isDark ? 0x0a0a0a : 0xffffff);
            return;
        }

        const colors = this.gradientPresets[preset];
        if (!colors) return;

        this.gradientMaterial.uniforms.uTopColor.value.copy(colors.top);
        this.gradientMaterial.uniforms.uBottomColor.value.copy(colors.bottom);
        this.gradientMesh.visible = true;
        this.scene.background = null;
    }

    initPostProcessing() {
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(new RenderPass(this.scene, this.camera));

        const res = new THREE.Vector2(window.innerWidth, window.innerHeight);

        this.bloomPass = new UnrealBloomPass(res, 0.35, 0.4, 0.85);
        this.composer.addPass(this.bloomPass);

        this.edlPass = new EDLPass(this.scene, this.camera, res);
        this.edlPass.enabled = this.edlEnabled;
        this.composer.addPass(this.edlPass);

        this.vignettePass = new ShaderPass(VignetteShader);
        this.vignettePass.uniforms.uEnabled.value = this.vignetteEnabled ? 1.0 : 0.0;
        this.composer.addPass(this.vignettePass);

        this.colorGradingPass = new ShaderPass(ColorGradingShader);
        const savedBrightness = parseFloat(localStorage.getItem('gh-brightness'));
        const savedContrast = parseFloat(localStorage.getItem('gh-contrast'));
        const savedSaturation = parseFloat(localStorage.getItem('gh-saturation'));
        if (!isNaN(savedBrightness)) this.colorGradingPass.uniforms.uBrightness.value = savedBrightness;
        if (!isNaN(savedContrast)) this.colorGradingPass.uniforms.uContrast.value = savedContrast;
        if (!isNaN(savedSaturation)) this.colorGradingPass.uniforms.uSaturation.value = savedSaturation;
        this.composer.addPass(this.colorGradingPass);

        this.baseBloomStrength = 0.35;
        this.bloomPulseActive = false;
    }

    initTheme() {
        this.isDark = localStorage.getItem('gh-theme') === 'dark';
        if (this.isDark) {
            document.body.classList.add('dark-theme');
            this.scene.background = new THREE.Color(0x0a0a0a);
            document.getElementById('btn-theme').textContent = '\u2600';
        }
        this.updateBloomForTheme();
        if (this.gradientBg !== 'none') {
            this.applyGradientBackground(this.gradientBg);
        }
    }

    toggleTheme() {
        this.isDark = !this.isDark;
        document.body.classList.toggle('dark-theme', this.isDark);
        if (this.gradientBg === 'none') {
            this.scene.background = new THREE.Color(this.isDark ? 0x0a0a0a : 0xffffff);
        }
        document.getElementById('btn-theme').textContent = this.isDark ? '\u2600' : '\u263E';
        localStorage.setItem('gh-theme', this.isDark ? 'dark' : 'light');
        this.updateBloomForTheme();
        this.applyBlendModeToAll();
        if (this.particleEngine) this.particleEngine.setTheme(this.isDark);
        if (this.groundGrid) {
            this.groundGrid.material.opacity = this.isDark ? 0.1 : 0.15;
        }
    }

    updateBloomForTheme() {
        if (this.isDark) {
            this.baseBloomStrength = 0.5;
            this.bloomPass.strength = 0.5;
            this.bloomPass.threshold = 0.6;
            this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
            this.renderer.toneMappingExposure = 1.0;
        } else {
            this.baseBloomStrength = 0.15;
            this.bloomPass.strength = 0.15;
            this.bloomPass.threshold = 0.9;
            this.renderer.toneMapping = THREE.NoToneMapping;
            this.renderer.toneMappingExposure = 1.0;
        }
    }

    initUI() {
        this.ui = {
            loading: document.getElementById('loading'),
            loadingText: document.querySelector('.loading-text'),
            eventLabel: document.getElementById('event-label'),
            progressBar: document.getElementById('timeline-progress'),
            stats: document.getElementById('stats-display'),
            prevBtn: document.getElementById('btn-prev'),
            nextBtn: document.getElementById('btn-next'),
            playBtn: document.getElementById('btn-play'),
            resetBtn: document.getElementById('btn-reset'),
            track: document.getElementById('timeline-track'),
            blendSelect: document.getElementById('blend-mode-select')
        };

        this.ui.prevBtn.addEventListener('click', () => this.step(-1));
        this.ui.nextBtn.addEventListener('click', () => this.step(1));
        this.ui.resetBtn.addEventListener('click', () => this.reset());
        this.ui.playBtn.addEventListener('click', () => this.togglePlay());
        
        this.ui.track.addEventListener('click', (e) => {
            if (!this.animationEngine) return;
            if (this.phase === 'convergence') {
                this.convergenceEngine.skipToEnd();
                this.transitionToMergePhase();
                return;
            }
            const rect = this.ui.track.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            const index = Math.floor(pct * this.animationEngine.mergeEvents.length);
            this.jumpTo(index);
        });

        this.ui.recordBtn = document.getElementById('btn-record');
        this.ui.recordBtn.addEventListener('click', () => this.toggleRecording());

        document.getElementById('btn-theme').addEventListener('click', () => this.toggleTheme());

        if (this.ui.blendSelect) {
            this.ui.blendSelect.value = this.blendMode;
            this.ui.blendSelect.addEventListener('change', (e) => {
                this.blendMode = e.target.value;
                localStorage.setItem('gh-blend-mode', this.blendMode);
                this.applyBlendModeToAll();
            });
        }

        this.initVisualSettingsUI();

        this.mediaRecorder = null;
        this.recordedChunks = [];

        window.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
            switch (e.code) {
                case 'Space':
                    e.preventDefault();
                    this.togglePlay();
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    this.step(1);
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    this.step(-1);
                    break;
                case 'KeyR':
                    e.preventDefault();
                    this.reset();
                    break;
            }
        });
    }

    initVisualSettingsUI() {
        const edlToggle = document.getElementById('toggle-edl');
        const vignetteToggle = document.getElementById('toggle-vignette');
        const gridToggle = document.getElementById('toggle-grid');
        const particleToggle = document.getElementById('toggle-particles');
        const bgSelect = document.getElementById('bg-select');
        const cameraSelect = document.getElementById('camera-mode-select');
        const brightnessSlider = document.getElementById('slider-brightness');
        const contrastSlider = document.getElementById('slider-contrast');
        const saturationSlider = document.getElementById('slider-saturation');

        if (edlToggle) {
            edlToggle.checked = this.edlEnabled;
            edlToggle.addEventListener('change', (e) => {
                this.edlEnabled = e.target.checked;
                this.edlPass.enabled = this.edlEnabled;
                localStorage.setItem('gh-edl', this.edlEnabled);
            });
        }

        if (vignetteToggle) {
            vignetteToggle.checked = this.vignetteEnabled;
            vignetteToggle.addEventListener('change', (e) => {
                this.vignetteEnabled = e.target.checked;
                this.vignettePass.uniforms.uEnabled.value = this.vignetteEnabled ? 1.0 : 0.0;
                localStorage.setItem('gh-vignette', this.vignetteEnabled);
            });
        }

        if (gridToggle) {
            gridToggle.checked = this.groundGridEnabled;
            gridToggle.addEventListener('change', (e) => {
                this.groundGridEnabled = e.target.checked;
                this.groundGrid.visible = this.groundGridEnabled;
                localStorage.setItem('gh-grid', this.groundGridEnabled);
            });
        }

        if (particleToggle) {
            particleToggle.checked = this.particlesEnabled;
            particleToggle.addEventListener('change', (e) => {
                this.particlesEnabled = e.target.checked;
                if (this.particleEngine) this.particleEngine.enabled = this.particlesEnabled;
                localStorage.setItem('gh-particles', this.particlesEnabled);
            });
        }

        if (bgSelect) {
            bgSelect.value = this.gradientBg;
            bgSelect.addEventListener('change', (e) => {
                this.applyGradientBackground(e.target.value);
            });
        }

        if (cameraSelect) {
            cameraSelect.addEventListener('change', (e) => {
                this.setCameraMode(e.target.value);
            });
        }

        if (brightnessSlider) {
            brightnessSlider.value = this.colorGradingPass.uniforms.uBrightness.value;
            brightnessSlider.addEventListener('input', (e) => {
                const v = parseFloat(e.target.value);
                this.colorGradingPass.uniforms.uBrightness.value = v;
                localStorage.setItem('gh-brightness', v);
            });
        }

        if (contrastSlider) {
            contrastSlider.value = this.colorGradingPass.uniforms.uContrast.value;
            contrastSlider.addEventListener('input', (e) => {
                const v = parseFloat(e.target.value);
                this.colorGradingPass.uniforms.uContrast.value = v;
                localStorage.setItem('gh-contrast', v);
            });
        }

        if (saturationSlider) {
            saturationSlider.value = this.colorGradingPass.uniforms.uSaturation.value;
            saturationSlider.addEventListener('input', (e) => {
                const v = parseFloat(e.target.value);
                this.colorGradingPass.uniforms.uSaturation.value = v;
                localStorage.setItem('gh-saturation', v);
            });
        }
    }

    setCameraMode(mode) {
        this.cameraMode = mode;
        if (!this.cameraEngine) return;

        this.cameraEngine.stopCameraPath();

        if (mode === 'orbit') {
            this.cameraEngine.startOrbitPath(this.orbitControls.target.clone());
        } else if (mode === 'cinematic') {
            this.cameraEngine.startCinematicPath(this.orbitControls.target.clone());
        }
    }

    applyBlendModeToAll() {
        if (!this.dataLoader) return;
        for (const cluster of this.dataLoader.clusters.values()) {
            if (cluster.pointCloud && cluster.pointCloud.material) {
                applyBlendMode(cluster.pointCloud.material, this.blendMode, this.isDark);
            }
        }
        if (this.animationEngine) {
            this.animationEngine.updateBlendMode(this.blendMode, this.isDark);
        }
    }

    async start() {
        try {
            this.dataLoader = new VGGTDataLoader();
            this.dataLoader.onProgress = (loaded, total) => {
                this.ui.loadingText.textContent = `Loading VGGT Clusters... ${loaded}/${total}`;
            };

            const clusters = await this.dataLoader.load();
            
            let loadedCount = 0;
            for (const c of clusters.values()) {
                if (c.pointCloud) loadedCount++;
            }
            
            if (loadedCount === 0) {
                throw new Error("No point clouds loaded. Check that data/ directory exists.");
            }

            console.log(`Loaded ${loadedCount}/${clusters.size} clusters with point data`);
        
            for (const cluster of clusters.values()) {
                this.worldGroup.add(cluster.group);
            }

            this.applyBlendModeToAll();

            this.layoutEngine = new SquarenessLayoutEngine(clusters);
            this.layoutEngine.computeLayout();

            this.animationEngine = new SquarenessAnimationEngine(clusters, this.layoutEngine, this.worldGroup);
            this.animationEngine.initTransitionBuffers(this.blendMode, this.isDark);
            this.events = this.animationEngine.initTimeline();
            this.currentEventIndex = 0;

            this.interactionEngine = new InteractionEngine(
                this.camera, 
                this.renderer.domElement, 
                clusters, 
                this.orbitControls
            );

            this.cameraEngine = new CameraEngine(this.camera, this.orbitControls);

            this.frustumEngine = new FrustumEngine(this.worldGroup);
            this.ui.loadingText.textContent = 'Loading camera frustums...';
            await this.frustumEngine.loadForClusters(clusters, this.dataLoader);

            this.particleEngine = new ParticleEngine(this.worldGroup);
            this.particleEngine.enabled = this.particlesEnabled;
            this.particleEngine.setTheme(this.isDark);
            this.animationEngine.particleEngine = this.particleEngine;

            this.cameraEngine.saveDefault();
            this.cameraEngine.setAutoOrbit(true);

            this.convergenceEngine = new ConvergenceEngine();
            const leafClusters = this.animationEngine.getLeafClusters();

            if (leafClusters.length > 0) {
                for (const cluster of this.dataLoader.clusters.values()) {
                    if (cluster.pointCloud) {
                        cluster.pointCloud.visible = false;
                    }
                }

                this.convergenceEngine.initConvergence(leafClusters);
                this.phase = 'convergence';

                this.fitCameraToAllLeaves(true);
                this.convergenceEngine.start();
                this.isPlaying = true;
                this.ui.playBtn.textContent = 'Pause';
            } else {
                if (this.events.length > 0) {
                    this.animationEngine.applyEventInstant(0);
                    this.frustumEngine.syncToEventIndex(this.events, 0);
                }
                this.phase = 'merge';
                this.fitCameraToVisible(true);
            }

            this.updateUI();

            this.ui.loading.style.display = 'none';
            
            this.animate();
            
        } catch (err) {
            console.error("App Start Error:", err);
            this.ui.loadingText.innerHTML = `<span style="color: #ff4444">Error starting app:<br>${err.message}</span>`;
        }
    }

    fitCameraToVisible(instant = false) {
        if (!this.events || this.events.length === 0) return;

        const visible = new Set();
        for (let i = 0; i <= this.currentEventIndex; i++) {
            const evt = this.events[i];
            if (evt.isLeaf) {
                visible.add(evt.cluster);
            } else {
                visible.add(evt.cluster);
                for (const childPath of evt.children) {
                    const child = this.dataLoader.clusters.get(childPath);
                    if (child) visible.delete(child);
                }
            }
        }

        const isFinalEvent = this.currentEventIndex === this.events.length - 1;

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        let found = false;

        if (isFinalEvent && visible.size === 1) {
            for (const cluster of visible) {
                if (!cluster.pointCloud || !cluster.pointCloud.geometry) continue;
                const geom = cluster.pointCloud.geometry;
                geom.computeBoundingBox();
                const box = geom.boundingBox;
                const s = cluster.fitScale || 1;
                const hp = cluster.hierarchyPosition;
                if (!hp || !box) continue;
                minX = Math.min(minX, hp.x + box.min.x * s);
                maxX = Math.max(maxX, hp.x + box.max.x * s);
                minY = Math.min(minY, hp.y + box.min.y * s);
                maxY = Math.max(maxY, hp.y + box.max.y * s);
                found = true;
            }
        } else {
            for (const cluster of visible) {
                const rect = cluster.rect || cluster.mergeRegion;
                if (!rect) continue;
                minX = Math.min(minX, rect.x);
                maxX = Math.max(maxX, rect.x + rect.w);
                minY = Math.min(minY, rect.y);
                maxY = Math.max(maxY, rect.y + rect.h);
                found = true;
            }
        }

        if (!found) return;

        const pad = 2;
        const width = maxX - minX + pad;
        const height = maxY - minY + pad;
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;

        const fov = this.camera.fov;
        const aspect = window.innerWidth / window.innerHeight;
        const vFovRad = THREE.MathUtils.degToRad(fov / 2);
        const hFovRad = Math.atan(aspect * Math.tan(vFovRad));

        const distForHeight = (height / 2) / Math.tan(vFovRad);
        const distForWidth = (width / 2) / Math.tan(hFovRad);
        const margin = isFinalEvent ? 1.45 : 1.05;
        let dist = Math.max(distForHeight, distForWidth) * margin;
        dist = Math.max(dist, 8);

        const targetPos = new THREE.Vector3(centerX, centerY, dist);
        const targetLookAt = new THREE.Vector3(centerX, centerY, 0);

        if (instant) {
            this.camera.position.copy(targetPos);
            this.camera.lookAt(targetLookAt);
            this.orbitControls.target.copy(targetLookAt);
            this.orbitControls.update();
            this.cameraAnimTarget = null;
            return;
        }

        this.cameraAnimTarget = targetPos;
        this.cameraAnimLookAt = targetLookAt;
        this.cameraAnimDuration = 0.6;
        this.cameraAnimStart = performance.now() / 1000;
        this.cameraAnimFrom = this.camera.position.clone();
        this.cameraAnimLookFrom = this.orbitControls.target.clone();
    }

    fitCameraToAllLeaves(instant = false) {
        const leafClusters = this.animationEngine.getLeafClusters();
        if (leafClusters.length === 0) return;

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const cluster of leafClusters) {
            const rect = cluster.rect;
            if (!rect) continue;
            minX = Math.min(minX, rect.x);
            maxX = Math.max(maxX, rect.x + rect.w);
            minY = Math.min(minY, rect.y);
            maxY = Math.max(maxY, rect.y + rect.h);
        }

        if (minX === Infinity) return;

        const pad = 2;
        const width = maxX - minX + pad;
        const height = maxY - minY + pad;
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;

        const fov = this.camera.fov;
        const aspect = window.innerWidth / window.innerHeight;
        const vFovRad = THREE.MathUtils.degToRad(fov / 2);
        const hFovRad = Math.atan(aspect * Math.tan(vFovRad));

        const distForHeight = (height / 2) / Math.tan(vFovRad);
        const distForWidth = (width / 2) / Math.tan(hFovRad);
        let dist = Math.max(distForHeight, distForWidth) * 1.4;
        dist = Math.max(dist, 8);

        const targetPos = new THREE.Vector3(centerX, centerY, dist);
        const targetLookAt = new THREE.Vector3(centerX, centerY, 0);

        if (instant) {
            this.camera.position.copy(targetPos);
            this.camera.lookAt(targetLookAt);
            this.orbitControls.target.copy(targetLookAt);
            this.orbitControls.update();
            this.cameraAnimTarget = null;
            return;
        }

        this.cameraAnimTarget = targetPos;
        this.cameraAnimLookAt = targetLookAt;
        this.cameraAnimDuration = 0.6;
        this.cameraAnimStart = performance.now() / 1000;
        this.cameraAnimFrom = this.camera.position.clone();
        this.cameraAnimLookFrom = this.orbitControls.target.clone();
    }

    transitionToMergePhase() {
        this.phase = 'merge';

        let lastLeafIdx = -1;
        for (let i = 0; i < this.events.length; i++) {
            if (this.events[i].isLeaf) lastLeafIdx = i;
        }
        this.currentEventIndex = Math.max(0, lastLeafIdx);

        if (this.events.length > 0) {
            this.animationEngine.applyEventInstant(this.currentEventIndex);
            this.frustumEngine.syncToEventIndex(this.events, this.currentEventIndex);
        }

        this.fitCameraToVisible(true);

        this.lastStepTime = 0;
        this.lastAnimEndTime = 0;
        this.hadActiveAnims = false;

        this.updateUI();
    }

    step(direction) {
        if (this.phase === 'convergence') {
            if (direction > 0) {
                this.convergenceEngine.skipToEnd();
                this.transitionToMergePhase();
            }
            return;
        }

        if (direction > 0) {
            if (this.currentEventIndex < this.events.length - 1) {
                this.currentEventIndex++;
                this.animationEngine.playEvent(this.currentEventIndex, 1);
                this.frustumEngine.syncToEventIndex(this.events, this.currentEventIndex, true);
            }
        } else {
            if (this.currentEventIndex > 0) {
                this.animationEngine.playEvent(this.currentEventIndex, -1);
                this.currentEventIndex--;
                this.frustumEngine.syncToEventIndex(this.events, this.currentEventIndex);
            }
        }
        this.fitCameraToVisible();
        this.updateUI();
    }
    
    jumpTo(index) {
        if (index < 0) index = 0;
        if (index >= this.events.length) index = this.events.length - 1;
        this.currentEventIndex = index;
        this.animationEngine.applyEventInstant(index);
        this.frustumEngine.syncToEventIndex(this.events, index);
        this.fitCameraToVisible();
        this.updateUI();
    }

    reset() {
        this.isPlaying = false;
        this.ui.playBtn.textContent = 'Play';

        if (this.convergenceEngine && this.convergenceEngine.clusterEntries.length > 0) {
            for (const cluster of this.dataLoader.clusters.values()) {
                if (cluster.pointCloud) cluster.pointCloud.visible = false;
            }
            this.animationEngine.hideTransitionClouds();
            this.animationEngine.activeAnimations = [];
            this.convergenceEngine.initConvergence(this.animationEngine.getLeafClusters());
            this.phase = 'convergence';
            this.fitCameraToAllLeaves(true);
            this.updateUI();
        } else {
            this.jumpTo(0);
        }
    }

    togglePlay() {
        this.isPlaying = !this.isPlaying;
        this.ui.playBtn.textContent = this.isPlaying ? 'Pause' : 'Play';

        if (this.phase === 'convergence') {
            if (this.isPlaying) {
                if (this.convergenceEngine.isComplete) {
                    this.reset();
                    this.isPlaying = true;
                    this.ui.playBtn.textContent = 'Pause';
                }
                if (!this.convergenceEngine.isActive && !this.convergenceEngine.isComplete) {
                    this.convergenceEngine.start();
                } else if (this.convergenceEngine.isPaused) {
                    this.convergenceEngine.resume();
                }
            } else {
                this.convergenceEngine.pause();
            }
            return;
        }
        
        if (this.isPlaying && this.currentEventIndex >= this.events.length - 1) {
            this.reset();
            this.isPlaying = true;
            this.ui.playBtn.textContent = 'Pause';
            if (this.phase === 'convergence' && !this.convergenceEngine.isActive) {
                this.convergenceEngine.start();
            }
        }
    }

    toggleRecording() {
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
            this.mediaRecorder.stop();
            this.ui.recordBtn.textContent = 'Record';
            this.ui.recordBtn.classList.remove('recording');
            return;
        }

        this.recordedChunks = [];
        const canvas = this.renderer.domElement;
        const stream = canvas.captureStream(30);
        this.mediaRecorder = new MediaRecorder(stream, {
            mimeType: 'video/webm;codecs=vp9',
            videoBitsPerSecond: 5000000
        });

        this.mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) this.recordedChunks.push(e.data);
        };

        this.mediaRecorder.onstop = () => {
            const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            a.download = `gerrard-hall-recording-${timestamp}.webm`;
            a.click();
            URL.revokeObjectURL(url);
        };

        this.mediaRecorder.start();
        this.ui.recordBtn.textContent = 'Stop';
        this.ui.recordBtn.classList.add('recording');
    }

    updateUI() {
        if (this.phase === 'convergence' && this.convergenceEngine) {
            const pct = this.convergenceEngine.progress * 100;
            this.ui.progressBar.style.width = `${pct}%`;

            const settled = this.convergenceEngine.clusterEntries.filter(e => e.settled).length;
            const total = this.convergenceEngine.clusterEntries.length;
            this.ui.eventLabel.textContent = `Forming clusters... ${settled}/${total} complete`;

            let visiblePoints = 0;
            let visibleClusters = 0;
            for (const entry of this.convergenceEngine.clusterEntries) {
                if (entry.cluster.pointCloud && entry.cluster.pointCloud.visible) {
                    visibleClusters++;
                    visiblePoints += entry.count;
                }
            }
            this.ui.stats.textContent = `Clusters: ${visibleClusters} | Points: ${visiblePoints.toLocaleString()}`;
            return;
        }

        const count = this.events.length;
        if (count === 0) return;
        
        const progress = (this.currentEventIndex / (count - 1)) * 100;
        this.ui.progressBar.style.width = `${progress}%`;
        
        const event = this.events[this.currentEventIndex];
        const eventType = event.isLeaf ? 'VGGT' : 'Merge';
        let label = `Event ${this.currentEventIndex + 1}/${count}: ${eventType} — ${event.path}`;
        if (event.timestamp) {
            const d = new Date(event.timestamp * 1000);
            label += ` (${d.toLocaleTimeString()})`;
        }
        this.ui.eventLabel.textContent = label;
        
        let visiblePoints = 0;
        let visibleClusters = 0;
        for (const c of this.dataLoader.clusters.values()) {
            if (c.pointCloud && c.pointCloud.visible) {
                visibleClusters++;
                visiblePoints += c.pointsCount;
            }
        }
        if (this.animationEngine) {
            const clouds = [this.animationEngine.preMatchedCloud, this.animationEngine.preChildOnlyCloud, this.animationEngine.preMergedOnlyCloud];
            for (const tc of clouds) {
                if (tc && tc.visible && tc.geometry) {
                    visiblePoints += tc.geometry.drawRange.count;
                    visibleClusters++;
                }
            }
        }
        this.ui.stats.textContent = `Clusters: ${visibleClusters} | Points: ${visiblePoints.toLocaleString()}`;

        const cameraSelect = document.getElementById('camera-mode-select');
        if (cameraSelect) {
            const isFinal = this.currentEventIndex === this.events.length - 1;
            const orbitOpt = cameraSelect.querySelector('option[value="orbit"]');
            const cinematicOpt = cameraSelect.querySelector('option[value="cinematic"]');
            if (orbitOpt) orbitOpt.disabled = !isFinal;
            if (cinematicOpt) cinematicOpt.disabled = !isFinal;
            if (!isFinal && this.cameraMode !== 'free') {
                cameraSelect.value = 'free';
                this.setCameraMode('free');
            }
        }
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        
        const time = performance.now() / 1000;
        const dt = 0.016;

        if (this.phase === 'convergence') {
            if (this.convergenceEngine && this.convergenceEngine.isActive) {
                this.convergenceEngine.update();
                this.updateUI();

                if (this.convergenceEngine.isComplete) {
                    this.transitionToMergePhase();
                }
            }
        } else if (this.phase === 'merge') {
            if (this.isPlaying) {
                if (!this.lastStepTime) this.lastStepTime = time;
                const hasActiveAnims = this.animationEngine && this.animationEngine.activeAnimations.length > 0;
                if (hasActiveAnims) {
                    this.hadActiveAnims = true;
                } else if (this.hadActiveAnims) {
                    this.hadActiveAnims = false;
                    this.lastAnimEndTime = time;
                }
                const ref = Math.max(this.lastStepTime, this.lastAnimEndTime || 0);
                const nextIdx = this.currentEventIndex + 1;
                const nextEvent = nextIdx < this.events.length ? this.events[nextIdx] : null;
                const delay = nextEvent && nextEvent.delay ? nextEvent.delay : 1.0;
                if (!hasActiveAnims && time - ref > delay) {
                    if (this.currentEventIndex < this.events.length - 1) {
                        this.step(1);
                        this.lastStepTime = time;
                    } else {
                        this.togglePlay();
                    }
                }
            } else {
                this.lastStepTime = 0;
                this.lastAnimEndTime = 0;
                this.hadActiveAnims = false;
            }
        }

        if (this.cameraAnimTarget) {
            const elapsed = time - this.cameraAnimStart;
            const t = Math.min(elapsed / this.cameraAnimDuration, 1);
            const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

            this.camera.position.lerpVectors(this.cameraAnimFrom, this.cameraAnimTarget, e);
            this.orbitControls.target.lerpVectors(this.cameraAnimLookFrom, this.cameraAnimLookAt, e);

            if (t >= 1) {
                this.cameraAnimTarget = null;
            }
        }

        if (this.animationEngine) {
            const hadAnimations = this.animationEngine.activeAnimations.length > 0;
            this.animationEngine.update(dt);
            if (hadAnimations) this.updateUI();
        }
        if (this.particleEngine) this.particleEngine.update();
        if (this.frustumEngine) this.frustumEngine.update();
        if (this.cameraEngine) this.cameraEngine.update(time);
        
        this.orbitControls.update();
        this.composer.render();
    }
}

const app = new VGGTHierarchyApp();
window.app = app;
app.start();
