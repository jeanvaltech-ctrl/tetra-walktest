// protocol.js — couche trame et décodage des mesures du Motorola MTP6550.
// Port JS de tools/mtp_trace.py ; référence : docs/PROTOCOL.md.

export const ESC = 0x1b;
const E4 = 0xe4, P = 0x50, S = 0x53;

// Voisines 1..4 : id de base (LA) ; canal = base-1, RSSI = base+1
export const NEIGH = { 1: 0x18, 2: 0x28, 3: 0x38, 4: 0xa8 };
export const CX_ID = { 1: 0x20, 2: 0x30, 3: 0x40, 4: 0xa0 };
export const LA_EMPTY = 65535;

// ---------- commandes PC -> radio ----------
const bytes = (...a) => Uint8Array.from(a.flatMap(x => typeof x === 'string' ? [...x].map(c => c.charCodeAt(0)) : [x]));

/** Encode une commande PC -> radio : ESC 'P' <corps échappé> ESC 'S'. */
export function buildCmd(body) {
  const out = [ESC, P];
  for (const b of body) b === ESC ? out.push(ESC, E4) : out.push(b);
  out.push(ESC, S);
  return Uint8Array.from(out);
}

export const CMD = {
  open: bytes('a', 0x03),        // ouvrir la session
  close: bytes('a', 0x04),       // fermer la session
  start: bytes('g', 0x03),       // démarrer le flux de trace
  stop: bytes('g', 0x04),        // arrêter le flux
  config: bytes('i', 0x01, 0x08),
  // lire une info radio ; les ids 0x08 et 0x12 sont suivis d'un octet 00
  info: id => (id === 0x08 || id === 0x12) ? bytes('e', 'q', id, 0x00) : bytes('e', 'q', id),
};

// Infos lues à la connexion (commande 'e' 'q' <id>)
export const INFO = [
  { id: 0x00, key: 'issi', label: 'ISSI' },
  { id: 0x02, key: 'model', label: 'Modèle' },
  { id: 0x01, key: 'serial', label: 'N° de série' },
  { id: 0x03, key: 'tei', label: 'TEI' },
  { id: 0x12, key: 'software', label: 'Logiciel' },
  { id: 0x0f, key: 'codeplug', label: 'Codeplug' },
];

// ---------- radio -> PC ----------
const latin1 = d => String.fromCharCode(...d).replace(/^\0+|\0+$/g, '').trim();
export const toHex = d => [...d].map(b => b.toString(16).padStart(2, '0')).join('');

/** Réponse 'G' 'q' 00 00 00 00 <id> <données> -> {id, value} (texte), null sinon. */
export function parseInfo(body) {
  if (body.length < 7 || body[0] !== 0x47 || body[1] !== 0x71) return null;
  const id = body[6], d = body.subarray(7);
  let value;
  switch (id) {
    case 0x00: value = String(d.subarray(-4).reduce((a, b) => a * 256 + b, 0)); break;   // ISSI
    case 0x03: value = toHex(d).toUpperCase().slice(0, 15); break;                        // TEI
    case 0x0f: value = d.length >= 4 ? `${(d[0] << 8) | d[1]}.${((d[2] << 8) | d[3]).toString(16)}` : toHex(d); break;
    case 0x0d: value = latin1(d).replace(/^(.*?UTC \d{4}).*$/, '$1'); break;               // date de build
    default: value = latin1(d);
  }
  return { id, value };
}
/** Découpe le flux brut radio -> PC en corps de trame déséchappés. */
export class Deframer {
  constructor() { this.buf = new Uint8Array(0); }

  feed(data) {
    const nb = new Uint8Array(this.buf.length + data.length);
    nb.set(this.buf); nb.set(data, this.buf.length);
    this.buf = nb;
    const out = [];
    for (;;) {
      const buf = this.buf;
      let s = -1;
      for (let i = 0; i < buf.length - 1; i++) if (buf[i] === ESC && buf[i + 1] === S) { s = i; break; }
      if (s < 0) { this.buf = buf.slice(-1); return out; }
      let j = s + 2, done = false;
      const body = [];
      while (j < buf.length - 1) {
        if (buf[j] === ESC) {
          const nxt = buf[j + 1];
          if (nxt === E4) { body.push(ESC); j += 2; continue; }
          if (nxt === P) { done = true; break; }
        }
        body.push(buf[j]); j++;
      }
      if (!done) { this.buf = buf.slice(s); return out; }   // trame incomplète
      out.push(Uint8Array.from(body));
      this.buf = buf.slice(j + 2);
    }
  }
}

/** Corps 'B' -> Map {id: valeur} ou null si ce n'est pas un bloc de mesure. */
export function decodeRecords(body) {
  if (body.length < 6 || body[0] !== 0x42 || body[3] !== 0x6f || body[4] !== 0x00 || body[5] !== 0x00) return null;
  let q = body.subarray(6, 3 + body[2]);
  const rec = new Map();
  while (q.length >= 8) {
    rec.set(q[0], new DataView(q.buffer, q.byteOffset + 4, 4).getInt32(0, false));
    q = q.subarray(8);
  }
  return rec;
}

/** Accumule les blocs : un point complet = dernière serveuse + voisines. */
export class MeasureState {
  constructor() { this.v = new Map(); }

  /** Retourne true si le bloc contient la serveuse (LA + RSSI) => nouveau point. */
  update(rec) {
    for (const [k, x] of rec) this.v.set(k, x);
    return rec.has(0x08) && rec.has(0x09);
  }

  snapshot() {
    const v = this.v, g = (id, d = '') => v.has(id) ? v.get(id) : d;
    const row = { la: g(0x08), channel: g(0x07, 0) & 0xfff, rssi: g(0x09), c1: g(0x10) };
    for (const [n, b] of Object.entries(NEIGH)) {
      const la = v.get(b), ok = la !== undefined && la !== LA_EMPTY;
      row[`n${n}_la`] = ok ? la : '';
      row[`n${n}_channel`] = ok ? g(b - 1, 0) & 0xfff : '';
      row[`n${n}_rssi`] = ok ? g(b + 1) : '';
      row[`n${n}_cx`] = ok ? g(CX_ID[n]) : '';
    }
    return row;
  }
}

/** Texte hexadécimal ("1b 53 …" ou "1b53…") -> Uint8Array, null si invalide. */
export function hexToBytes(h) {
  h = h.replace(/\s+/g, '');
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
