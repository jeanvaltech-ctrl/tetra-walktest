// app.js — point d'entrée de l'interface.
import { PlanView } from './planview.js';
import { createProject, addFloor, setCalibration, clearCalibration, serializeProject, deserializeProject } from './project.js';
import { floorCsv, floorPng, fileSafe } from './export.js';
import { dist } from './geometry.js';
import { Radio, RADIO_VID } from './radio.js';
import { INFO, toHex } from './protocol.js';
import { rssiColor, textOn, DEFAULT_THRESHOLDS } from './thresholds.js';
import { Session, floorStats } from './session.js';
import { SimPort } from './simport.js';
import { AutoSave } from './autosave.js';
import { nf, fmtMeters, drawLabel, drawTrace, drawLegend, drawScaleBar, LEGEND_W } from './render.js';

const $ = id => document.getElementById(id);

const state = {
  project: null,
  floor: null,      // étage affiché
  mode: 'idle',     // idle | pick1 | pick2 | distance (calibration)
  p1: null, p2: null,
  hover: null,      // position de la souris (coordonnées image)
  session: null,    // mesure par waypoints sur l'étage affiché
  bitmap: null,     // plan décodé de l'étage affiché
  fileHandle: null, // fichier projet ouvert / enregistré (API File System Access)
  dirty: false,     // modifications non enregistrées dans le fichier projet
  autosavedAt: 0,   // dernière copie de secours dans le navigateur
};

function markDirty() {
  if (!state.dirty) { state.dirty = true; renderSaveState(); }
  scheduleAutosave();
}

// ---------- sauvegarde automatique (copie de secours dans le navigateur) ----------
const autosave = new AutoSave();
const AUTOSAVE_MS = 3000;   // au plus une écriture toutes les 3 s pendant la mesure
let autosaveTimer = 0;

function scheduleAutosave() {
  if (state.project && !autosaveTimer) autosaveTimer = setTimeout(autosaveNow, AUTOSAVE_MS);
}

async function autosaveNow() {
  clearTimeout(autosaveTimer);
  autosaveTimer = 0;
  if (!state.project) return;
  try {
    await autosave.save(state.project, {
      session: state.session ? state.session.snapshot() : null,
      dirty: state.dirty, fileHandle: state.fileHandle, floorId: state.floor.id,
    });
    state.autosavedAt = Date.now();
    renderSaveState();
  } catch (e) {
    console.warn('Sauvegarde automatique :', e);
    setStatus(`Copie de secours impossible : ${e.message}`);
  }
}

