#!/usr/bin/env python3
"""
mtp_trace.py — décodeur du flux de mesure Motorola MTP6550 (tel qu'utilisé par SCOUT 19.12)

Reconstitué à partir d'une capture USBPcap + des fichiers SCOUT (.atp / Export.csv)
d'une mesure du 21/10/2026.

PROTOCOLE (interface USB 0, VID 0x0CAD / PID 0x9012, bulk EP 0x01 OUT / 0x81 IN)
------------------------------------------------------------------------------
Trames:   PC -> radio :  ESC 'P' <corps> ESC 'S'
          radio -> PC :  ESC 'S' <corps> ESC 'P'
Échappement: un octet 0x1B dans le corps est transmis comme 1B E4 (0xE4 = ~0x1B).

Commandes PC vues:
  'a' 03 / 'a' 04     ouverture / fermeture de session
  'g' 03              DÉMARRER le flux de trace
  'g' 04              arrêter le flux
  'i' 01 08           config (envoyé à chaque cycle)
  'e' 'q' <id>        lire une info radio -> réponse 'G' 'q' 00 00 00 00 <id> <data>
       00 ISSI (3 o.)  01 n° série   02 model number   03 TEI   08/12 versions SW
       0d date build   0f version codeplug
  Cycle « radio présente ? » toutes les ~7 s au repos: a03, g04, i0108, eq03, a04

Flux de trace (radio -> PC), corps:  'B' <seq> <len> <payload(len)>
  - len = 0x32 : burst/PDU MAC brut (non décodé ici)
  - payload commençant par 6F 00 00 : enregistrements de mesure de 8 octets
        <id:1> <type:1> <2 o.> <valeur int32 big-endian signé>
    (dernier octet = checksum)

IDs connus:
  Cellule serveuse : 08 LA   07 canal (valeur & 0xFFF)   09 RSSI dBm   10 C1
                     53 canal courant   0b classe abonné  0a ?  02 ?  06 ?
  Voisines 1..4    : base 0x18 / 0x28 / 0x38 / 0xA8
                     +0 LA  -1 canal  +1 RSSI  (0x20/0x30/0x40/0xA0) Cx  +3 classe
  Statut           : 01, 02, 03, 05 (timeslot / canal logique probablement)
  Resélection      : 50/51/52 (+ copie de la voisine choisie), 41-47, 56, 57

Fichier SCOUT .atp : texte. Lignes '#' = en-tête radio ;
  '#UM,<n>,<B|I|E>,<x>,<y>' = position interpolée du point (pixels, origine au
  CENTRE de l'image du plan, y vers le bas) ; B/I/E = début/intermédiaire/fin
  de segment. Lignes 'hh:mm:ss.mmm <hex>' = trames radio brutes (déséchappées).

Usage:
  python3 mtp_trace.py fichier.atp [--floor "FLOOR -1"] > points.csv
"""
import argparse
import csv
import struct
import sys

ESC = 0x1B
NEIGH = {1: 0x18, 2: 0x28, 3: 0x38, 4: 0xA8}
CX_ID = {1: 0x20, 2: 0x30, 3: 0x40, 4: 0xA0}


# ---------- couche trame (pour le futur lecteur USB en direct) ----------
def build_cmd(body: bytes) -> bytes:
    """Encode une commande PC -> radio (ex: build_cmd(b'g\\x03'))."""
    esc = body.replace(b'\x1b', b'\x1b\xe4')
    return b'\x1bP' + esc + b'\x1bS'


class Deframer:
    """Découpe le flux brut radio -> PC en corps de trame déséchappés."""

    def __init__(self):
        self.buf = bytearray()

    def feed(self, data: bytes):
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
                    nxt = self.buf[j + 1]
                    if nxt == 0xE4:
                        body.append(ESC); j += 2; continue
                    if nxt == ord('P'):
                        break
                body.append(self.buf[j]); j += 1
            else:
                self.buf = self.buf[s:]
                return out
            out.append(bytes(body))
            self.buf = self.buf[j + 2:]


# ---------- couche mesure ----------
def decode_records(body: bytes):
    """Corps 'B' -> dict {id: valeur} ou None si ce n'est pas un bloc de mesure."""
    if len(body) < 6 or body[:1] != b'B' or body[3:6] != b'\x6f\x00\x00':
        return None
    q = body[6:3 + body[2]]
    rec = {}
    while len(q) >= 8:
        rec[q[0]] = struct.unpack('>i', q[4:8])[0]
        q = q[8:]
    return rec


class State:
    """Accumule les blocs: un point complet = dernière serveuse + voisines."""

    def __init__(self):
        self.v = {}

    def update(self, rec):
        self.v.update(rec)
        return 0x08 in rec and 0x09 in rec  # nouveau bloc serveuse => nouveau point

    def snapshot(self):
        v = self.v
        row = dict(la=v.get(0x08), channel=v.get(0x07, 0) & 0xFFF, rssi=v.get(0x09), c1=v.get(0x10))
        for n, b in NEIGH.items():
            la = v.get(b)
            row[f'n{n}_la'] = la if la not in (None, 65535) else ''
            row[f'n{n}_channel'] = v.get(b - 1, 0) & 0xFFF if la not in (None, 65535) else ''
            row[f'n{n}_rssi'] = v.get(b + 1, '') if la not in (None, 65535) else ''
            row[f'n{n}_cx'] = v.get(CX_ID[n], '') if la not in (None, 65535) else ''
        return row


def parse_atp(path, floor=''):
    header, pos, st, rows = {}, None, State(), []
    for line in open(path, 'rb').read().decode('latin1').splitlines():
        if line.startswith('#UM,'):
            _, i, kind, x, y = line.split(',')
            pos = (int(i), kind, float(x), float(y))
        elif line.startswith('#'):
            if ':' in line:
                k, v = line[1:].split(':', 1)
                header[k.strip()] = v.strip()
        elif line[:1].isdigit() and ' ' in line:
            t, h = line.split(' ', 1)
            rec = decode_records(bytes.fromhex(h.strip()))
            if rec and st.update(rec) and pos:
                r = dict(time=t, floor=floor, x=round(pos[2], 1), y=round(pos[3], 1), seg=pos[1])
                r.update(st.snapshot())
                rows.append(r)
    return header, rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('atp')
    ap.add_argument('--floor', default='')
    a = ap.parse_args()
    hdr, rows = parse_atp(a.atp, a.floor)
    print(f"# {hdr.get('Date')} {hdr.get('Time')} {hdr.get('Radio Type')} ISSI {hdr.get('Radio ISSI')} : {len(rows)} points",
          file=sys.stderr)
    if rows:
        sys.stdout.reconfigure(newline='')  # sinon \r\r\n sous Windows (lignes vides)
        w = csv.DictWriter(sys.stdout, fieldnames=list(rows[0]), delimiter=';')
        w.writeheader()
        w.writerows(rows)


if __name__ == '__main__':
    main()
