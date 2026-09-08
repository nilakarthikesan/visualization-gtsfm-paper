import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { VGGTDataLoader, DATASETS } from './data-loader-vggt.js?v=49';
import { SquarenessLayoutEngine } from './layout-engine-squareness.js?v=48';
import { InteractionEngine } from './interaction-engine.js?v=6';
import { SquarenessAnimationEngine } from './animation-engine-squareness.js?v=44';
import { CameraEngine } from './camera-engine.js?v=40';
import { updatePointScale, applyBlendMode, BLEND_MODES, updateFlowTime, setFlowParams, setPointSizeScale } from './point-material.js?v=46';
import { FrustumEngine } from './frustum-engine.js?v=38';
import { EDLPass } from './edl-pass.js?v=40';
import { ParticleEngine } from './particle-engine.js?v=40';
import { ConvergenceEngine } from './convergence-engine.js?v=42';

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
        // Flow-field prototype: ?flow=1 turns on the glowing points + curl drift
        // look (modeled after GPGPU flow-field particle demos) without changing
        // defaults for the main site.
        this.flowMode = new URLSearchParams(window.location.search).get('flow') === '1';
        this.blendMode = this.flowMode ? 'glow' : (localStorage.getItem('gh-blend-mode') || 'sharp');
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
        // Fixed-frame ("lock the whole build") camera: instead of the camera chasing
        // the growing visible set event-by-event, frame the ENTIRE final floorplan
        // once and hold it. This is the area-universal / slicing-floorplan behavior -
        // clusters appear in their final cells and merges fuse adjacent cells in
        // place, so there is essentially no camera motion during the build (only the
        // finale collapse moves). Default ON (it's the math we're trying); toggleable.
        this.fixedFrame = localStorage.getItem('gh-fixed-frame') !== 'false';
        try {
            const p = new URLSearchParams(window.location.search);
            const c = p.get('camera');
            if (c === 'fixed') this.fixedFrame = true;
            else if (c === 'follow') this.fixedFrame = false;
        } catch (e) { /* non-browser */ }
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
            const index = Math.floor(pct * this.animationEngine.mergeEvents.length);
            this.jumpTo(index);
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
        
            for (const cluster of clusters.values()) {
                this.worldGroup.add(cluster.group);
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
            this.layoutEngine.computeLayout();

            this.convergenceEngine = new ConvergenceEngine();

            this.animationEngine = new SquarenessAnimationEngine(clusters, this.layoutEngine, this.worldGroup);
            this.animationEngine.convergenceEngine = this.convergenceEngine;
            if (this.flowMode) this.animationEngine.setFlowEnabled(true);
            this.animationEngine.initTransitionBuffers(this.blendMode, this.isDark);
            this.events = this.animationEngine.initTimeline();
            this.currentEventIndex = 0;

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

            if (this.fixedFrame) this.fitCameraToLayoutBounds(true);
            else this.fitCameraToAllLeaves(true);

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

    /**
     * Whether the camera may auto-frame right now. False when the user turned the
     * Auto-Frame toggle off, or when they have manually grabbed the camera (until
     * Reset). Geometry assembly is never gated on this - only camera moves are.
     */
    shouldAutoFrame() {
        return this.autoFrameEnabled && !this.userCameraOverride;
    }

    /**
     * Panel-aware top-down (+Z) framing of the XY box centered at (cx, cy) with the
     * given world width/height. Reserves the horizontal band covered by the fixed
     * Visual Settings panel so clusters are never drawn behind it: it zooms out just
     * enough that the model fills only the visible (1 - frac) width, then shifts the
     * aim so the model sits centered in that visible band. When the panel is hidden
     * (embed mode) or collapsed to nothing, frac = 0 and this is a plain centered fit.
     */
    computePanelFraming(cx, cy, width, height, margin, minDist = 8) {
        const aspect = window.innerWidth / window.innerHeight;
        const vFovRad = THREE.MathUtils.degToRad(this.camera.fov / 2);
        const hFovRad = Math.atan(aspect * Math.tan(vFovRad));

        let frac = 0;
        const el = document.getElementById('visual-settings');
        if (el && el.offsetParent !== null && getComputedStyle(el).display !== 'none') {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && window.innerWidth > 0) {
                // Panel width plus its right margin, capped so we never reserve an
                // absurd amount on very narrow windows.
                frac = Math.min(0.45, (r.width + 40) / window.innerWidth);
            }
        }

        const effWidth = frac > 0 ? width / (1 - frac) : width;
        const distForHeight = (height / 2) / Math.tan(vFovRad);
        const distForWidth = (effWidth / 2) / Math.tan(hFovRad);
        let dist = Math.max(distForHeight, distForWidth) * margin;
        dist = Math.max(dist, minDist);

        // Move the aim right by half the reserved band so the model centers in the
        // open (left) region rather than under the panel.
        const frameWorldWidth = 2 * dist * Math.tan(hFovRad);
        const aimX = cx + (frac > 0 ? (frac / 2) * frameWorldWidth : 0);

        return {
            pos: new THREE.Vector3(aimX, cy, dist),
            look: new THREE.Vector3(aimX, cy, 0),
            dist
        };
    }

    fitCameraToVisible(instant = false) {
        if (!this.shouldAutoFrame()) return;
        // Fixed-frame mode: never chase the visible set event-by-event. The whole
        // floorplan is already framed (set on start / on toggle), and the finale is
        // handled by collapseToFinalView, so the camera stays put through the build.
        if (this.fixedFrame) return;
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
                const s = cluster.fitScale || 1;
                const hp = cluster.hierarchyPosition;
                if (!hp) continue;
                // Near-full envelope so the WHOLE assembled model stays in frame
                // (user: see all the points); matches collapseToFinalView framing.
                const ext = this.computeRobustExtent(cluster, s, VGGTHierarchyApp.FINAL_PCTS);
                if (ext) {
                    minX = Math.min(minX, hp.x + ext.cx - ext.halfW);
                    maxX = Math.max(maxX, hp.x + ext.cx + ext.halfW);
                    minY = Math.min(minY, hp.y + ext.cy - ext.halfH);
                    maxY = Math.max(maxY, hp.y + ext.cy + ext.halfH);
                    found = true;
                } else {
                    const geom = cluster.pointCloud.geometry;
                    geom.computeBoundingBox();
                    const box = geom.boundingBox;
                    if (!box) continue;
                    minX = Math.min(minX, hp.x + box.min.x * s);
                    maxX = Math.max(maxX, hp.x + box.max.x * s);
                    minY = Math.min(minY, hp.y + box.min.y * s);
                    maxY = Math.max(maxY, hp.y + box.max.y * s);
                    found = true;
                }
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

        // Tighter framing so the visible clusters fill the frame at every step
        // (user wanted clusters to take up more space as they are placed). Panel-aware
        // so nothing hides behind the Visual Settings panel.
        const margin = isFinalEvent ? VGGTHierarchyApp.FINAL_MARGIN : 1.02;
        const framing = this.computePanelFraming(centerX, centerY, width, height, margin);
        const targetPos = framing.pos;
        const targetLookAt = framing.look;

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
        if (!this.shouldAutoFrame()) return;
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

        const framing = this.computePanelFraming(centerX, centerY, width, height, 1.05);
        const targetPos = framing.pos;
        const targetLookAt = framing.look;

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

    /**
     * Frame the ENTIRE final floorplan once and hold it (fixed-frame mode). The
     * layout bounds already span every cluster's final cell, so holding this frame
     * means clusters simply appear in place and merges fuse adjacent cells with no
     * camera motion - the area-universal / slicing-floorplan behavior we're trying.
     */
    /**
     * Union of every cluster's ACTUAL world-space XY extent (its group position plus
     * its fitScale-scaled point bounding box). We frame to this rather than the tile
     * rectangles, because tiles are only filled to FIT_FRAC (82%) - a cluster's
     * sparse tail extends past its tile, and an edge cluster's tail would otherwise
     * clip at the frame edge. Framing the real content guarantees every cluster (and
     * its points) stays fully on screen.
     */
    computeLayoutContentBounds() {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const c of this.dataLoader.clusters.values()) {
            const g = c.pointCloud && c.pointCloud.geometry;
            if (!g || !c.hierarchyPosition) continue;
            // Per-cluster robust extent (drops each cluster's sparse flier tail) so one
            // stray point can't force a big zoom-out that shrinks every dense cluster.
            // Brussels had a cluster whose fliers reached x=-1005 while its dense mass
            // ended near -409; trimming keeps framing hugged to what you can actually see.
            const ext = this.computeRobustExtent(c, c.fitScale || 1);
            if (!ext) continue;
            const px = c.hierarchyPosition.x, py = c.hierarchyPosition.y;
            minX = Math.min(minX, px + ext.cx - ext.halfW);
            maxX = Math.max(maxX, px + ext.cx + ext.halfW);
            minY = Math.min(minY, py + ext.cy - ext.halfH);
            maxY = Math.max(maxY, py + ext.cy + ext.halfH);
        }
        if (minX === Infinity) return null;
        return { minX, maxX, minY, maxY };
    }

    fitCameraToLayoutBounds(instant = false) {
        if (!this.shouldAutoFrame()) return;
        // Prefer the real content extent (keeps every cluster's points on screen);
        // fall back to the tile bounds only if geometry isn't ready yet.
        const b = this.computeLayoutContentBounds() || (this.layoutEngine && this.layoutEngine.bounds);
        if (!b) return;

        const pad = 2;
        const width = (b.maxX - b.minX) + pad;
        const height = (b.maxY - b.minY) + pad;
        const centerX = (b.minX + b.maxX) / 2;
        const centerY = (b.minY + b.maxY) / 2;

        // Comfortable margin so clusters never touch the frame edge.
        const framing = this.computePanelFraming(centerX, centerY, width, height, 1.08);
        if (instant) {
            this.camera.position.copy(framing.pos);
            this.camera.lookAt(framing.look);
            this.orbitControls.target.copy(framing.look);
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

    /**
     * Robust screen-plane (XY) extent of a cluster's cloud using percentiles, so the
     * diffuse halo of stray outlier points does NOT inflate the box (which was making
     * the camera zoom out and the dense building read small at the final view). Y uses
     * a looser top percentile so the iconic tower/spire tip is not cropped. Returns
     * center + half-width/height already multiplied by `scale`.
     */
    computeRobustExtent(cluster, scale = 1.0, pcts = null) {
        const geom = cluster.pointCloud && cluster.pointCloud.geometry;
        if (!geom || !geom.attributes.position) return null;
        const pos = geom.attributes.position;
        const n = pos.count;
        if (n === 0) return null;

        const maxSamples = 40000;
        const stepN = Math.max(1, Math.floor(n / maxSamples));
        const xs = [], ys = [];
        for (let i = 0; i < n; i += stepN) {
            xs.push(pos.getX(i));
            ys.push(pos.getY(i));
        }
        xs.sort((a, b) => a - b);
        ys.sort((a, b) => a - b);
        const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))];
        // Percentile trims are parameterizable. Default trims the diffuse ~2% halo on
        // X and bottom Y (keeps the tall tower). The final view passes a near-full
        // envelope so EVERY point stays on screen (user: "see all the points").
        const p = pcts || { xlo: 0.02, xhi: 0.98, ylo: 0.02, yhi: 0.995 };
        const xlo = q(xs, p.xlo), xhi = q(xs, p.xhi);
        const ylo = q(ys, p.ylo), yhi = q(ys, p.yhi);
        return {
            cx: ((xlo + xhi) / 2) * scale,
            cy: ((ylo + yhi) / 2) * scale,
            halfW: Math.max(((xhi - xlo) / 2) * scale, 1e-3),
            halfH: Math.max(((yhi - ylo) / 2) * scale, 1e-3)
        };
    }

    // Near-full envelope for the FINAL assembled view: keep 99.9% of points on each
    // tail (drops only the most extreme stray fliers so one bad point can't shrink
    // the model), so the whole reconstruction - spire tip to base - stays in frame.
    static FINAL_PCTS = { xlo: 0.001, xhi: 0.999, ylo: 0.001, yhi: 0.999 };
    // Comfortable air around the final model so nothing touches the frame edge.
    static FINAL_MARGIN = 1.08;

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

        // Near-full envelope at final world scale (1.0): keep 99.9% of points on each
        // tail so the ENTIRE assembled model - spire tip to base - stays on screen
        // (user: "see all the points and the full visualization"), while a couple of
        // extreme stray fliers can't shrink the model. Center that envelope at the
        // origin by offsetting the end position, then frame it with comfortable air.
        const ext = this.computeRobustExtent(cluster, 1.0, VGGTHierarchyApp.FINAL_PCTS)
            || { cx: 0, cy: 0, halfW: (box.max.x - box.min.x) / 2, halfH: (box.max.y - box.min.y) / 2 };

        const s = this.finalViewOrigScale;

        this.finalViewAnim = {
            startTime: performance.now() / 1000,
            duration: 1.5,
            startPos: cluster.group.position.clone(),
            endPos: new THREE.Vector3(-ext.cx, -ext.cy, 0),
            startScale: s,
            endScale: 1.0,
            cluster
        };

        // Tight final framing so the assembled model fills the screen (user wanted
        // the final reconstruction to read large). The cluster was offset by
        // (-ext.cx, -ext.cy) above so its robust center is at the origin; frame that
        // box, panel-aware so the model isn't hidden behind the Visual Settings panel.
        // Only snap the camera if the user hasn't taken manual control (respect-manual):
        // the geometry above always assembles, but we leave their view alone if they moved.
        if (this.shouldAutoFrame()) {
            const framing = this.computePanelFraming(0, 0, ext.halfW * 2, ext.halfH * 2, VGGTHierarchyApp.FINAL_MARGIN);
            this.cameraAnimTarget = framing.pos;
            this.cameraAnimLookAt = framing.look;
            this.cameraAnimDuration = 1.5;
            this.cameraAnimStart = performance.now() / 1000;
            this.cameraAnimFrom = this.camera.position.clone();
            this.cameraAnimLookFrom = this.orbitControls.target.clone();
        }

        const sceneName = (DATASETS[this.datasetKey] && DATASETS[this.datasetKey].sceneName) || 'the reconstruction';
        this.ui.eventLabel.textContent = `Assembled Reconstruction — ${sceneName}`;
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
        // Resume auto-framing: Reset is the explicit "give the cinematic camera back"
        // action after the user has been driving manually.
        this.userCameraOverride = false;
        this.undoFinalView();
        this.animationEngine.hideTransitionClouds();
        this.animationEngine.activeAnimations = [];
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
     * transforms change (no geometry rebuild). Skipped while collapsed to the single
     * final model, where tiling is irrelevant.
     */
    recomputeLayout() {
        if (!this.layoutEngine || !this.events || !this.events.length) return;
        if (this.finalViewActive) return;
        // buildTree() appends to treeNodes, so clear it before recomputing to avoid
        // accumulating duplicate nodes across runs.
        this.layoutEngine.treeNodes = [];
        this.layoutEngine.computeLayout();
        this.jumpTo(this.currentEventIndex);
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
            const sceneName = (DATASETS[this.datasetKey] && DATASETS[this.datasetKey].sceneName) || 'the reconstruction';
            desc = `All ${leafCount} VGGT clusters merged through ${mergeCount} hierarchical merge operations into a complete 3D model of ${sceneName}.`;
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
            const delay = nextEvent && nextEvent.delay ? nextEvent.delay : 0.12;
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
