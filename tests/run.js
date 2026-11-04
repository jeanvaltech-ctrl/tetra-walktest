// run.js — tests du décodeur JS, dans le navigateur (pas de Node requis).
// Référence : CSV produit par tools/mtp_trace.py sur fixtures/demo.atp, une vraie mesure SCOUT
// anonymisée par tools/anonymize_atp.py (identité radio, LA et canaux fictifs).
import { buildCmd, CMD, Deframer, parseInfo } from '../js/protocol.js';
import { Radio } from '../js/radio.js';
import { rssiColor, upgradeThresholds, DEFAULT_THRESHOLDS } from '../js/thresholds.js';
import { Session, floorStats } from '../js/session.js';
import { FakePort, radioFrame, cmdHex } from './fakeport.js';
import { parseAtp } from '../js/atp.js';
import { ViewTransform, metersPerPixel, niceLength } from '../js/geometry.js';
import { setCalibration, createProject, addFloor, removeFloor, floorSampleCount, serializeProject, deserializeProject } from '../js/project.js';
import { floorCsv, projectCsv, floorPng, caption, CSV_COLUMNS } from '../js/export.js';
import { AutoSave } from '../js/autosave.js';
import { sampleOk, floorCompliance, fmtPct, complianceText } from '../js/criterion.js';
import { readProjectFolder, newPlans, floorNameFromFile, floorNumber, compareFloorNames } from '../js/folder.js';
import { setLang, t, LANGS } from '../js/i18n.js';
import { STRINGS } from '../js/strings.js';

setLang('fr', false);   // les messages vérifiés ci-dessous sont en français

const ATP = 'fixtures/demo.atp';
const GOLDEN = 'fixtures/demo_mtp_trace.csv';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: String(e && e.message || e) }); }
}
function assert(c, msg) { if (!c) throw new Error(msg); }
const hex = a => [...a].map(b => b.toString(16).padStart(2, '0')).join(' ');

await test('buildCmd : g03 et échappement de 0x1B', () => {
  assert(hex(buildCmd(CMD.start)) === '1b 50 67 03 1b 53', hex(buildCmd(CMD.start)));
  assert(hex(buildCmd([0x41, 0x1b, 0x42])) === '1b 50 41 1b e4 42 1b 53', 'échappement');
  assert(hex(CMD.info(0x12)) === '65 71 12 00', 'eq12 suivi de 00');
  assert(hex(CMD.info(0x03)) === '65 71 03', 'eq03');
});

const atpText = new TextDecoder('latin1').decode(await (await fetch(ATP)).arrayBuffer());
const { header, rows, bodies } = parseAtp(atpText, 'Demo -1');

await test('Deframer : toutes les trames du .atp, découpage en morceaux aléatoires', () => {
  const stream = Uint8Array.from(bodies.flatMap(b => radioFrame(b.body)));
  const d = new Deframer(), got = [];
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < stream.length;) {
    const n = 1 + Math.floor(rnd() * 64);
    got.push(...d.feed(stream.subarray(i, i + n)));
    i += n;
  }
  assert(got.length === bodies.length, `${got.length} trames au lieu de ${bodies.length}`);
  for (let i = 0; i < got.length; i++) assert(hex(got[i]) === hex(bodies[i].body), `trame ${i} différente`);
});

await test('parseAtp : en-tête', () => {
  assert(header['Radio ISSI'] === '1234567', `ISSI ${header['Radio ISSI']}`);
});

await test('parseAtp : identique à mtp_trace.py (référence CSV)', async () => {
  const lines = (await (await fetch(GOLDEN)).text()).split(/\r?\n/).filter(Boolean);
  const cols = lines[0].split(';');
  const ref = lines.slice(1).map(l => Object.fromEntries(l.split(';').map((v, i) => [cols[i], v])));
  assert(rows.length === ref.length, `${rows.length} points au lieu de ${ref.length}`);
  assert(cols.join(';') === Object.keys(rows[0]).join(';'), 'colonnes différentes : ' + Object.keys(rows[0]).join(';'));
  for (let i = 0; i < ref.length; i++) {
    for (const c of cols) {
      const a = String(rows[i][c]), b = ref[i][c];
      const same = a === b || (a !== '' && b !== '' && !isNaN(a) && !isNaN(b) && Math.abs(+a - +b) < 0.051);
      assert(same, `point ${i}, colonne ${c} : JS « ${a} » / Python « ${b} »`);
    }
  }
});

// ---------- géométrie (M1) ----------
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

await test('ViewTransform : écran <-> image aller-retour', () => {
  const t = new ViewTransform(); t.s = 2.5; t.tx = -40; t.ty = 17;
  const p = { x: 123.4, y: -56.7 }, q = t.toImage(t.toScreen(p));
  assert(near(p.x, q.x) && near(p.y, q.y), JSON.stringify(q));
});

await test('ViewTransform : le zoom garde fixe le point sous le curseur', () => {
  const t = new ViewTransform(); t.fit(2000, 1000, 800, 600);
  const cursor = { x: 300, y: 200 }, before = t.toImage(cursor);
  t.zoomAt(cursor, 3);
  const after = t.toImage(cursor);
  assert(near(before.x, after.x, 1e-6) && near(before.y, after.y, 1e-6), `${JSON.stringify(before)} / ${JSON.stringify(after)}`);
});

await test('ViewTransform : ajustement centré et limites de zoom', () => {
  const t = new ViewTransform(); t.fit(2000, 1000, 800, 600, 16);
  assert(near(t.s, 768 / 2000), `s = ${t.s}`);
  assert(near(t.tx, 16) && near(t.ty, (600 - 1000 * t.s) / 2), `t = ${t.tx}, ${t.ty}`);
  t.zoomAt({ x: 0, y: 0 }, 1e-6);
  assert(near(t.s, t.min), 'zoom minimum');
  t.zoomAt({ x: 0, y: 0 }, 1e9);
  assert(near(t.s, t.max), 'zoom maximum');
});

