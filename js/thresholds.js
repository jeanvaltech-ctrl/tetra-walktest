// thresholds.js — classes de RSSI et couleurs (défaut = classes du rapport CRG, décision de Jean, 04/11/2026).
// Le premier seuil atteint (rssi >= min, sur le nombre tel quel) donne la couleur : -88 est vert, -88,4 et
// -89 bleus (la radio envoie des entiers ; même comparaison que le critère ASTRID).
// Sous le dernier seuil : classe « < dernier seuil » (BELOW). Pas de RSSI : « pas de service » (NO_SERVICE).
import { t } from './i18n.js';

export const DEFAULT_THRESHOLDS = [
  { min: -65, color: '#FF0000' },   // rouge (Excellent)
  { min: -75, color: '#FF8C00' },   // orange (Very good)
  { min: -85, color: '#FFD700' },   // jaune (Good)
  { min: -88, color: '#32CD32' },   // vert (Acceptable)
];
export const BELOW = { color: '#0066CC' };        // bleu (Bad, y compris sous -100)
export const NO_SERVICE = { color: '#000000' };

// Listes enregistrées avant les classes CRG (légende SCOUT, ancienne légende -72, seuils modifiés : l'appli
// ne change jamais les couleurs) : dernière classe dans ce bleu, noir en dessous. Elles gardent leur rendu.
const OLD_LAST_COLOR = '#1e3fd8';

const belowColor = thresholds =>
  thresholds.at(-1)?.color === OLD_LAST_COLOR ? NO_SERVICE.color : BELOW.color;

export function rssiColor(rssi, thresholds = DEFAULT_THRESHOLDS) {
  if (!Number.isFinite(rssi)) return NO_SERVICE.color;
  for (const t of thresholds) if (rssi >= t.min) return t.color;
  return belowColor(thresholds);
}

/** Libellés de légende : « ≥ -65 », …, « < -88 ». */
export function legendItems(thresholds = DEFAULT_THRESHOLDS) {
  const items = thresholds.map(t => ({ color: t.color, label: `≥ ${t.min}` }));
  const last = thresholds[thresholds.length - 1];
  items.push({ color: belowColor(thresholds), label: `< ${last.min}` });
  return items;
}

const sameLevel = (a, b) => a.min === b.min && String(a.color).toLowerCase() === b.color.toLowerCase();

/** Message si le projet garde ses propres seuils (jamais réécrits sans demande), sinon ''. */
export function thresholdsNotice(project) {
  const th = project.thresholds;
  if (!th || (th.length === DEFAULT_THRESHOLDS.length && th.every((level, i) => sameLevel(level, DEFAULT_THRESHOLDS[i])))) return '';
  return t('notify.customThresholds', {
    mins: th.map(level => level.min).join(' / '),
    defaults: DEFAULT_THRESHOLDS.map(level => `≥ ${level.min}`).join(' / '),
  });
}

/** Bouton « Seuils par défaut ». */
export function resetThresholds(project) {
  project.thresholds = DEFAULT_THRESHOLDS.map(level => ({ ...level }));
}

/** Couleur de texte lisible (noir ou blanc) sur un fond #rrggbb. */
export function textOn(bg) {
  const n = parseInt(bg.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111' : '#fff';
}
