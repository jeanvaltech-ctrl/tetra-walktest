"""Tests de tools/anonymize_atp.py (Python standard, sans dépendance).

Lancer depuis la racine du dépôt :  python3 -m unittest discover -s tests -p 'test_*.py'

Un petit .atp synthétique contient des identifiants « d'origine » (fictifs eux aussi, mais
différents des valeurs de remplacement) : après anonymisation, aucun ne doit subsister.
"""
import importlib.util
import struct
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('anonymize_atp', ROOT / 'tools' / 'anonymize_atp.py')
assert spec and spec.loader
anonymize_atp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(anonymize_atp)

ISSI, TEI, SN, RADIO_ID = '7654321', '987654321098765', '123ABC4567', '4242'
DATE, TIME = '15.06.2025', '14:37:12'
LOC_DB = r'C:\Users\Technicien\Clients\Site\Locations.mdb'
ALIAS_DB = r'D:\Mesures\Site\Alias.mdb'
OTHER_PATH = r'\\serveur\SSV\Batiment'          # chemin sous une clé inconnue
LA_SERVING, LA_NEIGH = 2571, 3333          # LA d'origine
CH_SERVING, CH_NEIGH = 2748, 1234          # n° de canal d'origine (12 bits bas)
KEPT = ['#Radio Type: MTP6550 350-470', '#Radio MN  : H65PCN6TZ6AN', '#Radio SW  : R33.020.9335', '#Radio CP  : 9.30']


def record(rid, value):
    return bytes([rid, 0x02, 0x00, 0x00]) + struct.pack('>i', value)


def measure_frame(seq=0x10):
    recs = b''.join([
        record(0x08, LA_SERVING), record(0x07, 0x33000 | CH_SERVING), record(0x09, -80), record(0x10, 12),
        record(0x18, LA_NEIGH), record(0x17, 0x33000 | CH_NEIGH), record(0x19, -95), record(0x20, 3),
    ])
    payload = b'\x6f\x00\x00' + recs + b'\x00'
    return b'B' + bytes([seq, len(payload)]) + payload


def identity_frame():
    # réponse « G q » à une demande d'ISSI : doit disparaître
    return b'Gq\x00\x00\x00\x00\x00' + struct.pack('>I', int(ISSI))


def mac_burst():
    return b'B\x11\x32' + bytes(range(0x32))


ATP = '\r\n'.join([
    f'#Time      : {TIME}',
    f'#Date      : {DATE}',
    '#Scout Ver.: 19.12.1',
    f'#Radio Id  : {RADIO_ID}',
    KEPT[0],
    f'#Radio ISSI: {ISSI}',
    f'#Radio TEI : {TEI}',
    f'#Radio SN  : {SN}',
    KEPT[1], KEPT[2], KEPT[3],
    f'#Loc_DB    : {LOC_DB}',
    f'#Alias_DB  : {ALIAS_DB}',
    f'#Export_Dir: {OTHER_PATH}',
    '#UM,0,B,10.5,-20.25',
    f'{TIME}.100 {identity_frame().hex()}',
    f'{TIME}.200 {mac_burst().hex()}',
    f'{TIME}.300 {measure_frame().hex()}',
    '#UM,1,E,30.5,-40.75',
]) + '\r\n'


def header_of(text):
    """En-tête « #Clé : valeur » -> {clé: valeur} (comme parse_atp)."""
    h = {}
    for line in text.splitlines():
        if line.startswith('#') and not line.startswith('#UM,') and ':' in line:
            k, v = line[1:].split(':', 1)
            h[k.strip()] = v.strip()
    return h


def decoded_values(text, ids):
    """Valeurs des enregistrements `ids` dans les blocs de mesure de la sortie."""
    out = []
    for line in text.splitlines():
        if line[:1].isdigit() and ' ' in line:
            body = bytes.fromhex(line.split(' ', 1)[1].strip())
            if body[:1] == b'B' and body[3:6] == b'\x6f\x00\x00':
                q = body[6:3 + body[2]]
                while len(q) >= 8:
                    if q[0] in ids:
                        out.append(struct.unpack('>i', q[4:8])[0])
                    q = q[8:]
    return out


class AnonymizeAtpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as d:
            src, dst = Path(d) / 'src.atp', Path(d) / 'dst.atp'
            src.write_bytes(ATP.encode('latin1'))
            import sys
            argv = sys.argv
            sys.argv = ['anonymize_atp.py', str(src), str(dst)]
            try:
                anonymize_atp.main()
            finally:
                sys.argv = argv
            cls.out = dst.read_bytes().decode('latin1')
            cls.header = header_of(cls.out)

    def test_identity_replaced(self):
        for v in (ISSI, TEI, SN):
            self.assertNotIn(v, self.out)
        self.assertEqual(self.header['Radio ISSI'], '1234567')
        self.assertEqual(self.header['Radio TEI'], '000000000000000')
        self.assertEqual(self.header['Radio SN'], '000TST0000')
        self.assertEqual(self.header['Radio Id'], '0')

    def test_issi_not_left_in_hex(self):
        self.assertNotIn(struct.pack('>I', int(ISSI)).hex(), self.out)

    def test_date_and_time_replaced(self):
        self.assertNotIn(DATE, self.out)
        self.assertEqual(self.header['Date'], '01.01.2000')
        self.assertEqual(self.header['Time'], '00:00:00')

    def test_scout_paths_removed(self):
        for s in ('Loc_DB', 'Alias_DB', 'Export_Dir', 'Locations.mdb', 'Alias.mdb', 'Technicien', 'Batiment', '\\'):
            self.assertNotIn(s, self.out)

    def test_realistic_header_kept(self):
        for line in KEPT:
            self.assertIn(line, self.out)

    def test_la_and_channels_replaced(self):
        las = decoded_values(self.out, {0x08, 0x18})
        chans = [v & 0xFFF for v in decoded_values(self.out, {0x07, 0x17})]
        self.assertEqual(las, [1001, 1002])
        self.assertEqual(chans, [100, 101])
        for v in (LA_SERVING, LA_NEIGH):
            self.assertNotIn(struct.pack('>i', v).hex(), self.out)

    def test_other_frames_dropped(self):
        frames = [l for l in self.out.splitlines() if l[:1].isdigit()]
        self.assertEqual(len(frames), 1)          # seul le bloc de mesure reste
        self.assertNotIn(mac_burst().hex(), self.out)

    def test_positions_kept(self):
        self.assertIn('#UM,0,B,10.5,-20.25', self.out)
        self.assertIn('#UM,1,E,30.5,-40.75', self.out)


if __name__ == '__main__':
    unittest.main()