/** Nouveau projet ou projet ouvert depuis un fichier : la copie de secours repart de zéro. */
async function restartAutosave() {
  await autosave.clear();
  await autosaveNow();
  // demande au navigateur de ne pas effacer ces données pour faire de la place
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

// enregistrer tout de suite quand la page passe en arrière-plan ou se ferme
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') autosaveNow(); });
window.addEventListener('pagehide', () => autosaveNow());

const thresholds = () => (state.project && state.project.thresholds) || DEFAULT_THRESHOLDS;
const colorOf = rssi => rssiColor(rssi, thresholds());

const view = new PlanView($('plan'));
view.drawOverlay = drawOverlay;

function setStatus(text) { $('status').textContent = text; }

// ---------- chargement du plan ----------
async function loadImage(file) {
  if (!/^image\/(png|jpeg)$/.test(file.type)) throw new Error(`Format non pris en charge (${file.type || file.name}) : PNG ou JPG uniquement.`);
  try { return await createImageBitmap(file); }
  catch { throw new Error(`Impossible de lire l'image « ${file.name} ».`); }
}

$('form-new').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, file = f.plan.files[0], err = $('new-error');
  err.hidden = true;
  if (!discardRecoveryOk()) return;
  try {
    const bmp = await loadImage(file);
    const project = createProject({ name: f.name.value.trim(), building: f.building.value.trim() });
    addFloor(project, {
      name: f.floor.value.trim(),
      image: { blob: file, name: file.name, type: file.type, width: bmp.width, height: bmp.height },
    });
    showProject(project, bmp, null);
    state.dirty = true;
    setStatus('Projet créé');
    render();
    await restartAutosave();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

/** Affiche un projet (nouveau, ouvert ou récupéré) : 1er étage et sa session de mesure. */
function showProject(project, bmp, handle, session = null) {
  state.project = project;
  state.floor = project.floors[0];
  state.bitmap = bmp;
  state.fileHandle = handle;
  state.dirty = false;
  Object.assign(state, { mode: 'idle', p1: null, p2: null });
  attachSession(session || new Session(state.floor));
  $('thresholds').innerHTML = '';
  $('sec-recover').hidden = true;
  view.setImage(bmp);
}

const abandonOk = () => !state.dirty || confirm('Abandonner le projet en cours ? Les dernières modifications ne sont pas enregistrées.');

$('btn-new-project').addEventListener('click', () => {
  if (!abandonOk()) return;
  attachSession(null);
  Object.assign(state, { project: null, floor: null, bitmap: null, fileHandle: null, dirty: false, mode: 'idle', p1: null, p2: null });
  autosave.clear();
  $('form-new').reset();
  $('thresholds').innerHTML = '';
  view.setImage(null);
  setStatus('Prêt');
  render();
});

// ---------- reprise au démarrage ----------
let recovered = null;

async function offerRecovery() {
  try { recovered = await autosave.load(); } catch (e) { console.warn('Lecture de la copie de secours :', e); return; }
  if (!recovered || state.project) return;
  const p = recovered.project, fl = p.floors.find(f => f.id === recovered.floorId) || p.floors[0];
  const n = fl.segments.reduce((a, s) => a + s.samples.length, 0) + (recovered.session?.pending?.length || 0);
  const when = new Date(recovered.savedAt).toLocaleString('fr-BE', { dateStyle: 'short', timeStyle: 'short' });
  const running = recovered.session && recovered.session.state !== 'idle';
  $('recover-text').innerHTML = `<b>${esc(p.name)}</b> — ${esc(fl.name)}<br>`
    + `<span class="muted small">Copie de secours du ${when} · ${nf(n)} mesure${n > 1 ? 's' : ''}`
    + `${running ? ' · mesure en cours' : ''}</span>`
    + (recovered.dirty ? '<br><span class="ko small">Contient des modifications non enregistrées dans un fichier.</span>' : '');
  $('sec-recover').hidden = false;
}

$('btn-recover').addEventListener('click', () => runFileAction(async () => {
  const rec = recovered;
  const p = rec.project;
  const i = Math.max(0, p.floors.findIndex(f => f.id === rec.floorId));
  if (i > 0) p.floors.unshift(...p.floors.splice(i, 1));      // étage affiché en premier
  const bmp = await createImageBitmap(p.floors[0].image.blob);
  showProject(p, bmp, rec.fileHandle || null, Session.restore(p.floors[0], rec.session));
  state.dirty = !!rec.dirty;
  const paused = state.session.state === 'paused';
  setStatus(paused ? 'Mesure récupérée, en pause au dernier point cliqué' : 'Projet récupéré');
  render();
  await autosaveNow();
}));

/** Avant de remplacer une copie de secours proposée et non enregistrée par un autre projet. */
function discardRecoveryOk() {
  if (!recovered || $('sec-recover').hidden || !recovered.dirty) return true;
  if (!confirm('Effacer définitivement la copie de secours proposée ? Les mesures non enregistrées dans un fichier seront perdues.')) return false;
  recovered = null;
  $('sec-recover').hidden = true;
  return true;
}

$('btn-recover-discard').addEventListener('click', () => {
  if (!discardRecoveryOk()) return;
  autosave.clear();
  recovered = null;
  $('sec-recover').hidden = true;
});

// ---------- fichiers : enregistrer, ouvrir, exporter ----------
const PROJECT_TYPE = { description: 'Projet TETRA Walk-Test', accept: { 'application/json': ['.json'] } };

/**
 * Enregistre un fichier : boîte « Enregistrer sous » si disponible (Edge/Chrome), sinon téléchargement.
 * makeBlob n'est appelé qu'après le choix du fichier : la boîte doit s'ouvrir juste après le clic.
 */
async function saveBlob(makeBlob, name, type, handle = null) {
  if (window.showSaveFilePicker) {
    // fichier repris d'une session précédente : Edge redemande l'autorisation d'écrire
    if (handle && handle.queryPermission && await handle.queryPermission({ mode: 'readwrite' }) !== 'granted'
        && await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') handle = null;
    handle ??= await showSaveFilePicker({ suggestedName: name, types: [type] });
    const blob = await makeBlob();
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
    return handle;
  }
  const blob = await makeBlob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return null;
}

async function runFileAction(fn) {
  try { await fn(); }
  catch (e) { if (e.name !== 'AbortError') setStatus(`Erreur : ${e.message}`); }   // AbortError = boîte annulée
}

async function saveProject(saveAs) {
  if (!state.project) return;
  const project = state.project;
  const handle = await saveBlob(async () => new Blob([await serializeProject(project)], { type: 'application/json' }),
    `${fileSafe(project.name)}.walktest.json`, PROJECT_TYPE, saveAs ? null : state.fileHandle);
  state.fileHandle = handle;
  state.dirty = false;
  setStatus(`Projet enregistré${handle ? ` (${handle.name})` : ''}`);
  renderSaveState();
  autosaveNow();
}

async function openProject() {
  if (!abandonOk() || !discardRecoveryOk()) return;
  let file, handle = null;
  if (window.showOpenFilePicker) {
    [handle] = await showOpenFilePicker({ types: [PROJECT_TYPE] });
    file = await handle.getFile();
  } else {
    file = await new Promise(ok => {
      const input = $('open-file');
      input.value = '';
      input.onchange = () => ok(input.files[0]);
      input.click();
    });
    if (!file) return;
  }
  const project = await deserializeProject(await file.text());
  const bmp = await createImageBitmap(project.floors[0].image.blob);
  attachSession(null);
  showProject(project, bmp, handle);
  setStatus(`Projet ouvert : ${file.name}`);
  render();
  await restartAutosave();
}

$('btn-save').addEventListener('click', () => runFileAction(() => saveProject(false)));
$('btn-save-as').addEventListener('click', () => runFileAction(() => saveProject(true)));
document.querySelectorAll('.btn-open').forEach(b => b.addEventListener('click', () => runFileAction(openProject)));
window.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's' && state.project) {
    e.preventDefault();
    runFileAction(() => saveProject(e.shiftKey));
  }
});

