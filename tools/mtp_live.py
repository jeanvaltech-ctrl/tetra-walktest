#!/usr/bin/env python3
"""
mtp_live.py — premier test de lecture directe du MTP6550 sans SCOUT (Windows).

Rejoue exactement la séquence de SCOUT vue dans la capture:
  a 03  (ouvrir session)  ->  g 03 (démarrer flux)  ->  i 01 08
  ... la radio envoie ses mesures toute seule ...
  g 04  (arrêter flux)    ->  a 04 (fermer session)

Prérequis : Python 3 + pyserial   (pip install pyserial)
            SCOUT FERMÉ (un seul programme peut ouvrir le port à la fois)
Usage     : python mtp_live.py COM5
            Ctrl+C pour arrêter (la radio est remise au repos proprement).
            Les mesures sont aussi enregistrées dans mtp_live_<date>.csv
"""
import csv
import datetime
import struct
import sys
import time

import serial  # pyserial

ESC = 0x1B
NEIGH = {1: 0x18, 2: 0x28, 3: 0x38, 4: 0xA8}
INFO = {0x00: 'ISSI', 0x01: 'N° série', 0x02: 'Model', 0x03: 'TEI', 0x12: 'Logiciel'}


def cmd(body: bytes) -> bytes:
    return b'\x1bP' + body.replace(b'\x1b', b'\x1b\xe4') + b'\x1bS'


class Deframer:
    def __init__(self):
        self.buf = bytearray()

    def feed(self, data):
        self.buf += data
        out = []
        while True:
            s = self.buf.find(b'\x1bS')
            if s < 0:
                self.buf = self.buf[-1:]
                return out
            j, body = s + 2, bytearray()
            while j < len(self.buf) - 1:
                if self.buf[j] == ESC:
                    if self.buf[j + 1] == 0xE4:
                        body.append(ESC); j += 2; continue
                    if self.buf[j + 1] == ord('P'):
                        break
                body.append(self.buf[j]); j += 1
            else:
                self.buf = self.buf[s:]
                return out
            out.append(bytes(body))
            self.buf = self.buf[j + 2:]


def records(body):
    if len(body) < 6 or body[:1] != b'B' or body[3:6] != b'\x6f\x00\x00':
        return None
    q, rec = body[6:3 + body[2]], {}
    while len(q) >= 8:
        rec[q[0]] = struct.unpack('>i', q[4:8])[0]
        q = q[8:]
    return rec


def info_text(body):
    # réponse 'G' 'q' 00 00 00 00 <id> <data>
    i, data = body[6], body[7:]
    if i == 0x00:
        return INFO[i], str(int.from_bytes(data[:4].rjust(4, b'\0'), 'big'))
    if i == 0x03:
        return INFO[i], data.hex().upper()[:15]
    return INFO.get(i, hex(i)), data.rstrip(b'\0').decode('latin1')


def read_for(port, df, seconds):
    end, frames = time.time() + seconds, []
    while time.time() < end:
        frames += df.feed(port.read(4096))
    return frames


def main():
    com = sys.argv[1] if len(sys.argv) > 1 else 'COM5'
    port = serial.Serial(com, 115200, timeout=0.1)
    df = Deframer()
    print(f'Port {com} ouvert.')

    # 1) Identification de la radio
    port.write(cmd(b'a\x03')); time.sleep(0.1)
    for i in (0x00, 0x01, 0x02, 0x03, 0x12):
        # SCOUT envoie les ids 0x08 / 0x12 avec un octet 00 supplémentaire
        port.write(cmd(b'eq' + bytes([i]) + (b'\x00' if i in (0x08, 0x12) else b'')))
        for f in read_for(port, df, 0.3):
            if f[:2] == b'Gq':
                print('  %-9s: %s' % info_text(f))

    # 2) Démarrage du flux de mesure
    port.write(cmd(b'g\x03')); time.sleep(0.1)
    port.write(cmd(b'i\x01\x08'))
    print('\nFlux démarré — Ctrl+C pour arrêter\n')
    print(f"{'heure':8}  {'LA':>5} {'canal':>5} {'RSSI':>5} {'C1':>4}   voisines (LA/RSSI)")

    fname = f"mtp_live_{datetime.datetime.now():%Y%m%d_%H%M%S}.csv"
    fh = open(fname, 'w', newline='')
    w = csv.writer(fh, delimiter=';')
    w.writerow(['time', 'la', 'channel', 'rssi', 'c1'] +
               [f'n{n}_{k}' for n in NEIGH for k in ('la', 'channel', 'rssi')])
    state, n_frames, t0 = {}, 0, time.time()
    try:
        while True:
            for f in df.feed(port.read(4096)):
                n_frames += 1
                rec = records(f)
                if not rec:
                    continue
                state.update(rec)
                if 0x08 in rec and 0x09 in rec:  # nouveau bloc cellule serveuse
                    now = datetime.datetime.now().strftime('%H:%M:%S')
                    neigh, row_n = [], []
                    for n, b in NEIGH.items():
                        la = state.get(b)
                        if la in (None, 65535):
                            row_n += ['', '', '']
                            continue
                        neigh.append(f'{la}/{state.get(b + 1)}')
                        row_n += [la, state.get(b - 1, 0) & 0xFFF, state.get(b + 1)]
                    ch = state.get(0x07, 0) & 0xFFF
                    print(f"{now}  {state[0x08]:>5} {ch:>5} {state[0x09]:>5} {state.get(0x10, ''):>4}   {'  '.join(neigh)}")
                    w.writerow([now, state[0x08], ch, state[0x09], state.get(0x10)] + row_n)
                    fh.flush()
            if n_frames == 0 and time.time() - t0 > 10:
                print('Aucune donnée reçue après 10 s. SCOUT est bien fermé ? Essaie COM6.')
                t0 = time.time() + 1e9
    except KeyboardInterrupt:
        pass
    finally:
        port.write(cmd(b'g\x04')); time.sleep(0.1)
        port.write(cmd(b'a\x04')); time.sleep(0.1)
        port.close(); fh.close()
        print(f'\nArrêté proprement. Mesures enregistrées dans {fname}')


if __name__ == '__main__':
    main()
