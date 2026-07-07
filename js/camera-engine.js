import * as THREE from 'three';

export class CameraEngine {
    constructor(camera, orbitControls) {
        this.camera = camera;
        this.orbitControls = orbitControls;

        this.flythrough = null;
        this.autoOrbit = false;
        this.autoOrbitSpeed = 0.08;

        this.defaultPosition = null;
        this.defaultTarget = null;
        this.userInteracting = false;

        this.cameraPath = null;

        this._onPointerDown = () => { this.userInteracting = true; };
        this._onPointerUp = () => {
            setTimeout(() => { this.userInteracting = false; }, 300);
        };
        const el = orbitControls.domElement;
        el.addEventListener('pointerdown', this._onPointerDown);
        el.addEventListener('pointerup', this._onPointerUp);
    }

    saveDefault() {
        this.defaultPosition = this.camera.position.clone();
        this.defaultTarget = this.orbitControls.target.clone();
    }

    resetToDefault() {
        if (!this.defaultPosition) return;
        this.flythrough = null;
        this.flyTo(this.defaultPosition, this.defaultTarget, 1.2);
    }

    setAutoOrbit(enabled) {
        this.autoOrbit = enabled;
    }

    flyTo(position, target, duration = 1.5) {
        this.flythrough = {
            startPos: this.camera.position.clone(),
            endPos: position.clone(),
            startTarget: this.orbitControls.target.clone(),
            endTarget: target.clone(),
            startTime: performance.now(),
            duration: duration * 1000
        };
    }

    stopFlythrough() {
        this.flythrough = null;
    }

    startOrbitPath(center, radius, duration) {
        const r = radius || this.camera.position.distanceTo(this.orbitControls.target);
        const elevation = this.camera.position.y - this.orbitControls.target.y;
        const startAngle = Math.atan2(
            this.camera.position.z - center.z,
            this.camera.position.x - center.x
        );

        this.cameraPath = {
            type: 'orbit',
            center: center.clone(),
            radius: r,
            elevation,
            startAngle,
            startTime: performance.now(),
            duration: (duration || 20) * 1000,
            loop: true
        };
    }

    startCinematicPath(center, radius) {
        const r = radius || this.camera.position.distanceTo(this.orbitControls.target);
        const elevation = this.camera.position.y - this.orbitControls.target.y;

        const keyframes = [
            { angle: 0, elevMult: 1.0, radiusMult: 1.0, time: 0 },
            { angle: Math.PI * 0.4, elevMult: 0.8, radiusMult: 0.85, time: 0.15 },
            { angle: Math.PI * 0.8, elevMult: 1.5, radiusMult: 1.1, time: 0.3 },
            { angle: Math.PI, elevMult: 2.5, radiusMult: 1.3, time: 0.45 },
            { angle: Math.PI * 1.3, elevMult: 1.8, radiusMult: 1.0, time: 0.6 },
            { angle: Math.PI * 1.7, elevMult: 0.6, radiusMult: 0.9, time: 0.8 },
            { angle: Math.PI * 2, elevMult: 1.0, radiusMult: 1.0, time: 1.0 }
        ];

        const startAngle = Math.atan2(
            this.camera.position.z - center.z,
            this.camera.position.x - center.x
        );

        this.cameraPath = {
            type: 'cinematic',
            center: center.clone(),
            baseRadius: r,
            baseElevation: elevation,
            startAngle,
            keyframes,
            startTime: performance.now(),
            duration: 15000,
            loop: false
        };
    }

    stopCameraPath() {
        this.cameraPath = null;
    }

    update(time) {
        if (this.cameraPath) {
            this._updateCameraPath();
            return;
        }

        if (this.flythrough) {
            this._updateFlythrough();
            return;
        }

        if (this.autoOrbit && !this.userInteracting) {
            this.orbitControls.autoRotate = true;
            this.orbitControls.autoRotateSpeed = this.autoOrbitSpeed;
        } else {
            this.orbitControls.autoRotate = false;
        }
    }

    _updateCameraPath() {
        const path = this.cameraPath;
        const elapsed = performance.now() - path.startTime;
        let t = elapsed / path.duration;

        if (path.loop) {
            t = t % 1;
        } else if (t >= 1) {
            this.cameraPath = null;
            return;
        }

        if (path.type === 'orbit') {
            const angle = path.startAngle + t * Math.PI * 2;
            const x = path.center.x + Math.cos(angle) * path.radius;
            const z = path.center.z + Math.sin(angle) * path.radius;
            const y = path.center.y + path.elevation;

            this.camera.position.set(x, y, z);
            this.orbitControls.target.copy(path.center);
            this.orbitControls.update();

        } else if (path.type === 'cinematic') {
            const kf = path.keyframes;
            let i = 0;
            for (; i < kf.length - 1; i++) {
                if (t >= kf[i].time && t < kf[i + 1].time) break;
            }
            if (i >= kf.length - 1) i = kf.length - 2;

            const segT = (t - kf[i].time) / (kf[i + 1].time - kf[i].time);
            const smooth = segT * segT * (3 - 2 * segT);

            const angle = path.startAngle + THREE.MathUtils.lerp(kf[i].angle, kf[i + 1].angle, smooth);
            const elev = path.baseElevation * THREE.MathUtils.lerp(kf[i].elevMult, kf[i + 1].elevMult, smooth);
            const radius = path.baseRadius * THREE.MathUtils.lerp(kf[i].radiusMult, kf[i + 1].radiusMult, smooth);

            const x = path.center.x + Math.cos(angle) * radius;
            const z = path.center.z + Math.sin(angle) * radius;
            const y = path.center.y + elev;

            this.camera.position.set(x, y, z);
            this.orbitControls.target.copy(path.center);
            this.orbitControls.update();
        }
    }

    _updateFlythrough() {
        const f = this.flythrough;
        const t = Math.min((performance.now() - f.startTime) / f.duration, 1);
        const e = this._easeInOutQuad(t);

        this.camera.position.lerpVectors(f.startPos, f.endPos, e);
        this.orbitControls.target.lerpVectors(f.startTarget, f.endTarget, e);
        this.orbitControls.update();

        if (t >= 1) this.flythrough = null;
    }

    _easeInOutQuad(t) {
        return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    }
}