await test('Calibration : mètres par pixel', () => {
  assert(near(metersPerPixel({ x: 0, y: 0 }, { x: 300, y: 400 }, 10), 0.02), 'diagonale 3-4-5');
  assert(metersPerPixel({ x: 5, y: 5 }, { x: 5, y: 5 }, 10) === null, 'points confondus');
  assert(metersPerPixel({ x: 0, y: 0 }, { x: 1, y: 0 }, 0) === null, 'distance nulle');
  const fl = {};
  setCalibration(fl, { x: 0, y: 0 }, { x: 100, y: 0 }, 5);
  assert(near(fl.calibration.mPerPx, 0.05), 'setCalibration');
});

await test('Barre d\'échelle : longueurs rondes', () => {
  const cases = [[0.7, 0.5], [1, 1], [1.9, 1], [2, 2], [4.99, 2], [5, 5], [9.9, 5], [37, 20], [0.033, 0.02]];
  for (const [m, want] of cases) assert(near(niceLength(m), want, 1e-12), `niceLength(${m}) = ${niceLength(m)}`);
});

// ---------- radio (M2) ----------
// Formats relevés sur le MTP6550 (valeurs fictives).
const ascii = s => [...s].map(c => c.charCodeAt(0));
const FAKE_INFO = {
  0x00: [0x00, 0x12, 0xd6, 0x87],                                   // ISSI 1234567 (4 octets)
  0x01: ascii('999TST0001'),
  0x02: [...ascii('H65TEST00000'), 0, 0, 0, 0, 0],
  0x03: [0x00, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0x00],           // TEI
  0x12: [...ascii('R33.020.9335'), 0, 0, 0, 0],                     // sans l'octet 00 de la requête
  0x0f: [0x00, 0x09, 0x00, 0x30],                                   // codeplug 9.30
};
const gq = (id, data) => Uint8Array.from([0x47, 0x71, 0, 0, 0, 0, id, ...data]);

await test('parseInfo : formats ISSI, TEI, texte, codeplug, date', () => {
  const v = id => parseInfo(gq(id, FAKE_INFO[id])).value;
  assert(v(0x00) === '1234567', `ISSI ${v(0x00)}`);
  assert(v(0x03) === '000123456789AB0', `TEI ${v(0x03)}`);
  assert(v(0x02) === 'H65TEST00000', `modèle « ${v(0x02)} »`);
  assert(v(0x12) === 'R33.020.9335', `logiciel « ${v(0x12)} »`);
  assert(v(0x0f) === '9.30', `codeplug ${v(0x0f)}`);
  const d = parseInfo(gq(0x0d, ascii('Thu Feb 28 06:23:54 UTC 2019abc123@host'))).value;
  assert(d === 'Thu Feb 28 06:23:54 UTC 2019', `date « ${d} »`);
  assert(parseInfo(Uint8Array.from([0x42, 1, 2])) === null, 'trame B');
});

const waitFor = (cond, ms = 3000) => new Promise((ok, ko) => {
  const t0 = Date.now(), tick = () => cond() ? ok() : Date.now() - t0 > ms ? ko(new Error('délai dépassé')) : setTimeout(tick, 10);
  tick();
});

await test('Radio : connexion, identité, flux, arrêt propre (faux port)', async () => {
  const port = new FakePort({ info: FAKE_INFO, bodies: bodies.map(b => b.body) });
  const radio = new Radio();
  const states = [], points = [];
  let identity = null;
  radio.addEventListener('state', e => states.push(e.detail.state));
  radio.addEventListener('identity', e => { identity = e.detail; });
  radio.addEventListener('measure', e => points.push(e.detail.snapshot));
  await radio.connect(port);
  assert(radio.state === 'streaming', `état ${radio.state}`);
  assert(identity && identity.issi === '1234567' && identity.software === 'R33.020.9335' && identity.codeplug === '9.30', JSON.stringify(identity));
  const seq = port.sent.slice(0, 2).concat(port.sent.slice(-2));
  assert(seq.join('|') === [cmdHex(CMD.open), cmdHex(CMD.stop), cmdHex(CMD.start), cmdHex(CMD.config)].join('|'), 'séquence : ' + port.sent.join(' | '));
  await waitFor(() => points.length === rows.length);
  assert(points[1].la === rows[1].la && points[1].rssi === rows[1].rssi && points[1].n1_la === rows[1].n1_la, 'point 1 différent');
  await radio.disconnect();
  assert(port.sent.slice(-2).join('|') === [cmdHex(CMD.stop), cmdHex(CMD.close)].join('|'), 'arrêt : ' + port.sent.slice(-2).join(' | '));
  assert(port.closed && radio.state === 'disconnected', 'port non fermé');
  assert(states.join(',') === 'connecting,streaming,disconnected', states.join(','));
});

await test('Radio : pas de réponse -> erreur claire, session refermée', async () => {
  const port = new FakePort();
  const radio = new Radio();
  radio.queryTimeout = 30;
  let err = null;
  try { await radio.connect(port); } catch (e) { err = e; }
  assert(err && /Aucune réponse/.test(err.message) && err.code === 'silent', String(err));
  const queries = port.sent.filter(h => h.startsWith('1b 50 65 71'));
  assert(queries.length === 1, `${queries.length} questions d'identité au lieu d'1 (échec rapide)`);
  assert(port.sent.at(-1) === cmdHex(CMD.close) && port.closed, 'a04 / fermeture : ' + port.sent.join(' | '));
  assert(radio.state === 'disconnected', radio.state);
});

await test('Radio : câble débranché pendant le flux', async () => {
  const port = new FakePort({ info: FAKE_INFO });
  const radio = new Radio();
  let lost = false;
  radio.addEventListener('lost', () => { lost = true; });
  await radio.connect(port);
  port.unplug();
  await waitFor(() => lost);
  assert(radio.state === 'disconnected' && radio.port === null, radio.state);
});

