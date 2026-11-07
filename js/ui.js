// The interface inside the headset: a world-fixed panel you point at, and a small head-locked message.
import * as THREE from './three.js';

const WIDTH = 1024;
const HEIGHT = 900;
const PANEL_WIDTH_M = 0.72;
const PANEL_HEIGHT_M = PANEL_WIDTH_M * (HEIGHT / WIDTH);
const PAD = 40;
const BUTTON_HEIGHT = 88;
const BUTTON_GAP = 16;

function wrap(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export class Panel {
  constructor(scene) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(PANEL_WIDTH_M, PANEL_HEIGHT_M),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, side: THREE.DoubleSide }),
    );
    this.mesh.renderOrder = 200;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.buttons = [];
    this.hovered = null;
    this.signature = '';
    this.title = '';
    this.lines = [];
    this.inverse = new THREE.Matrix4();
    this.ray = new THREE.Ray();
    this.point = new THREE.Vector3();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  }

  get visible() {
    return this.mesh.visible;
  }

  hide() {
    this.mesh.visible = false;
  }

  showInFront(headPos, headForward) {
    const flat = new THREE.Vector3(headForward.x, 0, headForward.z);
    if (flat.lengthSq() < 1e-4) flat.set(0, 0, -1);
    flat.normalize();
    this.mesh.position.copy(headPos).addScaledVector(flat, 0.85);
    this.mesh.position.y -= 0.12;
    this.mesh.lookAt(headPos);
    this.mesh.visible = true;
  }

  // Redraws only on a change, since uploading the texture is expensive on a headset.
  setContent(title, lines, buttons) {
    const signature = JSON.stringify([title, lines, buttons, this.hovered]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.title = title;
    this.lines = lines;
    this.draw(buttons);
  }

  draw(buttons) {
    const { ctx } = this;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = 'rgba(14,15,24,0.94)';
    ctx.beginPath();
    ctx.roundRect(0, 0, WIDTH, HEIGHT, 32);
    ctx.fill();

    ctx.textBaseline = 'top';
    ctx.fillStyle = '#eef0f7';
    ctx.font = '700 48px system-ui, sans-serif';
    ctx.fillText(this.title, PAD, 32);

    const rows = Math.ceil(buttons.length / 2);
    const gridTop = HEIGHT - PAD + BUTTON_GAP - rows * (BUTTON_HEIGHT + BUTTON_GAP);

    ctx.font = '500 32px system-ui, sans-serif';
    ctx.fillStyle = '#c5c9d8';
    let y = 104;
    for (const line of this.lines) {
      for (const part of wrap(ctx, line, WIDTH - PAD * 2)) {
        if (y + 40 > gridTop) break;
        ctx.fillText(part, PAD, y);
        y += 42;
      }
    }

    const columnWidth = (WIDTH - PAD * 2 - BUTTON_GAP) / 2;
    this.buttons = buttons.map((button, index) => {
      const x = PAD + (index % 2) * (columnWidth + BUTTON_GAP);
      const top = gridTop + Math.floor(index / 2) * (BUTTON_HEIGHT + BUTTON_GAP);
      const hovered = this.hovered === button.id && button.enabled !== false;
      ctx.fillStyle = button.enabled === false ? '#2a2c38' : button.primary ? '#8f7bff' : hovered ? '#4a4e63' : '#34374a';
      if (hovered && button.primary) ctx.fillStyle = '#a896ff';
      ctx.beginPath();
      ctx.roundRect(x, top, columnWidth, BUTTON_HEIGHT, 16);
      ctx.fill();
      if (hovered) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 4;
        ctx.stroke();
      }
      ctx.fillStyle = button.enabled === false ? '#6d7085' : button.primary ? '#0e0b22' : '#eef0f7';
      ctx.font = '600 32px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(button.label, x + columnWidth / 2, top + BUTTON_HEIGHT / 2, columnWidth - 24);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      return { ...button, x, top, width: columnWidth };
    });
    this.texture.needsUpdate = true;
  }

  // Where a ray meets the panel: its distance, and the button under it if there is one.
  hit(origin, direction) {
    if (!this.mesh.visible) return null;
    this.mesh.updateMatrixWorld();
    this.inverse.copy(this.mesh.matrixWorld).invert();
    this.ray.origin.copy(origin);
    this.ray.direction.copy(direction);
    this.ray.applyMatrix4(this.inverse);
    if (!this.ray.intersectPlane(this.plane, this.point)) return null;
    const cx = (this.point.x / PANEL_WIDTH_M + 0.5) * WIDTH;
    const cy = (0.5 - this.point.y / PANEL_HEIGHT_M) * HEIGHT;
    if (cx < 0 || cx > WIDTH || cy < 0 || cy > HEIGHT) return null;
    const button = this.buttons.find((b) => cx >= b.x && cx <= b.x + b.width && cy >= b.top && cy <= b.top + BUTTON_HEIGHT);
    return { distance: this.ray.origin.distanceTo(this.point), button: button || null };
  }

  setHover(id) {
    this.hovered = id;
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.mesh.material.dispose();
    this.mesh.geometry.dispose();
    this.texture.dispose();
  }
}

export class Toast {
  constructor(scene) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 768;
    this.canvas.height = 112;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.72, 0.105),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false }),
    );
    this.mesh.renderOrder = 210;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.text = '';
    this.warn = false;
  }

  update(text, warn, headPos, headQuat, headUp, headForward) {
    this.mesh.visible = !!text;
    if (!text) return;
    if (text !== this.text || warn !== this.warn) {
      this.text = text;
      this.warn = warn;
      const { ctx } = this;
      ctx.clearRect(0, 0, 768, 112);
      ctx.fillStyle = warn ? 'rgba(170,40,50,0.94)' : 'rgba(14,15,24,0.88)';
      ctx.beginPath();
      ctx.roundRect(0, 0, 768, 112, 24);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 34px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 384, 56, 720);
      this.texture.needsUpdate = true;
    }
    this.mesh.position.copy(headPos).addScaledVector(headForward, 1.5).addScaledVector(headUp, -0.38);
    this.mesh.quaternion.copy(headQuat);
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.mesh.material.dispose();
    this.mesh.geometry.dispose();
    this.texture.dispose();
  }
}
