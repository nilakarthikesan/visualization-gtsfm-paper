import * as THREE from 'three';

const sharedUniforms = {
    uScale: { value: window.innerHeight * window.devicePixelRatio * 0.5 }
};

export function updatePointScale() {
    sharedUniforms.uScale.value = window.innerHeight * window.devicePixelRatio * 0.5;
}

export const BLEND_MODES = {
    splat: { label: 'Gaussian Splat', pointSize: 18.0, maxSize: 50.0 },
    sharp: { label: 'Sharp Dense', pointSize: 6.0, maxSize: 20.0 },
    glow:  { label: 'Glowing Particles', pointSize: 14.0, maxSize: 40.0 }
};

const VERTEX_SHADER = `
    uniform float uPointSize;
    uniform float uScale;
    uniform float uMaxSize;
    attribute vec3 color;
    varying vec3 vColor;
    void main() {
        vColor = color;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uPointSize * (uScale / -mvPosition.z);
        gl_PointSize = clamp(gl_PointSize, 1.5, uMaxSize);
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
            float alpha = smoothstep(0.5, 0.42, dist) * uOpacity;
            gl_FragColor = vec4(vColor, alpha);
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
    const size = pointSize !== undefined ? pointSize : config.pointSize;
    const blend = getBlendConfig(blendMode, isDark);

    return new THREE.ShaderMaterial({
        uniforms: {
            uPointSize: { value: size },
            uOpacity: { value: opacity },
            uScale: sharedUniforms.uScale,
            uMaxSize: { value: config.maxSize }
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
    material.uniforms.uPointSize.value = config.pointSize;
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
