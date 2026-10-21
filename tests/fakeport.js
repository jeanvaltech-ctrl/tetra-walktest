// fakeport.js — faux port Web Serial qui imite un MTP6550, pour tester radio.js sans radio.
import { buildCmd, CMD, ESC } from '../js/protocol.js';

const hex = a => [...a].map(b => b.toString(16).padStart(2, '0')).join(' ');

/** Encode une trame radio -> PC : ESC 'S' <corps échappé> ESC 'P'. */
export function radioFrame(body) {
  const out = [ESC, 0x53];
  for (const b of body) b === ESC ? out.push(ESC, 0xe4) : out.push(b);
  out.push(ESC, 0x50);
  return out;
}

export class FakePort {
  /**
   * @param info    {id: [octets de données]} réponses aux 'e q <id>'
   * @param bodies  corps de trames envoyés après g03
   */
  constructor({ info = {}, bodies = [] } = {}) {
    this.info = info;
    this.bodies = bodies;
    this.sent = [];          // commandes reçues (hex)
    this.readable = null;
    this.writable = null;
    this.closed = false;
  }

  getInfo() { return { usbVendorId: 0x0cad, usbProductId: 0x9012 }; }

  async open() {
    this.readable = new ReadableStream({ start: c => { this.ctrl = c; } });
    this.writable = new WritableStream({ write: chunk => this.onCommand(chunk) });
  }

  async close() { this.closed = true; this.readable = null; this.writable = null; }

  push(bytes) { this.ctrl.enqueue(Uint8Array.from(bytes)); }

  onCommand(chunk) {
    const h = hex(chunk);
    this.sent.push(h);
    for (const [id, data] of Object.entries(this.info)) {
      if (h === hex(buildCmd(CMD.info(+id)))) this.push(radioFrame([0x47, 0x71, 0, 0, 0, 0, +id, ...data]));
    }
    if (h === hex(buildCmd(CMD.start))) {
      const stream = this.bodies.flatMap(b => radioFrame(b));
      for (let i = 0; i < stream.length; i += 100) this.push(stream.slice(i, i + 100));
    }
  }

  /** Simule l'arrachage du câble USB. */
  unplug() {
    this.readable = null;
    this.writable = null;
    this.ctrl.error(new DOMException('The device has been lost.', 'NetworkError'));
  }
}

export const cmdHex = body => hex(buildCmd(body));
