// render.js — dessin de la trace, de la légende et de l'échelle.
// Commun à l'écran (transformation de la vue) et à l'export PNG (taille réelle du plan).
// k : facteur d'épaisseur / de taille de texte (1 à l'écran, plus grand à l'export).
// lang : langue des textes dessinés (à l'export) ; absente, celle de l'interface (à l'écran).
import { niceLength } from './geometry.js';
import { legendItems, rssiColor, NO_SERVICE } from './thresholds.js';
import { nf, tx } from './i18n.js';

export { nf };   // formatage des nombres selon la langue choisie
export const FONT = 'system-ui, "Segoe UI", sans-serif';
export const fmtMeters = (m, lang) => m >= 1 ? `${nf(m, m < 10 ? 1 : 0, lang)} m` : `${nf(m * 100, 0, lang)} cm`;

export function drawLabel(ctx, text, x, y) {
  ctx.font = `600 12px ${FONT}`;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.fillRect(x - w / 2 - 4, y - 9, w + 8, 18);
  ctx.fillStyle = '#111';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

// trace : chaque échantillon couvre la moitié du chemin vers ses voisins, dans sa couleur.
// Aux extrémités d'un tronçon, il va jusqu'au point cliqué (sinon les coins seraient coupés en biais).
// « Pas de service » : noir (pas de RSSI), avec des tirets blancs au centre, tracés d'un seul trait
// sur toute la zone (un point par seconde est plus court qu'un tiret).
export function drawTrace(ctx, t, floor, thresholds, k = 1) {
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const seg of floor.segments) {
    const pts = seg.points.map(p => t.toScreen(p));
    ctx.lineWidth = 1.5 * k; ctx.strokeStyle = 'rgba(0,0,0,.45)';
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();

    const ss = seg.samples.map(s => t.toScreen(s));
    ctx.lineWidth = 7 * k;
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const reach = i => {
      const p = ss[i], leg = seg.samples[i].leg;
      const sameLeg = j => j >= 0 && j < ss.length && seg.samples[j].leg === leg;
      // tronçon leg : du point leg-1 au point leg ; à défaut (ancien format), voisin le plus proche
      const from = sameLeg(i - 1) ? mid(ss[i - 1], p) : (pts[leg - 1] || mid(ss[i - 1] || p, p));
      const to = sameLeg(i + 1) ? mid(p, ss[i + 1]) : (pts[leg] || mid(p, ss[i + 1] || p));
      return { from, p, to };
    };
    for (let i = 0; i < ss.length; i++) {
      const { from, p, to } = reach(i);
      ctx.strokeStyle = rssiColor(seg.samples[i].rssi, thresholds);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(p.x, p.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }

    ctx.save();
    ctx.lineCap = 'butt'; ctx.lineWidth = 2.5 * k; ctx.strokeStyle = '#fff';
    ctx.setLineDash([6 * k, 6 * k]);
    ctx.beginPath();
    let end = null;
    for (let i = 0; i < ss.length; i++) {
      if (!seg.samples[i].noService) { end = null; continue; }
      const { from, p, to } = reach(i);
      if (!end || end.x !== from.x || end.y !== from.y) ctx.moveTo(from.x, from.y);
      ctx.lineTo(p.x, p.y);
      ctx.lineTo(to.x, to.y);
      end = to;
    }
    ctx.stroke();
    ctx.restore();

    for (const p of pts) {
      ctx.beginPath(); ctx.arc(p.x, p.y, 3.5 * k, 0, 2 * Math.PI);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.lineWidth = 1.5 * k; ctx.strokeStyle = '#222'; ctx.stroke();
    }
  }
  ctx.restore();
}

export const LEGEND_W = 118;

/** Textes de la légende : classes de RSSI (sans langue), puis « pas de service » dans la langue demandée. */
export const legendLines = (thresholds, lang) =>
  [...legendItems(thresholds).map(it => it.label), tx(lang, 'legend.noService')];

/** Légende RSSI, coin haut-gauche en (x, y). */
export function drawLegend(ctx, x, y, thresholds, k = 1, lang) {
  const items = legendItems(thresholds), lines = legendLines(thresholds, lang), lh = 16, top = 24, h = (items.length + 1) * lh + top;
  ctx.save();
  ctx.translate(x, y); ctx.scale(k, k);
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.fillRect(0, 0, LEGEND_W, h);
  ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 1;
  ctx.strokeRect(.5, .5, LEGEND_W - 1, h - 1);
  ctx.font = `600 12px ${FONT}`;
  ctx.fillStyle = '#111'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('RSSI (dBm)', 8, 12);
  ctx.font = `12px ${FONT}`;
  items.forEach((it, i) => {
    const yy = top + i * lh;
    ctx.fillStyle = it.color; ctx.fillRect(8, yy + 2, 14, lh - 6);
    ctx.fillStyle = '#111'; ctx.fillText(lines[i], 30, yy + lh / 2 - 1);
  });
  // « pas de service » : sa propre ligne, distincte de la classe « < dernier seuil »
  const yy = top + items.length * lh, mid = yy + 2 + (lh - 6) / 2;
  ctx.fillStyle = NO_SERVICE.color; ctx.fillRect(8, yy + 2, 14, lh - 6);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.setLineDash([3, 2.5]);
  ctx.beginPath(); ctx.moveTo(8, mid); ctx.lineTo(22, mid); ctx.stroke();
  ctx.fillStyle = '#111'; ctx.fillText(lines[items.length], 30, yy + lh / 2 - 1, LEGEND_W - 34);
  ctx.restore();
}

/** Barre d'échelle « ronde » d'environ 120 px (× k), extrémité gauche de la barre en (x, y). */
export function drawScaleBar(ctx, t, mPerPx, x, y, k = 1, lang) {
  const L = niceLength(120 * k / t.s * mPerPx);
  const w = L / mPerPx * t.s;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.fillRect(x - 8 * k, y - 22 * k, w + 16 * k, 34 * k);
  ctx.fillStyle = '#111';
  ctx.fillRect(x, y, w, 4 * k);
  ctx.fillRect(x, y - 6 * k, 2 * k, 10 * k); ctx.fillRect(x + w - 2 * k, y - 6 * k, 2 * k, 10 * k);
  ctx.font = `${12 * k}px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(fmtMeters(L, lang), x + w / 2, y - 6 * k);
  ctx.restore();
}