$('btn-export-csv').addEventListener('click', () => runFileAction(async () => {
  const fl = state.floor;
  await saveBlob(() => new Blob([floorCsv(fl)], { type: 'text/csv' }), `${fileSafe(`${state.project.name} - ${fl.name}`)}.csv`,
    { description: 'CSV', accept: { 'text/csv': ['.csv'] } });
  setStatus('CSV exporté');
}));

$('btn-export-png').addEventListener('click', () => runFileAction(async () => {
  const fl = state.floor, project = state.project, bmp = state.bitmap;
  await saveBlob(() => floorPng(project, fl, bmp), `${fileSafe(`${project.name} - ${fl.name}`)}.png`,
    { description: 'Image PNG', accept: { 'image/png': ['.png'] } });
  setStatus('PNG exporté');
}));

function renderSaveState() {
  const el = $('save-state');
  if (!state.project) return;
  el.textContent = state.dirty ? '● Modifications non enregistrées'
    : state.fileHandle ? `Enregistré dans ${state.fileHandle.name}` : 'Enregistré';
  el.classList.toggle('ko', state.dirty);
  if (state.autosavedAt) {
    const t = new Date(state.autosavedAt).toLocaleTimeString('fr-BE');
    el.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: ` · copie de secours ${t}` }));
  }
}

// glisser-déposer d'un plan sur la zone centrale
const stage = $('stage');
stage.addEventListener('dragover', e => { e.preventDefault(); stage.classList.add('dragover'); });
stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
stage.addEventListener('drop', e => {
  e.preventDefault();
  stage.classList.remove('dragover');
  if (!e.dataTransfer.files.length) return;
  if (state.project) { setStatus('Un projet est déjà ouvert'); return; }
  const form = $('form-new');
  form.plan.files = e.dataTransfer.files;
  setStatus(`Plan sélectionné : ${e.dataTransfer.files[0].name}`);
  if (form.checkValidity()) form.requestSubmit(); else form.name.focus();
});

// ---------- affichage ----------
$('zoom-in').addEventListener('click', () => view.zoomBy(1.25));
$('zoom-out').addEventListener('click', () => view.zoomBy(0.8));
$('zoom-fit').addEventListener('click', () => view.fit());
view.addEventListener('viewchange', () => { $('zoom-level').textContent = `${nf(view.t.s * 100)} %`; });

window.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select') || !state.floor) return;
  const ses = state.session;
  if (ses && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z') {
    if (ses.undo()) e.preventDefault();
    return;
  }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key === ' ' && ses && !e.target.closest('button') && (ses.state === 'walking' || ses.state === 'paused')) {
    toggleMeasurePause();
  } else if (e.key === '+' || e.key === '=') view.zoomBy(1.25);
  else if (e.key === '-') view.zoomBy(0.8);
  else if (e.key === '0') view.fit();
  else if (e.key === 'Escape' && state.mode !== 'idle') cancelCalibration();
  else return;
  e.preventDefault();
});

