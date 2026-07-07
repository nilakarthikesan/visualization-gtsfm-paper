import * as THREE from 'three';

const PARTICLE_COUNT = 200;
const PARTICLE_LIFE = 1.8;
const FADE_IN = 0.3;
const FADE_OUT = 0.5;

export class ParticleEngine {
    constructor(worldGroup) {
        this.worldGroup = worldGroup;
        this.enabled = false;
        this.activeEffect = null;

        const geom = new THREE.BufferGeometry();
        const positions = new Float32Array(PARTICLE_COUNT * 3);
        const alphas = new Float32Array(PARTICLE_COUNT);
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geom.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
        geom.setDrawRange(0, PARTICLE_COUNT);

        this.material = new THREE.ShaderMaterial({
            uniforms: {
                uSize: { value: 3.0 },
                uScale: { value: window.innerHeight * 0.5 },
                uColor: { value: new THREE.Color(1, 1, 1) }
            },
            vertexShader: `
                uniform float uSize;
                uniform float uScale;
                attribute float alpha;
                varying float vAlpha;
                void main() {
                    vAlpha = alpha;
                    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                    gl_PointSize = uSize * (uScale / -mvPosition.z);
                    gl_PointSize = clamp(gl_PointSize, 1.0, 8.0);
                    gl_Position = projectionMatrix * mvPosition;
                }
            `,
            fragmentShader: `
                uniform vec3 uColor;
                varying float vAlpha;
                void main() {
                    float dist = length(gl_PointCoord - vec2(0.5));
                    if (dist > 0.5) discard;
                    float soft = smoothstep(0.5, 0.1, dist);
                    gl_FragColor = vec4(uColor, soft * vAlpha);
                }
            `,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });

        this.particles = new THREE.Points(geom, this.material);
        this.particles.frustumCulled = false;
        this.particles.visible = false;
        this.worldGroup.add(this.particles);

        this.velocities = new Float32Array(PARTICLE_COUNT * 3);
        this.phases = new Float32Array(PARTICLE_COUNT);
        for (let i = 0; i < PARTICLE_COUNT; i++) {
            this.phases[i] = Math.random() * Math.PI * 2;
        }
    }

    setTheme(isDark) {
        this.material.uniforms.uColor.value.set(isDark ? 0xccddff : 0x888888);
    }

    trigger(mergeCenter, mergeRadius) {
        if (!this.enabled) return;

        const positions = this.particles.geometry.attributes.position.array;
        const alphas = this.particles.geometry.attributes.alpha.array;
        const r = mergeRadius * 0.6;

        for (let i = 0; i < PARTICLE_COUNT; i++) {
            const i3 = i * 3;
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);
            const dist = r * (0.3 + Math.random() * 0.7);

            positions[i3] = mergeCenter.x + dist * Math.sin(phi) * Math.cos(theta);
            positions[i3 + 1] = mergeCenter.y + dist * Math.sin(phi) * Math.sin(theta);
            positions[i3 + 2] = mergeCenter.z + dist * Math.cos(phi);

            const toCenter = new THREE.Vector3(
                mergeCenter.x - positions[i3],
                mergeCenter.y - positions[i3 + 1],
                mergeCenter.z - positions[i3 + 2]
            ).normalize().multiplyScalar(r * 0.15);

            this.velocities[i3] = toCenter.x + (Math.random() - 0.5) * r * 0.05;
            this.velocities[i3 + 1] = toCenter.y + (Math.random() - 0.5) * r * 0.05;
            this.velocities[i3 + 2] = toCenter.z + (Math.random() - 0.5) * r * 0.05;

            alphas[i] = 0;
        }

        this.particles.geometry.attributes.position.needsUpdate = true;
        this.particles.geometry.attributes.alpha.needsUpdate = true;
        this.particles.visible = true;

        this.activeEffect = {
            startTime: performance.now(),
            duration: PARTICLE_LIFE * 1000,
            center: mergeCenter.clone()
        };
    }

    update() {
        if (!this.activeEffect) return;

        const elapsed = (performance.now() - this.activeEffect.startTime) / 1000;
        if (elapsed >= PARTICLE_LIFE) {
            this.particles.visible = false;
            this.activeEffect = null;
            return;
        }

        const positions = this.particles.geometry.attributes.position.array;
        const alphas = this.particles.geometry.attributes.alpha.array;
        const dt = 0.016;

        let alpha;
        if (elapsed < FADE_IN) {
            alpha = elapsed / FADE_IN;
        } else if (elapsed > PARTICLE_LIFE - FADE_OUT) {
            alpha = (PARTICLE_LIFE - elapsed) / FADE_OUT;
        } else {
            alpha = 1.0;
        }

        for (let i = 0; i < PARTICLE_COUNT; i++) {
            const i3 = i * 3;
            const wobble = Math.sin(elapsed * 3 + this.phases[i]) * 0.02;

            positions[i3] += (this.velocities[i3] + wobble) * dt;
            positions[i3 + 1] += (this.velocities[i3 + 1] + wobble) * dt;
            positions[i3 + 2] += (this.velocities[i3 + 2] + wobble) * dt;

            alphas[i] = alpha * (0.3 + 0.7 * Math.sin(elapsed * 2 + this.phases[i]) * 0.5 + 0.5);
        }

        this.particles.geometry.attributes.position.needsUpdate = true;
        this.particles.geometry.attributes.alpha.needsUpdate = true;
    }

    dispose() {
        this.particles.geometry.dispose();
        this.material.dispose();
        this.worldGroup.remove(this.particles);
    }
}
