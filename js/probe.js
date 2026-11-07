// Starts a throwaway AR session asking for every feature of interest, then reports what was granted.
// The game itself only requests what it uses, so speculative features can't destabilize it.
const PROBE_FEATURES = [
  'local', 'local-floor', 'hit-test', 'anchors', 'dom-overlay',
  'plane-detection', 'mesh-detection', 'depth-sensing', 'light-estimation', 'camera-access',
];

const GLOBALS = ['XRSession', 'XRWebGLLayer', 'XRWebGLBinding', 'XRRigidTransform', 'XRRay',
  'XRHitTestSource', 'XRHitTestResult', 'XRAnchor'];

function hasMethod(className, method) {
  const proto = window[className]?.prototype;
  return !!proto && method in proto;
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
    // Requested before any other await, so the tap still counts as a user gesture.
    session = await navigator.xr.requestSession('immersive-ar', {
      optionalFeatures: PROBE_FEATURES,
      domOverlay: { root: overlayRoot },
      depthSensing: {
        usagePreference: ['cpu-optimized', 'gpu-optimized'],
        dataFormatPreference: ['luminance-alpha', 'float32'],
      },
    });
  } catch (error) {
    lines.push(`Full feature request rejected: ${error.name}: ${error.message}`);
    try {
      session = await navigator.xr.requestSession('immersive-ar');
      lines.push('Bare immersive-ar session started.');
    } catch (bareError) {
      lines.push(`Bare session rejected: ${bareError.name}: ${bareError.message}`);
    }
  }

  lines.push(`Globals present: ${GLOBALS.filter((name) => name in window).join(', ') || 'none'}`);
  lines.push(`Globals missing: ${GLOBALS.filter((name) => !(name in window)).join(', ') || 'none'}`);
  lines.push(`XRFrame.createAnchor: ${hasMethod('XRFrame', 'createAnchor')}`);
  lines.push(`XRHitTestResult.createAnchor: ${hasMethod('XRHitTestResult', 'createAnchor')}`);
  lines.push(`getUserMedia present: ${!!navigator.mediaDevices?.getUserMedia}`);
  lines.push(`audioSession API: ${!!navigator.audioSession}`);

  if (!session) return lines.join('\n');

  const enabled = session.enabledFeatures;
  if (enabled) {
    const granted = [...enabled];
    lines.push(`Granted: ${granted.join(', ') || 'none'}`);
    lines.push(`Not granted: ${PROBE_FEATURES.filter((f) => !granted.includes(f)).join(', ') || 'none'}`);
  } else {
    lines.push('session.enabledFeatures is missing, so grants cannot be read directly.');
  }
  lines.push(`requestHitTestSource: ${typeof session.requestHitTestSource === 'function'}`);
  lines.push(`DOM overlay: ${session.domOverlayState?.type || 'none'}`);
  lines.push(`Blend mode: ${session.environmentBlendMode || 'unknown'}`);
  try {
    lines.push(`Depth usage: ${session.depthUsage || 'none'}`);
  } catch {
    lines.push('Depth usage: none');
  }

  try {
    await session.end();
  } catch (error) {
    lines.push(`Session end failed: ${error.message}`);
  }
  return lines.join('\n');
}
