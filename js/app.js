// app.js — point d'entrée de l'interface.
import { PlanView } from './planview.js';
import { createProject, addFloor, removeFloor, floorSampleCount, setCalibration, clearCalibration, serializeProject, deserializeProject } from './project.js';
import { floorCsv, projectCsv, floorPng, fileSafe } from './export.js';
import { dist } from './geometry.js';
import { Radio, RADIO_VID } from './radio.js';
import { INFO, toHex } from './protocol.js';
import { rssiColor, textOn, DEFAULT_THRESHOLDS, upgradeThresholds } from './thresholds.js';
import { Session, floorStats } from './session.js';
import { SimPort } from './simport.js';
import { AutoSave } from './autosave.js';
import { readProjectFolder, newPlans, floorNameFromFile, compareFloorNames, PLANS_DIR, EXPORTS_DIR } from './folder.js';
import { DEFAULT_CRITERION, sampleOk, floorCompliance, fmtPct } from './criterion.js';
import { nf, fmtMeters, drawLabel, drawTrace, drawLegend, drawScaleBar, LEGEND_W } from './render.js';
import { t, applyDom, setLang, getLang, locale } from './i18n.js';

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
  dirHandle: null,  // dossier projet ouvert (plans/, exports/, fichier projet)
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
      dirty: state.dirty, fileHandle: state.fileHandle, dirHandle: state.dirHandle, floorId: state.floor.id,
    });
    state.autosavedAt = Date.now();
    renderSaveState();
  } catch (e) {
    console.warn('Sauvegarde automatique :', e);
    setStatus(t('status.backupFailed', { msg: e.message }));
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
const criterion = () => (state.project && state.project.criterion) || DEFAULT_CRITERION;
const colorOf = rssi => rssiColor(rssi, thresholds());

const view = new PlanView($('plan'));
view.drawOverlay = drawOverlay;

function setStatus(text) { $('status').textContent = text; }

// notification bien visible (bas de l'écran) pour confirmer une action : enregistrement, exports…
let toastTimer = 0;
function notify(text, kind = 'ok', ms = 5000) {
  const t = $('toast');
  t.textContent = (kind === 'ok' ? '✔ ' : kind === 'ko' ? '✘ ' : '') + text;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  setStatus(text);
}

// ---------- chargement du plan ----------
async function loadImage(file) {
  if (!/^image\/(png|jpeg)$/.test(file.type)) throw new Error(t('err.format', { type: file.type || file.name }));
  try { return await createImageBitmap(file); }
  catch { throw new Error(t('err.image', { name: file.name })); }
}

$('form-new').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, file = f.plan.files[0], err = $('new-error');
  err.hidden = true;
  if (!discardRecoveryOk()) return;
  try {
    const bmp = await loadImage(file);
    const project = createProject({ name: f.name.value.trim(), building: f.building.value.trim() });
    const floor = addFloor(project, {
      name: f.floor.value.trim(),
      image: { blob: file, name: file.name, type: file.type, width: bmp.width, height: bmp.height },
    });
    await showProject(project, null);
    bitmaps.set(floor.id, bmp);
    state.dirty = true;
    setStatus(t('status.projectCreated'));
    render();
    await restartAutosave();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

// ---------- étages ----------
const bitmaps = new Map();   // floorId -> plan décodé
const views = new Map();     // floorId -> zoom / déplacement, pour retrouver chaque étage comme on l'a laissé

async function floorBitmap(fl) {
  if (!bitmaps.has(fl.id)) bitmaps.set(fl.id, await createImageBitmap(fl.image.blob));
  return bitmaps.get(fl.id);
}

/** Affiche un projet (nouveau, ouvert ou récupéré) sur l'étage demandé (1er par défaut). */
async function showProject(project, handle, floorId = null, session = null) {
  project.criterion ??= { ...DEFAULT_CRITERION };   // copie de secours d'avant le critère ASTRID
  const legendUpgraded = upgradeThresholds(project);   // ancienne légende (orange jusqu'à -72)
  state.project = project;
  state.floor = null;
  state.fileHandle = handle;
  state.dirHandle = null;
  state.dirty = false;
  bitmaps.clear();
  views.clear();
  $('thresholds').innerHTML = '';
  $('sec-recover').hidden = true;
  $('form-floor').hidden = true;
  await showFloor(project.floors.find(f => f.id === floorId) || project.floors[0], session);
  // la correction se refait à chaque ouverture tant que le projet n'est pas réenregistré ;
  // le message vient après celui de l'ouverture du projet
  if (legendUpgraded) setTimeout(() => notify(t('notify.legendUpgraded'), 'ok', 10000), 4000);
}

/** Affiche un étage avec sa propre session de mesure. */
async function showFloor(fl, session = null) {
  if (state.floor) views.set(state.floor.id, { ...view.t });
  const bmp = await floorBitmap(fl);
  state.floor = fl;
  state.bitmap = bmp;
  Object.assign(state, { mode: 'idle', p1: null, p2: null, hover: null });
  attachSession(session || new Session(fl));
  view.setImage(bmp);
  const v = views.get(fl.id);
  if (v) { Object.assign(view.t, v); view.changed(); }
}

/**
 * Changement d'étage par l'utilisateur. Une mesure en cours est terminée sur l'ancien étage
 * et reprend aussitôt sur le nouveau : il n'y a plus qu'à cliquer sa position de départ.
 */
async function switchFloor(fl) {
  if (!fl || fl === state.floor) return;
  const ses = state.session, was = ses.state;
  if (state.mode !== 'idle') cancelCalibration();
  if (was === 'walking' || was === 'paused') {
    if (!confirm(t('confirm.switchFloor', { from: state.floor.name, to: fl.name, n: ses.pending.length }))) return;
  }
  if (was !== 'idle') lostMessage(ses.stop());
  await showFloor(fl);
  if (was !== 'idle') {
    if (radio.state === 'streaming') fl.radio = { ...radio.info };
    state.session.start();
    setStatus(t('status.floorStart', { floor: fl.name }));
  } else {
    setStatus(fl.name);
  }
  scheduleAutosave();     // la copie de secours retient l'étage affiché
  render();
}

// liste déroulante + étage du dessous / du dessus (les étages sont rangés du plus bas au plus haut)
async function goToFloor(fl) {
  await switchFloor(fl);
  renderFloors();          // changement refusé : la liste revient sur l'étage affiché
}
function adjacentFloor(step) {
  const fs = state.project.floors;
  return fs[fs.indexOf(state.floor) + step];
}
$('floor-select').addEventListener('change', e => goToFloor(state.project.floors.find(f => f.id === e.target.value)));
$('btn-floor-down').addEventListener('click', () => goToFloor(adjacentFloor(-1)));
$('btn-floor-up').addEventListener('click', () => goToFloor(adjacentFloor(+1)));
window.addEventListener('keydown', e => {
  if (!state.project || e.ctrlKey || e.altKey || e.metaKey || e.target.closest('input, textarea, select')) return;
  if (e.key === 'PageUp' || e.key === 'PageDown') {
    e.preventDefault();
    goToFloor(adjacentFloor(e.key === 'PageUp' ? +1 : -1));
  }
});

$('btn-floor-add').addEventListener('click', () => {
  const f = $('form-floor');
  f.reset();
  $('floor-error').hidden = true;
  f.hidden = false;
  f.floor.focus();
});
$('btn-floor-cancel').addEventListener('click', () => { $('form-floor').hidden = true; });

$('form-floor').addEventListener('submit', e => runFileAction(async () => {
  e.preventDefault();
  const f = e.target, file = f.plan.files[0], err = $('floor-error');
  err.hidden = true;
  let bmp;
  try { bmp = await loadImage(file); } catch (ex) { err.textContent = ex.message; err.hidden = false; return; }
  const fl = addFloor(state.project, {
    name: f.floor.value.trim(),
    image: { blob: file, name: file.name, type: file.type, width: bmp.width, height: bmp.height },
  });
  bitmaps.set(fl.id, bmp);
  state.project.floors.sort((a, b) => compareFloorNames(a.name, b.name));   // ▲ / ▼ suivent l'ordre des étages
  f.hidden = true;
  markDirty();
  if (state.session.state === 'idle') { await showFloor(fl); setStatus(t('status.floorAdded', { floor: fl.name })); render(); }
  else await switchFloor(fl);       // en pleine mesure : on enchaîne sur le nouvel étage
}));

$('btn-floor-rename').addEventListener('click', () => {
  const name = prompt(t('prompt.rename'), state.floor.name);
  if (!name || !name.trim()) return;
  state.floor.name = name.trim();
  markDirty();
  render();
});

$('btn-floor-delete').addEventListener('click', () => runFileAction(async () => {
  const fl = state.floor, n = floorSampleCount(fl);
  if (!confirm(t('confirm.deleteFloor', { floor: fl.name, n }))) return;
  lostMessage(state.session.stop());
  const next = removeFloor(state.project, fl.id);
  bitmaps.delete(fl.id);
  views.delete(fl.id);
  state.floor = null;           // pas de vue à mémoriser pour l'étage supprimé
  await showFloor(next);
  markDirty();
  setStatus(t('status.floorDeleted', { floor: fl.name }));
  render();
}));

function renderFloors() {
  const p = state.project;
  $('sec-floors').hidden = !p;
  if (!p) return;
  const measuring = state.session && state.session.state !== 'idle';
  const count = f => t('floor.count', { n: floorSampleCount(f) });
  const sel = $('floor-select');
  // libellé court (la barre latérale est étroite) : nom, nombre de mesures entre parenthèses
  sel.innerHTML = p.floors.map(f => {
    const n = floorSampleCount(f), ok = floorCompliance(f, criterion()).ok;
    const mark = ok === null ? '' : ok ? ' ✔' : ' ✘';
    return `<option value="${f.id}">${esc(f.name)}${n ? ` (${nf(n)})` : ''}${mark}${f === state.floor && measuring ? ' ●' : ''}</option>`;
  }).join('');
  sel.value = state.floor.id;
  const i = p.floors.indexOf(state.floor), fl = state.floor;
  $('btn-floor-down').disabled = i <= 0;
  $('btn-floor-up').disabled = i >= p.floors.length - 1;
  const r = floorCompliance(fl, criterion());
  $('floor-meta').textContent = [t('floor.position', { i: i + 1, n: p.floors.length }), measuring ? t('floor.measuring') : '', count(fl),
    r.pct === null ? '' : `ASTRID ${r.ok ? '✔' : '✘'} ${fmtPct(r.pct)}`,
    t('floor.segments', { n: fl.segments.length }), t(fl.calibration ? 'floor.calibrated' : 'floor.notCalibrated')]
    .filter(Boolean).join(' · ');
  $('btn-floor-delete').disabled = p.floors.length < 2;
}

const abandonOk = () => !state.dirty || confirm(t('confirm.abandon'));

$('btn-new-project').addEventListener('click', () => {
  if (!abandonOk()) return;
  attachSession(null);
  Object.assign(state, { project: null, floor: null, bitmap: null, fileHandle: null, dirHandle: null, dirty: false, mode: 'idle', p1: null, p2: null });
  bitmaps.clear();
  views.clear();
  $('form-floor').hidden = true;
  autosave.clear();
  $('form-new').reset();
  $('thresholds').innerHTML = '';
  view.setImage(null);
  setStatus(t('status.ready'));
  render();
});

// ---------- reprise au démarrage ----------
let recovered = null;

async function offerRecovery() {
  try { recovered = await autosave.load(); } catch (e) { console.warn('Lecture de la copie de secours :', e); return; }
  if (!recovered || state.project) return;
  renderRecovery();
  $('sec-recover').hidden = false;
}

function renderRecovery() {
  if (!recovered) return;
  const p = recovered.project, fl = p.floors.find(f => f.id === recovered.floorId) || p.floors[0];
  const n = fl.segments.reduce((a, s) => a + s.samples.length, 0) + (recovered.session?.pending?.length || 0);
  const when = new Date(recovered.savedAt).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' });
  const running = recovered.session && recovered.session.state !== 'idle';
  $('recover-text').innerHTML = `<b>${esc(p.name)}</b> — ${esc(fl.name)}<br>`
    + `<span class="muted small">${esc(t('recover.backup', { when, n }))}${running ? ` · ${t('recover.running')}` : ''}</span>`
    + (recovered.dirty ? `<br><span class="ko small">${t('recover.dirty')}</span>` : '');
}

$('btn-recover').addEventListener('click', () => runFileAction(async () => {
  const rec = recovered;
  const p = rec.project;
  const fl = p.floors.find(f => f.id === rec.floorId) || p.floors[0];   // l'étage où l'on mesurait
  await showProject(p, rec.fileHandle || null, fl.id, Session.restore(fl, rec.session));
  state.dirHandle = rec.dirHandle || null;
  state.dirty = !!rec.dirty;
  const paused = state.session.state === 'paused';
  setStatus(t(paused ? 'status.recoveredPaused' : 'status.recovered'));
  render();
  await autosaveNow();
}));

/** Avant de remplacer une copie de secours proposée et non enregistrée par un autre projet. */
function discardRecoveryOk() {
  if (!recovered || $('sec-recover').hidden || !recovered.dirty) return true;
  if (!confirm(t('confirm.discardRecovery'))) return false;
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
const projectType = () => ({ description: t('filetype.project'), accept: { 'application/json': ['.json'] } });

/**
 * Enregistre un fichier : boîte « Enregistrer sous » si disponible (Edge/Chrome), sinon téléchargement.
 * makeBlob n'est appelé qu'après le choix du fichier : la boîte doit s'ouvrir juste après le clic.
 */
async function saveBlob(makeBlob, name, type, handle = null) {
  if (window.showSaveFilePicker) {
    if (handle && !await ensureWrite(handle)) handle = null;
    handle ??= await showSaveFilePicker({ suggestedName: name, types: [type], ...(state.dirHandle ? { startIn: state.dirHandle } : {}) });
    await writeHandle(handle, await makeBlob());
    return handle;
  }
  downloadBlob(await makeBlob(), name);
  return null;
}

/** Fichier ou dossier repris d'une session précédente : Edge redemande l'autorisation d'écrire. */
async function ensureWrite(handle) {
  if (!handle.queryPermission || await handle.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
  return await handle.requestPermission({ mode: 'readwrite' }) === 'granted';
}

async function writeHandle(handle, blob) {
  const w = await handle.createWritable();
  await w.write(blob);
  await w.close();
}

/** Sous-dossier « exports » du dossier projet ouvert, ou null s'il n'y en a pas. */
async function exportsDir() {
  if (!state.dirHandle || !await ensureWrite(state.dirHandle)) return null;
  return state.dirHandle.getDirectoryHandle(EXPORTS_DIR, { create: true });
}

/** Export d'un fichier : dans « exports » du dossier projet, sinon boîte « Enregistrer sous ». */
async function exportFile(makeBlob, name, type) {
  const dir = await exportsDir();
  if (!dir) {
    const handle = await saveBlob(makeBlob, name, type);
    notify(handle ? t('notify.exported', { name: handle.name }) : t('notify.downloaded', { name }));
    return;
  }
  notify(t('notify.exporting', { name }), 'busy', 0);
  await writeHandle(await dir.getFileHandle(name, { create: true }), await makeBlob());
  notify(t('notify.exportedIn', { where: `${state.dirHandle.name}/${EXPORTS_DIR}`, name }));
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function runFileAction(fn) {
  try { await fn(); }
  catch (e) {
    if (e.name === 'AbortError') { $('toast').hidden = true; return; }   // boîte annulée
    notify(t('notify.error', { msg: e.message }), 'ko', 10000);
  }
}

async function saveProject(saveAs) {
  if (!state.project) return;
  const project = state.project;
  let target = saveAs ? null : state.fileHandle;
  // dossier projet ouvert : le projet s'enregistre dedans, sans boîte de dialogue
  if (!target && !saveAs && state.dirHandle && await ensureWrite(state.dirHandle)) {
    target = await state.dirHandle.getFileHandle(`${fileSafe(state.dirHandle.name)}.walktest.json`, { create: true });
  }
  const handle = await saveBlob(async () => new Blob([await serializeProject(project)], { type: 'application/json' }),
    `${fileSafe(project.name)}.walktest.json`, projectType(), target);
  state.fileHandle = handle;
  state.dirty = false;
  notify(handle ? t('notify.saved', { name: handle.name }) : t('notify.savedDownload'));
  renderSaveState();
  autosaveNow();
}

async function openProject() {
  if (!abandonOk() || !discardRecoveryOk()) return;
  let file, handle = null;
  if (window.showOpenFilePicker) {
    [handle] = await showOpenFilePicker({ types: [projectType()] });
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
  attachSession(null);
  await showProject(project, handle);
  notify(t('notify.opened', { name: file.name }));
  render();
  await restartAutosave();
}

/**
 * Dossier projet : crée le projet à partir des plans du dossier (un étage par plan, triés par
 * numéro d'étage), ou reprend le projet déjà enregistré dedans en y ajoutant les nouveaux plans.
 */
async function openFolder() {
  if (!window.showDirectoryPicker) throw new Error(t('err.noFolderApi'));
  if (!abandonOk() || !discardRecoveryOk()) return;
  const dir = await showDirectoryPicker({ id: 'projects', mode: 'readwrite' });
  setStatus(t('status.readingFolder', { name: dir.name }));
  const found = await readProjectFolder(dir);
  const existing = !!found.projectFile;
  const project = existing
    ? await deserializeProject(await (await found.projectFile.getFile()).text())
    : createProject({ name: found.name });
  const added = [], unreadable = [];
  for (const file of newPlans(project, found.plans)) {
    let bmp;
    try { bmp = await loadImage(file); } catch { unreadable.push(file.name); continue; }
    addFloor(project, { name: floorNameFromFile(file.name), image: { blob: file, name: file.name, type: file.type, width: bmp.width, height: bmp.height } });
    added.push(floorNameFromFile(file.name));
  }
  if (!project.floors.length) throw new Error(t('err.noPlans', { path: `${dir.name}/${PLANS_DIR}` }));
  project.floors.sort((a, b) => compareFloorNames(a.name, b.name));
  attachSession(null);
  await showProject(project, found.projectFile);
  state.dirHandle = dir;
  state.dirty = !existing || added.length > 0;
  const ignored = [...unreadable, ...found.ignored];
  notify(t('notify.folder', {
    existing, floors: project.floors.length,
    added: existing && added.length ? added.join(', ') : '', ignored: ignored.join(', '),
  }), 'ok', 8000);
  render();
  await restartAutosave();
}

document.querySelectorAll('.btn-open-folder').forEach(b => b.addEventListener('click', () => runFileAction(openFolder)));
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
  await exportFile(async () => new Blob([floorCsv(fl, criterion())], { type: 'text/csv' }), `${fileSafe(`${state.project.name} - ${fl.name}`)}.csv`,
    { description: 'CSV', accept: { 'text/csv': ['.csv'] } });
}));

$('btn-export-png').addEventListener('click', () => runFileAction(async () => {
  const fl = state.floor, project = state.project, bmp = state.bitmap;
  await exportFile(() => floorPng(project, fl, bmp), `${fileSafe(`${project.name} - ${fl.name}`)}.png`,
    { description: t('filetype.png'), accept: { 'image/png': ['.png'] } });
}));

// tous les étages d'un coup : PNG + CSV de chaque étage et un CSV commun,
// dans « exports » du dossier projet, sinon dans un dossier choisi
$('btn-export-all').addEventListener('click', () => runFileAction(async () => {
  const project = state.project, base = `${project.name} - `;
  const dir = await exportsDir()
    || (window.showDirectoryPicker ? await showDirectoryPicker({ id: 'exports', mode: 'readwrite' }) : null);
  const files = project.floors.flatMap(fl => [
    { name: `${base}${fl.name}.png`, make: async () => floorPng(project, fl, await floorBitmap(fl)) },
    { name: `${base}${fl.name}.csv`, make: async () => new Blob([floorCsv(fl, project.criterion)], { type: 'text/csv' }) },
  ]).concat({ name: `${base}${t('file.allFloors')}.csv`, make: async () => new Blob([projectCsv(project)], { type: 'text/csv' }) });
  for (const [i, f] of files.entries()) {
    notify(t('notify.exportProgress', { i: i + 1, n: files.length }), 'busy', 0);
    const blob = await f.make(), name = fileSafe(f.name);
    if (!dir) { downloadBlob(blob, name); continue; }
    await writeHandle(await dir.getFileHandle(name, { create: true }), blob);
  }
  const where = dir ? (state.dirHandle && dir.name === EXPORTS_DIR ? `${state.dirHandle.name}/${EXPORTS_DIR}` : dir.name) : '';
  notify(t('notify.exportedAll', { n: files.length, where }), 'ok', 7000);
}));

function renderSaveState() {
  const el = $('save-state');
  if (!state.project) return;
  el.textContent = state.dirty
    ? t('save.dirty') + (state.dirHandle && !state.fileHandle ? t('save.dirtyFolder') : '')
    : state.fileHandle ? t('save.savedIn', { name: state.fileHandle.name }) : t('save.saved');
  el.classList.toggle('ko', state.dirty);
  if (state.autosavedAt) {
    const time = new Date(state.autosavedAt).toLocaleTimeString(locale());
    el.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: t('save.backup', { time }) }));
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
  if (state.project) {
    // projet ouvert : le plan déposé sert à ajouter un étage
    const f = $('form-floor');
    f.reset();
    f.plan.files = e.dataTransfer.files;
    f.hidden = false;
    f.floor.focus();
    setStatus(t('status.planSelectedFloor', { name: e.dataTransfer.files[0].name }));
    return;
  }
  const form = $('form-new');
  form.plan.files = e.dataTransfer.files;
  setStatus(t('status.planSelected', { name: e.dataTransfer.files[0].name }));
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
  setStatus(t('status.scaleRemoved'));
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
    if (ses.state === 'paused') { setStatus(t('status.pausedClickResume')); return; }
    if (p.x < 0 || p.y < 0 || p.x > img.width || p.y > img.height) { setStatus(t('status.outside')); return; }
    if (!radioOkOrConfirm(t('action.placePoint'))) return;
    ses.click(p);
    return;
  }
  if (p.x < 0 || p.y < 0 || p.x > img.width || p.y > img.height) { setStatus(t('status.outside')); return; }
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
    setStatus(t('status.scaleSaved'));
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
    if (ses.pending.length) drawLabel(ctx, t('map.pending', { n: ses.pending.length }), b.x, b.y - 18);
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
const CALIB_HELP = { pick1: 'calib.pick1', pick2: 'calib.pick2', distance: 'calib.distance' };

function render() {
  const p = state.project, fl = state.floor, calibrating = state.mode !== 'idle';
  $('sec-new').hidden = !!p;
  $('sec-project').hidden = $('sec-view').hidden = $('sec-scale').hidden = $('sec-thresholds').hidden = !p;
  renderMeasure();
  renderFloors();
  $('btn-export-all').hidden = !p || p.floors.length < 2;
  $('drop-hint').hidden = !!fl;
  $('project-title').textContent = p ? `${p.name}${fl ? ' — ' + fl.name : ''}` : '';
  document.title = p ? `${p.name} — TETRA Walk-Test` : 'TETRA Walk-Test';
  renderSaveState();
  $('plan').classList.toggle('picking', state.mode === 'pick1' || state.mode === 'pick2');

  if (p && fl) {
    if (!$('thresholds').childElementCount) renderThresholds();
    $('p-name').textContent = p.name;
    $('p-building').textContent = p.building || '—';
    $('p-folder').textContent = state.dirHandle ? state.dirHandle.name : '';
    $('p-folder').hidden = $('p-folder-label').hidden = !state.dirHandle;
    $('p-floor').textContent = fl.name;
    $('p-plan').textContent = `${fl.image.name} (${fl.image.width} × ${fl.image.height} px)`;

    const cal = fl.calibration;
    $('scale-status').innerHTML = cal
      ? `1 m = ${nf(1 / cal.mPerPx, 1)} px<br><span class="muted small">${t('scale.size', { w: nf(fl.image.width * cal.mPerPx), h: nf(fl.image.height * cal.mPerPx) })}</span>`
      : `<span class="muted">${t('scale.none')}</span>`;
    $('calib-help').hidden = !calibrating;
    $('calib-help').textContent = CALIB_HELP[state.mode] ? t(CALIB_HELP[state.mode]) : '';
    $('form-dist').hidden = state.mode !== 'distance';
    if (state.mode === 'distance') $('form-dist').meters.value = '';
    $('btn-calib').hidden = calibrating;
    $('btn-calib').disabled = !!state.session && state.session.state !== 'idle';
    $('btn-calib').title = $('btn-calib').disabled ? t('title.calibDisabled') : '';
    $('btn-calib').textContent = t(cal ? 'btn.recalibrate' : 'btn.calibrate');
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
    markDirty(); scheduleAutosave(); renderMeasure(); renderFloors(); view.redraw();
  });
}

