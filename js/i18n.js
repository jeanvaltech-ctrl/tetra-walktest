// i18n.js — langue de l'interface (FR / NL / EN) et formatage des nombres.
// Langue : choix mémorisé, sinon celle du navigateur (nl → NL, fr → FR, sinon EN).
// Les textes sont dans strings.js ; dans le HTML, data-i18n="clé" (texte), data-i18n-title,
// data-i18n-placeholder, data-i18n-aria (aria-label) et data-i18n-value (valeur d'un champ).
import { STRINGS } from './strings.js';

export const LANGS = ['fr', 'nl', 'en'];
const KEY = 'tetra-walktest.lang';
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

let lang = detect();

export const getLang = () => lang;
export const locale = () => LOCALES[lang];

export function setLang(l, persist = true) {
  if (!LANGS.includes(l)) return;
  lang = l;
  document.documentElement.lang = l;
  if (persist) try { localStorage.setItem(KEY, l); } catch { /* pas grave */ }
}

export const nf = (v, d = 0) => v.toLocaleString(locale(), { minimumFractionDigits: d, maximumFractionDigits: d });

/** Texte traduit ; {nom} est remplacé par params.nom. Les entrées peuvent être des fonctions (pluriels). */
export function t(key, params = {}) {
  const e = STRINGS[key];
  if (!e) { console.warn('Texte manquant :', key); return key; }
  const s = e[lang] ?? e.fr;
  if (typeof s === 'function') return s({ ...params, f: nf });
  return s.replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? ''));
}

/** Applique la langue à tous les éléments marqués data-i18n* du document. */
export function applyDom(root = document) {
  document.documentElement.lang = lang;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll('[data-i18n-value]')) if (!el.dataset.touched) el.value = t(el.dataset.i18nValue);
}
