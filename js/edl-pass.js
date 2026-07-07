import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export class EDLPass extends Pass {
    constructor(scene, camera, resolution) {
        super();

        this.scene = scene;
        this.camera = camera;
        this.enabled = true;

        this.edlStrength = 0.7;
        this.edlRadius = 1.4;

        const res = resolution || new THREE.Vector2(window.innerWidth, window.innerHeight);

        this.depthTarget = new THREE.WebGLRenderTarget(res.x, res.y, {
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            type: THREE.FloatType
        });
        this.depthTarget.depthTexture = new THREE.DepthTexture();
        this.depthTarget.depthTexture.type = THREE.UnsignedIntType;

        this.edlMaterial = new THREE.ShaderMaterial({
            uniforms: {
                tDiffuse: { value: null },
                tDepth: { value: null },
                uEdlStrength: { value: this.edlStrength },
                uEdlRadius: { value: this.edlRadius },
                uResolution: { value: res.clone() },
                uCameraNear: { value: camera.near },
                uCameraFar: { value: camera.far }
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
                uniform sampler2D tDepth;
                uniform float uEdlStrength;
                uniform float uEdlRadius;
                uniform vec2 uResolution;
                uniform float uCameraNear;
                uniform float uCameraFar;
                varying vec2 vUv;

                float readDepth(vec2 coord) {
                    float fragCoordZ = texture2D(tDepth, coord).x;
                    float viewZ = (uCameraNear * uCameraFar) / (uCameraFar - fragCoordZ * (uCameraFar - uCameraNear));
                    return viewZ;
                }

                float sampleEdl(vec2 center, float logDepth, vec2 offset) {
                    float neighbor = readDepth(center + offset);
                    if (neighbor >= uCameraFar * 0.99) return 0.0;
                    return max(0.0, logDepth - log2(neighbor));
                }

                void main() {
                    vec4 color = texture2D(tDiffuse, vUv);
                    float depth = readDepth(vUv);

                    if (depth >= uCameraFar * 0.99) {
                        gl_FragColor = color;
                        return;
                    }

                    float logDepth = log2(depth);
                    vec2 texelSize = uEdlRadius / uResolution;

                    float sum = 0.0;
                    sum += sampleEdl(vUv, logDepth, vec2( texelSize.x,  0.0));
                    sum += sampleEdl(vUv, logDepth, vec2(-texelSize.x,  0.0));
                    sum += sampleEdl(vUv, logDepth, vec2( 0.0,  texelSize.y));
                    sum += sampleEdl(vUv, logDepth, vec2( 0.0, -texelSize.y));

                    float diag = 0.707;
                    sum += sampleEdl(vUv, logDepth, vec2( texelSize.x,  texelSize.y) * diag) * 0.7;
                    sum += sampleEdl(vUv, logDepth, vec2(-texelSize.x,  texelSize.y) * diag) * 0.7;
                    sum += sampleEdl(vUv, logDepth, vec2( texelSize.x, -texelSize.y) * diag) * 0.7;
                    sum += sampleEdl(vUv, logDepth, vec2(-texelSize.x, -texelSize.y) * diag) * 0.7;

                    sum += sampleEdl(vUv, logDepth, vec2( texelSize.x * 2.0,  0.0)) * 0.4;
                    sum += sampleEdl(vUv, logDepth, vec2(-texelSize.x * 2.0,  0.0)) * 0.4;
                    sum += sampleEdl(vUv, logDepth, vec2( 0.0,  texelSize.y * 2.0)) * 0.4;
                    sum += sampleEdl(vUv, logDepth, vec2( 0.0, -texelSize.y * 2.0)) * 0.4;

                    sum /= 9.6;

                    float shade = exp(-sum * uEdlStrength * 300.0);
                    shade = mix(shade, 1.0, 0.15);
                    gl_FragColor = vec4(color.rgb * shade, color.a);
                }
            `
        });

        this.fsQuad = new FullScreenQuad(this.edlMaterial);
    }

    setSize(width, height) {
        this.depthTarget.setSize(width, height);
        this.edlMaterial.uniforms.uResolution.value.set(width, height);
    }

    render(renderer, writeBuffer, readBuffer) {
        if (!this.enabled) {
            if (this.renderToScreen) {
                renderer.setRenderTarget(null);
                this.fsQuad.material = new THREE.MeshBasicMaterial({ map: readBuffer.texture });
                this.fsQuad.render(renderer);
            }
            return;
        }

        this.edlMaterial.uniforms.uCameraNear.value = this.camera.near;
        this.edlMaterial.uniforms.uCameraFar.value = this.camera.far;

        renderer.setRenderTarget(this.depthTarget);
        renderer.render(this.scene, this.camera);

        this.edlMaterial.uniforms.tDiffuse.value = readBuffer.texture;
        this.edlMaterial.uniforms.tDepth.value = this.depthTarget.depthTexture;
        this.edlMaterial.uniforms.uEdlStrength.value = this.edlStrength;
        this.edlMaterial.uniforms.uEdlRadius.value = this.edlRadius;

        if (this.renderToScreen) {
            renderer.setRenderTarget(null);
        } else {
            renderer.setRenderTarget(writeBuffer);
        }
        this.fsQuad.render(renderer);
    }

    dispose() {
        this.depthTarget.dispose();
        this.edlMaterial.dispose();
        this.fsQuad.dispose();
    }
}