// ---------- calibration ----------
$('btn-calib').addEventListener('click', () => {
  Object.assign(state, { mode: 'pick1', p1: null, p2: null });
  render();
});
document.querySelectorAll('.calib-cancel').forEach(b => b.addEventListener('click', cancelCalibration));
$('btn-calib-clear').addEventListener('click', () => {
  clearCalibration(state.floor);
  markDirty();
  setStatus('Échelle supprimée');
  render();
});

function cancelCalibration() {
  Object.assign(state, { mode: 'idle', p1: null, p2: null });
  render();
}

view.addEventListener('planclick', e => {
  const p = e.detail, img = state.floor && state.floor.image, ses = state.session;
  if (!img || state.mode === 'distance') return;
  if (state.mode === 'idle') {
    if (!ses || ses.state === 'idle') return;
    if (ses.state === 'paused') { setStatus('En pause : cliquez « Reprendre »'); return; }
    if (p.x < 0 || p.y < 0 || p.x > img.width || p.y > img.height) { setStatus('Point hors du plan'); return; }
    if (!radioOkOrConfirm('Placer le point')) return;
    ses.click(p);
    return;
  }
  if (p.x < 0 || p.y < 0 || p.x > img.width || p.y > img.height) { setStatus('Point hors du plan'); return; }
  if (state.mode === 'pick1') {
    Object.assign(state, { p1: p, mode: 'pick2' });
  } else if (state.mode === 'pick2') {
    if (dist(state.p1, p) < 1) return;
    Object.assign(state, { p2: p, mode: 'distance' });
  }
  render();
  if (state.mode === 'distance') $('form-dist').meters.focus();
});

const followsHover = () => state.mode === 'pick2' || (state.session && state.session.lastPoint);
view.addEventListener('planhover', e => { state.hover = e.detail; if (followsHover()) view.redraw(); });
view.addEventListener('planleave', () => { state.hover = null; if (followsHover()) view.redraw(); });

$('form-dist').addEventListener('submit', e => {
  e.preventDefault();
  const meters = e.target.meters.valueAsNumber;
  try {
    setCalibration(state.floor, state.p1, state.p2, meters);
    markDirty();
    Object.assign(state, { mode: 'idle', p1: null, p2: null });
    setStatus('Échelle enregistrée');
    render();
  } catch (ex) { setStatus(ex.message); }
});

// ---------- dessin par-dessus le plan ----------
const CALIB_COLOR = '#d01c8b';

function drawPoint(ctx, s) {
  ctx.beginPath(); ctx.arc(s.x, s.y, 6, 0, 2 * Math.PI);
  ctx.fillStyle = CALIB_COLOR; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
}

function drawSegment(ctx, t, a, b, label, dashed) {
  const sa = t.toScreen(a), sb = t.toScreen(b);
  ctx.save();
  ctx.setLineDash(dashed ? [6, 4] : []);
  ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,.85)';
  ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
  ctx.lineWidth = 2; ctx.strokeStyle = CALIB_COLOR; ctx.stroke();
  ctx.restore();
  drawPoint(ctx, sa); drawPoint(ctx, sb);
  if (label) drawLabel(ctx, label, (sa.x + sb.x) / 2, (sa.y + sb.y) / 2 - 16);
}

// tronçon en cours : dernier point cliqué → curseur, avec le nombre de mesures en attente
function drawCurrentLeg(ctx, t, ses) {
  const last = ses.lastPoint;
  if (!last) return;
  const a = t.toScreen(last);
  if (state.hover && ses.state === 'walking') {
    const b = t.toScreen(state.hover);
    ctx.save();
    ctx.setLineDash([6, 5]); ctx.lineWidth = 2; ctx.strokeStyle = '#0b57d0';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.restore();
    if (ses.pending.length) drawLabel(ctx, `${ses.pending.length} mesure${ses.pending.length > 1 ? 's' : ''} en attente`, b.x, b.y - 18);
  }
  ctx.beginPath(); ctx.arc(a.x, a.y, 7, 0, 2 * Math.PI);
  ctx.fillStyle = ses.state === 'paused' ? '#888' : '#0b57d0'; ctx.fill();
  ctx.lineWidth = 2.5; ctx.strokeStyle = '#fff'; ctx.stroke();
}

