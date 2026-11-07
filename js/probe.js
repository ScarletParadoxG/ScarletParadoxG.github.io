// Starts a short AR session, asks for everything, and reports what this headset really provides.
// It runs for a few seconds because room planes aren't available right away.
const PROBE_FEATURES = [
  'local-floor', 'plane-detection', 'mesh-detection', 'anchors', 'hit-test', 'depth-sensing',
  'hand-tracking', 'light-estimation', 'camera-access', 'dom-overlay',
];

const PROBE_SECONDS = 4;

function hasMethod(className, method) {
  const proto = window[className]?.prototype;
  return !!proto && method in proto;
}

function tally(items, labelOf) {
  const counts = {};
  for (const item of items) {
    const label = labelOf(item);
    counts[label] = (counts[label] || 0) + 1;
  }
  return Object.entries(counts).map(([label, count]) => `${label} x${count}`).join(', ') || 'none';
}

export async function probeFeatures(overlayRoot) {
  const lines = [
    `--- Feature probe ${new Date().toISOString()} ---`,
    `URL: ${location.href}`,
    `User agent: ${navigator.userAgent}`,
    `Secure context: ${window.isSecureContext}`,
    `navigator.xr: ${!!navigator.xr}`,
  ];
  if (!navigator.xr) return lines.join('\n');

  let session;
  try {
    // Requested before any other await, so the click still counts as a user gesture.
    session = await navigator.xr.requestSession('immersive-ar', {
      optionalFeatures: PROBE_FEATURES,
      domOverlay: { root: overlayRoot },
      depthSensing: { usagePreference: ['gpu-optimized'], dataFormatPreference: [] },
    });
  } catch (error) {
    lines.push(`Session rejected: ${error.name}: ${error.message}`);
    return lines.join('\n');
  }

  const enabled = session.enabledFeatures ? [...session.enabledFeatures] : null;
  if (enabled) {
    lines.push(`Granted: ${enabled.join(', ') || 'none'}`);
    lines.push(`Not granted: ${PROBE_FEATURES.filter((f) => !enabled.includes(f)).join(', ') || 'none'}`);
  } else {
    lines.push('session.enabledFeatures is missing, so grants cannot be read directly.');
  }
  lines.push(`Blend mode: ${session.environmentBlendMode || 'unknown'}`);
  lines.push(`DOM overlay: ${session.domOverlayState?.type || 'none'}`);
  lines.push(`Room capture available: ${typeof session.initiateRoomCapture === 'function'}`);
  lines.push(`frame.createAnchor: ${hasMethod('XRFrame', 'createAnchor')}`);
  lines.push(`Projection layers: ${session.renderState.layers !== undefined}`);
  try {
    lines.push(`Depth: usage ${session.depthUsage || 'none'}, format ${session.depthDataFormat || 'none'}`);
  } catch {
    lines.push('Depth: none');
  }

  try {
    await inspectFrames(session, lines);
  } catch (error) {
    lines.push(`Frame checks failed: ${error.name}: ${error.message}`);
  }

  try {
    await session.end();
  } catch (error) {
    lines.push(`Session end failed: ${error.message}`);
  }
  return lines.join('\n');
}

async function inspectFrames(session, lines) {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { xrCompatible: true, alpha: true });
  await gl.makeXRCompatible?.();
  session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl, { alpha: true }) });

  const refSpace = await session.requestReferenceSpace('local-floor')
    .then((space) => { lines.push('Reference space: local-floor'); return space; })
    .catch(() => {
      lines.push('Reference space: local');
      return session.requestReferenceSpace('local');
    });

  let hitSource = null;
  if (session.requestHitTestSource) {
    try {
      const viewerSpace = await session.requestReferenceSpace('viewer');
      hitSource = await session.requestHitTestSource({ space: viewerSpace });
    } catch (error) {
      lines.push(`Hit test source failed: ${error.name}`);
    }
  }

  let frames = 0;
  let hits = 0;
  let anchorResult = 'not tried';

  await new Promise((resolve) => {
    const started = performance.now();
    const onFrame = (time, frame) => {
      frames++;
      gl.bindFramebuffer(gl.FRAMEBUFFER, session.renderState.baseLayer.framebuffer);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (hitSource && frame.getHitTestResults(hitSource).length) hits++;
      if (frames === 10 && frame.createAnchor) {
        try {
          anchorResult = 'pending';
          frame.createAnchor(new XRRigidTransform(), refSpace).then(
            (anchor) => { anchorResult = 'created'; anchor?.delete?.(); },
            (error) => { anchorResult = `rejected: ${error.name}`; },
          );
        } catch (error) {
          anchorResult = `threw: ${error.name}`;
        }
      }
      if (performance.now() - started >= PROBE_SECONDS * 1000) {
        // Read while this frame is still active.
        const planes = frame.detectedPlanes;
        lines.push(`Planes: ${planes ? `${planes.size}: ${tally(planes, (p) => `${p.semanticLabel || 'unlabeled'}/${p.orientation || '?'}`)}` : 'API missing'}`);
        const meshes = frame.detectedMeshes;
        lines.push(`Meshes: ${meshes ? `${meshes.size}: ${tally(meshes, (m) => m.semanticLabel || 'unlabeled')}` : 'API missing'}`);
        resolve();
        return;
      }
      session.requestAnimationFrame(onFrame);
    };
    session.requestAnimationFrame(onFrame);
  });

  lines.push(`Frames in ${PROBE_SECONDS} s: ${frames}`);
  lines.push(`Hit test: ${hitSource ? `${hits} frames with results` : 'unavailable'}`);
  lines.push(`Anchor test: ${anchorResult}`);
  lines.push(`Input sources: ${tally(session.inputSources, (s) => `${s.handedness}/${s.targetRayMode}/${s.hand ? 'hand' : 'controller'}`)}`);
}