function lostMessage(n) {
  if (n) setStatus(t('status.lost', { n }));
}

// Sans radio, aucune mesure n'arrive : un tronçon parcouru ainsi reste un simple trait sans niveaux.
// On ne l'interdit pas (corrections au bureau, après coup), mais on prévient à chaque fois.
function radioOkOrConfirm(action) {
  return radio.state === 'streaming'
    || confirm(t('confirm.noRadio', { action }));
}

function toggleMeasurePause() {
  const ses = state.session;
  if (ses.state === 'walking') ses.pause();
  else if (ses.state === 'paused' && radioOkOrConfirm(t('action.resume'))) ses.resume();
}

$('btn-start').addEventListener('click', () => {
  if (!radioOkOrConfirm(t('action.start'))) return;
  if (radio.state === 'streaming') state.floor.radio = { ...radio.info };   // radio utilisée pour cet étage
  state.session.start();
  render();
});
$('btn-pause').addEventListener('click', toggleMeasurePause);
// au-delà de quelques secondes de mesures non placées, on demande avant de les perdre
function confirmLoss() {
  const n = state.session.pending.length;
  return n < 3 || confirm(t('confirm.loss', { n }));
}
$('btn-endseg').addEventListener('click', () => { if (confirmLoss()) lostMessage(state.session.endSegment()); });
$('btn-undo').addEventListener('click', () => state.session.undo());
$('btn-stop').addEventListener('click', () => {
  if (!confirmLoss()) return;
  lostMessage(state.session.stop());
  render();
});

