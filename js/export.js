// export.js — exports par étage : CSV des mesures et PNG du plan avec la trace.
import { ViewTransform } from './geometry.js';
import { NEIGH } from './protocol.js';
import { FONT, nf, drawTrace, drawLegend, drawScaleBar, LEGEND_W } from './render.js';
import { DEFAULT_CRITERION, sampleOk, complianceText } from './criterion.js';

// Colonnes : mêmes noms que tools/mtp_trace.py, plus date, segment et position en mètres.
// x, y : pixels du plan importé (origine en haut à gauche) ; x_m, y_m : si l'étage est calibré.
// astrid_ok : 1 si le RSSI respecte le critère ASTRID du projet (> -88 dBm par défaut), sinon 0.
export const CSV_COLUMNS = ['date', 'time', 'floor', 'segment', 'x', 'y', 'x_m', 'y_m', 'la', 'channel', 'rssi', 'c1',
  ...Object.keys(NEIGH).flatMap(n => [`n${n}_la`, `n${n}_channel`, `n${n}_rssi`, `n${n}_cx`]), 'astrid_ok'];

const pad = (v, n = 2) => String(v).padStart(n, '0');
const localDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Échantillons de l'étage, triés par heure, avec leur n° de segment (à partir de 1). */
export function floorSamples(floor) {
  return floor.segments.flatMap((seg, i) => seg.samples.map(s => ({ ...s, segment: i + 1 })))
    .sort((a, b) => a.time - b.time);
}

/** Lignes CSV d'un étage, avec leur heure pour pouvoir trier plusieurs étages ensemble. */
function csvLines(floor, criterion) {
  const m = floor.calibration ? floor.calibration.mPerPx : null;
  return floorSamples(floor).map(s => {
    const d = new Date(s.time);
    const row = {
      ...s, date: localDate(d), time: localTime(d), floor: floor.name,
      x: s.x.toFixed(1), y: s.y.toFixed(1),
      x_m: m ? (s.x * m).toFixed(2) : '', y_m: m ? (s.y * m).toFixed(2) : '',
      astrid_ok: sampleOk(s.rssi, criterion) ? 1 : 0,
    };
    return { time: s.time, line: CSV_COLUMNS.map(c => csvCell(row[c])).join(';') };
  });
}

/** CSV séparé par « ; », UTF-8 avec BOM (accents lisibles dans Excel), point décimal. */
const csvText = lines => '﻿' + [CSV_COLUMNS.join(';'), ...lines.map(l => l.line)].join('\r\n') + '\r\n';

export const floorCsv = (floor, criterion = DEFAULT_CRITERION) => csvText(csvLines(floor, criterion));

/** Tous les étages dans un seul CSV (colonne floor), triés par heure. */
export const projectCsv = project =>
  csvText(project.floors.flatMap(f => csvLines(f, project.criterion || DEFAULT_CRITERION)).sort((a, b) => a.time - b.time));

/** Texte du bandeau sous le plan exporté. */
export function caption(project, floor) {
  const samples = floorSamples(floor);
  const parts = [project.name, project.building, floor.name].filter(Boolean).join(' — ');
  const when = samples.length
    ? `${localDate(new Date(samples[0].time))} ${localTime(new Date(samples[0].time)).slice(0, 5)}–${localTime(new Date(samples[samples.length - 1].time)).slice(0, 5)}`
    : '';
  const radio = floor.radio && floor.radio.issi ? `radio ISSI ${floor.radio.issi}` : '';
  const astrid = complianceText(floor, project.criterion || DEFAULT_CRITERION);
  return [parts, when, `${nf(samples.length)} mesures`, astrid, radio].filter(Boolean).join(' · ');
}

/** PNG du plan à sa taille réelle, avec trace, légende, échelle et bandeau. */
export async function floorPng(project, floor, image) {
  const w = image.width, h = image.height;
  const k = Math.max(1, Math.hypot(w, h) / 1000);   // épaisseurs et textes proportionnels au plan
  const band = Math.round(36 * k);
  const canvas = new OffscreenCanvas(w, h + band);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h + band);
  ctx.drawImage(image, 0, 0);

  const t = new ViewTransform();   // identité : coordonnées image = pixels du PNG
  drawTrace(ctx, t, floor, project.thresholds, k);
  drawLegend(ctx, w - (LEGEND_W + 12) * k, 12 * k, project.thresholds, k);
  if (floor.calibration) drawScaleBar(ctx, t, floor.calibration.mPerPx, 20 * k, h - 20 * k, k);

  ctx.fillStyle = '#f1f3f5';
  ctx.fillRect(0, h, w, band);
  ctx.fillStyle = '#111';
  ctx.font = `${13 * k}px ${FONT}`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(caption(project, floor), 12 * k, h + band / 2, w - 24 * k);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** Nom de fichier sans caractères interdits sous Windows. */
export const fileSafe = s => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'projet';
