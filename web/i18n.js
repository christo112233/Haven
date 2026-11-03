'use strict';
// Bilingual message catalog injected into index.html by server.py. The Python
// backend renders its own strings from the same JSON files (locales/<locale>/),
// so both sides always speak the same language.
const HAVEN_I18N = window.HAVEN_I18N || {locale: 'en-US', fallback: 'en-US', messages: {}, fallbackMessages: {}};
const I18N_MESSAGES = HAVEN_I18N.messages || {};
const I18N_FALLBACK_MESSAGES = HAVEN_I18N.fallbackMessages || {};
// Static markup carries these attributes; applyI18n() fills them in.
const I18N_ATTRIBUTES = [
  ['data-i18n', 'textContent'],
  ['data-i18n-title', 'title'],
  ['data-i18n-placeholder', 'placeholder'],
  ['data-i18n-aria-label', 'aria-label'],
  ['data-i18n-alt', 'alt']
];

function i18nLocale() {
  return HAVEN_I18N.locale || 'en-US';
}

function t(key, params) {
  if (!key) return '';
  const singular = params && Number(params.count) === 1;
  let text = singular ? I18N_MESSAGES[key + '.one'] : undefined;
  if (text === undefined) text = I18N_MESSAGES[key];
  if (text === undefined && singular) text = I18N_FALLBACK_MESSAGES[key + '.one'];
  if (text === undefined) text = I18N_FALLBACK_MESSAGES[key];
  if (text === undefined) return key;
  return String(text).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => params && params[name] !== undefined && params[name] !== null ? String(params[name]) : match);
}

function applyI18n(root) {
  const scope = root || document;
  for (const [attribute, target] of I18N_ATTRIBUTES) {
    for (const node of scope.querySelectorAll('[' + attribute + ']')) {
      const key = node.getAttribute(attribute);
      if (!key) continue;
      if (target === 'textContent') node.textContent = t(key);
      else node.setAttribute(target, t(key));
    }
  }
  if (document.documentElement) document.documentElement.lang = i18nLocale();
  return scope;
}
