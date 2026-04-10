/**
 * Composite browser fingerprinting (PRD §3.2)
 *
 * Generates a deterministic SHA-256 hex hash from:
 *   - Canvas rendering (GPU / OS anti-aliasing variations)
 *   - AudioContext properties (audio stack characteristics)
 *   - System configuration (screen, cores, platform, fonts)
 *
 * The hash persists across incognito sessions, VPNs, and cookie clears
 * because it relies on hardware-level rendering characteristics.
 */

async function sha256(message) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getCanvasFingerprint() {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "no-canvas";

    // Text rendering — GPU-specific anti-aliasing
    ctx.textBaseline = "top";
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = "#f60";
    ctx.fillRect(50, 1, 100, 50);
    ctx.fillStyle = "#069";
    ctx.fillText("NSBE Election Fingerprint 🐾", 2, 15);
    ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
    ctx.fillText("UGA Chapter 2026", 4, 45);

    // Geometric overlay
    ctx.beginPath();
    ctx.arc(80, 80, 30, 0, Math.PI * 2, true);
    ctx.closePath();
    ctx.fillStyle = "#ba0c2f";
    ctx.fill();

    return canvas.toDataURL();
  } catch {
    return "canvas-error";
  }
}

function getAudioFingerprint() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return "no-audio";
    const ctx = new AudioCtx();
    const oscillator = ctx.createOscillator();
    const analyser = ctx.createAnalyser();
    const gain = ctx.createGain();
    const compressor = ctx.createDynamicsCompressor();

    // Collect compressor defaults — differ across audio stacks
    const sig = [
      compressor.threshold?.value,
      compressor.knee?.value,
      compressor.ratio?.value,
      compressor.attack?.value,
      compressor.release?.value,
      analyser.fftSize,
      analyser.frequencyBinCount,
      ctx.sampleRate,
    ].join("|");

    ctx.close().catch(() => {});
    return sig;
  } catch {
    return "audio-error";
  }
}

function getSystemFingerprint() {
  const signals = [
    navigator.userAgent,
    navigator.language,
    navigator.languages?.join(","),
    screen.width,
    screen.height,
    screen.colorDepth,
    navigator.hardwareConcurrency,
    navigator.maxTouchPoints,
    navigator.platform,
    new Date().getTimezoneOffset(),
    typeof navigator.deviceMemory !== "undefined"
      ? navigator.deviceMemory
      : "unknown",
    navigator.vendor,
  ];
  return signals.join("||");
}

/**
 * Generate a persistent device hash.
 * Cached in a module-level variable so the hash is only computed once per page load.
 */
let _cachedHash = null;

export async function getDeviceHash() {
  if (_cachedHash) return _cachedHash;

  const canvas = getCanvasFingerprint();
  const audio = getAudioFingerprint();
  const system = getSystemFingerprint();

  const raw = [canvas, audio, system].join("::::");
  _cachedHash = await sha256(raw);
  return _cachedHash;
}
