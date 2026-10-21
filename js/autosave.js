// autosave.js — sauvegarde automatique continue dans le navigateur (IndexedDB).
// Permet de reprendre après un crash, une fermeture d'onglet ou une coupure de courant.
//
// Store « state » : un seul enregistrement « current » = projet (plans en Blob) + état de la
//   session + métadonnées (fichier ouvert, modifications non enregistrées).
// Store « raw »   : trames brutes, ajoutées par blocs ; seules les nouvelles trames sont écrites
//   à chaque sauvegarde (elles peuvent représenter plusieurs Mo par heure).

const req = r => new Promise((ok, ko) => { r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });
const done = tx => new Promise((ok, ko) => { tx.oncomplete = () => ok(); tx.onerror = tx.onabort = () => ko(tx.error); });

export class AutoSave {
  constructor(name = 'tetra-walktest') {
    this.name = name;
    this.rawSaved = new Map();   // floorId -> nombre de trames déjà écrites
    this.dbp = null;
    this.chain = Promise.resolve();
  }

  /** Les opérations s'exécutent l'une après l'autre (sinon un bloc de trames pourrait être écrit deux fois). */
  queue(fn) {
    const p = this.chain.catch(() => {}).then(fn);
    this.chain = p;
    return p;
  }

  db() {
    this.dbp ??= new Promise((ok, ko) => {
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('state');
        r.result.createObjectStore('raw', { autoIncrement: true });
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ko(r.error);
    });
    return this.dbp;
  }

  /** meta : { session, dirty, fileHandle, floorId } */
  save(project, meta = {}) { return this.queue(() => this.doSave(project, meta)); }
  load() { return this.queue(() => this.doLoad()); }
  clear() { return this.queue(() => this.doClear()); }

  async doSave(project, meta) {
    const db = await this.db();
    const chunks = [];
    for (const f of project.floors) {
      const from = this.rawSaved.get(f.id) || 0;
      if (f.raw.length > from) chunks.push({ floorId: f.id, from, frames: f.raw.slice(from) });
    }
    const light = { ...project, floors: project.floors.map(f => ({ ...f, raw: [] })) };
    const tx = db.transaction(['state', 'raw'], 'readwrite');
    tx.objectStore('state').put({ ...meta, project: light, savedAt: Date.now() }, 'current');
    for (const c of chunks) tx.objectStore('raw').add(c);
    await done(tx);
    for (const c of chunks) this.rawSaved.set(c.floorId, c.from + c.frames.length);
  }

  /** Dernière sauvegarde (projet avec ses trames brutes reconstituées), ou null. */
  async doLoad() {
    const db = await this.db();
    const tx = db.transaction(['state', 'raw'], 'readonly');
    const [rec, chunks] = await Promise.all([req(tx.objectStore('state').get('current')), req(tx.objectStore('raw').getAll())]);
    if (!rec || !rec.project) return null;
    this.rawSaved.clear();
    for (const f of rec.project.floors) {
      f.raw = chunks.filter(c => c.floorId === f.id).sort((a, b) => a.from - b.from).flatMap(c => c.frames);
      this.rawSaved.set(f.id, f.raw.length);
    }
    return rec;
  }

  /** Oublie la sauvegarde (nouveau projet, projet abandonné). */
  async doClear() {
    const db = await this.db();
    const tx = db.transaction(['state', 'raw'], 'readwrite');
    tx.objectStore('state').clear();
    tx.objectStore('raw').clear();
    await done(tx);
    this.rawSaved.clear();
  }
}