await test('Seuils RSSI : légende SCOUT', () => {
  // seuils relevés sur un export SCOUT : orange -66/-67 seulement, jaune dès -68
  const cases = [[-50, '#e00000'], [-65, '#e00000'], [-66, '#ff8c00'], [-67, '#ff8c00'], [-68, '#ffd800'], [-72, '#ffd800'], [-85, '#ffd800'],
    [-86, '#22b14c'], [-87, '#22b14c'], [-88, '#1e3fd8'], [-98, '#1e3fd8'], [-99, '#000000'], ['', '#000000']];
  for (const [r, c] of cases) assert(rssiColor(r) === c, `${r} -> ${rssiColor(r)}`);
  // projet enregistré avec l'ancienne légende par défaut (orange jusqu'à -72) : corrigé à l'ouverture
  const old = { thresholds: [-65, -72, -85, -87, -98].map((min, i) => ({ min, color: DEFAULT_THRESHOLDS[i].color })) };
  assert(upgradeThresholds(old) && old.thresholds[1].min === -67, 'ancienne légende non corrigée');
  const custom = { thresholds: [-60, -70, -80, -90, -100].map(min => ({ min, color: '#123456' })) };
  assert(!upgradeThresholds(custom) && custom.thresholds[1].min === -70, 'légende personnalisée modifiée');
});

// ---------- session par waypoints (M3) ----------
function fakeSession() {
  const clock = { t: 1000 };
  const floor = { segments: [] };
  const s = new Session(floor, () => clock.t);
  const at = (t, rssi) => { clock.t = t; return s.addSample({ la: 1, rssi }, t); };
  const click = (t, x, y) => { clock.t = t; return s.click({ x, y }); };
  return { s, floor, clock, at, click };
}

await test('Session : échantillons ignorés avant le 1er clic, répartis au prorata du temps', () => {
  const { s, floor, at, click } = fakeSession();
  s.start();
  assert(!at(1500, -60), 'échantillon avant le point de départ accepté');
  click(2000, 0, 0);
  at(3000, -70); at(4000, -80); at(6000, -90);
  click(6000, 100, 0);
  const seg = floor.segments[0];
  assert(floor.segments.length === 1 && seg.points.length === 2, 'segment');
  assert(seg.samples.map(x => x.x).join(',') === '25,50,100', seg.samples.map(x => x.x).join(','));
  assert(seg.samples.every(x => x.y === 0 && x.leg === 1), 'y / leg');
  assert(floorStats(floor).samples === 3 && floorStats(floor).length === 100, JSON.stringify(floorStats(floor)));
});

await test('Session : la pause exclut son temps et ses échantillons', () => {
  const { s, floor, clock, at, click } = fakeSession();
  s.start(); click(0, 0, 0);
  at(1000, -70);
  clock.t = 2000; s.pause();
  assert(!at(5000, -60), 'échantillon pendant la pause accepté');
  clock.t = 12000; s.resume();      // 10 s de pause
  at(13000, -80);
  click(14000, 40, 0);              // 4 s de temps actif
  assert(floor.segments[0].samples.map(x => x.x).join(',') === '10,30', floor.segments[0].samples.map(x => x.x).join(','));
});

await test('Session : annuler le dernier point remet ses échantillons en attente', () => {
  const { s, floor, at, click } = fakeSession();
  s.start(); click(0, 0, 0);
  at(1000, -70); click(2000, 20, 0);
  at(3000, -80); click(4000, 20, 20);
  assert(s.undo(), 'undo');
  const seg = floor.segments[0];
  assert(seg.points.length === 2 && seg.samples.length === 1 && s.pending.length === 1, `${seg.points.length} pts, ${seg.samples.length} placés, ${s.pending.length} en attente`);
  at(5000, -90); click(6000, 20, -40);   // replacés sur le nouveau tronçon
  assert(seg.samples.length === 3 && seg.samples.slice(1).every(x => x.leg === 2), 'replacement');
  assert(Math.abs(seg.samples[1].y - -10) < 1e-9 && Math.abs(seg.samples[2].y - -30) < 1e-9, seg.samples.map(x => x.y).join(','));
});

await test('Session : fin de segment, nouveau segment, annulation qui rouvre', () => {
  const { s, floor, at, click } = fakeSession();
  s.start(); click(0, 0, 0);
  at(1000, -70); click(2000, 10, 0);
  at(3000, -75);
  assert(s.endSegment() === 1 && s.state === 'ready', 'échantillon non placé perdu');
  click(4000, 50, 50); at(5000, -80); click(6000, 60, 50);
  assert(floor.segments.length === 2, 'deux segments');
  s.undo(); s.undo();                   // retire les 2 points du 2e segment
  assert(floor.segments.length === 1 && s.state === 'ready', `${floor.segments.length} segments, ${s.state}`);
  s.undo();                             // rouvre le 1er segment et retire son dernier point
  assert(s.state === 'walking' && floor.segments[0].points.length === 1 && s.pending.length === 1, `${s.state}, ${s.pending.length}`);
  s.endSegment();                       // point de départ seul : segment supprimé
  assert(floor.segments.length === 0, 'segment vide conservé');
  s.stop();
  assert(s.state === 'idle' && !s.undo(), 'arrêt');
});

