// Flat SVG portraits for the four seats and a few monochrome UI icons.

const EYE = '#2a1f1a';

function face(skin, shade, mouth = 'M28.6 35 Q32 37.4 35.4 35') {
  return `
    <rect x="27" y="35" width="10" height="11" rx="3" fill="${shade}"/>
    <ellipse cx="20.6" cy="29.5" rx="2.4" ry="3.2" fill="${shade}"/>
    <ellipse cx="43.4" cy="29.5" rx="2.4" ry="3.2" fill="${shade}"/>
    <ellipse cx="32" cy="28" rx="11.2" ry="12.6" fill="${skin}"/>
    <circle cx="27.6" cy="29" r="1.35" fill="${EYE}"/>
    <circle cx="36.4" cy="29" r="1.35" fill="${EYE}"/>
    <path d="${mouth}" fill="none" stroke="${EYE}" stroke-width="1.3" stroke-linecap="round"/>`;
}

function shoulders(color, collar) {
  return `<path d="M6 66 C8 50 19 45 32 45 C45 45 56 50 58 66 Z" fill="${color}"/>
    <path d="M26 45.5 L32 52 L38 45.5" fill="none" stroke="${collar}" stroke-width="2" stroke-linejoin="round"/>`;
}

const PORTRAITS = {
  // Bearded settler in a knit cap
  red: (bg, dark) => `
    <rect width="64" height="64" fill="${bg}"/>
    ${shoulders(dark, '#f3e3d0')}
    ${face('#e3b08c', '#c98f6c', 'M29 36.2 Q32 37.6 35 36.2')}
    <path d="M20.8 29 C20.5 45 43.5 45 43.2 29 C41.5 35.5 37 37.6 32 37.6 C27 37.6 22.5 35.5 20.8 29 Z" fill="#6e3d22"/>
    <path d="M27.5 34.4 Q32 32.4 36.5 34.4 Q32 35.8 27.5 34.4 Z" fill="#6e3d22"/>
    <path d="M29.2 36.6 Q32 38 34.8 36.6" fill="none" stroke="#3a1f12" stroke-width="1.2" stroke-linecap="round"/>
    <path d="M19.8 25 C19.8 11 44.2 11 44.2 25 Z" fill="#8b231a"/>
    <rect x="19" y="22" width="26" height="6" rx="3" fill="#a8342a"/>
    <circle cx="32" cy="11.5" r="3.6" fill="#a8342a"/>`,
  // Sailor with long dark hair and a headband
  blue: (bg, dark) => `
    <rect width="64" height="64" fill="${bg}"/>
    <path d="M18.5 30 C16 11 48 11 45.5 30 L47 50 C41 53 23 53 17 50 Z" fill="#2b1d17"/>
    ${shoulders(dark, '#e8eef6')}
    ${face('#c98d64', '#ad7350')}
    <path d="M20.6 27 C21 15 43 13.5 43.4 27 C38.5 20.5 28.5 20 20.6 27 Z" fill="#2b1d17"/>
    <path d="M21 21.6 C27 16.5 37 16.5 43 21.6" fill="none" stroke="#e7c14a" stroke-width="2.2" stroke-linecap="round"/>
    <circle cx="20.4" cy="34" r="1.3" fill="#e7c14a"/>
    <circle cx="43.6" cy="34" r="1.3" fill="#e7c14a"/>`,
  // Old scholar with round glasses
  white: (bg, dark) => `
    <rect width="64" height="64" fill="${bg}"/>
    ${shoulders(dark, '#d8d2c6')}
    ${face('#f0cdb0', '#d8ab8c', 'M29.4 37 Q32 38.2 34.6 37')}
    <path d="M20.2 30 C19 21 22 17 25 18 C23 22 23 26 22.6 31 Z" fill="#ece8df"/>
    <path d="M43.8 30 C45 21 42 17 39 18 C41 22 41 26 41.4 31 Z" fill="#ece8df"/>
    <path d="M24 38 C25 45 39 45 40 38 C37 40.5 27 40.5 24 38 Z" fill="#ece8df"/>
    <path d="M27.5 34.8 Q32 32.6 36.5 34.8 Q32 36 27.5 34.8 Z" fill="#ece8df"/>
    <circle cx="27.6" cy="29" r="3.9" fill="none" stroke="#3b3b40" stroke-width="1.4"/>
    <circle cx="36.4" cy="29" r="3.9" fill="none" stroke="#3b3b40" stroke-width="1.4"/>
    <path d="M31.4 28.6 Q32 27.8 32.6 28.6" fill="none" stroke="#3b3b40" stroke-width="1.3"/>`,
  // Farmer in a straw hat
  orange: (bg, dark) => `
    <rect width="64" height="64" fill="${bg}"/>
    ${shoulders(dark, '#f4e2c4')}
    ${face('#99603f', '#7f4d31')}
    <path d="M21 26 C21 30 22 32 22 32 L22.6 24 Z M43 26 C43 30 42 32 42 32 L41.4 24 Z" fill="#241510"/>
    <circle cx="25.8" cy="32.4" r="0.7" fill="#6e3f25"/><circle cx="38.2" cy="32.4" r="0.7" fill="#6e3f25"/>
    <circle cx="27.4" cy="33.4" r="0.6" fill="#6e3f25"/><circle cx="36.6" cy="33.4" r="0.6" fill="#6e3f25"/>
    <ellipse cx="32" cy="22.5" rx="21" ry="4.6" fill="#d7b15c"/>
    <path d="M22.5 22.5 C22.5 8.5 41.5 8.5 41.5 22.5 Z" fill="#e6c572"/>
    <rect x="22.5" y="17.6" width="19" height="3.6" fill="#8a5a2b"/>`,
};

