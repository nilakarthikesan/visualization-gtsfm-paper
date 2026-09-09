import * as THREE from 'three';

// Contain the tails outside the 95% fit, as well as point-sprite edges and
// line/particle effects. Source geometry is preserved for manual 3D inspection.
export function bindRegionClip(object, getRegion) {
    const material = object.material;
    const uniforms = {
        uRegionClip: { value: new THREE.Vector4() },
        uRegionClipEnabled: { value: 0 }
    };
    material.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, uniforms);
        shader.fragmentShader = `uniform vec4 uRegionClip;
            uniform float uRegionClipEnabled;\n` + shader.fragmentShader.replace('void main() {', `void main() {
            if (uRegionClipEnabled > 0.5 &&
                (gl_FragCoord.x < uRegionClip.x || gl_FragCoord.y < uRegionClip.y ||
                 gl_FragCoord.x > uRegionClip.z || gl_FragCoord.y > uRegionClip.w)) discard;`);
    };
    material.customProgramCacheKey = () => 'region-clip-v1';
    material.needsUpdate = true;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), direction = new THREE.Vector3();
    const viewport = new THREE.Vector4();
    object.onBeforeRender = (renderer, scene, camera) => {
        const r = getRegion();
        // A manually orbited view is for 3D inspection, outside the planned projection.
        const front = camera.isOrthographicCamera && camera.getWorldDirection(direction).z < -0.99999;
        uniforms.uRegionClipEnabled.value = r && front ? 1 : 0;
        if (!r || !front) return;
        a.set(r.x, r.y, 0).project(camera);
        b.set(r.x + r.w, r.y + r.h, 0).project(camera);
        renderer.getCurrentViewport(viewport);
        uniforms.uRegionClip.value.set(
            viewport.x + (a.x + 1) * viewport.z / 2,
            viewport.y + (a.y + 1) * viewport.w / 2,
            viewport.x + (b.x + 1) * viewport.z / 2,
            viewport.y + (b.y + 1) * viewport.w / 2
        );
    };
}