// ---------- exports et fichier projet (M4) ----------
async function sampleProject() {
  const project = createProject({ name: 'Test; "guillemets"', building: 'Bâtiment A' });
  const c = new OffscreenCanvas(400, 300), g = c.getContext('2d');
  g.fillStyle = '#ddd'; g.fillRect(0, 0, 400, 300);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const floor = addFloor(project, { name: 'Étage -1', image: { blob, name: 'plan.png', type: 'image/png', width: 400, height: 300 } });
  setCalibration(floor, { x: 0, y: 0 }, { x: 100, y: 0 }, 10);    // 0,1 m/px
  const t0 = new Date(2000, 0, 1, 10, 0, 0).getTime();
  const smp = (dt, x, y, rssi, extra = {}) => ({ la: 1001, channel: 100, rssi, c1: 10, n1_la: 1002, n1_channel: 101, n1_rssi: -90, n1_cx: 3,
    n2_la: '', n2_channel: '', n2_rssi: '', n2_cx: '', n3_la: '', n3_channel: '', n3_rssi: '', n3_cx: '', n4_la: '', n4_channel: '', n4_rssi: '', n4_cx: '',
    time: t0 + dt, ta: dt, x, y, leg: 1, ...extra });
  floor.segments.push(
    { id: 's1', points: [{ x: 50, y: 150, ta: 0 }, { x: 350, y: 150, ta: 3000 }], samples: [smp(1000, 150, 150, -60), smp(2000, 250, 150, -95)] },
    { id: 's2', points: [{ x: 200, y: 50, ta: 4000 }, { x: 200, y: 250, ta: 6000 }], samples: [smp(5000, 200, 150.04, -120)] },
  );
  floor.raw.push([t0, '42010a']);
  return { project, floor };
}

await test('Export CSV : colonnes, tri, mètres, échappement', async () => {
  const { floor } = await sampleProject();
  floor.name = 'Étage; -1';
  const csv = floorCsv(floor);
  assert(csv.startsWith('﻿'), 'BOM UTF-8');
  const lines = csv.slice(1).trimEnd().split('\r\n');
  assert(lines[0] === CSV_COLUMNS.join(';'), lines[0]);
  assert(lines.length === 4, `${lines.length - 1} lignes`);
  assert(lines.slice(1).every(l => l.includes(';"Étage; -1";')), 'nom d\'étage non échappé : ' + lines[1]);
  // une fois le nom échappé remplacé, chaque ligne se découpe simplement sur « ; »
  const rows = lines.slice(1).map(l => Object.fromEntries(l.replace('"Étage; -1"', 'E').split(';').map((v, i) => [CSV_COLUMNS[i], v])));
  const r = rows[0];
  assert(r.date === '2000-01-01' && r.time === '10:00:01.000', `${r.date} ${r.time}`);
  assert(r.segment === '1' && r.x === '150.0' && r.x_m === '15.00' && r.y_m === '15.00', lines[1]);
  assert(r.rssi === '-60' && r.n1_la === '1002' && r.n2_la === '', lines[1]);
  assert(rows.map(x => x.segment).join(',') === '1,1,2' && rows[2].time === '10:00:05.000', 'tri par heure');
  assert(rows.map(x => x.astrid_ok).join(',') === '1,0,0', 'astrid_ok : ' + rows.map(x => x.astrid_ok).join(','));
});

await test('Plusieurs étages : CSV commun trié par heure, suppression d\'un étage', async () => {
  const { project, floor } = await sampleProject();
  const f2 = addFloor(project, { name: 'Étage -2', image: { ...floor.image } });
  const t0 = floor.segments[0].samples[0].time;
  f2.segments.push({ id: 's3', points: [{ x: 0, y: 0, ta: 0 }, { x: 10, y: 0, ta: 1 }],
    samples: [{ ...floor.segments[0].samples[0], time: t0 + 2500, x: 5, y: 0 }] });
  const lines = projectCsv(project).slice(1).trimEnd().split('\r\n').slice(1);
  const floors = lines.map(l => l.split(';')[CSV_COLUMNS.indexOf('floor')]);
  assert(floors.join(',') === 'Étage -1,Étage -1,Étage -2,Étage -1', floors.join(','));
  assert(floorSampleCount(floor) === 3 && floorSampleCount(f2) === 1, 'comptage');
  assert(removeFloor(project, floor.id) === f2 && project.floors.length === 1, 'suppression');
  let err = null;
  try { removeFloor(project, f2.id); } catch (e) { err = e; }
  assert(err && project.floors.length === 1, 'le dernier étage a été supprimé');
});

// ---------- critère ASTRID ----------
await test('ASTRID : seuil strict, pondération par longueur parcourue, arrondi par défaut', async () => {
  assert(!sampleOk(-88) && sampleOk(-87) && !sampleOk('') && sampleOk(-60), 'seuil > -88 dBm');
  const { project, floor } = await sampleProject();
  // s1 : -60 (conforme) et -95 sur 100 px chacun ; s2 : un seul point (-120), sans longueur
  const r = floorCompliance(floor, project.criterion);
  assert(r.n === 3 && r.okN === 1 && Math.abs(r.pct - 50) < 1e-9 && Math.abs(r.pctSamples - 100 / 3) < 1e-9 && r.ok === false, JSON.stringify(r));
  // rester sur place ne pèse pas : 10 points conformes au même endroit ne changent rien
  floor.segments[0].samples.push(...Array.from({ length: 10 }, () => ({ ...floor.segments[0].samples[1], rssi: -60 })));
  assert(Math.abs(floorCompliance(floor).pct - 50) < 1e-9, 'points immobiles comptés dans la surface');
  assert(floorCompliance({ segments: [] }).pct === null, 'étage sans mesure');
  assert(fmtPct(94.96) === '94,9 %' && fmtPct(95) === '95,0 %', `${fmtPct(94.96)} / ${fmtPct(95)}`);
  assert(complianceText(floor, { rssi: -100, percent: 50 }).includes('conforme (objectif 50 %)'), complianceText(floor, { rssi: -100, percent: 50 }));
});