const hex = (n) => '#' + n.toString(16).padStart(6, '0');
const mix = (a, b, t) => {
  const ca = [a >> 16, (a >> 8) & 255, a & 255], cb = [b >> 16, (b >> 8) & 255, b & 255];
  return hex(ca.reduce((acc, c, i) => (acc << 8) | Math.round(c + (cb[i] - c) * t), 0));
};

/** Round portrait for a seat, tinted with the player's colour. */
export function avatarSvg(key, color) {
  const bg = key === 'white' ? '#c9d3dc' : mix(color, 0xffffff, 0.45);
  const dark = key === 'white' ? '#6b7280' : mix(color, 0x000000, 0.25);
  return `<svg viewBox="0 0 64 64" aria-hidden="true"><defs><clipPath id="av-${key}"><circle cx="32" cy="32" r="32"/></clipPath></defs>` +
    `<g clip-path="url(#av-${key})">${PORTRAITS[key](bg, dark)}</g></svg>`;
}

const icon = (body) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  cards: icon('<rect x="4" y="5" width="11" height="15" rx="2"/><path d="M9 3.5h8a2 2 0 0 1 2 2V17"/>'),
  dev: icon('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M12 8.2l1.2 2.5 2.7.3-2 1.9.5 2.7-2.4-1.3-2.4 1.3.5-2.7-2-1.9 2.7-.3z" fill="currentColor" stroke-width="1"/>'),
  shield: icon('<path d="M12 3l7 3v5.5c0 4.5-3 7.8-7 9.5-4-1.7-7-5-7-9.5V6z"/>'),
  road: icon('<path d="M8 21L11 3M16 21L13 3"/><path d="M12 6v2M12 11v2M12 16v2" stroke-width="1.6"/>'),
  anchor: icon('<circle cx="12" cy="5" r="2"/><path d="M12 7v14M5 13a7 7 0 0 0 14 0M8 10h8"/>'),
  menu: icon('<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>'),
  swap: icon('<path d="M4 8h13l-3-3M20 16H7l3 3"/>'),
};

/** Dice face with pips as inline markup (CSS draws the pips). */
export function dieHtml(n) {
  const pos = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] }[n] || [];
  return `<span class="die">${Array.from({ length: 9 }, (_, i) => `<i${pos.includes(i + 1) ? ' class="on"' : ''}></i>`).join('')}</span>`;
}