const MEASURE_HELP = { ready: 'help.ready', walking: 'help.walking', paused: 'help.paused' };

// un étage qu'on n'a pas pu finir se complète plus tard : les nouveaux passages s'ajoutent
function idleHelp(fl, streaming) {
  const n = floorSampleCount(fl);
  if (!streaming) return t('help.noRadio');
  return n ? t('help.continue', { floor: fl.name, n }) : t('help.start');
}

function renderMeasure() {
  const ses = state.session, fl = state.floor;
  $('sec-measure').hidden = !ses;
  if (!ses) return;
  const st = ses.state, streaming = radio.state === 'streaming';
  const help = $('measure-help');
  help.textContent = st !== 'idle' && !streaming
    ? (radioStuck ? `${t('radio.stuck')} ${t('help.stuck')}`
      : t(reconnecting ? 'help.reconnecting' : 'help.disconnected'))
    : MEASURE_HELP[st] ? t(MEASURE_HELP[st]) : idleHelp(fl, streaming);
  help.classList.toggle('warn', st !== 'idle' && !streaming);
  $('btn-start').hidden = st !== 'idle';
  $('btn-start').textContent = t(floorSampleCount(fl) ? 'btn.continue' : 'btn.start');
  $('btn-pause').hidden = st !== 'walking' && st !== 'paused';
  $('btn-pause').textContent = t(st === 'paused' ? 'btn.resume' : 'btn.pause');
  $('btn-pause').classList.toggle('primary', st === 'paused');
  $('btn-endseg').hidden = st !== 'walking' && st !== 'paused';
  $('btn-undo').hidden = st === 'idle';
  $('btn-undo').disabled = !ses.canUndo;
  $('btn-stop').hidden = st === 'idle';

  const s = floorStats(fl), cal = fl.calibration;
  const length = cal ? `${nf(s.length * cal.mPerPx, 1)} m` : `${nf(s.length)} ${t('stats.notCalibrated')}`;
  const c = criterion(), r = floorCompliance(fl, c);
  const astrid = r.pct === null ? `<dd class="muted">${t('stats.noMeasure')}</dd>`
    : `<dd class="${r.ok ? 'ok' : 'ko'}">${r.ok ? '✔' : '✘'} ${fmtPct(r.pct)} &gt; ${c.rssi} dBm `
      + `<span class="muted">${t('stats.goal', { goal: c.percent, points: fmtPct(r.pctSamples) })}</span></dd>`;
  $('measure-stats').innerHTML =
    `<dt>${t('stats.points')}</dt><dd>${nf(s.samples)}${ses.pending.length ? ` <span class="muted">${t('stats.pending', { n: ses.pending.length })}</span>` : ''}</dd>` +
    `<dt>${t('stats.segments')}</dt><dd>${s.segments}</dd><dt>${t('stats.route')}</dt><dd>${length}</dd>` +
    `<dt>${t('stats.astrid')}</dt>${astrid}`;
}

