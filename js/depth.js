// Quest 3 and 3S: real-time occlusion from the headset's depth sensing, so hands, people and
// furniture can hide ghosts. Quest 2 never grants the feature, and this file then does nothing.
//
// three.js writes the sensed depth into the depth buffer before the scene is drawn. Two additions:
//  - A small bias, because depth is noisy and would otherwise flicker against anything on a wall.
//  - A "punch" through each rift's hole. The real wall is in front of the tunnel, so without this
//    sensed depth would hide it. Anything real in front of the wall still hides the rift.
import * as THREE from './three.js';

const DEPTH_BIAS_METERS = 0.04;
const IN_FRONT_OF_WALL_METERS = 0.15;

// Each eye is one layer of the depth texture, and the eyes sit side by side in the framebuffer.
const SAMPLE_DEPTH = /* glsl */`
uniform sampler2DArray depthColor;
uniform float depthWidth;
uniform float depthHeight;
uniform float depthNear;
uniform float depthFar;

float sampleSensedDepth() {
  vec2 coord = vec2(gl_FragCoord.x / depthWidth, gl_FragCoord.y / depthHeight);
  if (coord.x >= 1.0) return texture(depthColor, vec3(coord.x - 1.0, coord.y, 1)).r;
  return texture(depthColor, vec3(coord.x, coord.y, 0)).r;
}

float toMeters(float d) {
  return depthNear * depthFar / (depthFar - d * (depthFar - depthNear));
}

float fromMeters(float z) {
  return depthFar * (z - depthNear) / (z * (depthFar - depthNear));
}
`;

const BIASED_FRAGMENT = /* glsl */`
${SAMPLE_DEPTH}
uniform float depthBias;

void main() {
  float d = sampleSensedDepth();
  gl_FragDepth = d >= 1.0 ? 1.0 : clamp(fromMeters(toMeters(d) + depthBias), 0.0, 1.0);
}
`;

const PUNCH_VERTEX = /* glsl */`
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const PUNCH_FRAGMENT = /* glsl */`
${SAMPLE_DEPTH}
uniform float inFrontMargin;

void main() {
  if (toMeters(sampleSensedDepth()) < toMeters(gl_FragCoord.z) - inFrontMargin) discard;
  gl_FragDepth = 1.0;
}
`;

export class DepthOcclusion {
  constructor() {
    this.enabled = true;
    this.active = false;
    this.mesh = null;
    this.punchMaterial = null;
    this.near = 0;
    this.far = 0;
  }

  update(renderer, rifts) {
    const mesh = renderer.xr.getDepthSensingMesh();
    if (!mesh) {
      this.active = false;
      return;
    }
    if (mesh !== this.mesh) this.attach(mesh);
    this.active = true;

    // three.js may switch to the depth texture's own range, which can be very far.
    const camera = renderer.xr.getCamera();
    this.near = camera.near;
    this.far = Math.min(camera.far, 1e5);
    for (const material of [this.mesh.material, this.punchMaterial]) {
      material.uniforms.depthNear.value = this.near;
      material.uniforms.depthFar.value = this.far;
    }

    this.mesh.visible = this.enabled;
    rifts.forEach((rift) => {
      if (!rift.punch) return;
      if (rift.punch.material !== this.punchMaterial) {
        rift.punch.material.dispose();
        rift.punch.material = this.punchMaterial;
      }
      rift.punch.visible = this.enabled;
    });
  }

  attach(mesh) {
    this.mesh = mesh;
    const { uniforms } = mesh.material;
    uniforms.depthNear = { value: 0.1 };
    uniforms.depthFar = { value: 100 };
    uniforms.depthBias = { value: DEPTH_BIAS_METERS };
    mesh.material.fragmentShader = BIASED_FRAGMENT;
    mesh.material.colorWrite = false;
    mesh.material.needsUpdate = true;

    this.punchMaterial = new THREE.ShaderMaterial({
      vertexShader: PUNCH_VERTEX,
      fragmentShader: PUNCH_FRAGMENT,
      side: THREE.DoubleSide,
      colorWrite: false,
      depthFunc: THREE.AlwaysDepth,
      uniforms: {
        depthColor: uniforms.depthColor,
        depthWidth: uniforms.depthWidth,
        depthHeight: uniforms.depthHeight,
        depthNear: { value: 0.1 },
        depthFar: { value: 100 },
        inFrontMargin: { value: IN_FRONT_OF_WALL_METERS },
      },
    });
  }

  reset() {
    this.active = false;
    this.mesh = null;
    this.punchMaterial?.dispose();
    this.punchMaterial = null;
  }
}
