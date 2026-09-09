import * as THREE from 'three';

const sharedUniforms = {
    uScale: { value: window.innerHeight * window.devicePixelRatio * 0.5 },
    // Flow-field drift: a gentle, always-on curl-like motion so the points
    // read as "alive" and mesh together smoothly (modeled after GPGPU flow
    // field particle demos). Sampled in world space so neighboring points move
    // coherently; applied in view space so amplitude is scale-consistent.
    uTime: { value: 0 },
    uFlowAmp: { value: 0.0 },     // world-unit amplitude of the idle drift
    uFlowFreq: { value: 0.35 },   // spatial frequency of the field
    uFlowSpeed: { value: 0.5 }    // temporal speed
};

export function updatePointScale() {
    sharedUniforms.uScale.value = window.innerHeight * window.devicePixelRatio * 0.5;
}

// Global multiplier on every point's base size. Sparse "sampled" clouds want
// big points to read as surfaces; dense "fine" optimization clouds (Kathir's
// data) want small points so detail isn't lost under fat blobs. Set per dataset
// (DATASETS[key].pointScale) and tunable live via window.setPointSizeScale().
let pointSizeScale = 1.0;

export function setPointSizeScale(scale) {
    pointSizeScale = (typeof scale === 'number' && scale > 0) ? scale : 1.0;
}

export function getPointSizeScale() {
    return pointSizeScale;
}

export function updateFlowTime(seconds) {
    sharedUniforms.uTime.value = seconds;
}

export function setFlowParams({ amp, freq, speed } = {}) {
    if (amp !== undefined) sharedUniforms.uFlowAmp.value = amp;
    if (freq !== undefined) sharedUniforms.uFlowFreq.value = freq;
    if (speed !== undefined) sharedUniforms.uFlowSpeed.value = speed;
}

export function getFlowParams() {
    return {
        amp: sharedUniforms.uFlowAmp.value,
        freq: sharedUniforms.uFlowFreq.value,
        speed: sharedUniforms.uFlowSpeed.value
    };
}

export const BLEND_MODES = {
    splat: { label: 'Gaussian Splat', pointSize: 18.0, maxSize: 50.0 },
    // Sharp is the default "Kathir" look: fine points. The maxSize ceiling is the
    // key lever for fineness (perspective sizing otherwise clamps points fat).
    sharp: { label: 'Sharp Dense', pointSize: 4.0, maxSize: 9.0 },
    glow:  { label: 'Glowing Particles', pointSize: 14.0, maxSize: 40.0 }
};

