#!/usr/bin/env python3
"""
anonymize_atp.py — copie anonymisée d'un fichier SCOUT .atp, publiable comme jeu de test.

- En-tête : identité de la radio (Radio Id, ISSI, TEI, n° de série) remplacée par des valeurs fictives,
  date et heure de la mesure remplacées par 01.01.2000 00:00:00, chemins des bases SCOUT (Loc_DB,
  Alias_DB, et toute valeur qui ressemble à un chemin Windows) supprimés. Modèle, code produit,
  version logicielle et codeplug sont gardés : en-tête réaliste pour tester les parseurs.
- Blocs de mesure : LA et numéros de canal remplacés par des valeurs fictives, cohérentes dans tout
  le fichier (une même cellule garde le même identifiant fictif). Seuls les enregistrements connus
  (cellule serveuse + 4 voisines) sont conservés ; le bloc est reconstruit (checksum mis à 00).
- Autres trames supprimées (bursts MAC, réponses d'identité, trames C) : elles peuvent contenir
  des informations du réseau.
- Heures des trames décalées : la première trame gardée est à 00:00:00.000, les écarts entre
  trames sont conservés à la milliseconde près (passage à minuit compris), pour que la répartition
  des mesures sur les segments reste identique.
- Lignes #UM (positions sur le plan) conservées : elles n'ont pas de sens sans le plan.

Usage:
  python anonymize_atp.py source.atp destination.atp
"""
import re
import struct
import sys

LA_IDS = {0x08, 0x18, 0x28, 0x38, 0xA8}
CHANNEL_IDS = {0x07, 0x17, 0x27, 0x37, 0xA7, 0x53}
KEEP = {0x07, 0x08, 0x09, 0x0B, 0x10, 0x53,                 # serveuse
        0x17, 0x18, 0x19, 0x1B, 0x20,                       # voisine 1
        0x27, 0x28, 0x29, 0x2B, 0x30,                       # voisine 2
        0x37, 0x38, 0x39, 0x3B, 0x40,                       # voisine 3
        0xA7, 0xA8, 0xA9, 0xAB, 0xA0}                       # voisine 4
HEADER = {'Radio Id': '0', 'Radio ISSI': '1234567', 'Radio TEI': '000000000000000', 'Radio SN': '000TST0000',
          'Date': '01.01.2000', 'Time': '00:00:00'}
DROP_HEADER = {'Loc_DB', 'Alias_DB'}
WINDOWS_PATH = re.compile(r'[A-Za-z]:\\|\\\\')     # C:\…  ou  \\serveur\…
LA_EMPTY = 65535


DAY_MS = 24 * 3600 * 1000


class Clock:
    """Heures « hh:mm:ss.mmm » -> heures décalées, la première trame gardée à 00:00:00.000.

    Toutes les trames (même supprimées) passent par absolute() : une heure plus petite que la
    précédente signifie un passage à minuit, et on ajoute un jour.
    """

    def __init__(self):
        self.prev, self.day, self.origin = None, 0, None

    def absolute(self, t):
        h, m, rest = t.split(':')
        sec, _, frac = rest.partition('.')
        v = ((int(h) * 60 + int(m)) * 60 + int(sec)) * 1000 + int((frac + '000')[:3])
        if self.prev is not None and v < self.prev:
            self.day += DAY_MS
        self.prev = v
        return v + self.day

    def shifted(self, absolute_ms):
        if self.origin is None:
            self.origin = absolute_ms
        d = absolute_ms - self.origin
        return f'{d // 3600000:02d}:{d // 60000 % 60:02d}:{d // 1000 % 60:02d}.{d % 1000:03d}'


class Mapper:
    """Valeur réelle -> valeur fictive, dans l'ordre d'apparition."""

    def __init__(self, start):
        self.start, self.map = start, {}

    def __call__(self, v):
        return self.map.setdefault(v, self.start + len(self.map))


def anonymize_body(body, la, channel):
    """Corps de trame -> corps anonymisé, ou None si la trame est à supprimer."""
    if len(body) < 6 or body[:1] != b'B' or body[3:6] != b'\x6f\x00\x00':
        return None
    q, recs = body[6:3 + body[2]], []
    while len(q) >= 8:
        rid, v = q[0], struct.unpack('>i', q[4:8])[0]
        if rid in KEEP:
            if rid in LA_IDS and v != LA_EMPTY:
                v = la(v)
            elif rid in CHANNEL_IDS:
                v = (v & ~0xFFF) | channel(v & 0xFFF)
            recs.append(q[:4] + struct.pack('>i', v))
        q = q[8:]
    if not recs:
        return None
    payload = b'\x6f\x00\x00' + b''.join(recs) + b'\x00'
    return b'B' + body[1:2] + bytes([len(payload)]) + payload


def main():
    src, dst = sys.argv[1], sys.argv[2]
    la, channel, clock = Mapper(1001), Mapper(100), Clock()
    out, kept, dropped = [], 0, 0
    for line in open(src, 'rb').read().decode('latin1').splitlines():
        if line.startswith('#') and not line.startswith('#UM,') and ':' in line:
            k, v = line[1:].split(':', 1)
            if k.strip() in DROP_HEADER or WINDOWS_PATH.search(v):
                continue
            if k.strip() in HEADER:
                line = f"#{k}: {HEADER[k.strip()]}"
        elif line[:1].isdigit() and ' ' in line:
            t, h = line.split(' ', 1)
            at = clock.absolute(t)
            body = anonymize_body(bytes.fromhex(h.strip()), la, channel)
            if body is None:
                dropped += 1
                continue
            kept += 1
            line = f'{clock.shifted(at)} {body.hex()}'
        out.append(line)
    open(dst, 'wb').write(('\r\n'.join(out) + '\r\n').encode('latin1'))
    print(f'{dst} : {kept} trames gardées, {dropped} supprimées, '
          f'{len(la.map)} cellules (LA) et {len(channel.map)} canaux remplacés', file=sys.stderr)


if __name__ == '__main__':
    main()
