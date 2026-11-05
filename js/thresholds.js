// thresholds.js — classes de RSSI et couleurs (défaut = classes du rapport CRG, décision de Jean, 04/11/2026).
// Le premier seuil atteint (rssi >= min, sur le nombre tel quel) donne la couleur : -88 est vert, -88,4 et
// -89 bleus (la radio envoie des entiers ; même comparaison que le critère ASTRID).
// Sous le dernier seuil : classe « < dernier seuil » (BELOW). Pas de RSSI : « pas de service » (NO_SERVICE).
// Toute autre liste enregistrée dans un projet garde son rendu d'avant : voir OLD_BELOW.
import { t } from './i18n.js';

export const DEFAULT_THRESHOLDS = [
  { min: -65, color: '#FF0000' },   // rouge (Excellent)
  { min: -75, color: '#FF8C00' },   // orange (Very good)
  { min: -85, color: '#FFD700' },   // jaune (Good)
  { min: -88, color: '#32CD32' },   // vert (Acceptable)
];
export const BELOW = { color: '#0066CC' };        // bleu (Bad, y compris sous -100)
export const NO_SERVICE = { color: '#000000' };

// Liste différente du défaut (légende SCOUT, ancienne légende -72, seuils modifiés…) : un projet enregistré
// n'est jamais modifié, ni son rendu (décision de Jean, 05/11/2026). Noir et « (No) » sous son dernier seuil.
const OLD_BELOW = { color: '#000000', label: 'No' };

const sameLevel = (a, b) => a.min === b.min && String(a.color).toLowerCase() === b.color.toLowerCase();

const isDefault = thresholds =>
  thresholds.length === DEFAULT_THRESHOLDS.length && thresholds.every((level, i) => sameLevel(level, DEFAULT_THRESHOLDS[i]));

export function rssiColor(rssi, thresholds = DEFAULT_THRESHOLDS) {
  if (!Number.isFinite(rssi)) return NO_SERVICE.color;
  for (const t of thresholds) if (rssi >= t.min) return t.color;
  return isDefault(thresholds) ? BELOW.color : OLD_BELOW.color;
}

/** Libellés de légende : « ≥ -65 », …, « < -88 » (« < -98 (No) » pour une liste différente du défaut). */
export function legendItems(thresholds = DEFAULT_THRESHOLDS) {
  const items = thresholds.map(t => ({ color: t.color, label: `≥ ${t.min}` }));
  const last = thresholds[thresholds.length - 1];
  items.push(isDefault(thresholds)
    ? { color: BELOW.color, label: `< ${last.min}` }
    : { color: OLD_BELOW.color, label: `< ${last.min} (${OLD_BELOW.label})` });
  return items;
}

/** Lignes du panneau des seuils sous les champs de saisie. */
export function thresholdsPanelTail(thresholds) {
  const min = thresholds[thresholds.length - 1].min;
  if (!isDefault(thresholds)) return [{ color: OLD_BELOW.color, op: '<', text: `${min} : ${OLD_BELOW.label}` }];
  return [{ color: BELOW.color, op: '<', text: `${min}` }, { color: NO_SERVICE.color, op: '', text: t('legend.noService') }];
}

/** Message si le projet garde ses propres seuils (jamais réécrits sans demande), sinon ''. */
export function thresholdsNotice(project) {
  const th = project.thresholds;
  if (!th || isDefault(th)) return '';
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
