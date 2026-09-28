// Plain data shared by the lobby (which does not load three.js) and the game: board
// variants and piece skins.

/** Board variants. `players` is [min, max]; `soon` marks ones not playable yet. */
export const VARIANT_INFO = {
  classic: { name: 'Classic', players: [2, 4], rows: [3, 4, 5, 4, 3], blurb: 'The standard 19-tile island.' },
  balanced: { name: 'Balanced', players: [2, 4], rows: [3, 4, 5, 4, 3], blurb: 'Shuffled numbers, no 6 and 8 side by side.' },
  extension: { name: '5-6 Extension', players: [2, 6], rows: [3, 4, 5, 6, 5, 4, 3], blurb: '30 tiles and two deserts for up to 6.' },
  seafarers: { name: 'Seafarers', players: [3, 4], rows: [4, 5, 6, 5, 4], blurb: 'Ships and hidden islands.', soon: true },
  cities: { name: 'Cities & Knights', players: [3, 4], rows: [3, 4, 5, 4, 3], blurb: 'Barbarians, knights and commodities.', soon: true },
};

/** Piece skins: cosmetic, sold in the store later. Prices are in coins. */
export const SKINS = {
  village: { name: 'Village', rarity: 'Common', price: 0, blurb: 'Thatched round hut and a timber-framed house.', art: { wall: '#c0392b', roof: '#6b1f18', stone: '#a39c90', trim: '#c9a55a', round: true } },
  stonework: { name: 'Stonework', rarity: 'Rare', price: 450, blurb: 'Stone cottage and a hall with a spired tower.', art: { wall: '#b9b3a8', roof: '#c0392b', stone: '#8f897e', trim: '#2b2b2b', tower: true } },
  nordic: { name: 'Nordic', rarity: 'Rare', price: 450, blurb: 'Turf-roofed longhouse and a carved mead hall.', art: { wall: '#3a2618', roof: '#c0392b', stone: '#6f6a62', trim: '#d8c7a0', aframe: true } },
  royal: { name: 'Royal Gold', rarity: 'Legendary', price: 1200, blurb: 'Marble and gold leaf for the whole village.', art: { wall: '#c0392b', roof: '#6b1f18', stone: '#f1ede4', trim: '#e0b94a', round: true, gold: true } },
};
export const DEFAULT_SKIN = 'village';

/** Small SVG picture of a skin's hut and house for the lobby store. */
export function skinArt(id) {
  const a = (SKINS[id] || SKINS[DEFAULT_SKIN]).art;
  const hut = a.round
    ? `<rect x="10" y="62" width="44" height="6" rx="2" fill="${a.stone}"/><rect x="14" y="44" width="36" height="20" rx="3" fill="${a.wall}"/><path d="M6 46 L32 18 L58 46 Z" fill="${a.roof}"/><rect x="28" y="50" width="8" height="14" fill="#4a3222"/>${a.gold ? '<circle cx="32" cy="18" r="3" fill="#e0b94a"/>' : ''}`
    : a.aframe
      ? `<rect x="6" y="62" width="52" height="6" rx="2" fill="${a.stone}"/><path d="M6 64 L32 26 L58 64 Z" fill="${a.roof}"/><path d="M26 20 L32 28 L38 20" stroke="${a.trim}" stroke-width="3" fill="none"/><rect x="28" y="50" width="8" height="14" fill="${a.wall}"/>`
      : `<rect x="8" y="62" width="48" height="6" rx="2" fill="${a.stone}"/><rect x="12" y="42" width="40" height="22" fill="${a.wall}"/><path d="M8 44 L32 24 L56 44 Z" fill="${a.roof}"/><rect x="28" y="50" width="8" height="14" fill="#4a3222"/>`;
  const house = a.tower
    ? `<rect x="4" y="80" width="72" height="6" rx="2" fill="${a.stone}"/><rect x="36" y="50" width="38" height="32" fill="${a.wall}"/><path d="M32 52 L55 32 L78 52 Z" fill="${a.roof}"/><rect x="8" y="26" width="24" height="56" fill="${a.wall}"/><path d="M6 28 L20 4 L34 28 Z" fill="${a.roof}"/><rect x="16" y="40" width="8" height="10" fill="#ffcf7a"/>`
    : a.aframe
      ? `<rect x="2" y="80" width="76" height="6" rx="2" fill="${a.stone}"/><path d="M2 82 L40 30 L78 82 Z" fill="${a.roof}"/><path d="M33 24 L40 34 L47 24" stroke="${a.trim}" stroke-width="3" fill="none"/><rect x="34" y="62" width="12" height="20" fill="${a.wall}"/><rect x="66" y="50" width="4" height="32" fill="${a.wall}"/>`
      : `<rect x="4" y="80" width="72" height="6" rx="2" fill="${a.stone}"/><rect x="10" y="60" width="60" height="22" fill="${a.stone}"/><rect x="8" y="40" width="64" height="22" fill="${a.wall}"/><path d="M4 42 L40 12 L76 42 Z" fill="${a.roof}"/><rect x="52" y="14" width="8" height="18" fill="${a.stone}"/><rect x="18" y="46" width="10" height="10" fill="#ffcf7a"/><rect x="52" y="46" width="10" height="10" fill="#ffcf7a"/><rect x="34" y="64" width="12" height="18" fill="#4a3222"/>${a.gold ? `<rect x="8" y="38" width="64" height="4" fill="${a.trim}"/>` : ''}`;
  return `<svg viewBox="0 0 64 70" width="64" height="70">${hut}</svg><svg viewBox="0 0 80 90" width="84" height="95">${house}</svg>`;
}

/** Tiny hex map of a variant's layout for the lobby cards. */
export function variantArt(id, seedIn = 7) {
  const v = VARIANT_INFO[id];
  const colors = ['#5a8f3a', '#2f6b2a', '#9dc25a', '#d9b24a', '#b5643a', '#8a8f96', '#e3d3a0'];
  const r = 7.2, w = Math.sqrt(3) * r;
  const rows = v.rows;
  const maxRow = Math.max(...rows);
  const width = maxRow * w + 4;
  const height = rows.length * r * 1.5 + r + 4;
  let seed = seedIn;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let hexes = '';
  rows.forEach((n, i) => {
    const y = 2 + r + i * r * 1.5;
    const x0 = 2 + (width - 4 - n * w) / 2 + w / 2;
    for (let k = 0; k < n; k++) {
      const cx = x0 + k * w;
      const pts = [0, 1, 2, 3, 4, 5].map((j) => { const a = Math.PI / 6 + (j * Math.PI) / 3; return `${(cx + r * 0.94 * Math.cos(a)).toFixed(1)},${(y + r * 0.94 * Math.sin(a)).toFixed(1)}`; }).join(' ');
      hexes += `<polygon points="${pts}" fill="${colors[Math.floor(rnd() * colors.length)]}"${v.soon ? ' opacity="0.5"' : ''}/>`;
    }
  });
  const sea = id === 'seafarers' ? `<rect x="0" y="0" width="${width}" height="${height}" rx="8" fill="#1d5f7c"/>` : '';
  return `<svg viewBox="0 0 ${width.toFixed(0)} ${height.toFixed(0)}" preserveAspectRatio="xMidYMid meet">${sea}${hexes}</svg>`;
}