const VERTEX_SHADER = `
    uniform float uPointSize;
    uniform float uScale;
    uniform float uMaxSize;
    uniform float uTime;
    uniform float uFlowAmp;
    uniform float uFlowFreq;
    uniform float uFlowSpeed;
    attribute vec3 color;
    varying vec3 vColor;

    // Cheap, smooth, continuous pseudo-curl flow (sum of sines). Sampled from
    // world position so nearby points share motion and appear to flow together.
    vec3 flowField(vec3 wp) {
        vec3 p = wp * uFlowFreq;
        float t = uTime * uFlowSpeed;
        return vec3(
            sin(p.y + t)       + sin(p.z * 1.3 + t * 0.7),
            sin(p.z + t * 1.1) + sin(p.x * 1.3 + t * 0.9),
            sin(p.x + t * 1.3) + sin(p.y * 1.3 + t * 0.6)
        );
    }

    void main() {
        vColor = color;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        if (uFlowAmp > 0.0001) {
            mvPosition.xyz += flowField(worldPos.xyz) * uFlowAmp;
        }
        bool perspective = projectionMatrix[2][3] == -1.0;
        float sizeScale = perspective ? 1.0 / -mvPosition.z : projectionMatrix[1][1] * 0.577350269;
        gl_PointSize = uPointSize * uScale * sizeScale;
        // Allow points to shrink well below the old 1.5px floor so dense fine
        // clouds keep their detail instead of blooming into fat discs.
        gl_PointSize = clamp(gl_PointSize, 0.75, uMaxSize);
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const FRAGMENT_SHADERS = {
    splat: `
        uniform float uOpacity;
        varying vec3 vColor;
        void main() {
            float dist = length(gl_PointCoord - vec2(0.5));
            if (dist > 0.5) discard;
            float alpha = exp(-dist * dist * 2.0) * uOpacity;
            gl_FragColor = vec4(vColor, alpha);
        }
    `,
    sharp: `
        uniform float uOpacity;
        varying vec3 vColor;
        void main() {
            float dist = length(gl_PointCoord - vec2(0.5));
            if (dist > 0.5) discard;
            // Hard-edged solid disc: every pixel out to the rim is the point's
            // OWN color at full opacity, with no alpha fade. The previous 1px
            // antialiased rim faded alpha toward 0 at the edge, which on a light
            // background blended to white and read as a white ring around every
            // point (Frank's feedback). Turning the fade off makes the edge the
            // same color as the point.
            gl_FragColor = vec4(vColor, uOpacity);
        }
    `,
    glow: `
        uniform float uOpacity;
        varying vec3 vColor;
        void main() {
            float dist = length(gl_PointCoord - vec2(0.5));
            if (dist > 0.5) discard;
            float core = smoothstep(0.18, 0.0, dist);
            float halo = exp(-dist * dist * 3.0) * 0.45;
            float alpha = min(core + halo, 1.0) * uOpacity;
            gl_FragColor = vec4(vColor * alpha, alpha);
        }
    `
};

function getBlendConfig(mode, isDark) {
    if (mode === 'glow' && isDark) {
        return {
            blending: THREE.CustomBlending,
            blendSrc: THREE.SrcAlphaFactor,
            blendDst: THREE.OneFactor,
            blendSrcAlpha: THREE.OneFactor,
            blendDstAlpha: THREE.OneMinusSrcAlphaFactor
        };
    }
    if (mode === 'glow') {
        return {
            blending: THREE.CustomBlending,
            blendSrc: THREE.OneFactor,
            blendDst: THREE.OneMinusSrcAlphaFactor,
            blendSrcAlpha: THREE.OneFactor,
            blendDstAlpha: THREE.OneMinusSrcAlphaFactor
        };
    }
    return {
        blending: THREE.NormalBlending,
        blendSrc: THREE.SrcAlphaFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneMinusSrcAlphaFactor
    };
}

export function createPointMaterial({ opacity = 1.0, pointSize, depthWrite = true, blendMode = 'splat', isDark = false } = {}) {
    const config = BLEND_MODES[blendMode] || BLEND_MODES.splat;
    const size = (pointSize !== undefined ? pointSize : config.pointSize) * pointSizeScale;
    const blend = getBlendConfig(blendMode, isDark);

    return new THREE.ShaderMaterial({
        uniforms: {
            uPointSize: { value: size },
            uOpacity: { value: opacity },
            uScale: sharedUniforms.uScale,
            uMaxSize: { value: config.maxSize },
            uTime: sharedUniforms.uTime,
            uFlowAmp: sharedUniforms.uFlowAmp,
            uFlowFreq: sharedUniforms.uFlowFreq,
            uFlowSpeed: sharedUniforms.uFlowSpeed
        },
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADERS[blendMode] || FRAGMENT_SHADERS.splat,
        transparent: true,
        depthWrite: depthWrite,
        ...blend
    });
}

export function applyBlendMode(material, blendMode, isDark = false) {
    const config = BLEND_MODES[blendMode] || BLEND_MODES.splat;
    const blend = getBlendConfig(blendMode, isDark);

    material.fragmentShader = FRAGMENT_SHADERS[blendMode] || FRAGMENT_SHADERS.splat;
    material.uniforms.uPointSize.value = config.pointSize * pointSizeScale;
    if (!material.uniforms.uMaxSize) {
        material.uniforms.uMaxSize = { value: config.maxSize };
        material.vertexShader = VERTEX_SHADER;
    } else {
        material.uniforms.uMaxSize.value = config.maxSize;
    }
    material.blending = blend.blending;
    material.blendSrc = blend.blendSrc;
    material.blendDst = blend.blendDst;
    material.blendSrcAlpha = blend.blendSrcAlpha;
    material.blendDstAlpha = blend.blendDstAlpha;
    material.needsUpdate = true;
}
