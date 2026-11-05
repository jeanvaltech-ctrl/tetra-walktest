// run.js — tests du décodeur JS, dans le navigateur (pas de Node requis).
// Référence : CSV produit par tools/mtp_trace.py sur fixtures/demo.atp, une vraie mesure SCOUT
// anonymisée par tools/anonymize_atp.py (identité radio, LA et canaux fictifs).
import { buildCmd, CMD, Deframer, parseInfo } from '../js/protocol.js';
import { Radio } from '../js/radio.js';
import { rssiColor, DEFAULT_THRESHOLDS } from '../js/thresholds.js';
import { Session, floorStats } from '../js/session.js';
import { FakePort, radioFrame, cmdHex } from './fakeport.js';
import { parseAtp } from '../js/atp.js';
import { ViewTransform, metersPerPixel, niceLength } from '../js/geometry.js';
import { setCalibration, createProject, addFloor, removeFloor, floorSampleCount, serializeProject, deserializeProject } from '../js/project.js';
import { floorCsv, projectCsv, floorPng, caption, CSV_COLUMNS } from '../js/export.js';
import { AutoSave } from '../js/autosave.js';
import { sampleOk, floorCompliance, floorShares, fmtPct, complianceText } from '../js/criterion.js';
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

// ---------- classes RSSI = classes du rapport CRG (décision de Jean, 04/11/2026) ----------
const thresholdsMod = await import('../js/thresholds.js');
// un espace de noms de module est figé : remplaçants au comportement d'avant la correction
const legendItems = thresholdsMod.legendItems;
const thresholdsNotice = thresholdsMod.thresholdsNotice ?? (() => '');   // avant : aucun message
const resetThresholds = thresholdsMod.resetThresholds ?? (p => { p.thresholds = DEFAULT_THRESHOLDS.map(x => ({ ...x })); });
const renderForLegend = await import('../js/render.js');
const SCOUT_COLORS = ['#e00000', '#ff8c00', '#ffd800', '#22b14c', '#1e3fd8'];
const scoutProject = (mins = [-65, -67, -85, -87, -98]) => ({ thresholds: mins.map((min, i) => ({ min, color: SCOUT_COLORS[i] })) });

await test('Seuils RSSI : classes et couleurs du rapport CRG', () => {
  assert(JSON.stringify(DEFAULT_THRESHOLDS) === JSON.stringify([{ min: -65, color: '#FF0000' }, { min: -75, color: '#FF8C00' }, { min: -85, color: '#FFD700' }, { min: -88, color: '#32CD32' }]),
    'classes par défaut : ' + JSON.stringify(DEFAULT_THRESHOLDS));
  assert(thresholdsMod.BELOW?.color === '#0066CC', 'couleur sous le dernier seuil : ' + JSON.stringify(thresholdsMod.BELOW));
  assert(thresholdsMod.NO_SERVICE?.color === '#000000', 'couleur « pas de service » : ' + JSON.stringify(thresholdsMod.NO_SERVICE));
  const cases = [[-50, '#FF0000'], [-65, '#FF0000'], [-66, '#FF8C00'], [-75, '#FF8C00'], [-76, '#FFD700'], [-85, '#FFD700'], [-86, '#32CD32'],
    [-88, '#32CD32'], [-88.0, '#32CD32'], [-88.4, '#0066CC'], [-89, '#0066CC'], [-100, '#0066CC'], [-120, '#0066CC']];
  for (const [r, c] of cases) assert(rssiColor(r) === c, `${r} -> ${rssiColor(r)}, attendu ${c}`);
  for (const r of ['', null, undefined, '-70', NaN]) assert(rssiColor(r) === '#000000', `${r} (pas un nombre) -> ${rssiColor(r)}`);
});

await test('Seuils RSSI : légende ≥ -65 … ≥ -88, < -88, puis « pas de service » sur sa propre ligne', () => {
  const items = legendItems(DEFAULT_THRESHOLDS);
  assert(items.map(i => i.label).join(' | ') === '≥ -65 | ≥ -75 | ≥ -85 | ≥ -88 | < -88', items.map(i => i.label).join(' | '));
  assert(items.map(i => i.color).join() === '#FF0000,#FF8C00,#FFD700,#32CD32,#0066CC', items.map(i => i.color).join());
  // à l'export : « No service » dans toutes les langues (décision de Jean, 05/11/2026)
  for (const l of ['fr', 'nl', 'en']) {
    const lines = renderForLegend.legendLines(DEFAULT_THRESHOLDS, l);
    assert(lines.join(' | ') === '≥ -65 | ≥ -75 | ≥ -85 | ≥ -88 | < -88 | No service', `${l} : ${lines.join(' | ')}`);
  }
  // à l'écran (sans langue) : celle de l'interface
  const screen = renderForLegend.legendLines(DEFAULT_THRESHOLDS);
  assert(screen.at(-1) === 'Pas de service', 'écran : ' + screen.join(' | '));
});

