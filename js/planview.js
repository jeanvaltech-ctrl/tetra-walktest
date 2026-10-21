// planview.js — affichage du plan sur un canvas : déplacement, zoom (molette, pinch), clics.
// Événements émis (detail en coordonnées image) :
//   planclick {x, y}   clic sans déplacement (bouton gauche / tap)
//   planhover {x, y}   survol sans bouton enfoncé
//   planleave          la souris quitte le plan
//   viewchange         zoom ou déplacement
import { ViewTransform, dist } from './geometry.js';

const DRAG_PX = 4;   // au-delà, un appui devient un déplacement et non un clic

export class PlanView extends EventTarget {
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.t = new ViewTransform();
    this.image = null;           // ImageBitmap ou HTMLImageElement
    this.drawOverlay = null;     // (ctx, transform) => void, en pixels CSS
    this.cw = 0; this.ch = 0;
    this.needFit = false;
    this.pointers = new Map();
    this.gesture = null;
    this.raf = 0;

    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointerdown', e => this.onDown(e));
    canvas.addEventListener('pointermove', e => this.onMove(e));
    canvas.addEventListener('pointerup', e => this.onUp(e, false));
    canvas.addEventListener('pointercancel', e => this.onUp(e, true));
    canvas.addEventListener('pointerleave', () => this.emit('planleave'));
    canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  setImage(image) {
    this.image = image;
    this.pointers.clear();
    this.gesture = null;
    this.fit();
    this.redraw();
  }

  fit() {
    if (!this.image || !this.cw) { this.needFit = true; return; }
    this.t.fit(this.image.width, this.image.height, this.cw, this.ch);
    this.needFit = false;
    this.changed();
  }

  /** Zoom centré sur le milieu de la vue. */
  zoomBy(factor) {
    this.t.zoomAt({ x: this.cw / 2, y: this.ch / 2 }, factor);
    this.changed();
  }

  changed() { this.emit('viewchange'); this.redraw(); }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.cw = this.canvas.clientWidth; this.ch = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.cw * dpr);
    this.canvas.height = Math.round(this.ch * dpr);
    if (this.needFit) this.fit(); else this.redraw();
  }

  redraw() {
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  draw() {
    const { ctx, t } = this, dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cw, this.ch);
    if (!this.image) return;
    ctx.save();
    ctx.translate(t.tx, t.ty);
    ctx.scale(t.s, t.s);
    ctx.fillStyle = '#fff';      // fond blanc sous les PNG transparents
    ctx.fillRect(0, 0, this.image.width, this.image.height);
    ctx.imageSmoothingEnabled = t.s < 3;
    ctx.drawImage(this.image, 0, 0);
    ctx.restore();
    if (this.drawOverlay) this.drawOverlay(ctx, t);
  }

  // ---------- pointeurs ----------
  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  pinchInfo() {
    const [a, b] = [...this.pointers.values()];
    return { d: dist(a, b), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  onDown(e) {
    if (!this.image) return;
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      this.gesture = { type: 'tap', start: p, last: p, button: e.button };
    } else if (this.pointers.size === 2) {
      this.gesture = { type: 'pinch', ...this.pinchInfo() };
    }
  }

  onMove(e) {
    const p = this.local(e);
    if (!this.pointers.has(e.pointerId)) {
      if (this.image && e.pointerType === 'mouse') this.emit('planhover', this.t.toImage(p));
      return;
    }
    this.pointers.set(e.pointerId, p);
    const g = this.gesture;
    if (!g) return;
    if (g.type === 'tap' && dist(g.start, p) > DRAG_PX) g.type = 'pan';
    if (g.type === 'pan') {
      this.t.pan(p.x - g.last.x, p.y - g.last.y);
      g.last = p;
      this.changed();
    } else if (g.type === 'pinch' && this.pointers.size === 2) {
      const { d, mid } = this.pinchInfo();
      if (g.d > 0) this.t.zoomAt(mid, d / g.d);
      this.t.pan(mid.x - g.mid.x, mid.y - g.mid.y);
      g.d = d; g.mid = mid;
      this.changed();
    }
  }

  onUp(e, cancelled) {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.local(e), g = this.gesture;
    this.pointers.delete(e.pointerId);
    if (g && g.type === 'tap' && !cancelled && g.button === 0) this.emit('planclick', this.t.toImage(p));
    if (this.pointers.size === 1 && g && g.type === 'pinch') {
      // fin du pinch : le doigt restant continue en déplacement
      this.gesture = { type: 'pan', last: [...this.pointers.values()][0] };
    } else if (this.pointers.size === 0) {
      this.gesture = null;
    }
  }

  onWheel(e) {
    if (!this.image) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 0.05 : 0.0015;   // lignes ou pixels
    this.t.zoomAt(this.local(e), Math.exp(-e.deltaY * k));
    this.changed();
  }
}
