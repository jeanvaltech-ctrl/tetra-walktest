// criterion.js — conformité aux recommandations ASTRID pour la couverture indoor.
//
// Règle (décision de Jean, 04/11/2026) : au moins 95 % des POINTS mesurés à -88 dBm ou mieux,
// radio portée à la ceinture (perte corporelle incluse). Sinon : installation indoor ASTRID nécessaire.
// - Seuil « -88 dBm ou mieux » (≥) : ASTRID parle d'un minimum (Annexe 2 §4.2.3 et §6, Annexe 6 §3).
// - Base : le % des points fait foi, comme le modèle de rapport Connext et CRG. Le % de la distance
//   parcourue (chaque mesure pèse la moitié du trajet vers ses voisines) reste une information.
// - Un point « pas de service » n'a pas de RSSI : il compte NON conforme, comme un niveau trop faible.
// - Verdict sur les comptes exacts ; parts tronquées à 1 décimale (même règle que CRG, voir docs/CSV.md).
// - Question ouverte (non tranchée) : -88 dBm avec perte corporelle, alors que l'Annexe 6 donne -98 dBm
//   en mesure radio portée ; voir la feuille de route.
import { dist } from './geometry.js';
import { nf, tx } from './i18n.js';

export const DEFAULT_CRITERION = { rssi: -88, percent: 95 };

export const sampleOk = (rssi, c = DEFAULT_CRITERION) => typeof rssi === 'number' && rssi >= c.rssi;

/** Longueur de trajet que couvre la mesure i d'un segment. */
const sampleWeight = (s, i) =>
  ((i > 0 ? dist(s[i - 1], s[i]) : 0) + (i < s.length - 1 ? dist(s[i], s[i + 1]) : 0)) / 2;

/**
 * @returns {{ n, okN, pct, pctDistance, ok }} pct : % des points conformes (fait foi, verdict `ok`) ;
 *   pctDistance : % de la distance parcourue conforme (information ; repli sur pct sans longueur).
 *   null s'il n'y a aucune mesure.
 */
export function floorCompliance(floor, c = DEFAULT_CRITERION) {
  let n = 0, okN = 0, len = 0, okLen = 0;
  for (const seg of floor.segments) {
    const s = seg.samples;
    for (let i = 0; i < s.length; i++) {
      const w = sampleWeight(s, i);
      const ok = sampleOk(s[i].rssi, c);
      n++; len += w;
      if (ok) { okN++; okLen += w; }
    }
  }
  if (!n) return { n, okN, pct: null, pctDistance: null, ok: null };
  const pct = okN / n * 100;
  const pctDistance = len > 0 ? okLen / len * 100 : pct;
  return { n, okN, pct, pctDistance, ok: okN * 100 >= c.percent * n };
}

/** Part des points « pas de service », en % (même base que le verdict) ; null sans mesure. */
export function floorShares(floor) {
  let n = 0, ns = 0;
  for (const seg of floor.segments) {
    for (const s of seg.samples) {
      n++;
      if (s.noService) ns++;
    }
  }
  return { noService: n ? ns / n * 100 : null };
}

/** Dixièmes de %, tronqués ; 1e-9 : 29/100*100 vaut 28,999999999999996 et doit rester 29,0 %. */
const tenths = p => Math.floor(p * 10 + 1e-9);

/** Pourcentage arrondi vers le bas : 94,96 % ne doit jamais s'afficher « 95,0 % » si c'est non conforme. */
export const fmtPct = (p, lang) => `${nf(tenths(p) / 10, 1, lang)} %`;

/** « ASTRID : 96,2 % des points ≥ -88 dBm — conforme (objectif 95 %) · No service : 1,0 % · distance parcourue : 97,0 % », ou null. */
export function complianceText(floor, c = DEFAULT_CRITERION, lang) {
  const r = floorCompliance(floor, c);
  if (r.pct === null) return null;
  return tx(lang, 'compliance.text', { pct: fmtPct(r.pct, lang), rssi: c.rssi, ok: r.ok, goal: c.percent, noService: fmtPct(floorShares(floor).noService, lang), dist: fmtPct(r.pctDistance, lang) });
}
