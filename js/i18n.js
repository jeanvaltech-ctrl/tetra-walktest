// i18n.js — langue de l'interface (FR / NL / EN), langue des exports et formatage des nombres.
// Langue de l'interface : choix mémorisé, sinon celle du navigateur (nl → NL, fr → FR, sinon EN).
// Langue des exports : ce qui est écrit dans les PNG (les noms de fichiers restent en anglais) ; anglais
// par défaut, mémorisée à part (préférence du poste, comme la langue de l'interface, pas dans le fichier projet).
// Les textes sont dans strings.js ; dans le HTML, data-i18n="clé" (texte), data-i18n-title,
// data-i18n-placeholder, data-i18n-aria (aria-label) et data-i18n-value (valeur d'un champ).
import { STRINGS } from './strings.js';

export const LANGS = ['fr', 'nl', 'en'];
const KEY = 'tetra-walktest.lang';
const EXPORT_KEY = 'tetra-walktest.exportLang';
const LOCALES = { fr: 'fr-BE', nl: 'nl-BE', en: 'en-GB' };

function detect() {
  try {
    const saved = localStorage.getItem(KEY);
    if (LANGS.includes(saved)) return saved;
  } catch { /* stockage indisponible : on suit le navigateur */ }
  for (const l of navigator.languages || [navigator.language || '']) {
    const p = l.slice(0, 2).toLowerCase();
    if (LANGS.includes(p)) return p;
  }
  return 'en';
}

function savedExportLang() {
  try {
    const saved = localStorage.getItem(EXPORT_KEY);
    if (LANGS.includes(saved)) return saved;
  } catch { /* stockage indisponible : anglais */ }
  return 'en';
}

let lang = detect();
let exportLang = savedExportLang();

export const getLang = () => lang;
export const getExportLang = () => exportLang;
export const locale = (l = lang) => LOCALES[l];

export function setLang(l, persist = true) {
  if (!LANGS.includes(l)) return;
  lang = l;
  document.documentElement.lang = l;
  if (persist) try { localStorage.setItem(KEY, l); } catch { /* pas grave */ }
}

export function setExportLang(l, persist = true) {
  if (!LANGS.includes(l)) return;
  exportLang = l;
  if (persist) try { localStorage.setItem(EXPORT_KEY, l); } catch { /* pas grave */ }
}

// Sans langue précisée (l absent), les formats et les textes suivent la langue de l'interface.
export const nf = (v, d = 0, l = lang) => v.toLocaleString(LOCALES[l], { minimumFractionDigits: d, maximumFractionDigits: d });
export const fmtDate = (d, l = lang) => d.toLocaleDateString(LOCALES[l], { day: '2-digit', month: '2-digit', year: 'numeric' });
export const fmtTime = (d, l = lang) => d.toLocaleTimeString(LOCALES[l], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Texte traduit dans la langue l ; {nom} est remplacé par params.nom. Les entrées peuvent être des fonctions (pluriels). */
export function tx(l = lang, key, params = {}) {
  const e = STRINGS[key];
  if (!e) { console.warn('Texte manquant :', key); return key; }
  const s = e[l] ?? e.fr;
  if (typeof s === 'function') return s({ ...params, f: (v, d) => nf(v, d, l) });
  return s.replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? ''));
}

/** Texte traduit dans la langue de l'interface. */
export const t = (key, params) => tx(lang, key, params);

/** Applique la langue à tous les éléments marqués data-i18n* du document. */
export function applyDom(root = document) {
  document.documentElement.lang = lang;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll('[data-i18n-value]')) if (!el.dataset.touched) el.value = t(el.dataset.i18nValue);
}