await test('Seuils RSSI : projet enregistré avec les seuils SCOUT -> gardés à l\'ouverture, message avec ses seuils', async () => {
  const { project } = await sampleProject();
  project.thresholds = scoutProject().thresholds;
  const stored = JSON.stringify(project.thresholds);
  const back = await deserializeProject(await serializeProject(project));
  const text = thresholdsNotice(back);
  assert(JSON.stringify(back.thresholds) === stored, 'seuils modifiés : ' + JSON.stringify(back.thresholds));
  assert(text === 'Ce projet utilise ses propres seuils RSSI (-65 / -67 / -85 / -87 / -98), différents des seuils par défaut alignés sur CRG (≥ -65 / ≥ -75 / ≥ -85 / ≥ -88). Bouton « Seuils par défaut » pour les remplacer.', 'message : ' + (text || '(aucun)'));
  assert(JSON.stringify(back.thresholds) === stored, 'seuils modifiés par le message');
  // ses couleurs ne changent pas non plus : sous -98, toujours le noir de cette légende, pas le bleu CRG
  const th = back.thresholds;
  assert(rssiColor(-98, th) === '#1e3fd8' && rssiColor(-99, th) === '#000000', `-98 -> ${rssiColor(-98, th)}, -99 -> ${rssiColor(-99, th)}`);
  assert(legendItems(th).at(-1).label === '< -98 (No)' && legendItems(th).at(-1).color === '#000000', JSON.stringify(legendItems(th).at(-1)));
  try {
    for (const l of ['nl', 'en']) {
      setLang(l, false);
      const s = thresholdsNotice(back);
      assert(s.includes('-65 / -67 / -85 / -87 / -98') && s.includes('≥ -65 / ≥ -75 / ≥ -85 / ≥ -88') && s.includes(t('btn.resetThresholds')) && !/\{/.test(s), `${l} : ${s}`);
    }
  } finally { setLang('fr', false); }
});

// Décision de Jean : plus aucune réécriture silencieuse, même pour l'ancienne légende (orange jusqu'à -72).
// Ce test remplace « corrigé à l'ouverture » de l'ancien test des seuils.
await test('Seuils RSSI : projet avec l\'ancienne légende -72 -> PAS réécrit, même message', async () => {
  const old = scoutProject([-65, -72, -85, -87, -98]);
  const stored = JSON.stringify(old.thresholds);
  thresholdsMod.upgradeThresholds?.(old);
  assert(JSON.stringify(old.thresholds) === stored, 'réécrit en silence : ' + JSON.stringify(old.thresholds));
  assert(thresholdsNotice(old).includes('-65 / -72 / -85 / -87 / -98'), 'message : ' + (thresholdsNotice(old) || '(aucun)'));
  assert(JSON.stringify(old.thresholds) === stored, 'seuils modifiés par le message');
  const app = await (await fetch('../js/app.js')).text();
  const show = app.slice(app.indexOf('async function showProject'), app.indexOf('/** Affiche un étage'));
  assert(!app.includes('upgradeThresholds') && !app.includes('legendUpgraded'), 'app.js réécrit encore les seuils à l\'ouverture');
  assert(/thresholdsNotice\(project\)/.test(show), 'showProject ne prévient pas : ' + show);
  assert(!STRINGS['notify.legendUpgraded'], 'message « légende corrigée » encore présent');
});

// Décision de Jean (05/11/2026) : une liste qui n'est pas le nouveau défaut s'affiche exactement comme sur
// origin/feat/export-language (#4) : couleurs, libellés, noir et « (No) » sous le dernier seuil.
const BLACK = '#000000';
function legendDrawing(th, lang) {
  const texts = [], fills = [];
  const ctx = new Proxy({}, {
    get: (o, k) => k === 'fillText' ? (s => texts.push(s)) : k === 'fillRect' ? (() => fills.push(o.fillStyle)) : k in o ? o[k] : () => {},
    set: (o, k, v) => { o[k] = v; return true; },
  });
  renderForLegend.drawLegend(ctx, 0, 0, th, 1, lang);
  return { texts: texts.slice(1), fills: fills.slice(1) };   // sans le titre « RSSI (dBm) » ni le fond
}
function assertOldRender(th, labels, colors, colorCases) {
  const items = legendItems(th);
  assert(items.map(i => i.label).join(' | ') === labels.join(' | '), 'libellés : ' + items.map(i => i.label).join(' | '));
  assert(items.map(i => i.color).join() === colors.join(), 'couleurs : ' + items.map(i => i.color).join());
  // à l'export : « No service » dans toutes les langues ; à l'écran (sans langue) : celle de l'interface
  for (const [l, noService] of [['fr', 'No service'], ['nl', 'No service'], ['en', 'No service'], [undefined, 'Pas de service']]) {
    const d = legendDrawing(th, l);
    assert(d.texts.join(' | ') === [...labels, noService].join(' | '), `dessin ${l} : ${d.texts.join(' | ')}`);
    assert(d.fills.join() === [...colors, BLACK].join(), `dessin ${l} : ${d.fills.join()}`);
  }
  for (const [r, c] of colorCases) assert(rssiColor(r, th) === c, `${r} -> ${rssiColor(r, th)}, attendu ${c}`);
  for (const r of ['', null, undefined, NaN]) assert(rssiColor(r, th) === BLACK, `${r} -> ${rssiColor(r, th)}`);
  const min = th.at(-1).min, tail = thresholdsMod.thresholdsPanelTail?.(th);
  assert(JSON.stringify(tail) === JSON.stringify([{ color: BLACK, op: '<', text: `${min} : No` }]), 'panneau des seuils : ' + JSON.stringify(tail));
}

await test('Seuils RSSI : projet SCOUT -> légende et couleurs exactes de #4, noir et « (No) » sous -98', () => {
  assertOldRender(scoutProject().thresholds,
    ['≥ -65', '≥ -67', '≥ -85', '≥ -87', '≥ -98', '< -98 (No)'],
    ['#e00000', '#ff8c00', '#ffd800', '#22b14c', '#1e3fd8', BLACK],
    [[-65, '#e00000'], [-66, '#ff8c00'], [-67, '#ff8c00'], [-68, '#ffd800'], [-85, '#ffd800'], [-86, '#22b14c'], [-87, '#22b14c'], [-88, '#1e3fd8'], [-98, '#1e3fd8'], [-99, BLACK], [-120, BLACK]]);
});

await test('Seuils RSSI : ancienne légende -72 -> légende et couleurs exactes de #4', () => {
  assertOldRender(scoutProject([-65, -72, -85, -87, -98]).thresholds,
    ['≥ -65', '≥ -72', '≥ -85', '≥ -87', '≥ -98', '< -98 (No)'],
    ['#e00000', '#ff8c00', '#ffd800', '#22b14c', '#1e3fd8', BLACK],
    [[-72, '#ff8c00'], [-73, '#ffd800'], [-98, '#1e3fd8'], [-99, BLACK]]);
});

await test('Seuils RSSI : toute liste autre que le défaut suit les règles de #4, seul le défaut exact a le bleu CRG', async () => {
  // autres couleurs, autre nombre de classes
  assertOldRender([{ min: -70, color: '#123456' }], ['≥ -70', '< -70 (No)'], ['#123456', BLACK], [[-70, '#123456'], [-71, BLACK]]);
  // couleurs CRG avec un seuil modifié : ce n'est plus le défaut
  const edited = DEFAULT_THRESHOLDS.map((x, i) => ({ ...x, min: i === 3 ? -90 : x.min }));
  assertOldRender(edited, ['≥ -65', '≥ -75', '≥ -85', '≥ -90', '< -90 (No)'], ['#FF0000', '#FF8C00', '#FFD700', '#32CD32', BLACK], [[-90, '#32CD32'], [-91, BLACK]]);
  // le défaut, même enregistré en minuscules, et après « Seuils par défaut »
  const p = scoutProject();
  resetThresholds(p);
  for (const th of [DEFAULT_THRESHOLDS, DEFAULT_THRESHOLDS.map(x => ({ ...x, color: x.color.toLowerCase() })), p.thresholds]) {
    assert(legendItems(th).at(-1).label === '< -88' && legendItems(th).at(-1).color === '#0066CC', JSON.stringify(legendItems(th).at(-1)));
    assert(rssiColor(-89, th) === '#0066CC', `-89 -> ${rssiColor(-89, th)}`);
    const tail = thresholdsMod.thresholdsPanelTail?.(th);
    assert(JSON.stringify(tail) === JSON.stringify([{ color: '#0066CC', op: '<', text: '-88' }, { color: BLACK, op: '', text: 'Pas de service' }]), 'panneau des seuils : ' + JSON.stringify(tail));
  }
  const app = await (await fetch('../js/app.js')).text();
  const panel = app.slice(app.indexOf('function renderThresholds'), app.indexOf('// critère ASTRID réglable'));
  assert(/thresholdsPanelTail\(th\)/.test(panel), 'le panneau n\'utilise pas thresholdsPanelTail : ' + panel);
});

await test('Seuils RSSI : project.thresholds identique après ouverture, rendu et enregistrement', async () => {
  for (const mins of [[-65, -67, -85, -87, -98], [-65, -72, -85, -87, -98]]) {
    const { project } = await sampleProject();
    project.thresholds = scoutProject(mins).thresholds;
    const stored = JSON.stringify(project.thresholds);
    const opened = await deserializeProject(await serializeProject(project));
    assert(JSON.stringify(opened.thresholds) === stored, 'à l\'ouverture : ' + JSON.stringify(opened.thresholds));
    const th = opened.thresholds;
    rssiColor(-120, th); legendItems(th); legendDrawing(th, 'fr'); thresholdsNotice(opened); thresholdsMod.thresholdsPanelTail?.(th);
    assert(JSON.stringify(opened.thresholds) === stored, 'après le rendu : ' + JSON.stringify(opened.thresholds));
    const saved = JSON.parse(await serializeProject(opened));
    assert(JSON.stringify(saved.thresholds) === stored, 'à l\'enregistrement : ' + JSON.stringify(saved.thresholds));
  }
});

await test('Doc : pas de classe en plus, le bouton « Seuils par défaut » suffit', async () => {
  const readme = (await (await fetch('../README.md')).text()).replace(/\s+/g, ' ');
  assert(readme.includes('légende SCOUT reste celle des projets qui l\'ont enregistrée ; « Seuils par défaut » applique les classes CRG'), 'phrase de Jean absente du README');
  assert(!readme.includes('reste possible en saisissant'), 'le README propose encore de saisir la légende SCOUT');
});

await test('Seuils RSSI : message seulement si les seuils diffèrent du défaut (seuils ou couleurs)', () => {
  assert(thresholdsNotice({ thresholds: DEFAULT_THRESHOLDS.map(x => ({ ...x })) }) === '', 'défaut : pas de message');
  assert(thresholdsNotice(createProject({ name: 'x' })) === '', 'nouveau projet : pas de message');
  assert(thresholdsNotice({}) === '', 'projet sans seuils enregistrés : il utilise le défaut, pas de message');
  assert(thresholdsNotice({ thresholds: DEFAULT_THRESHOLDS.map(x => ({ ...x, color: x.color.toLowerCase() })) }) === '', 'même couleur en minuscules : pas de message');
  const hasNotice = th => thresholdsNotice({ thresholds: th }) !== '';
  assert(hasNotice(DEFAULT_THRESHOLDS.map((x, i) => ({ ...x, min: i ? x.min : -60 }))), 'un seuil différent : message');
  assert(hasNotice(DEFAULT_THRESHOLDS.map((x, i) => ({ ...x, color: i ? x.color : '#123456' }))), 'une couleur différente : message');
  assert(hasNotice(DEFAULT_THRESHOLDS.slice(0, 3)), 'moins de classes : message');
  assert(hasNotice([...DEFAULT_THRESHOLDS, { min: -98, color: '#123456' }]), 'plus de classes : message');
});

await test('Seuils RSSI : le bouton « Seuils par défaut » applique le nouveau défaut', async () => {
  const p = scoutProject();
  resetThresholds(p);
  assert(p.thresholds.map(x => x.min).join() === '-65,-75,-85,-88' && p.thresholds.map(x => x.color).join() === '#FF0000,#FF8C00,#FFD700,#32CD32', JSON.stringify(p.thresholds));
  assert(p.thresholds[0] !== DEFAULT_THRESHOLDS[0], 'copie attendue : le défaut ne doit pas être modifiable depuis un projet');
  assert(thresholdsNotice(p) === '', 'message après remise au défaut');
  const app = await (await fetch('../js/app.js')).text();
  const handler = app.slice(app.indexOf(`$('btn-thresholds-reset')`), app.indexOf('// ---------- radio ----------'));
  assert(/resetThresholds\(state\.project\)/.test(handler), 'le bouton n\'appelle pas resetThresholds : ' + handler);
  const html = document.createElement('div');
  html.innerHTML = await (await fetch('../index.html')).text();
  const key = html.querySelector('#btn-thresholds-reset').dataset.i18n;
  assert(STRINGS[key].fr === 'Seuils par défaut', `libellé du bouton : ${STRINGS[key].fr}`);
  assert(key === 'btn.resetThresholds' && !STRINGS['btn.resetScout'], `clé ${key}`);
  assert(!/background:#000"><\/span><span>&lt;/.test(app) && !app.includes(': No<'), 'panneau des seuils : « < dernier seuil » encore en noir « No »');
});

await test('Bandeau : ASTRID, verdict, pas de service, distance ; ni part non conforme ni part sous un seuil', async () => {
  const { project } = await sampleProject();
  // décision de Jean (04/11) : 59 conformes, 91 faibles, 147 sans service sur 297 ; 147/297 = 49,49… -> 49,4
  const cap = caption(project, withNoService(countsFloor(59, 297), 147), 'fr');
  assert(cap.endsWith('297 points dont 147 No service · ASTRID : 19,8 % des points ≥ -88 dBm — NON conforme (objectif 95 %) · No service : 49,4 % · distance parcourue : 19,7 %'), cap);
  assert(!cap.includes('non conforme :') && !cap.includes('< -98') && !cap.includes('< -88 dBm :'), cap);
  const en = caption(project, withNoService(countsFloor(59, 297), 147), 'en');
  assert(en.endsWith('ASTRID: 19.8 % of points ≥ -88 dBm — NOT compliant (target 95 %) · no service: 49.4 % · distance covered: 19.7 %'), en);
  assert(!en.includes('non-compliant') && !en.includes('< -88'), en);
  const nl = caption(project, withNoService(countsFloor(59, 297), 147), 'nl');
  assert(nl.endsWith('297 punten waarvan 147 No service · ASTRID: 19,8 % van de punten ≥ -88 dBm — voldoet NIET (doel 95 %) · No service: 49,4 % · afgelegde weg: 19,7 %'), nl);
  assert(!nl.includes('niet conform') && !nl.includes('< -88'), nl);
  // la part « pas de service » ne dépend plus des seuils ; le point à -88 pile n'y compte pas
  const fl = countsFloor(4, 4), s = fl.segments[0].samples;
  s[0].rssi = -70; s[1].rssi = -88; s[2].rssi = -89; Object.assign(s[3], { rssi: '', noService: 'noserving' });
  const sh = floorShares(fl);
  assert(sh.noService === 25 && !('below' in sh), JSON.stringify(sh));
  // un projet qui garde ses seuils n'a pas non plus de part sous son dernier seuil
  project.thresholds = scoutProject().thresholds;
  assert(!caption(project, countsFloor(1, 3, -120), 'fr').includes('< -98'), caption(project, countsFloor(1, 3, -120), 'fr'));
  // le radio ISSI reste à sa place, après les parts
  const withRadio = { ...countsFloor(1, 3), radio: { issi: '1234567' } };
  assert(caption(project, withRadio, 'fr').endsWith(' · radio ISSI 1234567'), caption(project, withRadio, 'fr'));
});

await test('Textes : le critère ASTRID s\'écrit ≥ -88 dBm, jamais > -88', async () => {
  for (const [key, entry] of Object.entries(STRINGS)) {
    for (const l of LANGS) assert(!/>\s*-88/.test(String(entry[l])), `${key} (${l}) : ${entry[l]}`);
  }
  const e = STRINGS['btn.resetAstrid'];
  assert(e.fr === 'Rétablir ASTRID (≥ -88 dBm, 95 %)' && e.nl === 'ASTRID herstellen (≥ -88 dBm, 95 %)' && e.en === 'Restore ASTRID (≥ -88 dBm, 95 %)', JSON.stringify(e));
  const html = document.createElement('div');
  html.innerHTML = await (await fetch('../index.html')).text();
  assert(html.querySelector('#btn-criterion-reset').textContent === e.fr, 'index.html : ' + html.querySelector('#btn-criterion-reset').textContent);
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
await test('ASTRID : seuil ≥ -88 dBm, % des points (fait foi), distance en information, arrondi par défaut', async () => {
  // décision de Jean : -88 pile est conforme (Annexes 2 et 6 : « minimum -88 dBm »)
  assert(sampleOk(-88) && sampleOk(-87) && !sampleOk(-89) && !sampleOk('') && sampleOk(-60), `seuil ≥ -88 dBm : -88 -> ${sampleOk(-88)}`);
  const { project, floor } = await sampleProject();
  // s1 : -60 (conforme) et -95 sur 100 px chacun ; s2 : un seul point (-120), sans longueur
  const r = floorCompliance(floor, project.criterion);
  assert(r.n === 3 && r.okN === 1 && Math.abs(r.pct - 100 / 3) < 1e-9 && Math.abs(r.pctDistance - 50) < 1e-9 && r.ok === false,
    'le % des points fait foi, la distance est secondaire : ' + JSON.stringify(r));
  // 10 points conformes au même endroit : comptent dans le % des points, pas dans la distance
  floor.segments[0].samples.push(...Array.from({ length: 10 }, () => ({ ...floor.segments[0].samples[1], rssi: -60 })));
  const r2 = floorCompliance(floor);
  assert(Math.abs(r2.pct - 11 / 13 * 100) < 1e-9 && Math.abs(r2.pctDistance - 50) < 1e-9, JSON.stringify(r2));
  assert(floorCompliance({ segments: [] }).pct === null && floorCompliance({ segments: [] }).pctDistance === null, 'étage sans mesure');
  assert(fmtPct(94.96) === '94,9 %' && fmtPct(95) === '95,0 %', `${fmtPct(94.96)} / ${fmtPct(95)}`);
  const txt = complianceText(sampleProjectFloorCopy(floor), { rssi: -100, percent: 50 });
  assert(txt.includes('des points ≥ -100 dBm — conforme (objectif 50 %)') && /distance parcourue : \d/.test(txt), txt);
});

/** Copie de l'étage limitée aux 3 mesures d'origine (-60, -95, -120). */
function sampleProjectFloorCopy(floor) {
  return { ...floor, segments: [{ ...floor.segments[0], samples: floor.segments[0].samples.slice(0, 2) }, floor.segments[1]] };
}

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
  assert(back.name === project.name && back.thresholds.length === 4, 'en-tête');
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
  assert(px(150, 150) === '255,0,0', `rouge attendu à -60 dBm : ${px(150, 150)}`);
  assert(px(250, 150) === '0,102,204', `bleu attendu à -95 dBm : ${px(250, 150)}`);
  assert(px(5, bmp.height - 5) === '241,243,245', `bandeau : ${px(5, bmp.height - 5)}`);
  // la trace va jusqu'aux points cliqués : près de l'extrémité droite du tronçon (350,150), du bleu
  // (avant, la dernière mesure s'arrêtait à mi-chemin, vers x = 300)
  assert(px(338, 150) === '0,102,204', `fin de tronçon : ${px(338, 150)}`);
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

await test('Pas de service : compté NON conforme dans le % ASTRID (points)', () => {
  const r = floorCompliance(noServiceWalk());
  // aujourd'hui : 100 % « conforme » alors qu'un tiers du trajet n'a aucun service
  // aujourd'hui : 100 % « conforme » alors qu'un tiers du trajet n'a aucun service.
  // % des points (fait foi) : 20 points conformes sur ~50, les points « pas de service » comptent non conformes
  assert(Math.abs(r.pct - r.okN / r.n * 100) < 1e-9 && r.pct > 38 && r.pct < 42 && r.ok === false, `ASTRID ${r.pct} % des points, conforme : ${r.ok}`);
  assert(r.pctDistance > 55 && r.pctDistance < 72, `distance ${r.pctDistance}`);
  assert(typeof criterionMod.floorShares === 'function', 'floorShares() (part « pas de service ») n\'existe pas');
  const sh = criterionMod.floorShares(noServiceWalk());
  assert(sh.noService > 56 && sh.noService < 62, 'parts en % des points : ' + JSON.stringify(sh));
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
  assert(/distance parcourue/.test(cap) && /No service : /.test(cap) && !/< -88 dBm/.test(cap), cap);
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
  assert(caption(project, floor).includes(`${all} points dont ${ns} No service`), caption(project, floor));
  // le compteur de la liste des étages est à l'écran : il garde la langue de l'interface
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

// ---------- langue des exports (le PNG part dans le rapport CRG, quelle que soit la langue de l'interface) ----------
// Attendu : réglage FR / NL / EN, anglais par défaut, mémorisé à part. Aujourd'hui, une interface en
// français met « Pas de service » dans le PNG d'un rapport néerlandais.
const i18nMod = await import('../js/i18n.js');
const renderMod = await import('../js/render.js');
const exportMod = await import('../js/export.js');
// un espace de noms de module est figé (« ns.fn ??= … » lèverait une erreur et stopperait run.js) :
// les remplaçants reproduisent le comportement d'avant la correction (langue de l'interface)
const getLang = i18nMod.getLang;
const getExportLang = i18nMod.getExportLang ?? (() => undefined);
const setExportLang = i18nMod.setExportLang ?? (() => undefined);
const tx = i18nMod.tx ?? ((l, key, params) => t(key, params));
const legendLines = renderMod.legendLines ?? (() => [t('legend.noService')]);
const combinedCsvName = exportMod.combinedCsvName;
const otherCombinedWarning = exportMod.otherCombinedWarning ?? (async () => '');   // avant : aucun avertissement

const EXPORT_KEY = 'tetra-walktest.exportLang';
let freshN = 0;
/** i18n.js rechargé comme au démarrage de l'appli, avec cette valeur mémorisée (null : aucune). */
function freshI18n(saved) {
  if (saved === null) localStorage.removeItem(EXPORT_KEY); else localStorage.setItem(EXPORT_KEY, saved);
  return import(`../js/i18n.js?fresh=${++freshN}`);
}
/** Exécute fn puis rend à ce navigateur la préférence mémorisée qu'il avait avant le test. */
async function keepingExportPref(fn) {
  const before = localStorage.getItem(EXPORT_KEY);
  try { return await fn(); }
  finally { if (before === null) localStorage.removeItem(EXPORT_KEY); else localStorage.setItem(EXPORT_KEY, before); }
}
const defaultExportLang = () => keepingExportPref(async () => (await freshI18n(null)).getExportLang?.());

/** Étage fictif : les `ok` premiers points à -70 dBm, les autres à `lowRssi`, un point par seconde dès 10:00:00. */
function countsFloor(ok, total, lowRssi = -95) {
  const t0 = new Date(2000, 0, 1, 10, 0, 0).getTime();
  return { name: 'Étage -1', segments: [{ id: 's1', points: [], samples: Array.from({ length: total }, (_, i) =>
    ({ la: 1001, channel: 100, c1: 10, time: t0 + i * 1000, ta: i * 1000, x: i, y: 0, leg: 1, rssi: i < ok ? -70 : lowRssi })) }] };
}

/** Les n dernières mesures de l'étage deviennent des points « pas de service ». */
function withNoService(floor, n) {
  for (const s of floor.segments[0].samples.slice(-n)) Object.assign(s, { rssi: '', noService: 'noserving' });
  return floor;
}

await test('Langue des exports : anglais par défaut, choix mémorisé, valeur inconnue ignorée', () => keepingExportPref(async () => {
  assert(typeof i18nMod.getExportLang === 'function', 'getExportLang() n\'existe pas : aucun réglage de langue des exports');
  assert((await freshI18n(null)).getExportLang() === 'en', 'défaut : anglais');
  assert((await freshI18n('xx')).getExportLang() === 'en', 'valeur mémorisée inconnue : anglais');
  assert((await freshI18n('nl')).getExportLang() === 'nl', 'valeur mémorisée non relue au démarrage');
  localStorage.removeItem(EXPORT_KEY);
  const uiLang = localStorage.getItem('tetra-walktest.lang');
  setExportLang('fr');
  assert(getExportLang() === 'fr' && localStorage.getItem(EXPORT_KEY) === 'fr', `non mémorisé : ${localStorage.getItem(EXPORT_KEY)}`);
  setExportLang('xx');
  assert(getExportLang() === 'fr', 'langue inconnue acceptée');
  assert(localStorage.getItem('tetra-walktest.lang') === uiLang && getLang() === 'fr', 'la langue de l\'interface a changé');
  setExportLang('en', false);
}));

await test('Langue des exports : traduire dans une langue donnée sans changer celle de l\'interface', () => {
  assert(tx('en', 'legend.noService') === 'No service', tx('en', 'legend.noService'));
  assert(tx('nl', 'floor.count', { n: 1234 }) === '1.234 metingen', tx('nl', 'floor.count', { n: 1234 }));
  assert(tx('en', 'floor.count', { n: 1234 }) === '1,234 measurements', tx('en', 'floor.count', { n: 1234 }));
  assert(i18nMod.nf(19.8, 1, 'en') === '19.8' && i18nMod.nf(19.8, 1, 'nl') === '19,8', `nf : ${i18nMod.nf(19.8, 1, 'en')}`);
  assert(getLang() === 'fr' && t('legend.noService') === 'Pas de service' && i18nMod.nf(19.8, 1) === '19,8', 'interface modifiée');
});

await test('Langue des exports : interface FR, réglage par défaut -> légende et bandeau en anglais', async () => {
  const { project, floor } = await sampleProject();
  floor.segments = noServiceWalk('noserving', 150, 50).segments;
  floor.radio = { issi: '1234567' };
  const lang = await defaultExportLang();
  assert(legendLines(DEFAULT_THRESHOLDS, lang).includes('No service'), 'légende : ' + legendLines(DEFAULT_THRESHOLDS, lang).join(' | '));
  const cap = caption(project, floor, lang);
  assert(!/pas de service|sans service|des points|distance parcourue/i.test(cap), 'bandeau en français : ' + cap);
  assert(/without service/.test(cap) && /ASTRID: \d+\.\d % of points/.test(cap) && /NOT compliant \(target 95 %\)/.test(cap), cap);
  assert(/distance covered/.test(cap) && /no service: \d+\.\d %/.test(cap) && !/< -88 dBm/.test(cap) && /radio ISSI 1234567/.test(cap), cap);
  assert(getLang() === 'fr' && document.documentElement.lang === 'fr', 'interface modifiée');
});

await test('Langue des exports : NL -> légende et bandeau en néerlandais, interface inchangée', async () => {
  const { project, floor } = await sampleProject();
  floor.segments = noServiceWalk('noserving', 150, 50).segments;
  assert(legendLines(DEFAULT_THRESHOLDS, 'nl').includes('No service'), 'légende : ' + legendLines(DEFAULT_THRESHOLDS, 'nl').join(' | '));
  const cap = caption(project, floor, 'nl');
  assert(!/pas de service|sans service|des points|distance parcourue/i.test(cap), 'bandeau en français : ' + cap);
  assert(/waarvan \d+ No service/.test(cap) && /ASTRID: \d+,\d % van de punten/.test(cap) && /voldoet NIET \(doel 95 %\)/.test(cap), cap);
  assert(/afgelegde weg/.test(cap) && /No service: \d+,\d %/.test(cap) && !/< -88 dBm/.test(cap), cap);
  assert(getLang() === 'fr' && document.documentElement.lang === 'fr', 'interface modifiée');
});

await test('Langue des exports : dates et nombres du bandeau selon la langue, pas selon l\'interface', async () => {
  const { project } = await sampleProject();
  const fl = countsFloor(59, 1234);   // 1 234 points de 10:00:00 à 10:20:33
  const en = caption(project, fl, 'en'), nl = caption(project, fl, 'nl');
  assert(en.includes('1,234 measurements') && en.includes('01/01/2000 10:00–10:20'), en);
  assert(nl.includes('1.234 metingen') && !nl.includes('2000-01-01') && nl.includes('10:00–10:20'), nl);
  assert(en.includes('4.7 %') && nl.includes('4,7 %'), `${en} / ${nl}`);
});

await test('Langue des exports : textes dessinés dans le PNG (légende, bandeau, échelle), écran inchangé', async () => {
  const { project, floor } = await sampleProject();
  floor.segments = noServiceWalk('noserving', 150, 50).segments;
  floor.calibration = { ...floor.calibration, mPerPx: 0.05 };   // barre d'échelle de 5 m : décimale visible
  const img = await createImageBitmap(floor.image.blob);
  const proto = OffscreenCanvasRenderingContext2D.prototype, real = proto.fillText;
  let drawn = [];
  proto.fillText = function (text, ...rest) { drawn.push(String(text)); return real.call(this, text, ...rest); };
  try {
    setExportLang('nl', false);
    await floorPng(project, floor, img);
    const nl = drawn.join(' | ');
    assert(drawn.includes('No service') && !drawn.includes('Pas de service'), 'légende du PNG : ' + nl);
    assert(/van de punten/.test(nl) && !/des points/.test(nl), 'bandeau du PNG : ' + nl);
    assert(drawn.includes('5,0 m'), 'échelle : ' + nl);
    assert(getLang() === 'fr' && document.documentElement.lang === 'fr', 'interface modifiée par l\'export');

    drawn = [];
    setExportLang('en', false);
    await floorPng(project, floor, img);
    assert(drawn.includes('No service') && drawn.includes('5.0 m') && drawn.join(' | ').includes('of points'), 'PNG en anglais : ' + drawn.join(' | '));

    // la légende à l'écran garde la langue de l'interface
    drawn = [];
    renderMod.drawLegend(new OffscreenCanvas(200, 200).getContext('2d'), 0, 0, DEFAULT_THRESHOLDS);
    assert(drawn.includes('Pas de service'), 'légende à l\'écran : ' + drawn.join(' | '));
    assert(renderMod.fmtMeters(5.5) === '5,5 m', `échelle à l'écran : ${renderMod.fmtMeters(5.5)}`);
  } finally {
    proto.fillText = real;
    setExportLang('en', false);
  }
});

// Décision de Jean (05/11/2026) : « No service » reste en anglais dans le PNG exporté (légende et bandeau),
// quelle que soit la langue des exports ; l'écran garde la langue de l'interface.
const TRANSLATED_NO_SERVICE = ['Pas de service', 'pas de service', 'Geen service', 'geen service', 'sans service', 'zonder service'];
const translatedNoService = text => TRANSLATED_NO_SERVICE.filter(term => text.includes(term));

await test('Langue des exports : « No service » en anglais dans la légende et le bandeau du PNG, en FR et en NL', async () => {
  const { project } = await sampleProject();
  const fl = withNoService(countsFloor(59, 297), 147);
  const cases = {
    fr: '297 points dont 147 No service · ASTRID : 19,8 % des points ≥ -88 dBm — NON conforme (objectif 95 %) · No service : 49,4 % · distance parcourue : 19,7 %',
    nl: '297 punten waarvan 147 No service · ASTRID: 19,8 % van de punten ≥ -88 dBm — voldoet NIET (doel 95 %) · No service: 49,4 % · afgelegde weg: 19,7 %',
  };
  for (const [lang, want] of Object.entries(cases)) {
    const lines = legendLines(DEFAULT_THRESHOLDS, lang), cap = caption(project, fl, lang);
    assert(lines.at(-1) === 'No service', `légende ${lang} : ${lines.join(' | ')}`);
    assert(cap.endsWith(want), `bandeau ${lang} : ${cap}`);
    assert(!translatedNoService(cap).length, `bandeau ${lang}, terme traduit (${translatedNoService(cap).join(', ')}) : ${cap}`);
    // une légende enregistrée (« < -98 (No) ») a la même ligne
    assert(legendLines(scoutProject().thresholds, lang).at(-1) === 'No service', `légende SCOUT ${lang} : ${legendLines(scoutProject().thresholds, lang).join(' | ')}`);
  }
  // l'anglais ne change pas
  const en = caption(project, fl, 'en');
  assert(legendLines(DEFAULT_THRESHOLDS, 'en').at(-1) === 'No service', legendLines(DEFAULT_THRESHOLDS, 'en').join(' | '));
  assert(en.endsWith('297 points, 147 without service · ASTRID: 19.8 % of points ≥ -88 dBm — NOT compliant (target 95 %) · no service: 49.4 % · distance covered: 19.7 %'), en);
});

await test('Langue des exports : « No service » dessiné dans le PNG en FR et en NL, interface en français', async () => {
  const { project, floor } = await sampleProject();
  floor.segments = noServiceWalk('noserving', 150, 50).segments;
  const img = await createImageBitmap(floor.image.blob);
  const proto = OffscreenCanvasRenderingContext2D.prototype, real = proto.fillText;
  let drawn = [];
  proto.fillText = function (text, ...rest) { drawn.push(String(text)); return real.call(this, text, ...rest); };
  try {
    for (const lang of ['fr', 'nl']) {
      drawn = [];
      setExportLang(lang, false);
      await floorPng(project, floor, img);
      const all = drawn.join(' | ');
      assert(drawn.includes('No service'), `légende du PNG ${lang} : ${all}`);
      assert(/No service ?: \d+,\d %/.test(all), `bandeau du PNG ${lang} : ${all}`);
      assert(!translatedNoService(all).length, `PNG ${lang}, terme traduit (${translatedNoService(all).join(', ')}) : ${all}`);
    }
  } finally {
    proto.fillText = real;
    setExportLang('en', false);
  }
});

await test('Interface : l\'écran garde le terme traduit, même après un export', () => {
  const screen = () => {
    const d = legendDrawing(DEFAULT_THRESHOLDS);
    return [d.texts.at(-1), t('legend.noService'), thresholdsMod.thresholdsPanelTail(DEFAULT_THRESHOLDS).at(-1).text];
  };
  try {
    const want = { fr: 'Pas de service', nl: 'Geen service', en: 'No service' };
    for (const [l, term] of Object.entries(want)) {
      setLang(l, false);
      assert(screen().every(s => s === term), `${l} : ${screen().join(' | ')}`);
    }
    setLang('fr', false);
    assert(t('live.noService').includes('Pas de service'), t('live.noService'));
    assert(t('stats.noService', { n: 3 }) === 'dont 3 sans service', t('stats.noService', { n: 3 }));
    assert(t('floor.count', { n: 5, ns: 3 }) === '5 points dont 3 sans service', t('floor.count', { n: 5, ns: 3 }));
    assert(t('crit.help').includes('pas de service'), t('crit.help'));
  } finally {
    setLang('fr', false);
  }
});

// Décision de Jean (04/11/2026) : les noms de fichiers restent en anglais, quelles que soient les langues.
await test('Noms de fichiers : CSV commun toujours en anglais, contenu des CSV inchangé', async () => {
  try {
    for (const l of LANGS) {
      setExportLang(l, false);
      setLang(l, false);
      assert(combinedCsvName('Plans') === 'Plans - all floors.csv', `interface et exports en ${l} : ${combinedCsvName('Plans')}`);
      assert(combinedCsvName('Plans', l) === 'Plans - all floors.csv', `langue ${l} précisée : ${combinedCsvName('Plans', l)}`);
    }
    setLang('fr', false);
    assert(!STRINGS['file.allFloors'], 'file.allFloors encore traduit : le nom ne doit pas dépendre de strings.js');
    for (const l of LANGS) assert(!/CSV commun|gezamenlijke CSV|combined CSV/.test(STRINGS['title.exportLang'][l]), `infobulle en ${l} : ${STRINGS['title.exportLang'][l]}`);
    setExportLang('nl', false);
    const { project, floor } = await sampleProject();
    const csvFl = floorCsv(floor), csvAll = projectCsv(project);
    setExportLang('en', false);
    assert(floorCsv(floor) === csvFl && projectCsv(project) === csvAll, 'le contenu du CSV dépend de la langue des exports');
    assert(csvFl.slice(1).startsWith(CSV_COLUMNS.join(';')), 'en-têtes du CSV modifiés');
  } finally {
    setLang('fr', false);
    setExportLang('en', false);
  }
});

/** Faux dossier exports/ : `names` à l'intérieur, enregistre tout appel à removeEntry. */
function exportsHandle(names, failAfter = null) {
  const removed = [];
  return {
    kind: 'directory', name: 'exports', removed,
    async *values() {
      for (const [i, name] of names.entries()) {
        if (i === failAfter) throw new DOMException('refusé', 'NotAllowedError');
        yield { kind: name.endsWith('/') ? 'directory' : 'file', name: name.replace(/\/$/, '') };
      }
      if (failAfter !== null) throw new DOMException('refusé', 'NotAllowedError');
    },
    async removeEntry(name) { removed.push(name); },
  };
}
const needsWarningFn = () => assert(typeof exportMod.otherCombinedWarning === 'function', 'otherCombinedWarning() n\'existe pas : aucun contrôle du dossier exports/');

await test('Exports : un autre CSV commun dans exports/ -> avertissement avec ses noms, rien n\'est supprimé', async () => {
  const dir = exportsHandle([
    'Plans - Floor -1.png', 'Plans - Floor -1.csv', 'Plans - all floors.csv',   // ce qu'on vient d'écrire
    'Plans - tous les étages.csv', 'Plans - alle verdiepingen.csv', 'Autre - all floors.csv',
    'notes - all floors.txt', 'Dossier - all floors.csv/',
  ]);
  const names = 'Autre - all floors.csv, Plans - alle verdiepingen.csv, Plans - tous les étages.csv';
  const fr = await otherCombinedWarning(dir, 'Plans');
  assert(fr === `Un autre fichier « tous les étages » existe déjà dans exports/ : ${names}. CRG l'ignore, mais pensez à ne pas l'envoyer avec le rapport.`, 'avertissement : ' + (fr || '(aucun)'));
  try {
    setExportLang('nl', false);   // le message suit l'interface, pas la langue des exports
    assert(await otherCombinedWarning(dir, 'Plans') === fr, 'le message suit la langue des exports');
    setLang('nl', false);
    const nl = await otherCombinedWarning(dir, 'Plans');
    assert(nl.includes(`in exports/: ${names}.`) && nl.includes('CRG negeert'), 'NL : ' + nl);
    setLang('en', false);
    const en = await otherCombinedWarning(dir, 'Plans');
    assert(en.includes(`in exports/: ${names}.`) && en.includes('CRG ignores'), 'EN : ' + en);
  } finally {
    setLang('fr', false);
    setExportLang('en', false);
  }
  assert(dir.removed.length === 0, 'fichier supprimé : ' + dir.removed.join(', '));
  // é décomposé (dossier passé par un Mac) : reconnu quand même
  const nfd = 'Plans - tous les étages.csv';
  assert((await otherCombinedWarning(exportsHandle([nfd]), 'Plans')).includes(nfd), 'é décomposé non reconnu');
});

await test('Exports : même nom seulement -> pas d\'avertissement (écrasement normal)', async () => {
  needsWarningFn();
  const cases = [
    ['Plans', ['Plans - Floor -1.csv', 'Plans - all floors.csv']],
    ['Plans', ['PLANS - ALL FLOORS.CSV']],                 // même fichier sous Windows
    ['A/B: test', ['A_B_ test - all floors.csv']],         // nom réellement écrit (caractères interdits remplacés)
    ['Plans', []],
  ];
  for (const [project, names] of cases) {
    const dir = exportsHandle(names), w = await otherCombinedWarning(dir, project);
    assert(w === '', `${project} / ${names.join(', ')} : ${w}`);
    assert(dir.removed.length === 0, 'fichier supprimé');
  }
});

await test('Exports : dossier illisible -> pas d\'avertissement, pas d\'erreur', async () => {
  needsWarningFn();
  for (const failAfter of [0, 1]) {
    const dir = exportsHandle(['Plans - tous les étages.csv'], failAfter);
    const w = await otherCombinedWarning(dir, 'Plans');
    assert(w === '', `échec après ${failAfter} entrée(s) : ${w}`);
    assert(dir.removed.length === 0, 'fichier supprimé');
  }
});

await test('Exports : « tous les étages » prévient après l\'export dans exports/, aucun code ne supprime de fichier', async () => {
  const app = await (await fetch('../js/app.js')).text();
  const all = app.slice(app.indexOf(`$('btn-export-all')`), app.indexOf('function renderSaveState'));
  assert(/otherCombinedWarning\(projectDir, project\.name\)/.test(all), 'l\'export de tous les étages ne contrôle pas exports/');
  assert(all.indexOf('otherCombinedWarning(') > all.indexOf('writeHandle('), 'contrôle avant l\'écriture des fichiers');
  // un seul toast : un notify() de succès après l'avertissement l'effacerait
  assert(/notify\([^\n]*warning[^\n]*'warn'/.test(all) && !/notify\(/.test(all.slice(all.lastIndexOf(`'warn'`))), 'avertissement effacé ou non affiché');
  assert((await (await fetch('../css/app.css')).text()).includes('.toast.warn'), 'style .toast.warn absent');
  for (const f of ['app', 'export', 'folder', 'project', 'autosave']) {
    assert(!(await (await fetch(`../js/${f}.js`)).text()).includes('removeEntry'), `removeEntry dans js/${f}.js`);
  }
});

await test('Langue des exports : sélecteur à côté des boutons d\'export, relié au réglage', async () => {
  const html = document.createElement('div');
  html.innerHTML = await (await fetch('../index.html')).text();
  const sel = html.querySelector('select#export-lang');
  assert(sel, 'select#export-lang absent de index.html');
  assert([...sel.options].map(o => o.value).join(',') === LANGS.join(','), 'options : ' + [...sel.options].map(o => o.value).join(','));
  const label = html.querySelector('label[for="export-lang"]');
  assert(label && label.dataset.i18n === 'label.exportLang', 'libellé du sélecteur');
  const e = STRINGS['label.exportLang'];
  assert(e.fr === 'Langue des exports' && e.nl === 'Taal van de exports' && e.en === 'Export language', JSON.stringify(e));
  const panel = html.querySelector('#btn-export-all').closest('section');
  assert(panel.contains(sel), 'le sélecteur n\'est pas dans le panneau des exports');
  const app = await (await fetch('../js/app.js')).text();
  assert(/setExportLang\(/.test(app) && /getExportLang\(/.test(app), 'app.js ne relie pas le sélecteur au réglage');
  assert(/combinedCsvName\(/.test(app) && !app.includes(`t('file.allFloors')`), 'app.js nomme le CSV commun dans la langue de l\'interface');
});

await test('Pourcentages : 59/297 -> 19,8, NON conforme, sans part non conforme', async () => {
  const { project } = await sampleProject();
  const fl = countsFloor(59, 297), r = floorCompliance(fl);
  assert(r.ok === false && fmtPct(r.pct) === '19,8 %', `${r.ok} ${fmtPct(r.pct)}`);
  const cap = caption(project, fl, 'fr');
  assert(cap.includes('19,8 % des points') && cap.includes('NON conforme'), cap);
  assert(!cap.includes('80,2') && !cap.includes('non conforme :'), 'part non conforme encore dans le bandeau : ' + cap);
  const en = caption(project, fl, 'en'), nl = caption(project, fl, 'nl');
  assert(en.includes('19.8 %') && en.includes('NOT compliant') && !en.includes('non-compliant'), en);
  assert(nl.includes('19,8 %') && !nl.includes('niet conform'), nl);
});

await test('Pourcentages : 9496/10000 -> 94,9 NON conforme ; 95/100 et 19/20 -> 95,0 conforme', async () => {
  const { project } = await sampleProject();
  const fl = countsFloor(9496, 10000), r = floorCompliance(fl);
  assert(r.ok === false, '94,96 % déclaré conforme');
  const cap = caption(project, fl, 'fr');
  assert(cap.includes('94,9 % des points') && cap.includes('NON conforme') && !cap.includes('95,0 %') && !cap.includes('non conforme :'), cap);
  for (const [ok, total] of [[95, 100], [19, 20]]) {
    const pile = countsFloor(ok, total), capPile = caption(project, pile, 'fr');
    assert(floorCompliance(pile).ok === true, '95 % pile : conforme');
    assert(capPile.includes('95,0 % des points ≥ -88 dBm — conforme (objectif 95 %)') && !capPile.includes('NON conforme') && !capPile.includes('non conforme :'), capPile);
  }
});

await test('Pourcentages : verdict et troncature sans erreur de virgule flottante, autres parts tronquées', async () => {
  // 29/100*100 = 28,999999999999996 en virgule flottante : verdict faux et « 28,9 % » affiché
  const fl = countsFloor(29, 100);
  assert(floorCompliance(fl, { rssi: -88, percent: 29 }).ok === true, '29/100 pour un objectif de 29 % : verdict sur les comptes exacts');
  assert(fmtPct(floorCompliance(fl).pct) === '29,0 %', `29/100 affiché ${fmtPct(floorCompliance(fl).pct)}`);
  const { project } = await sampleProject();
  // 1 point conforme, 2 sans service : 66,66… % tronqué à 66,6 (pas 66,7)
  const cap = caption(project, withNoService(countsFloor(1, 3), 2), 'fr');
  assert(cap.includes('33,3 % des points') && cap.includes('No service : 66,6 %'), cap);
});

const ko = results.filter(r => !r.ok).length;
document.getElementById('out').innerHTML = results.map(r =>
  `<div class="${r.ok ? 'ok' : 'ko'}">${r.ok ? '✔' : '✘'} ${r.name}</div>` + (r.err ? `<pre>${r.err}</pre>` : '')
).join('') + `<p><b>${results.length - ko}/${results.length} réussis</b> — ${rows.length} points décodés.</p>`;
document.title = ko ? 'ÉCHEC' : 'OK';
window.__results = results;
