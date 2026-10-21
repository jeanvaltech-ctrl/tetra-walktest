// thresholds.js — classes de RSSI et couleurs (défaut = légende SCOUT).
// Le premier seuil atteint (rssi >= min) donne la couleur ; en dessous du dernier : « No ».

export const DEFAULT_THRESHOLDS = [
  { min: -65, color: '#e00000' },   // rouge
  { min: -72, color: '#ff8c00' },   // orange
  { min: -85, color: '#ffd800' },   // jaune
  { min: -87, color: '#22b14c' },   // vert
  { min: -98, color: '#1e3fd8' },   // bleu
];
export const NO_COVERAGE = { color: '#000000', label: 'No' };

export function rssiColor(rssi, thresholds = DEFAULT_THRESHOLDS) {
  if (typeof rssi !== 'number') return NO_COVERAGE.color;
  for (const t of thresholds) if (rssi >= t.min) return t.color;
  return NO_COVERAGE.color;
}

/** Libellés de légende : « ≥ -65 », …, « < -98 ». */
export function legendItems(thresholds = DEFAULT_THRESHOLDS) {
  const items = thresholds.map(t => ({ color: t.color, label: `≥ ${t.min}` }));
  const last = thresholds[thresholds.length - 1];
  items.push({ color: NO_COVERAGE.color, label: `< ${last.min} (${NO_COVERAGE.label})` });
  return items;
}

/** Couleur de texte lisible (noir ou blanc) sur un fond #rrggbb. */
export function textOn(bg) {
  const n = parseInt(bg.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111' : '#fff';
}