function drawOverlay(ctx, t) {
  const fl = state.floor;
  if (!fl) return;
  drawTrace(ctx, t, fl, thresholds());
  if (state.session) drawCurrentLeg(ctx, t, state.session);
  if (fl.segments.length || (state.session && state.session.state !== 'idle')) drawLegend(ctx, view.cw - LEGEND_W - 16, 16, thresholds());
  const cal = fl.calibration;
  if (state.mode === 'idle' && cal) {
    drawSegment(ctx, t, cal.p1, cal.p2, fmtMeters(cal.meters), true);
  } else if (state.p1) {
    const b = state.p2 || state.hover;
    if (b) {
      const px = dist(state.p1, b);
      drawSegment(ctx, t, state.p1, b, cal ? `${nf(px)} px ≈ ${fmtMeters(px * cal.mPerPx)}` : `${nf(px)} px`, false);
    } else {
      drawPoint(ctx, t.toScreen(state.p1));
    }
  }
  if (cal) drawScaleBar(ctx, t, cal.mPerPx, 16, view.ch - 24);
}

// ---------- panneaux ----------
const HELP = {
  pick1: 'Cliquez sur le 1er point d\'une distance connue (mur, trame de poteaux…).',
  pick2: 'Cliquez sur le 2e point.',
  distance: 'Saisissez la distance réelle entre les 2 points.',
};

function render() {
  const p = state.project, fl = state.floor, calibrating = state.mode !== 'idle';
  $('sec-new').hidden = !!p;
  $('sec-project').hidden = $('sec-view').hidden = $('sec-scale').hidden = $('sec-thresholds').hidden = !p;
  renderMeasure();
  $('drop-hint').hidden = !!fl;
  $('project-title').textContent = p ? `${p.name}${fl ? ' — ' + fl.name : ''}` : '';
  document.title = p ? `${p.name} — TETRA Walk-Test` : 'TETRA Walk-Test';
  renderSaveState();
  $('plan').classList.toggle('picking', state.mode === 'pick1' || state.mode === 'pick2');

  if (p && fl) {
    if (!$('thresholds').childElementCount) renderThresholds();
    $('p-name').textContent = p.name;
    $('p-building').textContent = p.building || '—';
    $('p-floor').textContent = fl.name;
    $('p-plan').textContent = `${fl.image.name} (${fl.image.width} × ${fl.image.height} px)`;

    const cal = fl.calibration;
    $('scale-status').innerHTML = cal
      ? `1 m = ${nf(1 / cal.mPerPx, 1)} px<br><span class="muted small">Plan ≈ ${nf(fl.image.width * cal.mPerPx)} × ${nf(fl.image.height * cal.mPerPx)} m</span>`
      : '<span class="muted">Non calibrée (optionnel).</span>';
    $('calib-help').hidden = !calibrating;
    $('calib-help').textContent = HELP[state.mode] || '';
    $('form-dist').hidden = state.mode !== 'distance';
    if (state.mode === 'distance') $('form-dist').meters.value = '';
    $('btn-calib').hidden = calibrating;
    $('btn-calib').disabled = !!state.session && state.session.state !== 'idle';
    $('btn-calib').title = $('btn-calib').disabled ? 'Terminez la mesure avant de recalibrer' : '';
    $('btn-calib').textContent = cal ? 'Recalibrer…' : 'Calibrer…';
    $('btn-calib-clear').hidden = calibrating || !cal;
    document.querySelector('#calib-actions .calib-cancel').hidden = !(state.mode === 'pick1' || state.mode === 'pick2');
  }
  view.redraw();
}

// ---------- mesure par waypoints ----------
function attachSession(ses) {
  const old = state.session;
  state.session = ses;
  if (old) old.stop();     // son écouteur ne réagit plus : ce n'est plus la session courante
  if (ses) ses.addEventListener('change', () => {
    if (ses !== state.session) return;
    markDirty(); scheduleAutosave(); renderMeasure(); view.redraw();
  });
}

function lostMessage(n) {
  if (n) setStatus(`${n} mesure${n > 1 ? 's' : ''} reçue${n > 1 ? 's' : ''} après le dernier clic ignorée${n > 1 ? 's' : ''}`);
}

// Sans radio, aucune mesure n'arrive : un tronçon parcouru ainsi reste un simple trait sans niveaux.
// On ne l'interdit pas (corrections au bureau, après coup), mais on prévient à chaque fois.
function radioOkOrConfirm(action) {
  return radio.state === 'streaming'
    || confirm(`La radio n'est pas connectée : aucune mesure ne sera enregistrée.\n\n${action} quand même ?`);
}

function toggleMeasurePause() {
  const ses = state.session;
  if (ses.state === 'walking') ses.pause();
  else if (ses.state === 'paused' && radioOkOrConfirm('Reprendre la mesure')) ses.resume();
}

