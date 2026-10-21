// radio.js — connexion au MTP6550 par l'API Web Serial.
// Séquence (comme SCOUT) : a03 → (g04) → identité 'e q' → g03 → i0108 … flux … g04 → a04.
// Événements :
//   state     {state: 'disconnected' | 'connecting' | 'streaming', message}
//   identity  {issi, model, serial, tei, software, codeplug}
//   frame     {time, body}       chaque trame reçue (pour l'enregistrement brut)
//   measure   {time, rec, snapshot}   nouveau point (bloc cellule serveuse)
//   lost      la radio a été débranchée
import { buildCmd, CMD, Deframer, decodeRecords, MeasureState, parseInfo, INFO } from './protocol.js';

export const RADIO_VID = 0x0cad;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Radio extends EventTarget {
  constructor() {
    super();
    this.port = null;
    this.state = 'disconnected';
    this.info = {};
    this.queryTimeout = 600;     // ms par info d'identité
    this.closing = false;
    this.reset();
    if (navigator.serial) {
      navigator.serial.addEventListener('disconnect', e => { if (e.target === this.port) this.lost(); });
    }
  }

  reset() {
    this.deframer = new Deframer();
    this.measure = new MeasureState();
    this.waiters = new Map();
    this.writeChain = Promise.resolve();
    this.lastFrameAt = 0;
    this.lastMeasureAt = 0;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  setState(state, message = '') { this.state = state; this.emit('state', { state, message }); }

  async connect(port) {
    if (this.port) throw new Error('Une radio est déjà connectée.');
    this.reset();
    this.info = {};
    this.setState('connecting');
    try {
      await port.open({ baudRate: 115200 });   // débit sans effet (USB)
    } catch (e) {
      this.setState('disconnected');
      throw Object.assign(new Error(`Impossible d'ouvrir le port (${e.message}). SCOUT ou mtp_live.py est peut-être encore ouvert.`), { code: 'open' });
    }
    this.port = port;
    this.reading = this.readLoop(port);
    try {
      await this.send(CMD.open);
      await this.send(CMD.stop);          // au cas où un flux serait resté actif
      for (const { id, key } of INFO) {
        const v = await this.query(id);
        if (v !== null) this.info[key] = v;
        else if (id === INFO[0].id) break;    // muette dès la 1re question : inutile d'insister
      }
      if (!Object.keys(this.info).length) {
        // port ouvert mais aucun octet : Port 2 choisi, ou radio bloquée (câble arraché en plein flux)
        throw Object.assign(new Error('Aucune réponse de la radio. Vérifiez que le port choisi est « Portable Tetra Radio Port 1 ». '
          + 'Si c\'est le bon port, éteignez puis rallumez la radio (câble branché) : après un câble arraché '
          + 'en pleine mesure, la radio ne répond plus jusqu\'à son redémarrage.'), { code: 'silent' });
      }
      this.emit('identity', this.info);
      await this.send(CMD.start);
      await sleep(100);
      await this.send(CMD.config);
      this.setState('streaming');
    } catch (e) {
      await this.disconnect();
      throw e;
    }
  }

  /** Arrêt propre : g04 → a04, puis fermeture du port. */
  async disconnect() {
    const port = this.port;
    if (!port) return;
    try {
      await this.send(CMD.stop); await sleep(100);
      await this.send(CMD.close); await sleep(100);
    } catch { /* port déjà perdu */ }
    this.closing = true;
    try { await this.reader?.cancel(); } catch { /* déjà fermé */ }
    try { await this.reading; } catch { /* idem */ }
    try { await port.close(); } catch { /* idem */ }
    this.port = null;
    this.closing = false;
    this.failWaiters();
    this.setState('disconnected');
  }

  /** Fermeture de la page : g04 + a04 envoyés sans attendre. */
  stopNow() {
    try {
      const w = this.port?.writable?.getWriter();
      if (!w) return;
      w.write(buildCmd(CMD.stop));
      w.write(buildCmd(CMD.close));
      w.releaseLock();
    } catch { /* tant pis : la page se ferme */ }
  }

  lost() {
    if (!this.port || this.closing) return;
    const port = this.port;
    this.port = null;
    this.failWaiters();
    port.close().catch(() => {});
    this.setState('disconnected', 'Radio débranchée.');
    this.emit('lost');
  }

  // ---------- écriture ----------
  send(body) {
    const port = this.port;
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      if (!port || !port.writable) throw new Error('Port fermé.');
      const w = port.writable.getWriter();
      try { await w.write(buildCmd(body)); } finally { w.releaseLock(); }
    });
    return this.writeChain;
  }

  /** Lit une info radio ; résout la valeur texte, ou null après queryTimeout. */
  query(id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); resolve(null); }, this.queryTimeout);
      this.waiters.set(id, v => { clearTimeout(timer); resolve(v); });
      this.send(CMD.info(id)).catch(e => { clearTimeout(timer); this.waiters.delete(id); reject(e); });
    });
  }

  failWaiters() {
    for (const done of this.waiters.values()) done(null);
    this.waiters.clear();
  }

  // ---------- lecture ----------
  async readLoop(port) {
    while (port.readable && !this.closing) {
      const reader = port.readable.getReader();
      this.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) this.onData(value);
        }
      } catch (e) {
        // erreurs non fatales (trame série) : on reprend ; NetworkError = câble débranché
        if (!this.closing) console.warn('Lecture série :', e);
      } finally {
        reader.releaseLock();
      }
    }
    if (!this.closing && this.port === port) this.lost();
  }

  onData(chunk) {
    const time = new Date();
    for (const body of this.deframer.feed(chunk)) {
      this.lastFrameAt = time.getTime();
      this.emit('frame', { time, body });
      const info = parseInfo(body);
      if (info) {
        const done = this.waiters.get(info.id);
        if (done) { this.waiters.delete(info.id); done(info.value); }
        continue;
      }
      const rec = decodeRecords(body);
      if (rec && this.measure.update(rec)) {
        this.lastMeasureAt = time.getTime();
        this.emit('measure', { time, rec, snapshot: this.measure.snapshot() });
      }
    }
  }
}
