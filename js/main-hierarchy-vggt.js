import * as THREE from 'three';
import { planPlayback, PlaybackClock, formatClock } from './playback-timeline.js?v=3';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { VGGTDataLoader, DATASETS, DEFAULT_DATASET } from './data-loader-vggt.js?v=57';
import { MatchingCoordinator, matchingPriorities } from './matching-coordinator.js?v=1';
import { SquarenessLayoutEngine } from './layout-engine-squareness.js?v=53';
import { LayoutGuides } from './layout-guides.js?v=4';
import { bindRegionClip } from './region-clipping.js?v=1';
import { InteractionEngine } from './interaction-engine.js?v=6';
import { SquarenessAnimationEngine } from './animation-engine-squareness.js?v=49';
import { CameraEngine } from './camera-engine.js?v=40';
import { updatePointScale, applyBlendMode, BLEND_MODES, updateFlowTime, setFlowParams, setPointSizeScale } from './point-material.js?v=47';
import { FrustumEngine } from './frustum-engine.js?v=40';
import { EDLPass } from './edl-pass.js?v=41';
import { ParticleEngine } from './particle-engine.js?v=41';
import { ConvergenceEngine } from './convergence-engine.js?v=44';

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

export class VGGTHierarchyApp {
    constructor() {
        // The explanatory layout uses contained paths without ambient point drift.
        this.flowMode = false;
        // The project-page demo always uses the default, regardless of saved viewer settings.
        this.blendMode = new URLSearchParams(window.location.search).get('embed') === '1'
            ? 'sharp' : this.flowMode ? 'glow' : (localStorage.getItem('gh-blend-mode') || 'sharp');
        this.cameraAnimTarget = null;
        this.gradientBg = localStorage.getItem('gh-bg') || 'none';
        this.groundGridEnabled = localStorage.getItem('gh-grid') === 'true';
        // EDL off by default: its depth-based shading draws a dark ring around
        // every point sprite (the "black circles" feedback). Still available as
        // an opt-in via the toggle for users who want the depth cue.
        this.edlEnabled = localStorage.getItem('gh-edl') === 'true';
        this.vignetteEnabled = localStorage.getItem('gh-vignette') !== 'false';
        this.particlesEnabled = localStorage.getItem('gh-particles') === 'true';
        this.cameraMode = 'free';
        // Auto-frame: master toggle (default on) for the cinematic camera that follows
        // the build. userCameraOverride is a runtime flag set the moment the user grabs
        // the camera, so auto-framing cedes control until Reset (smart-suspend).
        this.autoFrameEnabled = localStorage.getItem('gh-auto-frame') !== 'false';
        this.userCameraOverride = false;
        // Hold the final composition for the entire timeline. Follow remains opt-in.
        this.fixedFrame = localStorage.getItem('gh-fixed-frame') !== 'false';
        const regions = new URLSearchParams(window.location.search).get('regions');
        this.showLayoutGuides = regions === '1' || (regions !== '0'
            && localStorage.getItem('gh-layout-guides') !== 'false');
        this.showNodeLabels = localStorage.getItem('gh-node-labels') === 'true';
        try {
            const p = new URLSearchParams(window.location.search);
            const c = p.get('camera');
            if (c === 'fixed') this.fixedFrame = true;
            else if (c === 'follow') this.fixedFrame = false;
        } catch (e) { /* non-browser */ }
        this.initThree();
        this.initUI();
        // A user collapsing a panel changes the usable viewport, unlike a timeline event.
        document.querySelector('.vs-header')?.addEventListener('click', () => this.scheduleRelayout());
    }

    initThree() {
        this.container = document.getElementById('canvas-container');
        
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xffffff);
        
        this.camera = new THREE.OrthographicCamera(-200, 200, 200, -200, 0.1, 50000);
        this.camera.aspect = window.innerWidth / window.innerHeight;
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
        // As soon as the user grabs the camera (orbit/pan/zoom), cede control: suspend
        // auto-framing and cancel any in-flight auto move so it doesn't fight the user.
        // Control resumes on Reset (or re-enabling the Auto-Frame toggle).
        this.orbitControls.addEventListener('start', () => {
            this.userCameraOverride = true;
            this.cameraAnimTarget = null;
        });
        
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
            this.scheduleRelayout();
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

