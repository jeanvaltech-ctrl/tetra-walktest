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
//   noService : 'noserving' | 'silent' sur un point « pas de service » (mesures vides : noir, non conforme)
//               'noserving' : trames reçues sans cellule serveuse ; 'silent' : silence compté par l'utilisateur
//
// « No service » ne vient que de trames reçues sans cellule serveuse (une vraie zone morte ne fait pas
// taire la radio, voir docs/PROTOCOL.md). Un silence total n'est jamais compté sans confirmation.
import { dist } from './geometry.js';
import { NEIGH } from './protocol.js';

export const NO_SERVICE_MS = 3000;   // sans mesure valide de la cellule serveuse pendant la marche
const NO_SERVICE_STEP_MS = 1000;     // un point « pas de service » par seconde manquante

// mêmes champs qu'un instantané de mesure (MeasureState.snapshot), tous vides
const EMPTY_MEASURE = Object.fromEntries(['la', 'channel', 'rssi', 'c1',
  ...Object.keys(NEIGH).flatMap(n => [`n${n}_la`, `n${n}_channel`, `n${n}_rssi`, `n${n}_cx`])].map(k => [k, '']));

/** Au-delà de ce retard du contrôle de chaque seconde, sans aucune trame : l'ordinateur était en veille. */
export const FREEZE_MS = 10000;
export const isFreeze = (lastTick, now, lastFrameAt) => now - lastTick > FREEZE_MS && !(lastFrameAt > lastTick);

/** 'noserving' : la radio envoie des trames, mais sans cellule serveuse ; 'silent' : plus aucune trame. */
export const noServiceCause = (lastFrameAt, now) =>
  lastFrameAt && now - lastFrameAt < NO_SERVICE_MS ? 'noserving' : 'silent';

/**
 * Plus aucune trame depuis NO_SERVICE_MS pendant la marche : pause datée de la dernière trame, sans point.
 * reason : 'standby' si la page est cachée ou a été figée (veille), 'silent' si elle est visible.
 * since : début du temps de marche à surveiller (reprise, ou dernière mesure si aucune trame n'est arrivée).
 */
export function silenceAction({ state, hidden, frozen, lastFrameAt, now, since = 0 }) {
  if (state !== 'walking') return null;
  const pauseAt = Math.max(lastFrameAt || 0, since);
  if (now - pauseAt < NO_SERVICE_MS) return null;
  return { pauseAt, reason: hidden || frozen ? 'standby' : 'silent' };
}

// textes de la barre d'état qui parlent d'une pause : à remplacer dès que la session change d'état
const PAUSE_STATUS = new Set(['status.pausedClickResume', 'status.radioPaused', 'status.recoveredPaused', 'status.reconnectedResume',
  'status.standby', 'status.silencePaused', 'notify.frozen', 'live.silent']);
const STATE_STATUS = { walking: 'status.measureResumed', ready: 'help.ready', idle: 'status.ready' };

