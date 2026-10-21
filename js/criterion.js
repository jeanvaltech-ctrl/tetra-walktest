// criterion.js — conformité aux recommandations ASTRID pour la couverture indoor.
//
// « Om goede communicatie te kunnen garanderen, dient het ontvangstniveau beter te zijn dan
//   -88 dBm voor 95% van de vloeroppervlakte. » Sinon : installation indoor ASTRID exigée (IBZ).
//
// « Meilleur que -88 dBm » = strictement supérieur (-87 dBm ou mieux : le vert de la légende SCOUT).
// La surface est approchée par la longueur parcourue : chaque mesure compte pour la moitié du trajet
// vers ses voisines dans son segment (comme sur la trace), si bien que rester sur place ne pèse pas.
import { dist } from './geometry.js';
import { nf } from './render.js';

export const DEFAULT_CRITERION = { rssi: -88, percent: 95 };

export const sampleOk = (rssi, c = DEFAULT_CRITERION) => typeof rssi === 'number' && rssi > c.rssi;

/**
 * @returns {{ n, okN, pct, pctSamples, ok }} pct : % de la longueur parcourue conforme
 *   (repli sur le % de points si aucune longueur) ; null s'il n'y a aucune mesure.
 */
export function floorCompliance(floor, c = DEFAULT_CRITERION) {
  let n = 0, okN = 0, len = 0, okLen = 0;
  for (const seg of floor.segments) {
    const s = seg.samples;
    for (let i = 0; i < s.length; i++) {
      const w = ((i > 0 ? dist(s[i - 1], s[i]) : 0) + (i < s.length - 1 ? dist(s[i], s[i + 1]) : 0)) / 2;
      const ok = sampleOk(s[i].rssi, c);
      n++; len += w;
      if (ok) { okN++; okLen += w; }
    }
  }
  if (!n) return { n, okN, pct: null, pctSamples: null, ok: null };
  const pctSamples = okN / n * 100;
  const pct = len > 0 ? okLen / len * 100 : pctSamples;
  return { n, okN, pct, pctSamples, ok: pct >= c.percent };
}

/** Pourcentage arrondi vers le bas : 94,96 % ne doit jamais s'afficher « 95,0 % » si c'est non conforme. */
export const fmtPct = p => `${nf(Math.floor(p * 10) / 10, 1)} %`;

/** « ASTRID : 96,2 % > -88 dBm — conforme (objectif 95 %) », ou null sans mesure. */
export function complianceText(floor, c = DEFAULT_CRITERION) {
  const r = floorCompliance(floor, c);
  if (r.pct === null) return null;
  return `ASTRID : ${fmtPct(r.pct)} > ${c.rssi} dBm — ${r.ok ? 'conforme' : 'NON conforme'} (objectif ${c.percent} %)`;
}
