// atp.js — lecture d'un fichier SCOUT .atp (texte). Port de parse_atp() de tools/mtp_trace.py.
import { decodeRecords, MeasureState, hexToBytes } from './protocol.js';

/**
 * @param {string} text  contenu du .atp (décodé en latin1)
 * @returns {{header: Object, rows: Object[], bodies: {time: string, body: Uint8Array}[]}}
 * x, y : pixels du PNG SCOUT, origine au centre, y vers le bas.
 */
export function parseAtp(text, floor = '') {
  const header = {}, rows = [], bodies = [], st = new MeasureState();
  let pos = null;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.startsWith('#UM,')) {
      const [, i, kind, x, y] = line.split(',');
      pos = { n: +i, kind, x: +x, y: +y };
    } else if (line.startsWith('#')) {
      const k = line.indexOf(':');
      if (k >= 0) header[line.slice(1, k).trim()] = line.slice(k + 1).trim();
    } else if (/^\d/.test(line) && line.includes(' ')) {
      const sp = line.indexOf(' '), time = line.slice(0, sp);
      const body = hexToBytes(line.slice(sp + 1));
      if (!body) continue;
      bodies.push({ time, body });
      const rec = decodeRecords(body);
      if (rec && st.update(rec) && pos) {
        rows.push({ time, floor, x: +pos.x.toFixed(1), y: +pos.y.toFixed(1), seg: pos.kind, ...st.snapshot() });
      }
    }
  }
  return { header, rows, bodies };
}