/** Clé du texte qui remplace prevKey dans la barre d'état pour cet état de session ; null : il reste. */
export function statusAfterChange(prevKey, sessionState) {
  if (sessionState === 'paused') return prevKey === 'status.measureResumed' ? 'status.pausedClickResume' : null;
  if (!PAUSE_STATUS.has(prevKey) && prevKey !== 'status.measureResumed') return null;
  const key = STATE_STATUS[sessionState];
  return key === prevKey ? null : key;
}

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
    this.validTa = 0;         // temps actif de la dernière mesure valide (ou du clic de départ)
    this.gapTa = 0;           // … du dernier point déjà couvert (mesure valide ou « pas de service »)
    this.cause = 'silent';    // dernière cause connue, pour les vérifications faites par la session
    this.lastFrameAt = 0;     // horodatage de la dernière trame radio (quelle qu'elle soit)
    this.silences = [];       // [début, fin] des silences radio d'au moins NO_SERVICE_MS
    this.walkingSince = 0;    // dernier passage à l'état walking (clic de départ, reprise)
    this.silence = null;      // pause automatique pour silence radio en cours : { reason: 'standby' | 'silent' }
  }

  /**
   * Trame radio reçue (horodatage de réception). La cause de chaque point « pas de service »
   * se déduit de ces horodatages, pas du moment où le contrôle passe (minuteur freiné en arrière-plan).
   * Retourne la durée (ms) d'un silence de marche découvert seulement maintenant, sinon 0 : il n'est pas compté.
   */
  noteFrame(time) {
    let unseen = 0;
    if (this.lastFrameAt && time - this.lastFrameAt >= NO_SERVICE_MS) {
      this.silences.push([this.lastFrameAt, time]);
      if (this.silences.length > 200) this.silences.shift();
      const from = Math.max(this.lastFrameAt, this.walkingSince);
      if (this.state === 'walking' && time - from >= NO_SERVICE_MS) unseen = time - from;
    }
    if (time > this.lastFrameAt) this.lastFrameAt = time;
    // radio revenue pendant la pause « silence » : fin réelle du silence (seule cette durée peut être comptée)
    if (this.state === 'paused' && this.silence && this.silence.endAt == null && time > this.pauseStart) this.silence.endAt = time;
    return unseen;
  }

  /** Cause d'après les trames notées : 'silent' si aucune trame depuis NO_SERVICE_MS à cet instant, ou dans un silence passé. */
  causeAt(time, fallback) {
    if (!this.lastFrameAt) return fallback;
    if (time - this.lastFrameAt >= NO_SERVICE_MS) return 'silent';
    return this.silences.some(([a, b]) => time > a && time < b) ? 'silent' : 'noserving';
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
    // un trou vu en retard (contrôle freiné quand la fenêtre est réduite) est couvert avant la mesure
    this.checkService(time - 1, this.cause);
    const ta = this.active(time);
    this.pending.push({ ...snapshot, time, ta });
    this.validTa = this.gapTa = ta;
    this.changed();
    return true;
  }

  /** Temps de marche (ms) sans mesure valide. */
  serviceGap(now = this.now()) { return this.active(now) - this.validTa; }

  /**
   * Passé NO_SERVICE_MS sans mesure valide, couvre le trou d'un point « pas de service » par seconde
   * manquante, en partant de la dernière mesure valide. Retourne le nombre de points ajoutés.
   * Seules les secondes où des trames arrivent donnent un point ('noserving') : une seconde après la dernière
   * trame attend la suivante (peut-être le début d'un silence), une seconde de silence n'en donne jamais.
   */
  checkService(now = this.now(), cause = 'silent') {
    this.cause = cause;
    if (this.state !== 'walking') return 0;
    const taNow = this.active(now);
    if (taNow - this.validTa < NO_SERVICE_MS) return 0;
    let added = 0;
    for (let ta = this.gapTa + NO_SERVICE_STEP_MS; ta <= taNow; ta += NO_SERVICE_STEP_MS) {
      const time = now - (taNow - ta);
      if (this.lastFrameAt && time > this.lastFrameAt) break;
      if (this.causeAt(time, cause) === 'noserving') {
        this.addNoService({ ...EMPTY_MEASURE, noService: 'noserving', time, ta });
        added++;
      }
      this.gapTa = ta;
    }
    if (added) this.changed();
    return added;
  }

  /** Applique silenceAction à la session : pause sans point. Retourne { pauseAt, reason } ou null. */
  checkSilence({ hidden = false, frozen = false, lastFrameAt = this.lastFrameAt, now = this.now() } = {}) {
    const since = Math.max(this.walkingSince, this.validTa + this.pausedTotal);
    const action = silenceAction({ state: this.state, hidden, frozen, lastFrameAt, now, since });
    if (!action) return null;
    this.silence = { reason: action.reason };
    this.pause(action.pauseAt);
    return { pauseAt: this.pauseStart, reason: action.reason };
  }

  /**
   * « Compter ce silence comme No service » : reprise, et le silence reçoit un point 'silent' par seconde,
   * placé comme les autres. Seule la durée réelle du silence compte (décision de Jean, 05/11/2026) : de la
   * dernière trame avant la pause à la première trame reçue après ; si la radio est encore muette, jusqu'à
   * maintenant. Le temps entre le retour de la radio et le clic reste une pause. Retourne le nombre de points.
   */
  countSilence(now = this.now()) {
    if (this.state !== 'paused' || !this.silence || this.silence.reason !== 'silent') return 0;
    const end = Math.min(this.silence.endAt ?? now, now);
    this.silence = null;
    this.pausedTotal += now - end;   // radio revenue avant le clic : cette attente n'est pas de la marche
    this.state = 'walking';
    this.walkingSince = now;
    const taEnd = this.active(now);  // = temps actif à la fin réelle du silence
    let added = 0;
    for (let ta = this.gapTa + NO_SERVICE_STEP_MS; ta <= taEnd; ta += NO_SERVICE_STEP_MS) {
      this.addNoService({ ...EMPTY_MEASURE, noService: 'silent', time: end - (taEnd - ta), ta });
      this.gapTa = ta;
      added++;
    }
    this.validTa = Math.max(this.validTa, taEnd);   // pas de second remplissage du même silence par checkService
    this.changed();
    return added;
  }

  /**
   * Jette les mesures en attente, sans toucher à ce qui est placé. La période jetée compte comme une pause :
   * ni point « pas de service » pour elle, ni tassement des mesures suivantes au bout du tronçon.
   */
  discardPending(now = this.now()) {
    const n = this.pending.length, noService = this.pending.filter(s => s.noService).length;
    if (!n) return { n, noService };
    const ref = this.lastPoint.ta;
    this.pausedTotal += this.active(this.state === 'paused' ? this.pauseStart : now) - ref;
    this.pending = [];
    this.validTa = this.gapTa = ref;
    this.changed();
    return { n, noService };
  }

  /**
   * Le délai peut expirer après un clic : les points d'avant ce clic vont sur leur tronçon, déjà
   * fermé (sinon il resterait vide et sa longueur irait aux mesures voisines), les autres en attente.
   */
  addNoService(s) {
    const { points, samples } = this.seg;
    if (points.length < 2 || s.ta > points[points.length - 1].ta) { this.pending.push(s); return; }
    let leg = 1;
    while (points[leg].ta < s.ta) leg++;
    placeSamples([s], points[leg - 1], points[leg], leg);
    let i = samples.length;
    while (i > 0 && samples[i - 1].ta > s.ta) i--;
    samples.splice(i, 0, s);
  }

  /** Clic sur le plan = position actuelle (coordonnées image). */
  click(p) {
    const now = this.now();
    this.checkService(now, this.cause);
    const ta = this.active(now);
    if (this.state === 'ready') {
      this.seg = { id: crypto.randomUUID(), points: [{ x: p.x, y: p.y, ta }], samples: [] };
      this.floor.segments.push(this.seg);
      this.pending = [];
      this.validTa = this.gapTa = ta;
      this.state = 'walking';
      this.walkingSince = now;
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

  /**
   * Pause ; `at` antérieur à maintenant (veille, radio muette ou perdue) : le temps depuis `at` compte comme pause.
   * Jamais avant ce qui est déjà acquis (reprise, point cliqué, point ajouté) : le temps actif ne recule pas.
   */
  pause(at = this.now()) {
    if (this.state !== 'walking') return false;
    at = Math.max(at, this.walkingSince, this.gapTa + this.pausedTotal, this.lastPoint.ta + this.pausedTotal);
    this.checkService(at, this.cause);
    this.state = 'paused';
    this.pauseStart = at;
    this.changed();
    return true;
  }

  resume() {
    if (this.state !== 'paused') return false;
    this.pausedTotal += this.now() - this.pauseStart;
    this.state = 'walking';
    this.walkingSince = this.now();
    this.silence = null;
    this.changed();
    return true;
  }

  /** Ferme le segment au dernier point cliqué ; retourne le nombre d'échantillons non placés (perdus). */
  endSegment() {
    if (this.state !== 'walking' && this.state !== 'paused') return 0;
    this.checkService(this.now(), this.cause);
    if (this.state === 'paused') this.pausedTotal += this.now() - this.pauseStart;
    const lost = this.pending.length;
    this.pending = [];
    this.silence = null;
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
      this.validTa = this.gapTa = this.active(this.now());   // le temps hors segment n'est pas un trou
      this.state = 'walking';
      this.walkingSince = this.now();
    }
    const seg = this.seg, idx = seg.points.length - 1;
    if (idx === 0) {
      this.removeSegment(seg);
      if (this.state === 'paused') this.pausedTotal += this.now() - this.pauseStart;
      this.seg = null;
      this.pending = [];
      this.silence = null;
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
      validTa: this.validTa, gapTa: this.gapTa,
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
      // copie de secours d'avant la détection : on repart de la dernière mesure connue
      const known = Math.max(s.lastPoint.ta, ...s.pending.map(x => x.ta));
      s.validTa = snap.validTa ?? known;
      s.gapTa = snap.gapTa ?? known;
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
  let samples = 0, noService = 0, length = 0;
  for (const seg of floor.segments) {
    samples += seg.samples.length;
    noService += seg.samples.filter(s => s.noService).length;
    for (let i = 1; i < seg.points.length; i++) length += dist(seg.points[i - 1], seg.points[i]);
  }
  return { samples, noService, segments: floor.segments.length, length };
}
