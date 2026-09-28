// Player preferences kept in localStorage (per device).
const KEY = 'catan.settings';

export const DEFAULTS = {
  volume: 0.7,
  muted: false,
  botSpeed: 'normal', // slow | normal | fast | instant
  turnSeconds: 90,
  skin: 'village',
  quality: 'auto', // auto | high | low
  autoRotate: false,
};

export const BOT_SPEEDS = { slow: 1.7, normal: 1, fast: 0.45, instant: 0 };

export function loadSettings() {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY)) || {}) }; } catch { return { ...DEFAULTS }; }
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}
