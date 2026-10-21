// project.js — modèle de données d'un projet de mesure.
// Un projet = un bâtiment ; chaque étage a son plan, sa calibration et ses mesures.
// La V1 n'expose qu'un étage dans l'interface, mais le modèle en prévoit plusieurs.
import { metersPerPixel } from './geometry.js';
import { DEFAULT_THRESHOLDS } from './thresholds.js';

export const FORMAT = 'tetra-walktest';
export const FORMAT_VERSION = 1;

export function createProject({ name, building = '' }) {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    id: crypto.randomUUID(),
    name,
    building,
    created: new Date().toISOString(),
    thresholds: DEFAULT_THRESHOLDS.map(t => ({ ...t })),
    floors: [],
  };
}

/**
 * image : { blob, name, type, width, height }
 * radio : identité de la radio utilisée (lue au démarrage de la mesure)
 * raw   : trames radio brutes reçues pendant la mesure, [temps ms, hex] (comme un .atp)
 */
export function addFloor(project, { name, image }) {
  const floor = { id: crypto.randomUUID(), name, image, calibration: null, segments: [], radio: null, raw: [] };
  project.floors.push(floor);
  return floor;
}

/** Supprime un étage (jamais le dernier) ; retourne l'étage à afficher ensuite. */
export function removeFloor(project, floorId) {
  const i = project.floors.findIndex(f => f.id === floorId);
  if (i < 0 || project.floors.length < 2) throw new Error('Un projet doit garder au moins un étage.');
  project.floors.splice(i, 1);
  return project.floors[Math.min(i, project.floors.length - 1)];
}

/** Nombre de mesures placées sur un étage. */
export const floorSampleCount = floor => floor.segments.reduce((n, s) => n + s.samples.length, 0);

/** Calibration par 2 points (coordonnées image) et distance réelle en mètres. */
export function setCalibration(floor, p1, p2, meters) {
  const mPerPx = metersPerPixel(p1, p2, meters);
  if (!mPerPx) throw new Error('Calibration invalide : points confondus ou distance nulle.');
  floor.calibration = { p1, p2, meters, mPerPx };
  return floor.calibration;
}

export function clearCalibration(floor) { floor.calibration = null; }

// ---------- fichier projet (.json, plans inclus en base64) ----------
const blobToDataUrl = blob => new Promise((ok, ko) => {
  const r = new FileReader();
  r.onload = () => ok(r.result);
  r.onerror = () => ko(r.error);
  r.readAsDataURL(blob);
});

export async function serializeProject(project) {
  const floors = await Promise.all(project.floors.map(async f => {
    const { blob, ...image } = f.image;
    return { ...f, image: { ...image, data: await blobToDataUrl(blob) } };
  }));
  return JSON.stringify({ ...project, saved: new Date().toISOString(), floors });
}

export async function deserializeProject(text) {
  let p;
  try { p = JSON.parse(text); } catch { throw new Error('Ce fichier n\'est pas un projet TETRA Walk-Test (JSON illisible).'); }
  if (!p || p.format !== FORMAT || !Array.isArray(p.floors)) throw new Error('Ce fichier n\'est pas un projet TETRA Walk-Test.');
  if (p.version > FORMAT_VERSION) throw new Error(`Projet enregistré par une version plus récente (format ${p.version}) : mettez l'appli à jour.`);
  for (const f of p.floors) {
    const { data, ...image } = f.image;
    f.image = { ...image, blob: await (await fetch(data)).blob() };
    f.segments ??= [];
    f.raw ??= [];
    f.radio ??= null;
  }
  return p;
}