// ---------- seuils RSSI ----------
function renderThresholds() {
  const th = thresholds();
  $('thresholds').innerHTML = th.map((level, i) =>
    `<span class="swatch" style="background:${level.color}"></span><span>≥</span>` +
    `<input type="number" step="1" max="0" min="-140" data-i="${i}" value="${level.min}" aria-label="${esc(t('aria.threshold', { i: i + 1 }))}">`
  ).join('') + `<span class="swatch" style="background:#000"></span><span>&lt;</span><span class="muted">${th[th.length - 1].min} : No</span>`;
  $('crit-rssi').value = criterion().rssi;
  $('crit-pct').value = criterion().percent;
}

// critère ASTRID réglable (par défaut : > -88 dBm sur 95 %)
function setCriterion(c) {
  state.project.criterion = c;
  markDirty();
  renderThresholds();
  render();
}
for (const id of ['crit-rssi', 'crit-pct']) {
  $(id).addEventListener('change', () => {
    if (!state.project) return;
    const rssi = $('crit-rssi').valueAsNumber, percent = $('crit-pct').valueAsNumber;
    if (!Number.isFinite(rssi) || !Number.isFinite(percent) || percent <= 0 || percent > 100) { renderThresholds(); return; }
    setCriterion({ rssi, percent });
  });
}
$('btn-criterion-reset').addEventListener('click', () => { if (state.project) setCriterion({ ...DEFAULT_CRITERION }); });

