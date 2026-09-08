import * as THREE from 'three';

export class InteractionEngine {
    constructor(camera, domElement, clusters, orbitControls) {
        this.camera = camera;
        this.domElement = domElement;
        this.clusters = clusters;
        this.orbitControls = orbitControls;
        this.raycaster = new THREE.Raycaster();
        this.raycaster.params.Points.threshold = 2;
        this.mouse = new THREE.Vector2();
        this.hoveredCluster = null;

        this.domElement.addEventListener('mousemove', (e) => this.onMouseMove(e));
    }

    onMouseMove(event) {
        this.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    }

    update() {
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const pointClouds = [];
        for (const cluster of this.clusters.values()) {
            if (cluster.pointCloud && cluster.pointCloud.visible) {
                pointClouds.push(cluster.pointCloud);
            }
        }
        const intersects = this.raycaster.intersectObjects(pointClouds);

        // Restore the previously hovered cluster to its real base size (the
        // active blend mode's size), not a hardcoded value that would inflate
        // points permanently after a hover.
        if (this.hoveredCluster) {
            const u = this.hoveredCluster.pointCloud.material.uniforms.uPointSize;
            if (this._savedSize !== undefined) u.value = this._savedSize;
            this.hoveredCluster = null;
            this._savedSize = undefined;
        }

        if (intersects.length > 0) {
            const cluster = intersects[0].object.userData.cluster;
            if (cluster) {
                this.hoveredCluster = cluster;
                const u = cluster.pointCloud.material.uniforms.uPointSize;
                this._savedSize = u.value;
                u.value = this._savedSize * 1.6; // relative emphasis on hover
            }
        }
    }
}