// ---------- dossier projet ----------
await test('Dossier projet : noms et ordre des étages', () => {
  assert(floorNameFromFile('Floor -1.png') === 'Floor -1' && floorNameFromFile('Floor 00.JPG') === 'Floor 00', 'noms');
  const cases = [['Floor -1', -1], ['Floor 00', 0], ['Floor 01', 1], ['Niveau +2', 2], ['Étage -2 parking', -2], ['Toiture', null]];
  for (const [n, want] of cases) assert(floorNumber(n) === want, `${n} -> ${floorNumber(n)}`);
  const sorted = ['Floor 01', 'Toiture', 'Floor -1', 'Floor 10', 'Floor 00', 'Floor -2', 'Annexe', 'Floor 02'].sort(compareFloorNames);
  assert(sorted.join(',') === 'Floor -2,Floor -1,Floor 00,Floor 01,Floor 02,Floor 10,Annexe,Toiture', sorted.join(','));
});

await test('Dossier projet : lecture des plans et du projet enregistré', async () => {
  const png = await (await sampleProject()).floor.image.blob;
  const file = name => ({ kind: 'file', name, getFile: async () => new File([png], name, { type: name.endsWith('.png') ? 'image/png' : 'image/jpeg' }) });
  const dir = (name, children) => ({ kind: 'directory', name, async *values() { yield* children; } });
  const root = dir('SSV_Site_01-01-2000', [
    dir('Plans', [file('Floor 01.jpg'), file('Floor -1.png'), file('Floor 00.png'), file('notes.txt'), file('Floor 02.pdf')]),
    file('SSV_Site_01-01-2000.walktest.json'), file('autre.walktest.json'),
  ]);
  const found = await readProjectFolder(root);
  assert(found.name === 'SSV_Site_01-01-2000', found.name);
  assert(found.plans.map(p => p.name).join(',') === 'Floor -1.png,Floor 00.png,Floor 01.jpg', found.plans.map(p => p.name).join(','));
  assert(found.ignored.join(',') === 'notes.txt,Floor 02.pdf', 'ignorés : ' + found.ignored.join(','));
  assert(found.projectFile && found.projectFile.name === 'SSV_Site_01-01-2000.walktest.json', 'fichier projet');
  const project = createProject({ name: 'x' });
  addFloor(project, { name: 'Sous-sol', image: { name: 'floor -1.PNG' } });   // déjà importé (casse différente)
  assert(newPlans(project, found.plans).map(p => p.name).join(',') === 'Floor 00.png,Floor 01.jpg', 'nouveaux plans');
  const flat = await readProjectFolder(dir('Sans sous-dossier', [file('B.png'), file('A.png')]));
  assert(flat.plans.length === 2 && flat.projectFile === null, 'plans à la racine');
});

await test('Fichier projet : enregistrer puis rouvrir à l\'identique', async () => {
  const { project } = await sampleProject();
  const json = await serializeProject(project);
  const back = await deserializeProject(json);
  const fl = back.floors[0], src = project.floors[0];
  assert(back.name === project.name && back.thresholds.length === 5, 'en-tête');
  assert(JSON.stringify(fl.segments) === JSON.stringify(src.segments), 'segments différents');
  assert(JSON.stringify(fl.calibration) === JSON.stringify(src.calibration) && fl.raw.length === 1, 'calibration / trames');
  assert(fl.image.blob.size === src.image.blob.size && fl.image.blob.type === 'image/png', `image ${fl.image.blob.size} / ${src.image.blob.size}`);
  const bmp = await createImageBitmap(fl.image.blob);
  assert(bmp.width === 400 && bmp.height === 300, 'image illisible');
  let err = null;
  try { await deserializeProject('{"format":"autre"}'); } catch (e) { err = e; }
  assert(err && /pas un projet/.test(err.message), 'fichier étranger accepté');
});

await test('Export PNG : taille, trace colorée, bandeau', async () => {
  const { project, floor } = await sampleProject();
  const img = await createImageBitmap(floor.image.blob);
  const png = await floorPng(project, floor, img);
  const bmp = await createImageBitmap(png);
  assert(png.type === 'image/png' && bmp.width === 400 && bmp.height > 300, `${bmp.width} × ${bmp.height}`);
  const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const px = (x, y) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)].join(',');
  assert(px(150, 150) === '224,0,0', `rouge attendu à -60 dBm : ${px(150, 150)}`);
  assert(px(250, 150) === '30,63,216', `bleu attendu à -95 dBm : ${px(250, 150)}`);
  assert(px(5, bmp.height - 5) === '241,243,245', `bandeau : ${px(5, bmp.height - 5)}`);
  // la trace va jusqu'aux points cliqués : près de l'extrémité droite du tronçon (350,150), du bleu
  // (avant, la dernière mesure s'arrêtait à mi-chemin, vers x = 300)
  assert(px(338, 150) === '30,63,216', `fin de tronçon : ${px(338, 150)}`);
  assert(caption(project, floor).includes('3 mesures'), caption(project, floor));
});

// ---------- reprise après crash (M5) ----------
await test('Session : instantané puis restauration en pause au dernier point', () => {
  const { s, floor, clock, at, click } = fakeSession();
  s.start(); click(0, 0, 0);
  at(1000, -70); click(2000, 20, 0);
  at(3000, -80); at(4000, -85);                 // 2 mesures en attente au moment du « crash »
  const snap = structuredClone(s.snapshot());   // comme IndexedDB
  const floor2 = structuredClone(floor);
  clock.t = 60000;                              // reprise 56 s plus tard
  const r = Session.restore(floor2, snap, () => clock.t);
  assert(r.state === 'paused' && r.pending.length === 2 && r.lastPoint.x === 20, `${r.state}, ${r.pending.length}`);
  clock.t = 61000; r.resume();
  r.addSample({ la: 1, rssi: -90 }, 62000);
  clock.t = 63000; r.click({ x: 70, y: 0 });
  // temps actif : dernier point à 2000, mesures à 3000, 4000 et 62000 - 57000 de pause = 5000 ; clic à 6000
  assert(floor2.segments[0].samples.slice(1).map(x => x.x).join(',') === '32.5,45,57.5', floor2.segments[0].samples.map(x => x.x).join(','));
  const idle = Session.restore(floor2, { state: 'idle' });
  assert(idle.state === 'idle', 'idle');
});

