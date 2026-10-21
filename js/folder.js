// folder.js — dossier projet sur le disque (API File System Access, Edge / Chrome).
//
//   SSV_Site_21-10-2026/                  nom du dossier = nom du projet
//     plans/Floor -1.png, Floor 00.jpg…   un plan par étage (PNG, JPG ; à la racine si pas de « plans »)
//     SSV_Site_21-10-2026.walktest.json   projet enregistré par l'appli (mesures comprises)
//     exports/                            PNG et CSV exportés

export const PLANS_DIR = 'plans';
export const EXPORTS_DIR = 'exports';
const IMAGE = /\.(png|jpe?g)$/i;
const PROJECT = /\.walktest\.json$/i;

/** « Floor -1.png » -> « Floor -1 ». */
export const floorNameFromFile = name => name.replace(/\.[^.]+$/, '').trim();

/** Numéro d'étage lu dans le nom (« Floor -1 » -> -1, « Floor 00 » -> 0), null s'il n'y en a pas. */
export function floorNumber(name) {
  const m = name.match(/(?:^|[^\d])([+-]?\d+)(?!.*\d)/);
  return m ? parseInt(m[1], 10) : null;
}

/** Tri des étages : du plus bas au plus haut, puis les noms sans numéro par ordre alphabétique. */
export function compareFloorNames(a, b) {
  const na = floorNumber(a), nb = floorNumber(b);
  if (na !== null && nb !== null && na !== nb) return na - nb;
  if ((na === null) !== (nb === null)) return na === null ? 1 : -1;
  return a.localeCompare(b, 'fr', { numeric: true });
}

async function entries(dir) {
  const out = [];
  for await (const h of dir.values()) out.push(h);
  return out;
}

/**
 * Lit un dossier projet.
 * @returns {{ name, plans: File[], ignored: string[], projectFile: FileSystemFileHandle|null }}
 */
export async function readProjectFolder(dir) {
  const root = await entries(dir);
  const plansDir = root.find(h => h.kind === 'directory' && h.name.toLowerCase() === PLANS_DIR);
  const source = plansDir ? await entries(plansDir) : root;
  const files = source.filter(h => h.kind === 'file');
  const plans = await Promise.all(files.filter(h => IMAGE.test(h.name)).map(h => h.getFile()));
  plans.sort((a, b) => compareFloorNames(floorNameFromFile(a.name), floorNameFromFile(b.name)));
  const ignored = files.filter(h => !IMAGE.test(h.name) && !PROJECT.test(h.name)).map(h => h.name);
  // projet enregistré : de préférence celui qui porte le nom du dossier
  const saved = root.filter(h => h.kind === 'file' && PROJECT.test(h.name));
  const projectFile = saved.find(h => h.name.toLowerCase() === `${dir.name}.walktest.json`.toLowerCase()) || saved[0] || null;
  return { name: dir.name, plans, ignored, projectFile };
}

/** Plans du dossier qui ne sont pas encore des étages du projet (comparés par nom de fichier). */
export function newPlans(project, plans) {
  const known = new Set(project.floors.map(f => f.image.name.toLowerCase()));
  return plans.filter(p => !known.has(p.name.toLowerCase()));
}