        if (preset === 'white') {
            this.gradientMesh.visible = false;
            this.scene.background = new THREE.Color(0xffffff);
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
        const params = new URLSearchParams(window.location.search);
        // Kathir's "paper" look is the default: clean white background everywhere
        // (including the embedded demo). Dark is opt-in via ?theme=dark or the
        // saved toggle; ?bg=white still forces light.
        const forceWhite = params.get('bg') === 'white';
        const forceDark = params.get('theme') === 'dark';
        this.isDark = !forceWhite && (forceDark || localStorage.getItem('gh-theme') === 'dark');
        if (this.isDark) {
            document.body.classList.add('dark-theme');
            this.scene.background = new THREE.Color(0x0a0a0a);
            document.getElementById('btn-theme').textContent = '\u2600';
        } else {
            this.scene.background = new THREE.Color(0xffffff);
        }
        this.updateBloomForTheme();
        if (this.gradientBg !== 'none') {
            this.applyGradientBackground(this.gradientBg);
        }
        this.updateBgToggleLabel();
    }

    updateBgToggleLabel() {
        const btn = document.getElementById('btn-bg');
        if (btn) btn.textContent = this.isDark ? 'White BG' : 'Dark BG';
    }

    toggleTheme() {
        this.isDark = !this.isDark;
        document.body.classList.toggle('dark-theme', this.isDark);
        if (this.gradientBg === 'none' || this.gradientBg === 'white') {
            this.scene.background = new THREE.Color(this.isDark ? 0x0a0a0a : 0xffffff);
            if (this.gradientBg === 'white' && !this.isDark) {
                this.scene.background = new THREE.Color(0xffffff);
            }
        }
        document.getElementById('btn-theme').textContent = this.isDark ? '\u2600' : '\u263E';
        localStorage.setItem('gh-theme', this.isDark ? 'dark' : 'light');
        this.updateBloomForTheme();
        this.applyBlendModeToAll();
        this.updateBgToggleLabel();
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
            if (this.playback) this.seekPlayback(pct * this.playback.duration);
        });

        this.ui.recordBtn = document.getElementById('btn-record');
        this.ui.recordBtn.addEventListener('click', () => this.toggleRecording());

        document.getElementById('btn-theme').addEventListener('click', () => this.toggleTheme());

        const bgToggle = document.getElementById('btn-bg');
        if (bgToggle) bgToggle.addEventListener('click', () => this.toggleTheme());

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
                case 'Home':
                    e.preventDefault();
                    this.jumpTo(0);
                    break;
                case 'End':
                    e.preventDefault();
                    this.jumpTo(this.events.length - 1);
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

        // Camera frustum size (Akshay: expose as a parameter). Rebuilds the coral
        // wireframes live; persisted so the chosen size sticks across reloads.
        const frustumSizeSlider = document.getElementById('slider-frustum-size');
        if (frustumSizeSlider) {
            const savedFr = parseFloat(localStorage.getItem('gh-frustum-size'));
            if (!isNaN(savedFr)) frustumSizeSlider.value = savedFr;
            frustumSizeSlider.addEventListener('input', (e) => {
                const v = parseFloat(e.target.value);
                if (this.frustumEngine) this.frustumEngine.setFrustumSize(v);
                localStorage.setItem('gh-frustum-size', v);
            });
        }

        // Point size (Xinan: expose as a control). Scales the rendered disc size
        // live and persists across reloads. The slider's displayed value is synced
        // in start() once the dataset's default pointScale is known.
        const pointSizeSlider = document.getElementById('slider-point-size');
        if (pointSizeSlider) {
            pointSizeSlider.addEventListener('input', (e) => {
                const v = parseFloat(e.target.value);
                setPointSizeScale(v);
                this.applyBlendModeToAll();
                localStorage.setItem('gh-point-size', v);
            });
        }

        // Auto-Frame Camera: master toggle for the cinematic follow. Off = the camera
        // is never touched (you drive the whole time). On = it follows the build, but
        // still cedes control the instant you grab the camera (until Reset).
        const autoFrameToggle = document.getElementById('toggle-auto-frame');
        if (autoFrameToggle) {
            autoFrameToggle.checked = this.autoFrameEnabled;
            autoFrameToggle.addEventListener('change', (e) => {
                this.autoFrameEnabled = e.target.checked;
                localStorage.setItem('gh-auto-frame', this.autoFrameEnabled);
                if (this.autoFrameEnabled) {
                    // Turning it back on = "follow again": drop the manual override and
                    // re-frame the current state right away.
                    this.userCameraOverride = false;
                    if (this.fixedFrame) this.fitCameraToLayoutBounds();
                    else this.fitCameraToVisible();
                }
            });
        }

        // Lock Frame: hold one frame around the whole build (fixed-frame / area-
        // universal behavior) vs. following the growing visible set. On = minimal
        // camera motion, clusters appear and merge in place.
        const lockFrameToggle = document.getElementById('toggle-lock-frame');
        if (lockFrameToggle) {
            lockFrameToggle.checked = this.fixedFrame;
            lockFrameToggle.addEventListener('change', (e) => {
                this.fixedFrame = e.target.checked;
                localStorage.setItem('gh-fixed-frame', this.fixedFrame);
                this.userCameraOverride = false;
                if (this.fixedFrame) this.fitCameraToLayoutBounds();
                else this.fitCameraToVisible();
            });
        }

        const regionsToggle = document.getElementById('toggle-layout-guides');
        regionsToggle.checked = this.showLayoutGuides;
        regionsToggle.addEventListener('change', e => {
            this.showLayoutGuides = e.target.checked;
            localStorage.setItem('gh-layout-guides', this.showLayoutGuides);
        });
        const labelsToggle = document.getElementById('toggle-node-labels');
        labelsToggle.checked = this.showNodeLabels;
        labelsToggle.addEventListener('change', e => {
            this.showNodeLabels = e.target.checked;
            localStorage.setItem('gh-node-labels', this.showNodeLabels);
            this.updateUI();
        });

        // Cluster Gap: space between neighboring tiles (treemap PADDING_FRAC). Higher
        // = more breathing room so clusters don't read as crowded. Re-tiles live.
        const tileGapSlider = document.getElementById('slider-tile-gap');
        if (tileGapSlider) {
            const saved = parseFloat(localStorage.getItem('gh-tile-gap'));
            if (!isNaN(saved)) tileGapSlider.value = saved;
            tileGapSlider.addEventListener('input', (e) => {
                const v = parseFloat(e.target.value);
                if (this.layoutEngine) { this.layoutEngine.PADDING_FRAC = v; this.scheduleRelayout(); }
                localStorage.setItem('gh-tile-gap', v);
            });
        }

        // Cluster Fill: how much of its tile each cluster fills (treemap FIT_FRAC).
        // Lower = more air around each cluster. Re-tiles live.
        const tileFillSlider = document.getElementById('slider-tile-fill');
        if (tileFillSlider) {
            const saved = parseFloat(localStorage.getItem('gh-tile-fill'));
            if (!isNaN(saved)) tileFillSlider.value = saved;
            tileFillSlider.addEventListener('input', (e) => {
                const v = parseFloat(e.target.value);
                if (this.layoutEngine) { this.layoutEngine.FIT_FRAC = v; this.scheduleRelayout(); }
                localStorage.setItem('gh-tile-fill', v);
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
            // Hidden datasets stay reachable via ?dataset=<key> but are not offered.
            if (ds.hidden && key !== this.datasetKey) continue;
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
            const requested = params.get('dataset') || DEFAULT_DATASET;
            if (!Object.hasOwn(DATASETS, requested)) throw new Error(`Unknown dataset: ${requested}`);
            this.datasetKey = requested;

            // Point size: dense "fine" clouds want small points, sparse "sampled"
            // clouds want big ones. Use the dataset's pointScale (default 1.0),
            // overridable live via window.setPointSizeScale() or ?psize= in the URL.
            // Priority: ?psize= URL override > persisted slider value > dataset default.
            const dsScale = DATASETS[this.datasetKey].pointScale;
            const urlScale = parseFloat(params.get('psize'));
            const savedScale = parseFloat(localStorage.getItem('gh-point-size'));
            const effScale = !isNaN(urlScale)
                ? urlScale
                : (!isNaN(savedScale) ? savedScale : (dsScale || 1.0));
            setPointSizeScale(effScale);
            const pointSizeSlider = document.getElementById('slider-point-size');
            if (pointSizeSlider) pointSizeSlider.value = effScale;
            if (typeof window !== 'undefined') {
                window.setPointSizeScale = (s) => {
                    setPointSizeScale(s);
                    this.applyBlendModeToAll();
                    if (pointSizeSlider) pointSizeSlider.value = s;
                };
            }

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

            // Snapshot normalized positions before any reveal can change geometry.
            this.matchingCoordinator?.dispose();
            this.matchingCoordinator = new MatchingCoordinator(clusters);
            this.matchingCoordinator.initialize();
            if (!this._matchingPageHide) {
                this._matchingPageHide = event => {
                    // A back/forward-cache entry keeps its worker and dataset alive.
                    if (!event.persisted) this.matchingCoordinator?.dispose();
                };
                window.addEventListener('pagehide', this._matchingPageHide);
            }
        
            for (const cluster of clusters.values()) {
                this.worldGroup.add(cluster.group);
                if (cluster.pointCloud) bindRegionClip(cluster.pointCloud, () => cluster.rect);
            }

            this.applyBlendModeToAll();

            if (this.flowMode) {
                // Amplitude in world units; freq tuned so the wavelength (~80u) is
                // near cluster size (~47u) → whole clusters flow coherently rather
                // than shimmering. Calibrated against the ~500u layout span.
                setFlowParams({ amp: 2.0, freq: 0.08, speed: 0.5 });
                if (typeof window !== 'undefined') window.setFlowParams = setFlowParams;
            }

            this.layoutEngine = new SquarenessLayoutEngine(clusters);
            // Apply any persisted layout-spacing choices (Cluster Gap / Fill sliders)
            // before the first layout so the saved crowding sticks across reloads.
            const savedGap = parseFloat(localStorage.getItem('gh-tile-gap'));
            if (!isNaN(savedGap)) this.layoutEngine.PADDING_FRAC = savedGap;
            const savedFill = parseFloat(localStorage.getItem('gh-tile-fill'));
            if (!isNaN(savedFill)) this.layoutEngine.FIT_FRAC = savedFill;
            this.layoutEngine.viewportAspect = this.usableViewportAspect();
            this.layoutEngine.computeLayout();

            this.convergenceEngine = new ConvergenceEngine();

            this.animationEngine = new SquarenessAnimationEngine(clusters, this.layoutEngine, this.worldGroup);
            this.animationEngine.convergenceEngine = this.convergenceEngine;
            if (this.flowMode) this.animationEngine.setFlowEnabled(true);
            this.animationEngine.initTransitionBuffers(this.blendMode, this.isDark);
            this.events = this.animationEngine.initTimeline();
            if (!this.events.length) throw new Error('No reconstruction events loaded');
            this.currentEventIndex = 0;

            this.playbackPlan = planPlayback(this.events);
            this.playback = new PlaybackClock(this.playbackPlan.duration);
            this.animationEngine.now = () => this.playback.elapsed * 1000;
            this.refreshMatching();

            const leafClusters = this.animationEngine.getLeafClusters();
            this.convergenceEngine.prepareAllLeaves(leafClusters);

            // Frame the composed layout right away, BEFORE the (slow) frustum load,
            // so the scene is correctly framed immediately instead of sitting at the
            // default camera until frustums finish. Re-applied after full load below.
            if (this.fixedFrame) this.fitCameraToLayoutBounds(true);
            else this.fitCameraToAllLeaves(true);

            this.interactionEngine = new InteractionEngine(
                this.camera, 
                this.renderer.domElement, 
                clusters, 
                this.orbitControls
            );

            this.cameraEngine = new CameraEngine(this.camera, this.orbitControls);

            // Red camera frustums (Kathir's look): one wireframe per camera, loaded
            // from each cluster's images.txt and synced to the timeline.
            this.frustumEngine = new FrustumEngine(this.worldGroup);
            this.ui.loadingText.textContent = 'Loading camera frustums...';
            await this.frustumEngine.loadForClusters(this.dataLoader.clusters, this.dataLoader);

            // Apply a persisted frustum size (from the UI slider) once the frustums
            // exist, and expose a live global for quick tuning.
            const savedFrustum = parseFloat(localStorage.getItem('gh-frustum-size'));
            if (!isNaN(savedFrustum)) this.frustumEngine.setFrustumSize(savedFrustum);
            if (typeof window !== 'undefined') {
                window.setFrustumSize = (s) => this.frustumEngine.setFrustumSize(s);
            }

            this.particleEngine = new ParticleEngine(this.worldGroup);
            this.particleEngine.enabled = this.particlesEnabled;
            this.particleEngine.setTheme(this.isDark);
            this.animationEngine.particleEngine = this.particleEngine;

            this.frustumEngine.onGeometryChanged = () => this.scheduleRelayout();
            // Camera wireframes must participate before the presentation frame is fixed.
            this.layoutEngine.computeLayout();
            this.convergenceEngine.prepareAllLeaves(leafClusters);
            this.layoutGuides = new LayoutGuides(this.layoutEngine);
            this.cameraEngine.saveDefault();
            this.cameraEngine.setAutoOrbit(false);

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

            if (this.fixedFrame) this.fitCameraToLayoutBounds(true);
            else this.fitCameraToAllLeaves(true);

            this.isPlaying = false;
            if (this.events.length) this.seekPlayback(0);

            // Dataset changes reload this viewer, so both entry paths autoplay
            // once geometry, layout, and camera framing are ready.
            if (this.events.length > 0) this.togglePlay();
            this.updateUI();

            this.ui.loading.style.display = 'none';
            
            this.startBackgroundTicker();
            this.animate();
            
        } catch (err) {
            this.matchingCoordinator?.dispose();
            console.error("App Start Error:", err);
            this.ui.loadingText.innerHTML = `<span style="color: #ff4444">Error starting app:<br>${err.message}</span>`;
        }
    }

    /**
     * Whether the camera may auto-frame right now. False when the user turned the
     * Auto-Frame toggle off, or when they have manually grabbed the camera (until
     * Reset). Geometry assembly is never gated on this - only camera moves are.
     */
    shouldAutoFrame() {
        return this.autoFrameEnabled && !this.userCameraOverride;
    }

    usableViewport() {
        const el = document.getElementById('visual-settings');
        // Fixed-position elements have offsetParent === null even when visible.
        const panel = el && el.getClientRects().length && getComputedStyle(el).display !== 'none'
            ? el.getBoundingClientRect() : null;
        const width = window.innerWidth;
        const reserved = panel ? Math.min(width * 0.45, panel.width + 40) : 0;
        // Reserve fixed UI bands so changing annotation text cannot reframe a build.
        const embed = document.body.classList.contains('embed-mode');
        const top = embed ? (width < 760 ? 190 : 80) : (width < 1050 ? 195 : 125);
        const bottom = embed ? 180 : 260;
        return { left: 24, top, width: Math.max(100, width - reserved - 48),
            height: Math.max(100, window.innerHeight - top - bottom) };
    }

    usableViewportAspect() {
        const v = this.usableViewport();
        return v.width / v.height;
    }

    computePanelFraming(cx, cy, width, height, margin = 1.08) {
        const v = this.usableViewport();
        const unitsPerPixel = Math.max(width / v.width, height / v.height) * margin;
        const halfHeight = unitsPerPixel * window.innerHeight / 2;
        const aimX = cx + (window.innerWidth / 2 - v.left - v.width / 2) * unitsPerPixel;
        const aimY = cy - (window.innerHeight / 2 - v.top - v.height / 2) * unitsPerPixel;
        const depth = this.layoutEngine?.bounds?.maxDepth || 300;
        const dist = depth + Math.max(width, height, 300);
        return { pos: new THREE.Vector3(aimX, aimY, dist),
            look: new THREE.Vector3(aimX, aimY, 0), halfHeight, dist };
    }

    applyCameraFrame(framing, instant = false) {
        this.camera.near = 0.1;
        this.camera.far = framing.dist + (this.layoutEngine?.bounds?.maxDepth || 300) + 1000;
        this.camera.zoom = 1;
        if (instant) {
            this.camera.position.copy(framing.pos);
            this.orbitControls.target.copy(framing.look);
            this.setProjectionHeight(framing.halfHeight);
            this.camera.lookAt(framing.look);
            this.orbitControls.update();
            this.cameraAnimTarget = null;
            return;
        }
        this.cameraAnimTarget = framing.pos;
        this.cameraAnimLookAt = framing.look;
        this.cameraAnimDuration = 0.6;
        this.cameraAnimStart = performance.now() / 1000;
        this.cameraAnimFrom = this.camera.position.clone();
        this.cameraAnimLookFrom = this.orbitControls.target.clone();
        this.cameraAnimHeightFrom = this.camera.top;
        this.cameraAnimHeightTo = framing.halfHeight;
    }

    setProjectionHeight(halfHeight) {
        this.camera.top = halfHeight;
        this.camera.bottom = -halfHeight;
        this.camera.right = halfHeight * window.innerWidth / window.innerHeight;
        this.camera.left = -this.camera.right;
        this.camera.updateProjectionMatrix();
    }

    fitCameraToLayoutBounds(instant = true) {
        if (!this.shouldAutoFrame() || !this.layoutEngine?.bounds) return;
        const b = this.layoutEngine.bounds;
        this.applyCameraFrame(this.computePanelFraming(0, 0, b.width, b.height), instant);
    }

    fitCameraToAllLeaves(instant = true) {
        this.fitCameraToLayoutBounds(instant);
    }

    fitCameraToVisible(instant = false) {
        if (!this.shouldAutoFrame()) return;
        if (this.fixedFrame) {
            // No camera work at event boundaries: the frame was set on load/resize/reset.
            return;
        }
        const active = new Set();
        for (const e of (this.events || []).slice(0, this.currentEventIndex + 1)) {
            for (const child of e.children) active.delete(child);
            active.add(e.path);
        }
        const box = new THREE.Box2();
        for (const path of active) {
            const r = this.dataLoader.clusters.get(path).rect;
            box.expandByPoint(new THREE.Vector2(r.x, r.y));
            box.expandByPoint(new THREE.Vector2(r.x + r.w, r.y + r.h));
        }
        if (box.isEmpty()) return;
        const center = box.getCenter(new THREE.Vector2()), size = box.getSize(new THREE.Vector2());
        this.applyCameraFrame(this.computePanelFraming(center.x, center.y, size.x, size.y), instant);
    }

    step(direction) {
        if (this.playback) return this.jumpTo(this.currentEventIndex + direction);
        // Manual stepping can interrupt a reveal or merge. Settle the current
        // frontier before starting another animation that uses the shared buffers.
        this.animationEngine.applyEventInstant(this.currentEventIndex);
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
        if (this.playback) {
            const seconds = index === 0 ? 0
                : index === this.events.length - 1 ? this.playback.duration : this.playbackPlan.ends[index];
            this.playback.seek(seconds, performance.now() / 1000);
        }
        this.currentEventIndex = index;
        this.animationEngine.applyEventInstant(index);
        this.refreshMatching(index, false);
        this.frustumEngine.syncToEventIndex(this.events, index);
        this.fitCameraToVisible();
        this.updateUI();
    }

    collapseToFinalView() {
        this.matchingCoordinator?.prioritize([]);
        this.finalViewActive = true;
        const sceneName = DATASETS[this.datasetKey]?.sceneName || 'the reconstruction';
        this.ui.eventLabel.textContent = `Assembled Reconstruction — ${sceneName}`;
        this.updateAnnotation();
    }

    undoFinalView() {
        this.finalViewActive = false;
    }

    reset() {
        this.playback?.pause(performance.now() / 1000);
        this.isPlaying = false;
        this.ui.playBtn.textContent = 'Play';
        // Resume auto-framing: Reset is the explicit "give the cinematic camera back"
        // action after the user has been driving manually.
        this.userCameraOverride = false;
        this.orbitControls.autoRotate = false;
        this.undoFinalView();
        this.animationEngine.hideTransitionClouds();
        this.animationEngine.activeAnimations = [];
        this.cameraEngine?.stopCameraPath();
        this.cameraEngine?.stopFlythrough();
        this.fitCameraToLayoutBounds(true);
        this.jumpTo(0);
    }

    /**
     * Coalesce rapid slider input into at most one re-layout per frame so dragging
     * the Cluster Gap / Fill sliders stays smooth.
     */
    scheduleRelayout() {
        if (this._relayoutQueued) return;
        this._relayoutQueued = true;
        requestAnimationFrame(() => {
            this._relayoutQueued = false;
            this.recomputeLayout();
        });
    }

    /**
     * Recompute the treemap with the current PADDING_FRAC / FIT_FRAC and re-apply the
     * current event state so new tile spacing takes effect live. Only the group
     * transforms change; the completed view uses the same plan as the build.
     */
    recomputeLayout() {
        if (!this.layoutEngine || !this.events || !this.events.length) return;
        // Restore original point positions before measuring (a reveal mutates geometry).
        this.animationEngine.applyEventInstant(this.currentEventIndex);
        this.layoutEngine.viewportAspect = this.usableViewportAspect();
        this.layoutEngine.computeLayout();
        this.convergenceEngine.prepareAllLeaves(this.animationEngine.getLeafClusters());
        this.layoutGuides?.rebuild();
        if (this.playback) this.seekPlayback(this.playback.update(performance.now() / 1000));
        else this.jumpTo(this.currentEventIndex);
        if (this.fixedFrame) this.fitCameraToLayoutBounds(true);
    }

    updatePlaybackClock() {
        if (!this.playback) return;
        const elapsed = this.playback.elapsed;
        const clock = this.playbackPlan.runClock(elapsed);
        const run = document.getElementById('run-clock');
        const progress = document.getElementById('playback-clock');
        const status = document.getElementById('clock-status');
        const setText = (element, text) => {
            if (element && element.textContent !== text) element.textContent = text;
        };
        setText(run, clock ? formatClock(clock.elapsed, true) : 'No timestamps');
        setText(progress, formatClock(elapsed, true, false) + ' / ' + formatClock(this.playback.duration, true, false));
        setText(status, elapsed >= this.playback.duration ? 'Complete'
            : !this.isPlaying ? 'Paused'
            : clock?.rate > 0 ? clock.rate.toFixed(1) + '×' + (clock.compressedIdle ? ' · idle gap compressed' : '')
            : 'Playing');
        if (this.ui.progressBar) this.ui.progressBar.style.width = (elapsed / this.playback.duration * 100) + '%';
    }

    refreshMatching(index = this.currentEventIndex, includeCurrent = true) {
        if (!this.matchingCoordinator || !this.playbackPlan) return;
        const unfinished = includeCurrent && this.playback.elapsed < this.playbackPlan.ends[index];
        this.matchingCoordinator.prioritize(matchingPriorities(this.events, this.playbackPlan, index, unfinished));
    }

    startScheduledEvent(index) {
        this.refreshMatching(index);
        this.animationEngine.applyEventInstant(index - 1);
        this.currentEventIndex = index;
        const duration = this.playbackPlan.animationDurations[index];
        if (duration > 0) {
            this.animationEngine.setSpeed(this.animationEngine.baseMergeDuration / duration);
            this.animationEngine.playEvent(index);
        } else {
            this.animationEngine.applyEventInstant(index);
        }
        for (const animation of this.animationEngine.activeAnimations) {
            animation.startTime = this.playbackPlan.starts[index] * 1000;
        }
        this.frustumEngine.syncToEventIndex(this.events, index);
        this.fitCameraToVisible();
        this.updateUI();
    }

    seekPlayback(seconds) {
        this.playback.seek(seconds, performance.now() / 1000);
        this.undoFinalView();
        this.startScheduledEvent(this.playbackPlan.indexAt(this.playback.elapsed));
        this.animationEngine.update(0);
        this.updatePlaybackClock();
    }

    advancePlayback(now) {
        if (!this.playback) return;
        this.playback.update(now);
        if (this.playback.elapsed >= this.playback.duration) {
            if (!this.finalViewActive) {
                this.currentEventIndex = this.events.length - 1;
                this.animationEngine.applyEventInstant(this.currentEventIndex);
                this.frustumEngine.syncToEventIndex(this.events, this.currentEventIndex);
                this.isPlaying = false;
                this.ui.playBtn.textContent = 'Play';
                this.updateUI();
                this.collapseToFinalView();
            }
        } else {
            const index = this.playbackPlan.indexAt(this.playback.elapsed);
            if (index !== this.currentEventIndex) this.startScheduledEvent(index);
        }
        this.updatePlaybackClock();
    }

    togglePlay() {
        if (!this.playback || !this.events.length) return;
        const now = performance.now() / 1000;
        if (this.isPlaying) {
            this.playback.pause(now);
            this.isPlaying = false;
        } else {
            if (this.playback.elapsed >= this.playback.duration) this.seekPlayback(0);
            this.refreshMatching();
            this.playback.play(now);
            this.isPlaying = true;
        }
        this.ui.playBtn.textContent = this.isPlaying ? 'Pause' : 'Play';
        this.updatePlaybackClock();
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
            const sceneName = (DATASETS[this.datasetKey] && DATASETS[this.datasetKey].sceneName) || 'the reconstruction';
            desc = `All ${leafCount} VGGT clusters merged through ${mergeCount} hierarchical merge operations into a complete 3D model of ${sceneName}.`;
        } else if (evt.isLeaf) {
            step = `VGGT Reconstruction ${leafsSoFar} of ${leafCount}`;
            title = `Cluster: ${evt.path.split('/').pop()}`;
            const parts = evt.path.split('/');
            const parentCluster = parts.length > 1 ? parts[0] : 'root';
            desc = `VGGT reconstructs a 3D point cloud from images assigned to partition ${parentCluster}. The reconstruction appears within its reserved region.`;
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
        
        const progress = count > 1 ? (this.currentEventIndex / (count - 1)) * 100 : 0;
        this.ui.progressBar.style.width = `${progress}%`;
        
        const event = this.events[this.currentEventIndex];
        const eventType = event.isLeaf ? 'Cluster' : 'Merge';
        let label = `Event ${this.currentEventIndex + 1}/${count}: ${eventType}`;
        if (this.showNodeLabels) label += ` — ${event.path}`;
        if (event.timestamp) {
            const d = new Date(event.timestamp * 1000);
            label += ` (${d.toLocaleTimeString()})`;
        }
        this.ui.eventLabel.textContent = label;
        this.updateAnnotation();
        this.updatePlaybackClock();
        
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

        // Kathir-style monospace HUD (run / stage / cameras / points).
        const hudRun = document.getElementById('hud-run');
        if (hudRun) {
            let visibleCameras = 0;
            if (this.frustumEngine) {
                for (const g of this.frustumEngine.frustumGroups.values()) {
                    if (g.visible) visibleCameras += (g.userData.cameraCount || 0);
                }
            }
            hudRun.textContent = (DATASETS[this.datasetKey] && DATASETS[this.datasetKey].label) || this.datasetKey;
            const stageEl = document.getElementById('hud-stage');
            if (stageEl) stageEl.textContent = `${this.currentEventIndex + 1} / ${this.events.length}`;
            const camEl = document.getElementById('hud-cameras');
            if (camEl) camEl.textContent = visibleCameras.toLocaleString();
            const ptEl = document.getElementById('hud-points');
            if (ptEl) ptEl.textContent = visiblePoints.toLocaleString();
        }

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

        if (this.flowMode) updateFlowTime(time);

        this.advancePlayback(time);

        if (this.cameraAnimTarget) {
            const elapsed = time - this.cameraAnimStart;
            const t = Math.min(elapsed / this.cameraAnimDuration, 1);
            const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

            this.setProjectionHeight(THREE.MathUtils.lerp(this.cameraAnimHeightFrom, this.cameraAnimHeightTo, e));
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
        this.layoutGuides?.update(this.camera, this.events, this.currentEventIndex, this.showLayoutGuides, this.showNodeLabels);
        this.composer.render();
    }
}

if (typeof document !== 'undefined') {
window.addEventListener('error', (e) => {
    console.error('UNCAUGHT:', e.message, 'at', e.filename + ':' + e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
    console.error('UNHANDLED PROMISE:', e.reason && e.reason.message ? e.reason.message : e.reason);
});

const app = new VGGTHierarchyApp();
window.app = app;
app.start();

}
