import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { VGGTDataLoader, DATASETS } from './data-loader-vggt.js?v=42';
import { SquarenessLayoutEngine } from './layout-engine-squareness.js?v=40';
import { InteractionEngine } from './interaction-engine.js?v=5';
import { SquarenessAnimationEngine } from './animation-engine-squareness.js?v=40';
import { CameraEngine } from './camera-engine.js?v=40';
import { updatePointScale, applyBlendMode, BLEND_MODES } from './point-material.js?v=40';
import { FrustumEngine } from './frustum-engine.js?v=30';
import { EDLPass } from './edl-pass.js?v=40';
import { ParticleEngine } from './particle-engine.js?v=40';
import { ConvergenceEngine } from './convergence-engine.js?v=40';

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

        const edlStrengthSlider = document.getElementById('slider-edl-strength');
        if (edlStrengthSlider) {
            const savedStr = parseFloat(localStorage.getItem('gh-edl-strength'));
            if (!isNaN(savedStr)) {
                edlStrengthSlider.value = savedStr;
                if (this.edlPass) this.edlPass.edlStrength = savedStr;
            }
            edlStrengthSlider.addEventListener('input', (e) => {
                const v = parseFloat(e.target.value);
                if (this.edlPass) this.edlPass.edlStrength = v;
                localStorage.setItem('gh-edl-strength', v);
            });
        }

        const edlRadiusSlider = document.getElementById('slider-edl-radius');
        if (edlRadiusSlider) {
            const savedRad = parseFloat(localStorage.getItem('gh-edl-radius'));
            if (!isNaN(savedRad)) {
                edlRadiusSlider.value = savedRad;
                if (this.edlPass) this.edlPass.edlRadius = savedRad;
            }
            edlRadiusSlider.addEventListener('input', (e) => {
                const v = parseFloat(e.target.value);
                if (this.edlPass) this.edlPass.edlRadius = v;
                localStorage.setItem('gh-edl-radius', v);
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

        const colorModeSelect = document.getElementById('color-mode-select');
        if (colorModeSelect) {
            const savedMode = localStorage.getItem('gh-color-mode') || 'rgb';
            colorModeSelect.value = savedMode;
            colorModeSelect.addEventListener('change', (e) => {
                this.setColorMode(e.target.value);
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

    initColorModes() {
        this.colorMode = 'rgb';
        this.originalColors = new Map();
        this.clusterHues = new Map();

        for (const [path, cluster] of this.dataLoader.clusters) {
            if (!cluster.pointCloud || !cluster.pointCloud.geometry) continue;
            const colorAttr = cluster.pointCloud.geometry.attributes.color;
            if (colorAttr) {
                this.originalColors.set(path, new Float32Array(colorAttr.array));
            }
        }

        const paths = [...this.dataLoader.clusters.keys()];
        const goldenAngle = 137.508;
        for (let i = 0; i < paths.length; i++) {
            this.clusterHues.set(paths[i], (i * goldenAngle) % 360);
        }
    }

    setColorMode(mode) {
        this.colorMode = mode;
        localStorage.setItem('gh-color-mode', mode);

        for (const [path, cluster] of this.dataLoader.clusters) {
            if (!cluster.pointCloud || !cluster.pointCloud.geometry) continue;
            const colorAttr = cluster.pointCloud.geometry.attributes.color;
            if (!colorAttr) continue;
            const arr = colorAttr.array;
            const count = colorAttr.count;

            if (mode === 'rgb') {
                const orig = this.originalColors.get(path);
                if (orig) {
                    for (let i = 0; i < orig.length; i++) arr[i] = orig[i];
                }
            } else if (mode === 'cluster') {
                const hue = this.clusterHues.get(path) || 0;
                const c = new THREE.Color();
                c.setHSL(hue / 360, 0.75, 0.55);
                for (let i = 0; i < count; i++) {
                    arr[i * 3]     = c.r;
                    arr[i * 3 + 1] = c.g;
                    arr[i * 3 + 2] = c.b;
                }
            } else if (mode === 'depth') {
                const posAttr = cluster.pointCloud.geometry.attributes.position;
                let minY = Infinity, maxY = -Infinity;
                for (let i = 0; i < count; i++) {
                    const y = posAttr.getY(i);
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
                const range = maxY - minY || 1;
                const c = new THREE.Color();
                for (let i = 0; i < count; i++) {
                    const t = (posAttr.getY(i) - minY) / range;
                    c.setHSL(0.67 - t * 0.67, 0.9, 0.45 + t * 0.15);
                    arr[i * 3]     = c.r;
                    arr[i * 3 + 1] = c.g;
                    arr[i * 3 + 2] = c.b;
                }
            }

            colorAttr.needsUpdate = true;
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

    initDatasetSelect() {
        const select = document.getElementById('dataset-select');
        if (!select) return;

        for (const [key, ds] of Object.entries(DATASETS)) {
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = ds.label;
            select.appendChild(opt);
        }
        select.value = this.datasetKey;
        select.addEventListener('change', (e) => {
            const url = new URL(window.location.href);
            url.searchParams.set('dataset', e.target.value);
            window.location.href = url.toString();
        });
    }

    async start() {
        try {
            const params = new URLSearchParams(window.location.search);
            const requested = params.get('dataset') || 'original';
            this.datasetKey = DATASETS[requested] ? requested : 'original';
            this.initDatasetSelect();

            this.dataLoader = new VGGTDataLoader(this.datasetKey);
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

            this.convergenceEngine = new ConvergenceEngine();

            this.animationEngine = new SquarenessAnimationEngine(clusters, this.layoutEngine, this.worldGroup);
            this.animationEngine.convergenceEngine = this.convergenceEngine;
            this.animationEngine.initTransitionBuffers(this.blendMode, this.isDark);
            this.events = this.animationEngine.initTimeline();
            this.currentEventIndex = 0;

            const leafClusters = this.animationEngine.getLeafClusters();
            this.convergenceEngine.prepareAllLeaves(leafClusters);

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

            this.initColorModes();
            const savedColorMode = localStorage.getItem('gh-color-mode');
            if (savedColorMode && savedColorMode !== 'rgb') {
                this.setColorMode(savedColorMode);
            }

            for (const cluster of this.dataLoader.clusters.values()) {
                if (cluster.pointCloud) {
                    cluster.pointCloud.visible = false;
                }
            }

            if (this.events.length > 0) {
                this.animationEngine.applyEventInstant(0);
                this.frustumEngine.syncToEventIndex(this.events, 0);
            }

            this.fitCameraToAllLeaves(true);

            this.isPlaying = false;
            this.lastStepTime = 0;
            this.lastAnimEndTime = 0;
            this.hadActiveAnims = false;

            this.updateUI();

            this.ui.loading.style.display = 'none';
            
            this.startBackgroundTicker();
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

    step(direction) {
        if (direction > 0) {
            if (this.currentEventIndex < this.events.length - 1) {
                this.currentEventIndex++;
                this.animationEngine.playEvent(this.currentEventIndex, 1);
                this.frustumEngine.syncToEventIndex(this.events, this.currentEventIndex, true);
            }
        } else {
            if (this.finalViewActive) {
                this.undoFinalView();
            }
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
        if (this.finalViewActive && index < this.events.length - 1) {
            this.undoFinalView();
        }
        this.currentEventIndex = index;
        this.animationEngine.applyEventInstant(index);
        this.frustumEngine.syncToEventIndex(this.events, index);
        this.fitCameraToVisible();
        this.updateUI();
    }

    collapseToFinalView() {
        if (this.finalViewActive) return;

        const lastEvt = this.events[this.events.length - 1];
        if (!lastEvt) return;
        const cluster = lastEvt.cluster;
        if (!cluster || !cluster.pointCloud) return;

        this.finalViewActive = true;
        this.finalViewCluster = cluster;
        this.finalViewOrigPos = cluster.hierarchyPosition.clone();
        this.finalViewOrigScale = cluster.fitScale || 1;

        const geom = cluster.pointCloud.geometry;
        geom.computeBoundingBox();
        const box = geom.boundingBox;
        if (!box) return;

        const s = this.finalViewOrigScale;
        const hp = cluster.hierarchyPosition;
        const cx = hp.x + ((box.min.x + box.max.x) / 2) * s;
        const cy = hp.y + ((box.min.y + box.max.y) / 2) * s;

        this.finalViewAnim = {
            startTime: performance.now() / 1000,
            duration: 1.5,
            startPos: cluster.group.position.clone(),
            endPos: new THREE.Vector3(0, 0, 0),
            startScale: s,
            endScale: 1.0,
            cluster
        };

        const halfW = (box.max.x - box.min.x) / 2;
        const halfH = (box.max.y - box.min.y) / 2;
        const fov = this.camera.fov;
        const aspect = window.innerWidth / window.innerHeight;
        const vFovRad = THREE.MathUtils.degToRad(fov / 2);
        const hFovRad = Math.atan(aspect * Math.tan(vFovRad));
        const distForHeight = halfH / Math.tan(vFovRad);
        const distForWidth = halfW / Math.tan(hFovRad);
        let dist = Math.max(distForHeight, distForWidth) * 1.2;
        dist = Math.max(dist, 8);

        this.cameraAnimTarget = new THREE.Vector3(0, 0, dist);
        this.cameraAnimLookAt = new THREE.Vector3(0, 0, 0);
        this.cameraAnimDuration = 1.5;
        this.cameraAnimStart = performance.now() / 1000;
        this.cameraAnimFrom = this.camera.position.clone();
        this.cameraAnimLookFrom = this.orbitControls.target.clone();

        this.ui.eventLabel.textContent = 'Assembled Reconstruction — Gerrard Hall';
        this.updateAnnotation();
    }

    undoFinalView() {
        if (!this.finalViewActive || !this.finalViewCluster) return;
        const cluster = this.finalViewCluster;
        cluster.group.position.copy(this.finalViewOrigPos);
        cluster.group.scale.setScalar(this.finalViewOrigScale);
        this.finalViewActive = false;
        this.finalViewAnim = null;
        this.finalViewCluster = null;
    }

    reset() {
        this.isPlaying = false;
        this.ui.playBtn.textContent = 'Play';
        this.undoFinalView();
        this.animationEngine.hideTransitionClouds();
        this.animationEngine.activeAnimations = [];
        this.jumpTo(0);
    }

    togglePlay() {
        this.isPlaying = !this.isPlaying;
        this.ui.playBtn.textContent = this.isPlaying ? 'Pause' : 'Play';
        
        if (this.isPlaying && this.currentEventIndex >= this.events.length - 1) {
            this.jumpTo(0);
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

    updateAnnotation() {
        const overlay = document.getElementById('annotation-overlay');
        const stepEl = document.getElementById('annotation-step');
        const titleEl = document.getElementById('annotation-title');
        const descEl = document.getElementById('annotation-desc');
        if (!overlay || !stepEl || !titleEl || !descEl) return;

        if (!this.events || this.events.length === 0) {
            overlay.classList.remove('visible');
            return;
        }

        const evt = this.events[this.currentEventIndex];
        const count = this.events.length;
        const leafCount = this.events.filter(e => e.isLeaf).length;
        const mergeCount = count - leafCount;
        const leafsSoFar = this.events.slice(0, this.currentEventIndex + 1).filter(e => e.isLeaf).length;
        const mergesSoFar = this.events.slice(0, this.currentEventIndex + 1).filter(e => !e.isLeaf).length;

        let step, title, desc;

        if (this.finalViewActive) {
            step = 'Final Result';
            title = 'Assembled 3D Reconstruction';
            desc = `All ${leafCount} VGGT clusters merged through ${mergeCount} hierarchical merge operations into a complete 3D model of Gerrard Hall.`;
        } else if (evt.isLeaf) {
            step = `VGGT Reconstruction ${leafsSoFar} of ${leafCount}`;
            title = `Cluster: ${evt.path.split('/').pop()}`;
            const parts = evt.path.split('/');
            const parentCluster = parts.length > 1 ? parts[0] : 'root';
            desc = `VGGT reconstructs a 3D point cloud from a subset of images assigned to partition ${parentCluster}. Points converge from scattered positions to their reconstructed coordinates.`;
        } else {
            step = `Hierarchical Merge ${mergesSoFar} of ${mergeCount}`;
            const childNames = evt.children.map(c => c.split('/').pop()).join(' + ');
            title = `Merging: ${childNames}`;
            const matchInfo = evt.cluster.matchData;
            if (matchInfo) {
                const total = matchInfo.matchedPairs.length + matchInfo.childOnlyPoints.length + matchInfo.mergedOnlyIndices.length;
                const matchPct = ((matchInfo.matchedPairs.length / total) * 100).toFixed(0);
                desc = `Aligning and fusing child clusters using nearest-neighbor point matching. ${matchInfo.matchedPairs.length} matched point pairs (${matchPct}%) guide the transition.`;
            } else {
                desc = `Child clusters are aligned and merged using spatial proximity, creating a more complete reconstruction.`;
            }
        }

        stepEl.textContent = step;
        titleEl.textContent = title;
        descEl.textContent = desc;
        overlay.classList.add('visible');
    }

    updateUI() {
        const count = this.events.length;
        if (count === 0) return;
        
        const progress = (this.currentEventIndex / (count - 1)) * 100;
        this.ui.progressBar.style.width = `${progress}%`;
        
        const event = this.events[this.currentEventIndex];
        const eventType = event.isLeaf ? 'Cluster' : 'Merge';
        let label = `Event ${this.currentEventIndex + 1}/${count}: ${eventType} — ${event.path}`;
        if (event.timestamp) {
            const d = new Date(event.timestamp * 1000);
            label += ` (${d.toLocaleTimeString()})`;
        }
        this.ui.eventLabel.textContent = label;
        this.updateAnnotation();
        
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
        this._lastRafTime = performance.now();
        this.tick();
    }

    startBackgroundTicker() {
        this._lastRafTime = performance.now();
        setInterval(() => {
            // If rAF is being throttled (hidden/backgrounded view), keep the
            // timeline and animations advancing from this interval instead.
            if (performance.now() - this._lastRafTime > 250) {
                this.tick();
            }
        }, 100);
    }

    // Advances timeline/animation state. Called from the rAF loop and from a
    // fallback interval so playback still progresses when the browser
    // throttles requestAnimationFrame (hidden/backgrounded tab).
    tick() {
        const time = performance.now() / 1000;
        const dt = 0.016;

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
                    if (!this.finalViewActive) {
                        this.collapseToFinalView();
                    }
                    this.togglePlay();
                }
            }
        } else {
            this.lastStepTime = 0;
            this.lastAnimEndTime = 0;
            this.hadActiveAnims = false;
        }

        if (this.finalViewAnim) {
            const anim = this.finalViewAnim;
            const elapsed = time - anim.startTime;
            const t = Math.min(elapsed / anim.duration, 1);
            const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

            anim.cluster.group.position.lerpVectors(anim.startPos, anim.endPos, e);
            const currentScale = anim.startScale + (anim.endScale - anim.startScale) * e;
            anim.cluster.group.scale.setScalar(currentScale);

            if (t >= 1) {
                this.finalViewAnim = null;
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

window.addEventListener('error', (e) => {
    console.error('UNCAUGHT:', e.message, 'at', e.filename + ':' + e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
    console.error('UNHANDLED PROMISE:', e.reason && e.reason.message ? e.reason.message : e.reason);
});

const app = new VGGTHierarchyApp();
window.app = app;
app.start();
