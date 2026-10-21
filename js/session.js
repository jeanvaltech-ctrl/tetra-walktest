// session.js — mesure par waypoints (comme SCOUT).
// Un clic = la position actuelle. Les échantillons reçus entre deux clics sont répartis
// linéairement sur le segment, au prorata du temps de mesure (pauses exclues).
//
// États : idle → (start) → ready → (clic) → walking ⇄ (pause/resume) paused
//         walking/paused → (endSegment) → ready ; → (stop) → idle
//
// Données écrites dans floor.segments :
//   { id, points: [{x, y, ta}], samples: [{...mesure, time, ta, x, y, leg}] }
//   ta  : temps « actif » en ms (horloge moins le temps passé en pause)
//   leg : n° du point qui termine le tronçon sur lequel l'échantillon est placé
import { dist } from './geometry.js';

export class Session extends EventTarget {
  constructor(floor, now = () => Date.now()) {
    super();
    this.floor = floor;
    this.now = now;
    this.state = 'idle';
    this.seg = null;          // segment ouvert
    this.pending = [];        // échantillons depuis le dernier clic
    this.pausedTotal = 0;
    this.pauseStart = 0;
  }

  changed() { this.dispatchEvent(new Event('change')); }
  active(t) { return t - this.pausedTotal; }

  start() {
    if (this.state !== 'idle') return false;
    this.state = 'ready';
    this.changed();
    return true;
  }

  /** Enregistre une mesure ; ignorée hors segment ouvert ou en pause. */
  addSample(snapshot, time = this.now()) {
    if (this.state !== 'walking') return false;
    this.pending.push({ ...snapshot, time, ta: this.active(time) });
    this.changed();
    return true;
  }

  /** Clic sur le plan = position actuelle (coordonnées image). */
  click(p) {
    const ta = this.active(this.now());
    if (this.state === 'ready') {
      this.seg = { id: crypto.randomUUID(), points: [{ x: p.x, y: p.y, ta }], samples: [] };
      this.floor.segments.push(this.seg);
      this.pending = [];
      this.state = 'walking';
    } else if (this.state === 'walking') {
      const pts = this.seg.points, a = pts[pts.length - 1], b = { x: p.x, y: p.y, ta };
      pts.push(b);
      placeSamples(this.pending, a, b, pts.length - 1);
      this.seg.samples.push(...this.pending);
      this.pending = [];
    } else {
      return false;
    }
    this.changed();
    return true;
  }

  pause() {
    if (this.state !== 'walking') return false;
    this.state = 'paused';
    this.pauseStart = this.now();
    this.changed();
    return true;
  }

  resume() {
    if (this.state !== 'paused') return false;
    this.pausedTotal += this.now() - this.pauseStart;
    this.state = 'walking';
    this.changed();
    return true;
  }

  /** Ferme le segment au dernier point cliqué ; retourne le nombre d'échantillons non placés (perdus). */
  endSegment() {
    if (this.state !== 'walking' && this.state !== 'paused') return 0;
    if (this.state === 'paused') this.pausedTotal += this.now() - this.pauseStart;
    const lost = this.pending.length;
    this.pending = [];
    if (this.seg.points.length === 1) this.removeSegment(this.seg);   // point de départ seul
    this.seg = null;
    this.state = 'ready';
    this.changed();
    return lost;
  }

  stop() {
    const lost = this.endSegment();
    this.state = 'idle';
    this.changed();
    return lost;
  }

  /**
   * Annule le dernier point cliqué. Les échantillons de son tronçon redeviennent « en attente »
   * et seront replacés au prochain clic. Après une fin de segment, rouvre le segment précédent.
   */
  undo() {
    if (this.state === 'idle') return false;
    if (this.state === 'ready') {
      const last = this.floor.segments[this.floor.segments.length - 1];
      if (!last) return false;
      this.seg = last;
      this.pending = [];
      this.state = 'walking';
    }
    const seg = this.seg, idx = seg.points.length - 1;
    if (idx === 0) {
      this.removeSegment(seg);
      if (this.state === 'paused') this.pausedTotal += this.now() - this.pauseStart;
      this.seg = null;
      this.pending = [];
      this.state = 'ready';
    } else {
      const back = seg.samples.filter(s => s.leg === idx);
      seg.samples = seg.samples.filter(s => s.leg !== idx);
      for (const s of back) { delete s.x; delete s.y; delete s.leg; }
      this.pending = back.concat(this.pending);
      seg.points.pop();
    }
    this.changed();
    return true;
  }

  removeSegment(seg) {
    const i = this.floor.segments.indexOf(seg);
    if (i >= 0) this.floor.segments.splice(i, 1);
  }

  /** État à conserver pour reprendre après un crash (avec floor.segments, sauvegardé à part). */
  snapshot() {
    return {
      state: this.state, segId: this.seg ? this.seg.id : null, pending: this.pending,
      pausedTotal: this.pausedTotal, pauseStart: this.pauseStart, savedAt: this.now(),
    };
  }

  /**
   * Reprise après crash : une mesure en cours repart en pause au dernier point cliqué,
   * avec ses mesures en attente. Le temps écoulé depuis la sauvegarde compte comme une pause.
   */
  static restore(floor, snap, now = () => Date.now()) {
    const s = new Session(floor, now);
    if (!snap || snap.state === 'idle') return s;
    s.pausedTotal = snap.pausedTotal || 0;
    s.seg = floor.segments.find(x => x.id === snap.segId) || null;
    if (snap.state === 'ready' || !s.seg) {
      s.state = 'ready';
      s.seg = null;
    } else {
      s.state = 'paused';
      s.pending = snap.pending || [];
      s.pauseStart = snap.state === 'paused' ? snap.pauseStart : snap.savedAt;
    }
    return s;
  }

  get canUndo() {
    return this.state !== 'idle' && (this.seg !== null || this.floor.segments.length > 0);
  }

  /** Dernier point cliqué du segment ouvert (pour dessiner le tronçon en cours). */
  get lastPoint() {
    return this.seg ? this.seg.points[this.seg.points.length - 1] : null;
  }
}

/** Répartit les échantillons sur le tronçon a → b au prorata du temps actif. */
export function placeSamples(samples, a, b, leg) {
  const span = b.ta - a.ta;
  for (const s of samples) {
    const f = span > 0 ? Math.min(1, Math.max(0, (s.ta - a.ta) / span)) : 1;
    s.x = a.x + f * (b.x - a.x);
    s.y = a.y + f * (b.y - a.y);
    s.leg = leg;
  }
}

/** Statistiques d'un étage : points de mesure, segments, longueur parcourue (px image). */
export function floorStats(floor) {
  let samples = 0, length = 0;
  for (const seg of floor.segments) {
    samples += seg.samples.length;
    for (let i = 1; i < seg.points.length; i++) length += dist(seg.points[i - 1], seg.points[i]);
  }
  return { samples, segments: floor.segments.length, length };
}