await test('Copie de secours : écriture incrémentale des trames et relecture', async () => {
  const name = 'tetra-walktest-test';
  await new Promise(ok => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = ok; });
  const { project, floor } = await sampleProject();
  const a = new AutoSave(name);
  await a.save(project, { dirty: true, floorId: floor.id, session: { state: 'walking' } });
  floor.raw.push([1, 'aa'], [2, 'bb']);
  await Promise.all([a.save(project, { dirty: true }), a.save(project, { dirty: false, floorId: floor.id })]);   // en parallèle
  const back = await new AutoSave(name).load();
  const f = back.project.floors[0];
  assert(f.raw.map(r => r[1]).join(',') === '42010a,aa,bb', 'trames : ' + JSON.stringify(f.raw));
  assert(back.dirty === false && back.floorId === floor.id, 'métadonnées');
  assert(f.image.blob instanceof Blob && f.image.blob.size === floor.image.blob.size, 'plan');
  assert(JSON.stringify(f.segments) === JSON.stringify(floor.segments), 'segments');
  await a.clear();
  assert(await new AutoSave(name).load() === null, 'effacement');
});

// ---------- pas de service (terrain du 04/11 : aucune trace dans la zone sans couverture) ----------
// Attendu : au-delà de 3 s sans mesure valide de la cellule serveuse, un point « pas de service »
// par seconde manquante, tracé en noir à tirets blancs et compté NON conforme (% de la distance).
const sessionMod = await import('../js/session.js');
const criterionMod = await import('../js/criterion.js');

/** Corps de bloc de mesure 'B' … 6f 00 00 avec des enregistrements [id, valeur]. */
function buildBody(recs, seq = 1) {
  const payload = [0x6f, 0, 0];
  for (const [id, v] of recs) payload.push(id, 2, 0, 0, (v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  payload.push(0);
  return Uint8Array.from([0x42, seq, payload.length, ...payload]);
}

/** 3 tronçons de 100 px : -70 dBm sur le 1er et le 3e, rien du tout pendant 30 s sur le 2e. */
function noServiceWalk(cause = 'noserving', y = 0, x0 = 0) {
  let now = 0;
  const floor = { segments: [] };
  const s = new Session(floor, () => now);
  s.checkService ??= () => 0;          // code d'avant la correction : rien ne détecte la perte de service
  const ok = () => ({ la: 1001, channel: 100, rssi: -70, c1: 10 });
  const tick = until => { while (now < until) { now += 1000; s.checkService(now, cause); } };
  s.start(); s.click({ x: x0, y });
  for (let i = 1; i <= 10; i++) { now = i * 1000; s.addSample(ok(), now); s.checkService(now, cause); }
  now = 10500; s.click({ x: x0 + 100, y });
  tick(40000); now = 40500; s.click({ x: x0 + 200, y });          // 30 s sans aucune mesure valide
  for (let i = 1; i <= 10; i++) { now = 40500 + i * 1000; s.addSample(ok(), now); s.checkService(now, cause); }
  now = 51000; s.click({ x: x0 + 300, y });
  s.stop();
  return floor;
}

await test('Pas de service : le tronçon sans mesure reçoit des points « pas de service »', () => {
  const floor = noServiceWalk('noserving');
  const seg = floor.segments[0], leg2 = seg.samples.filter(x => x.leg === 2);
  assert(leg2.length >= 28, `${leg2.length} point(s) sur le tronçon sans service (aucun = pas de trace)`);
  assert(leg2.every(x => x.noService === 'noserving' && x.rssi === ''), JSON.stringify(leg2[0]));
  assert(sessionMod.NO_SERVICE_MS === 3000, `délai ${sessionMod.NO_SERVICE_MS}`);
});

await test('Pas de service : compté NON conforme dans le % ASTRID (distance parcourue)', () => {
  const r = floorCompliance(noServiceWalk());
  // aujourd'hui : 100 % « conforme » alors qu'un tiers du trajet n'a aucun service
  assert(r.pct > 55 && r.pct < 72 && r.ok === false, `ASTRID ${r.pct} %, conforme : ${r.ok}`);
  assert(typeof criterionMod.floorShares === 'function', 'floorShares() (part de distance « pas de service » / « < -98 ») n\'existe pas');
  const sh = criterionMod.floorShares(noServiceWalk(), DEFAULT_THRESHOLDS);
  assert(sh.noService > 28 && sh.noService < 40 && sh.below === 0, JSON.stringify(sh));
});

await test('Pas de service : un trou de moins de 3 s n\'ajoute rien', () => {
  let now = 0;
  const floor = { segments: [] }, s = new Session(floor, () => now);
  s.checkService ??= () => 0;
  s.start(); s.click({ x: 0, y: 0 });
  for (const t of [1000, 2000, 4900, 6000]) { now = t; s.addSample({ la: 1001, rssi: -70 }, t); s.checkService(t, 'noserving'); }
  now = 6500; s.click({ x: 100, y: 0 });
  assert(floor.segments[0].samples.length === 4 && floor.segments[0].samples.every(x => !x.noService), JSON.stringify(floor.segments[0].samples.map(x => x.noService || x.rssi)));
});

await test('Pas de service : radio muette (aucune trame) ou trames sans cellule serveuse', async () => {
  // trames reçues, mais aucune ne contient la cellule serveuse (LA + RSSI) : voisines seules
  const neighbourOnly = buildBody([[0x18, 1002], [0x19, -101]]);
  const port = new FakePort({ info: FAKE_INFO, bodies: [neighbourOnly, neighbourOnly, neighbourOnly] });
  const radio = new Radio();
  let frames = 0, measures = 0;
  radio.addEventListener('frame', () => frames++);
  radio.addEventListener('measure', () => measures++);
  await radio.connect(port);
  await waitFor(() => frames >= 3);
  assert(measures === 0, `${measures} mesure(s) sans cellule serveuse`);
  assert(typeof sessionMod.noServiceCause === 'function', `${frames} trames reçues sans cellule serveuse, mais rien ne le signale (noServiceCause() n'existe pas)`);
  const now = Date.now();
  assert(sessionMod.noServiceCause(radio.lastFrameAt, now) === 'noserving', 'trames reçues : ' + sessionMod.noServiceCause(radio.lastFrameAt, now));
  assert(sessionMod.noServiceCause(radio.lastFrameAt, now + 3000) === 'silent', 'plus de trame depuis 3 s');
  assert(sessionMod.noServiceCause(0, now) === 'silent', 'aucune trame');
  await radio.disconnect();
  const leg2 = noServiceWalk('silent').segments[0].samples.filter(x => x.leg === 2);
  assert(leg2.length && leg2.every(x => x.noService === 'silent'), 'cause « silent » non enregistrée');
});

await test('Pas de service : export CSV et PNG (trace noire à tirets, légende, bandeau)', async () => {
  const { project, floor } = await sampleProject();
  floor.segments = noServiceWalk('noserving', 150, 50).segments;   // de (50,150) à (350,150)
  const csv = floorCsv(floor).slice(1).trimEnd().split('\r\n');
  const cols = csv[0].split(';');
  assert(cols.includes('no_service'), 'colonne no_service absente : ' + csv[0]);
  const rows = csv.slice(1).map(l => Object.fromEntries(l.split(';').map((v, i) => [cols[i], v])));
  const ns = rows.filter(r => r.no_service === '1');
  assert(ns.length >= 28 && ns.every(r => r.rssi === '' && r.astrid_ok === '0'), `${ns.length} lignes « pas de service »`);
  const img = await createImageBitmap(floor.image.blob);
  const bmp = await createImageBitmap(await floorPng(project, floor, img));
  const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const px = (x, y) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)].join(',');
  // tronçon 2 (x 150 à 250) : noir sur le bord du trait, tirets blancs au centre
  assert(px(200, 152) === '0,0,0', `bord du trait « pas de service » : ${px(200, 152)} (attendu noir)`);
  const centre = [...Array(40)].map((_, i) => px(170 + i, 150));
  assert(centre.includes('255,255,255') && centre.includes('0,0,0'), 'tirets blancs absents : ' + [...new Set(centre)].join(' / '));
  const cap = caption(project, floor);
  assert(/distance parcourue/.test(cap) && /pas de service/i.test(cap) && /< -98 dBm/.test(cap), cap);
  for (const l of LANGS) assert(STRINGS['legend.noService'] && STRINGS['legend.noService'][l], `légende « pas de service » en ${l}`);
});

