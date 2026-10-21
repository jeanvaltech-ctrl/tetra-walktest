// geometry.js — transformation écran <-> image et calculs d'échelle.
// Coordonnées « image » : pixels du plan importé, origine en haut à gauche, y vers le bas.

export const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Mètres par pixel image à partir de 2 points et de la distance réelle, null si invalide. */
export function metersPerPixel(p1, p2, meters) {
  const px = dist(p1, p2);
  return px > 0 && meters > 0 ? meters / px : null;
}

/** Longueur « ronde » (1, 2 ou 5 × 10^n) inférieure ou égale à m. */
export function niceLength(m) {
  const p = 10 ** Math.floor(Math.log10(m)), f = m / p;
  return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p;
}

/** écran = image × s + t (pixels CSS). */
export class ViewTransform {
  constructor() { this.s = 1; this.tx = 0; this.ty = 0; this.min = 0.01; this.max = 16; }

  toScreen(p) { return { x: p.x * this.s + this.tx, y: p.y * this.s + this.ty }; }
  toImage(p) { return { x: (p.x - this.tx) / this.s, y: (p.y - this.ty) / this.s }; }

  pan(dx, dy) { this.tx += dx; this.ty += dy; }

  /** Zoom d'un facteur en gardant fixe le point écran donné. */
  zoomAt(pt, factor) {
    const img = this.toImage(pt);
    this.s = clamp(this.s * factor, this.min, this.max);
    this.tx = pt.x - img.x * this.s;
    this.ty = pt.y - img.y * this.s;
  }

  /** Cadre une image w × h au centre d'une vue vw × vh. */
  fit(w, h, vw, vh, margin = 16) {
    const s = Math.max(0.001, Math.min((vw - 2 * margin) / w, (vh - 2 * margin) / h));
    this.s = s;
    this.min = s / 8;
    this.max = Math.max(16, s);
    this.tx = (vw - w * s) / 2;
    this.ty = (vh - h * s) / 2;
  }
}