$('btn-start').addEventListener('click', () => {
  if (!radioOkOrConfirm('Démarrer')) return;
  if (radio.state === 'streaming') state.floor.radio = { ...radio.info };   // radio utilisée pour cet étage
  state.session.start();
  render();
});
$('btn-pause').addEventListener('click', toggleMeasurePause);
// au-delà de quelques secondes de mesures non placées, on demande avant de les perdre
function confirmLoss() {
  const n = state.session.pending.length;
  return n < 3 || confirm(`${n} mesures reçues depuis le dernier clic seront perdues.\n\n`
    + 'Annulez puis cliquez d\'abord votre position actuelle sur le plan pour les garder.\n\nContinuer quand même ?');
}
$('btn-endseg').addEventListener('click', () => { if (confirmLoss()) lostMessage(state.session.endSegment()); });
$('btn-undo').addEventListener('click', () => state.session.undo());
$('btn-stop').addEventListener('click', () => {
  if (!confirmLoss()) return;
  lostMessage(state.session.stop());
  render();
});

const MEASURE_HELP = {
  ready: 'Cliquez sur le plan à votre position de départ.',
  walking: 'Marchez et cliquez votre position à chaque virage ou repère. Avant « Fin de segment » ou « Terminer », cliquez le dernier point.',
  paused: 'En pause : les mesures reçues ne sont pas enregistrées.',
};

function renderMeasure() {
  const ses = state.session, fl = state.floor;
  $('sec-measure').hidden = !ses;
  if (!ses) return;
  const st = ses.state, streaming = radio.state === 'streaming';
  const help = $('measure-help');
  help.textContent = st !== 'idle' && !streaming
    ? (radioStuck ? STUCK_MSG + ' Puis « Reprendre » à votre position.'
      : reconnecting ? 'Radio déconnectée : reconnexion automatique en cours… Ne reprenez qu\'une fois la radio « en mesure ».'
      : 'Radio déconnectée : reconnectez-la, puis « Reprendre » à votre position.')
    : MEASURE_HELP[st] || (streaming ? 'Cliquez « Démarrer », puis votre position de départ sur le plan.' : 'Connectez la radio pour pouvoir mesurer.');
  help.classList.toggle('warn', st !== 'idle' && !streaming);
  $('btn-start').hidden = st !== 'idle';
  $('btn-pause').hidden = st !== 'walking' && st !== 'paused';
  $('btn-pause').textContent = st === 'paused' ? 'Reprendre' : 'Pause';
  $('btn-pause').classList.toggle('primary', st === 'paused');
  $('btn-endseg').hidden = st !== 'walking' && st !== 'paused';
  $('btn-undo').hidden = st === 'idle';
  $('btn-undo').disabled = !ses.canUndo;
  $('btn-stop').hidden = st === 'idle';

  const s = floorStats(fl), cal = fl.calibration;
  const length = cal ? `${nf(s.length * cal.mPerPx, 1)} m` : `${nf(s.length)} px (non calibré)`;
  $('measure-stats').innerHTML =
    `<dt>Points de mesure</dt><dd>${nf(s.samples)}${ses.pending.length ? ` <span class="muted">+ ${ses.pending.length} en attente</span>` : ''}</dd>` +
    `<dt>Segments</dt><dd>${s.segments}</dd><dt>Parcours</dt><dd>${length}</dd>`;
}

// ---------- seuils RSSI ----------
function renderThresholds() {
  const th = thresholds();
  $('thresholds').innerHTML = th.map((t, i) =>
    `<span class="swatch" style="background:${t.color}"></span><span>≥</span>` +
    `<input type="number" step="1" max="0" min="-140" data-i="${i}" value="${t.min}" aria-label="Seuil ${i + 1} (dBm)">`
  ).join('') + `<span class="swatch" style="background:#000"></span><span>&lt;</span><span class="muted">${th[th.length - 1].min} : « No »</span>`;
}

$('thresholds').addEventListener('change', e => {
  if (!e.target.matches('input') || !state.project) return;
  const mins = [...$('thresholds').querySelectorAll('input')].map(i => i.valueAsNumber);
  const ok = mins.every((m, i) => Number.isFinite(m) && (i === 0 || m < mins[i - 1]));
  $('thresholds-error').hidden = ok;
  $('thresholds-error').textContent = ok ? '' : 'Les seuils doivent être des nombres strictement décroissants.';
  if (!ok) return;
  state.project.thresholds = state.project.thresholds.map((t, i) => ({ ...t, min: mins[i] }));
  markDirty();
  renderThresholds();
  view.redraw();
});