await test('Pas de service : aucun point en pause, avant Démarrer ni après Fin', () => {
  let now = 0;
  const floor = { segments: [] }, s = new Session(floor, () => now);
  const ns = () => floor.segments.flatMap(g => g.samples).concat(s.pending).filter(x => x.noService).length;
  now = 10000; s.checkService(now, 'noserving');                 // avant Démarrer
  s.start(); now = 20000; s.checkService(now, 'noserving');      // démarré, pas encore de point de départ
  assert(ns() === 0, `${ns()} point(s) avant le point de départ`);
  now = 20000; s.click({ x: 0, y: 0 });
  now = 21000; s.addSample({ la: 1001, rssi: -70 }, now);
  now = 22000; s.pause();
  for (now = 23000; now <= 80000; now += 1000) s.checkService(now, 'noserving');   // 58 s de pause
  assert(ns() === 0, `${ns()} point(s) pendant la pause`);
  now = 80000; s.resume();
  now = 81000; s.addSample({ la: 1001, rssi: -70 }, now);
  now = 81500; s.click({ x: 50, y: 0 });
  assert(ns() === 0, `${ns()} point(s) à la reprise (la pause compte comme un trou)`);
  s.stop();
  for (now = 82000; now <= 200000; now += 1000) s.checkService(now, 'silent');      // après Fin
  assert(ns() === 0, `${ns()} point(s) après Fin`);
});

await test('Pas de service : fenêtre réduite (minuteur freiné), détection sur l\'horodatage des trames', () => {
  // A. service normal, mesures chaque seconde, mais le contrôle ne passe qu'une fois par minute
  let now = 0;
  const fa = { segments: [] }, a = new Session(fa, () => now);
  a.start(); a.click({ x: 0, y: 0 });
  for (now = 1000; now <= 120000; now += 1000) {
    a.noteFrame?.(now);
    a.addSample({ la: 1001, rssi: -70 }, now);
    if (now % 60000 === 0) a.checkService(now, 'noserving');
  }
  now = 120500; a.click({ x: 100, y: 0 });
  const falseNs = fa.segments[0].samples.filter(x => x.noService).length;
  assert(falseNs === 0, `${falseNs} faux point(s) « pas de service » avec un minuteur freiné`);
  // B. 40 s sans serveuse (trames de voisines toutes les 0,5 s) ; le minuteur ne passe qu'APRÈS le retour du service
  now = 0;
  const fb = { segments: [] }, b = new Session(fb, () => now);
  b.start(); b.click({ x: 0, y: 0 });
  for (now = 500; now <= 60000; now += 500) {
    b.noteFrame?.(now);
    const covered = now <= 10000 || now > 50000;
    if (covered && now % 1000 === 0) b.addSample({ la: 1001, rssi: -70 }, now);
  }
  b.checkService(60000, 'noserving');
  now = 60500; b.click({ x: 100, y: 0 });
  const nsb = fb.segments[0].samples.filter(x => x.noService);
  assert(nsb.length >= 38 && nsb.length <= 40, `${nsb.length} point(s) « pas de service » pour un trou de 40 s vu en retard (attendu ~39)`);
  assert(nsb.every(x => x.noService === 'noserving'), 'cause : ' + [...new Set(nsb.map(x => x.noService))].join(','));
  assert(nsb.every(x => x.ta > 10000 && x.ta < 51000), 'points hors du trou');
});

