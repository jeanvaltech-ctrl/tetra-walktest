// simport.js — radio simulée (démonstration / formation sans MTP6550), activée par ?demo dans l'URL.
// Imite un port Web Serial : répond aux 'e q', puis envoie ~1 bloc de mesure par seconde après g03.
import { buildCmd, CMD, ESC } from './protocol.js';

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const ascii = s => [...s].map(c => c.charCodeAt(0));
const IDENTITY = {
  0x00: [0, 0, 0, 1], 0x01: ascii('DEMO000001'), 0x02: ascii('SIMULATION'),
  0x03: [0, 0, 0, 0, 0, 0, 0, 0], 0x12: ascii('DEMO'), 0x0f: [0, 1, 0, 0],
};

function frame(body) {
  const out = [ESC, 0x53];
  for (const b of body) b === ESC ? out.push(ESC, 0xe4) : out.push(b);
  out.push(ESC, 0x50);
  return Uint8Array.from(out);
}

function record(id, v) {
  return [id, 0, 0, 0, (v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
}

export class SimPort {
  constructor() { this.readable = null; this.writable = null; this.seq = 0; this.rssi = -75; this.timer = 0; }

  getInfo() { return {}; }

  async open() {
    this.readable = new ReadableStream({ start: c => { this.ctrl = c; }, cancel: () => this.halt() });
    this.writable = new WritableStream({ write: chunk => this.onCommand(Uint8Array.from(chunk)) });
  }

  async close() { this.halt(); this.readable = null; this.writable = null; }

  halt() { clearInterval(this.timer); this.timer = 0; }

  onCommand(c) {
    for (const [id, data] of Object.entries(IDENTITY)) {
      if (same(c, buildCmd(CMD.info(+id)))) this.ctrl.enqueue(frame([0x47, 0x71, 0, 0, 0, 0, +id, ...data]));
    }
    if (same(c, buildCmd(CMD.start)) && !this.timer) this.timer = setInterval(() => this.tick(), 1000);
    if (same(c, buildCmd(CMD.stop))) this.halt();
  }

  tick() {
    // marche aléatoire bornée : passe par toutes les couleurs de la légende
    this.rssi = Math.max(-110, Math.min(-55, this.rssi + Math.round((Math.random() - 0.5) * 8)));
    const r = this.rssi;
    const recs = [
      // LA et canaux fictifs
      record(0x08, 1001), record(0x07, 0x33000000 | 100), record(0x09, r), record(0x10, r + 105),
      record(0x18, 1002), record(0x17, 101), record(0x19, r - 8), record(0x20, r + 97),
      record(0x28, 1003), record(0x27, 102), record(0x29, r - 17), record(0x30, r + 88),
      record(0x38, 65535), record(0xa8, 65535),
    ].flat();
    const payload = [0x6f, 0, 0, ...recs, 0];   // dernier octet : checksum (non vérifié)
    this.seq = (this.seq + 1) & 255;
    this.ctrl.enqueue(frame([0x42, this.seq, payload.length, ...payload]));
  }
}