$('btn-thresholds-reset').addEventListener('click', () => {
  if (!state.project) return;
  state.project.thresholds = DEFAULT_THRESHOLDS.map(t => ({ ...t }));
  markDirty();
  $('thresholds-error').hidden = true;
  renderThresholds();
  view.redraw();
});

// ---------- radio ----------
const radio = new Radio();
const STALE_MS = 5000;   // au-delà sans mesure : alerte
const DEMO = new URLSearchParams(location.search).has('demo');   // radio simulée
if (DEMO) $('btn-connect').textContent = 'Connecter la radio simulée';

function showRadioError(msg) {
  $('radio-error').textContent = msg || '';
  $('radio-error').hidden = !msg;
}

$('btn-connect').addEventListener('click', async () => {
  showRadioError('');
  reconnectWanted = false;     // connexion manuelle : la reconnexion automatique s'arrête
  radioStuck = false;
  let port;
  if (DEMO) {
    try { await radio.connect(new SimPort()); } catch (e) { showRadioError(e.message); }
    return;
  }
  try {
    port = await navigator.serial.requestPort();
  } catch (e) {
    if (e.name !== 'NotFoundError') showRadioError(e.message);   // NotFoundError = choix annulé
    return;
  }
  const vid = port.getInfo().usbVendorId;
  if (vid !== undefined && vid !== RADIO_VID) showRadioError('Ce port ne semble pas être une radio Motorola ; tentative quand même…');
  try {
    await radio.connect(port);
    showRadioError('');
  } catch (e) {
    showRadioError(e.message);
  }
});

$('btn-disconnect').addEventListener('click', () => { reconnectWanted = false; radio.disconnect(); });

// Câble arraché puis rebranché : reconnexion automatique sur les ports déjà autorisés, sans boîte
// de choix. Windows met quelques secondes à recréer le port, et la radio expose 2 ports (seul
// « Port 1 » répond). Surtout : un câble arraché en plein flux BLOQUE la radio (Port 1 muet) jusqu'à
// son redémarrage (docs/PROTOCOL.md). Dès qu'on le constate, on demande de redémarrer la radio et on
// continue d'essayer : elle se reconnecte toute seule une fois rallumée. La mesure reste en pause.
const RECONNECT_MS = 5 * 60 * 1000, RECONNECT_GAP_MS = 3000;   // relancé à chaque rebranchement
const STUCK_MSG = 'La radio ne répond plus : éteignez-la puis rallumez-la, câble branché. La reconnexion se fera toute seule.';
let reconnectWanted = false, reconnecting = false, radioStuck = false;

async function autoReconnect() {
  if (reconnecting || !reconnectWanted || DEMO || !navigator.serial) return;
  reconnecting = true;
  renderMeasure();
  const deadline = Date.now() + RECONNECT_MS;
  try {
    for (let i = 1; Date.now() < deadline; i++) {
      if (!reconnectWanted || radio.state !== 'disconnected') return;
      setStatus(radioStuck ? `Radio bloquée : redémarrez-la (essai ${i})…` : `Radio débranchée : reconnexion automatique (essai ${i})…`);
      for (const port of await navigator.serial.getPorts()) {
        if (!reconnectWanted || radio.state !== 'disconnected') return;
        try {
          await radio.connect(port);
          reconnectWanted = false;
          radioStuck = false;
          showRadioError('');
          setStatus(state.session && state.session.state === 'paused'
            ? 'Radio reconnectée : cliquez « Reprendre » une fois à votre position' : 'Radio reconnectée');
          return;
        } catch (e) {
          // port ouvert mais muet : radio bloquée (ou Port 2, qui ne compte pas si Port 1 répond ensuite)
          if (e.code === 'silent' && !radioStuck) {
            radioStuck = true;
            showRadioError(STUCK_MSG);
            renderMeasure();
          }
        }
      }
      await new Promise(r => setTimeout(r, RECONNECT_GAP_MS));
    }
    setStatus('Reconnexion automatique abandonnée : cliquez « Connecter la radio… »');
  } finally {
    reconnecting = false;
    renderMeasure();
  }
}

if (navigator.serial) navigator.serial.addEventListener('connect', () => autoReconnect());