await test('Veille du portable : saut d\'horloge sans trame -> pause automatique, aucun point', () => {
  let now = 0;
  const floor = { segments: [] }, s = new Session(floor, () => now);
  s.start(); s.click({ x: 0, y: 0 });
  for (now = 1000; now <= 5000; now += 1000) { s.noteFrame?.(now); s.addSample({ la: 1001, rssi: -70 }, now); s.checkService(now, 'noserving'); }
  now = 65000;                                     // réveil : 60 s plus tard, aucune trame entre-temps
  assert(s.pause(5000) && s.state === 'paused', 'pas de pause automatique');
  now = 66000; s.resume();
  for (now = 67000; now <= 70000; now += 1000) { s.noteFrame?.(now); s.addSample({ la: 1001, rssi: -70 }, now); s.checkService(now, 'noserving'); }
  now = 70500; s.click({ x: 100, y: 0 });
  const ns = floor.segments[0].samples.filter(x => x.noService).length;
  assert(ns === 0, `${ns} point(s) « pas de service » pour la veille`);
  assert(floor.segments[0].samples.at(-1).x > 90, 'temps de veille non exclu (pause datée du dernier contrôle)');
  assert(sessionMod.FREEZE_MS === 10000, `FREEZE_MS ${sessionMod.FREEZE_MS}`);
  assert(typeof sessionMod.isFreeze === 'function', 'isFreeze() n\'existe pas');
  assert(sessionMod.isFreeze(5000, 65000, 5000) === true, 'veille non détectée');
  assert(sessionMod.isFreeze(5000, 65000, 64000) === false, 'minuteur freiné mais trames reçues : pas une veille');
  assert(sessionMod.isFreeze(5000, 9000, 5000) === false, 'retard de 4 s : pas une veille');
});

await test('Pas de service : compteurs « N points dont M sans service » et texte ASTRID du panneau', async () => {
  const { project, floor } = await sampleProject();
  floor.segments = noServiceWalk('noserving', 150, 50).segments;
  const all = floor.segments[0].samples.length, ns = floor.segments[0].samples.filter(x => x.noService).length;
  assert(caption(project, floor).includes(`${all} points dont ${ns} sans service`), caption(project, floor));
  assert(t('floor.count', { n: all, ns }) === `${all} points dont ${ns} sans service`, t('floor.count', { n: all, ns }));
  assert(t('floor.count', { n: 3, ns: 0 }) === '3 mesures', 'sans perte de service, le libellé ne change pas');
  for (const l of ['nl', 'en']) {
    setLang(l, false);
    assert(!/undefined|\{/.test(t('floor.count', { n: all, ns })) && t('floor.count', { n: all, ns }).includes(String(ns)), `${l} : ${t('floor.count', { n: all, ns })}`);
  }
  setLang('fr', false);
  assert(/distance parcourue/.test(t('stats.goal', { goal: 95, points: '80,0 %' })), 'panneau Mesure : ' + t('stats.goal', { goal: 95, points: '80,0 %' }));
});

// ---------- langues ----------
await test('Langues : chaque texte existe en FR, NL et EN', () => {
  const missing = Object.entries(STRINGS).flatMap(([k, e]) => LANGS.filter(l => !(l in e)).map(l => `${k}:${l}`));
  assert(!missing.length, 'traductions manquantes : ' + missing.join(', '));
  const html = document.createElement('div');
  return fetch('../index.html').then(r => r.text()).then(src => {
    html.innerHTML = src;
    const keys = [...html.querySelectorAll('[data-i18n],[data-i18n-title],[data-i18n-placeholder],[data-i18n-aria],[data-i18n-value]')]
      .flatMap(el => ['i18n', 'i18nTitle', 'i18nPlaceholder', 'i18nAria', 'i18nValue'].map(a => el.dataset[a]).filter(Boolean));
    const unknown = keys.filter(k => !STRINGS[k]);
    assert(!unknown.length, 'clés inconnues dans index.html : ' + unknown.join(', '));
  });
});

await test('Langues : pluriels et paramètres', () => {
  assert(t('floor.segments', { n: 0 }) === '0 segment', 'FR : 0 au singulier');
  setLang('nl', false);
  assert(t('floor.count', { n: 0 }) === 'geen metingen' && t('floor.count', { n: 1 }) === '1 meting', t('floor.count', { n: 1 }));
  assert(t('floor.segments', { n: 0 }) === '0 segmenten' && t('floor.segments', { n: 1 }) === '1 segment', 'NL : 0 au pluriel');
  assert(t('notify.exportProgress', { i: 2, n: 9 }) === 'Exporteren 2/9…', t('notify.exportProgress', { i: 2, n: 9 }));
  setLang('en', false);
  assert(t('floor.count', { n: 1234 }) === '1,234 measurements', t('floor.count', { n: 1234 }));
  assert(t('floor.segments', { n: 0 }) === '0 segments', 'EN : 0 au pluriel');
  setLang('fr', false);
  assert(t('floor.count', { n: 2 }) === '2 mesures', t('floor.count', { n: 2 }));
});

const ko = results.filter(r => !r.ok).length;
document.getElementById('out').innerHTML = results.map(r =>
  `<div class="${r.ok ? 'ok' : 'ko'}">${r.ok ? '✔' : '✘'} ${r.name}</div>` + (r.err ? `<pre>${r.err}</pre>` : '')
).join('') + `<p><b>${results.length - ko}/${results.length} réussis</b> — ${rows.length} points décodés.</p>`;
document.title = ko ? 'ÉCHEC' : 'OK';
window.__results = results;
