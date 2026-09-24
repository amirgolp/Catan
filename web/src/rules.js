// Shared rule constants used by the game loop and the AI bots.
export const RESOURCES = ['wood', 'brick', 'wool', 'grain', 'ore'];
export const RESOURCE_OF = { fields: 'grain', forest: 'wood', pasture: 'wool', hills: 'brick', mountains: 'ore' };
export const RESOURCE_ICON = { wood: '🌲', brick: '🧱', wool: '🐑', grain: '🌾', ore: '⛰️' };
export const COSTS = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, wool: 1, grain: 1 },
  city: { ore: 3, grain: 2 },
};
export const DEV_COST = { ore: 1, wool: 1, grain: 1 };
export const DEV = { knight: 'Knight', roads: 'Road building', plenty: 'Year of plenty', monopoly: 'Monopoly', vp: 'Victory point' };
export const DEV_ICON = { knight: '⚔️', roads: '🛤️', plenty: '🎁', monopoly: '🏦', vp: '🏆' };
/** The standard 25-card deck. */
export const DEV_DECK = [...Array(14).fill('knight'), ...Array(5).fill('vp'), 'roads', 'roads', 'plenty', 'plenty', 'monopoly', 'monopoly'];
/** Number of dice combinations that roll each number (the dots on a token). */
export const PIPS = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
export const WIN_VP = 10;

export const handSize = (p) => RESOURCES.reduce((s, r) => s + p.hand[r], 0);
export const missing = (p, cost) => {
  const m = {};
  for (const [r, n] of Object.entries(cost)) if (p.hand[r] < n) m[r] = n - p.hand[r];
  return m;
};