radio.addEventListener('state', e => {
  const { state: s, message } = e.detail;
  const pill = $('radio-pill');
  pill.className = `pill ${s}`;
  pill.textContent = { disconnected: 'Radio déconnectée', connecting: 'Connexion…', streaming: 'Radio en mesure' }[s];
  $('radio-state').textContent = { disconnected: 'Non connectée.', connecting: 'Connexion et lecture de l\'identité…', streaming: 'Connectée, flux de mesure actif.' }[s];
  $('btn-connect').hidden = s !== 'disconnected';
  $('btn-connect').disabled = s === 'connecting';
  $('btn-disconnect').hidden = s === 'disconnected';
  $('sec-live').hidden = s !== 'streaming';
  if (s === 'disconnected') $('radio-info').hidden = true;
  if (message) showRadioError(message);
  if (s === 'streaming') resetLive();
  // radio perdue en pleine mesure : pause automatique (rien n'est perdu de ce qui est placé)
  if (s === 'disconnected' && state.session && state.session.pause()) setStatus('Radio déconnectée : mesure en pause');
  renderMeasure();
});

radio.addEventListener('identity', e => {
  const info = e.detail;
  $('radio-info').innerHTML = INFO.filter(i => info[i.key]).map(i => `<dt>${i.label}</dt><dd>${esc(info[i.key])}</dd>`).join('');
  $('radio-info').hidden = false;
});

radio.addEventListener('lost', () => {
  reconnectWanted = !DEMO;
  setStatus(DEMO ? 'Radio débranchée' : 'Radio débranchée : rebranchez-la, la reconnexion est automatique');
  autoReconnect();
});

// trames brutes conservées pendant la mesure (pour pouvoir tout recalculer plus tard)
radio.addEventListener('frame', e => {
  if (state.session && state.session.state !== 'idle') state.floor.raw.push([e.detail.time.getTime(), toHex(e.detail.body)]);
});

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function resetLive() {
  const b = $('live-rssi');
  b.style.background = ''; b.style.color = '';
  b.querySelector('b').textContent = '—';
  for (const id of ['live-la', 'live-ch', 'live-c1']) $(id).textContent = '—';
  $('live-neigh').innerHTML = '<tr><td colspan="4" class="muted">En attente des mesures…</td></tr>';
  $('live-age').textContent = '';
}

radio.addEventListener('measure', e => {
  if (state.session) state.session.addSample(e.detail.snapshot, e.detail.time.getTime());
  const s = e.detail.snapshot, b = $('live-rssi'), bg = colorOf(s.rssi);
  b.style.background = bg; b.style.color = textOn(bg);
  b.querySelector('b').textContent = s.rssi ?? '—';
  $('live-la').textContent = s.la ?? '—';
  $('live-ch').textContent = s.channel ?? '—';
  $('live-c1').textContent = s.c1 === '' ? '—' : s.c1;
  // voisines identifiées par LA (la radio les reclasse en permanence), triées par RSSI
  const neigh = [1, 2, 3, 4].filter(n => s[`n${n}_la`] !== '')
    .map(n => ({ la: s[`n${n}_la`], ch: s[`n${n}_channel`], rssi: s[`n${n}_rssi`], cx: s[`n${n}_cx`] }))
    .sort((a, b) => (b.rssi === '' ? -999 : b.rssi) - (a.rssi === '' ? -999 : a.rssi));
  $('live-neigh').innerHTML = neigh.length
    ? neigh.map(n => `<tr><td><span class="dot" style="background:${colorOf(n.rssi)}"></span>${n.la}</td><td>${n.ch}</td><td>${n.rssi}</td><td>${n.cx}</td></tr>`).join('')
    : '<tr><td colspan="4" class="muted">Aucune voisine.</td></tr>';
  updateAge();
});

function updateAge() {
  if (radio.state !== 'streaming') return;
  const last = radio.lastMeasureAt, age = last ? (Date.now() - last) / 1000 : null;
  const stale = age === null ? false : age * 1000 > STALE_MS;
  $('live-age').textContent = age === null ? 'En attente de la première mesure…'
    : stale ? `⚠ Aucune mesure depuis ${nf(age)} s` : `Dernière mesure il y a ${nf(age)} s`;
  $('live-age').classList.toggle('ko', stale);
  $('radio-pill').classList.toggle('stale', stale);
}
setInterval(updateAge, 1000);

window.addEventListener('pagehide', () => radio.stopNow());

window.addEventListener('beforeunload', e => {
  if (state.dirty || radio.state === 'streaming') { e.preventDefault(); e.returnValue = ''; }
});

// ---------- environnement ----------
if (!('serial' in navigator) && !DEMO) {
  $('serial-support').innerHTML = '<span class="ko">✘ API Web Serial indisponible : utiliser Edge ou Chrome (https ou localhost).</span>';
  $('btn-connect').disabled = true;
}

// Service worker : appli disponible hors ligne sur site
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker non enregistré :', e));
}

render();
offerRecovery();