$('thresholds').addEventListener('change', e => {
  if (!e.target.matches('input') || !state.project) return;
  const mins = [...$('thresholds').querySelectorAll('input')].map(i => i.valueAsNumber);
  const ok = mins.every((m, i) => Number.isFinite(m) && (i === 0 || m < mins[i - 1]));
  $('thresholds-error').hidden = ok;
  $('thresholds-error').textContent = ok ? '' : t('err.thresholds');
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
  if (vid !== undefined && vid !== RADIO_VID) showRadioError(t('radio.notMotorola'));
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
let reconnectWanted = false, reconnecting = false, radioStuck = false;

async function autoReconnect() {
  if (reconnecting || !reconnectWanted || DEMO || !navigator.serial) return;
  reconnecting = true;
  renderMeasure();
  const deadline = Date.now() + RECONNECT_MS;
  try {
    for (let i = 1; Date.now() < deadline; i++) {
      if (!reconnectWanted || radio.state !== 'disconnected') return;
      setStatus(t(radioStuck ? 'status.stuckTry' : 'status.reconnectTry', { i }));
      for (const port of await navigator.serial.getPorts()) {
        if (!reconnectWanted || radio.state !== 'disconnected') return;
        try {
          await radio.connect(port);
          reconnectWanted = false;
          radioStuck = false;
          showRadioError('');
          setStatus(t(state.session && state.session.state === 'paused' ? 'status.reconnectedResume' : 'status.reconnected'));
          return;
        } catch (e) {
          // port ouvert mais muet : radio bloquée (ou Port 2, qui ne compte pas si Port 1 répond ensuite)
          if (e.code === 'silent' && !radioStuck) {
            radioStuck = true;
            showRadioError(t('radio.stuck'));
            renderMeasure();
          }
        }
      }
      await new Promise(r => setTimeout(r, RECONNECT_GAP_MS));
    }
    setStatus(t('status.reconnectGaveUp'));
  } finally {
    reconnecting = false;
    renderMeasure();
  }
}

if (navigator.serial) navigator.serial.addEventListener('connect', () => autoReconnect());

/** Textes de l'état radio (indicateur, section Radio) ; rappelé au changement de langue. */
function renderRadio() {
  const s = radio.state, pill = $('radio-pill');
  pill.className = `pill ${s}`;
  pill.textContent = t(`pill.${s}`);
  $('radio-state').textContent = t(`radio.state.${s}`);
  $('btn-connect').textContent = t(DEMO ? 'btn.connectDemo' : 'btn.connect');
  if (radio.info && !$('radio-info').hidden) renderIdentity(radio.info);
}

function renderIdentity(info) {
  $('radio-info').innerHTML = INFO.filter(i => info[i.key]).map(i => `<dt>${t(`info.${i.key}`)}</dt><dd>${esc(info[i.key])}</dd>`).join('');
}

radio.addEventListener('state', e => {
  const { state: s, message } = e.detail;
  renderRadio();
  $('btn-connect').hidden = s !== 'disconnected';
  $('btn-connect').disabled = s === 'connecting';
  $('btn-disconnect').hidden = s === 'disconnected';
  $('sec-live').hidden = s !== 'streaming';
  if (s === 'disconnected') $('radio-info').hidden = true;
  if (message) showRadioError(message);
  if (s === 'streaming') resetLive();
  // radio perdue en pleine mesure : pause automatique (rien n'est perdu de ce qui est placé)
  if (s === 'disconnected' && state.session && state.session.pause()) setStatus(t('status.radioPaused'));
  renderMeasure();
});

radio.addEventListener('identity', e => {
  renderIdentity(e.detail);
  $('radio-info').hidden = false;
});

radio.addEventListener('lost', () => {
  reconnectWanted = !DEMO;
  setStatus(t(DEMO ? 'status.unplugged' : 'status.unpluggedAuto'));
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
  $('live-neigh').innerHTML = `<tr><td colspan="4" class="muted">${t('live.waiting')}</td></tr>`;
  $('live-astrid').textContent = '';
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
  // verdict ASTRID de la mesure en cours
  const c = criterion(), ok = sampleOk(s.rssi, c), v = $('live-astrid');
  v.textContent = t(ok ? 'live.ok' : 'live.ko', { rssi: c.rssi });
  v.className = `verdict ${ok ? 'ok' : 'ko'}`;
  // voisines identifiées par LA (la radio les reclasse en permanence), triées par RSSI
  const neigh = [1, 2, 3, 4].filter(n => s[`n${n}_la`] !== '')
    .map(n => ({ la: s[`n${n}_la`], ch: s[`n${n}_channel`], rssi: s[`n${n}_rssi`], cx: s[`n${n}_cx`] }))
    .sort((a, b) => (b.rssi === '' ? -999 : b.rssi) - (a.rssi === '' ? -999 : a.rssi));
  $('live-neigh').innerHTML = neigh.length
    ? neigh.map(n => `<tr><td><span class="dot" style="background:${colorOf(n.rssi)}"></span>${n.la}</td><td>${n.ch}</td><td>${n.rssi}</td><td>${n.cx}</td></tr>`).join('')
    : `<tr><td colspan="4" class="muted">${t('live.noNeighbour')}</td></tr>`;
  updateAge();
});

function updateAge() {
  if (radio.state !== 'streaming') return;
  const last = radio.lastMeasureAt, age = last ? (Date.now() - last) / 1000 : null;
  const stale = age === null ? false : age * 1000 > STALE_MS;
  $('live-age').textContent = age === null ? t('age.first') : t(stale ? 'age.stale' : 'age.last', { s: nf(age) });
  $('live-age').classList.toggle('ko', stale);
  $('radio-pill').classList.toggle('stale', stale);
}
setInterval(updateAge, 1000);

window.addEventListener('pagehide', () => radio.stopNow());

window.addEventListener('beforeunload', e => {
  if (state.dirty || radio.state === 'streaming') { e.preventDefault(); e.returnValue = ''; }
});

// ---------- environnement ----------
function renderSerialSupport() {
  if ('serial' in navigator || DEMO) return;
  $('serial-support').innerHTML = `<span class="ko">${t('serial.unsupported')}</span>`;
  $('btn-connect').disabled = true;
}

// ---------- langue ----------
// Change la langue sans recharger : textes fixes (data-i18n), puis tous les panneaux dynamiques.
function applyLanguage() {
  applyDom();
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === getLang()));
  renderRadio();
  renderSerialSupport();
  renderRecovery();
  if (state.project) renderThresholds();
  if (radio.state === 'streaming' && !radio.lastMeasureAt) resetLive();
  updateAge();
  render();
}
document.querySelectorAll('[data-lang]').forEach(b => b.addEventListener('click', () => {
  const wasReady = $('status').textContent === t('status.ready');
  setLang(b.dataset.lang);
  if (wasReady) setStatus(t('status.ready'));
  applyLanguage();
}));
// le nom d'étage par défaut suit la langue tant qu'on ne l'a pas modifié
$('form-new').floor.addEventListener('input', e => { e.target.dataset.touched = '1'; });
$('form-new').addEventListener('reset', () => setTimeout(() => {
  delete $('form-new').floor.dataset.touched;
  applyDom($('form-new'));
}));

// Service worker : appli disponible hors ligne sur site
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker non enregistré :', e));
}

setStatus(t('status.ready'));
applyLanguage();
offerRecovery();
