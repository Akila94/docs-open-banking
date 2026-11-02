/**
 * What raw HTML may contain, per page (fail closed), and how elements behave for whitespace.
 *
 * Every exception to "no scripts, frames, inline handlers or styles" is listed here:
 *   - the home page (`index.md`): `onclick="location.href='…'"` cards (become `<Link>`), the
 *     YouTube `<iframe>` embed and its inline `<style>` block (Ruling 18);
 *   - Redoc pages (front matter `wide: true`, from `template: redoc.html`): the `<redoc>` element
 *     and the vendored `redoc.standalone.js` `<script>`, which Task 6 replaces.
 */
import {htmlTagNames} from 'html-tag-names';

/** HTML element names browsers know (anything else is an author placeholder such as `<IS_HOME>`). */
export const HTML_ELEMENTS = new Set(htmlTagNames);

/** Void elements: written self-closed in JSX. */
export const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
]);

/** Elements whose text content is kept exact (template literals; whitespace is significant). */
export const RAW_TEXT_ELEMENTS = new Set(['pre', 'textarea', 'style', 'script']);

/**
 * Elements that start or end a line box. Whitespace next to them has no rendered effect; whitespace
 * between two inline-level neighbours renders as one space.
 */
export const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'col', 'colgroup', 'dd', 'details', 'dialog',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hgroup', 'hr', 'legend', 'li', 'main', 'menu', 'nav', 'ol', 'optgroup', 'option', 'p', 'pre',
  'script', 'section', 'style', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

/** Elements that are never accepted, on any page. */
const FORBIDDEN_ELEMENTS = new Set([
  'applet', 'base', 'embed', 'frame', 'frameset', 'link', 'math', 'meta', 'noscript', 'object', 'svg', 'template',
]);

/** Attributes that carry URLs (checked for script schemes). */
export const URL_ATTRIBUTES = new Set([
  'action', 'background', 'cite', 'codebase', 'data', 'dynsrc', 'formaction', 'href', 'longdesc', 'lowsrc',
  'manifest', 'ping', 'poster', 'spec-url', 'src', 'srcset', 'xlink:href',
]);

/** The only iframe source the home page embeds. */
const IFRAME_SRC = /^https:\/\/www\.youtube(?:-nocookie)?\.com\/embed\/[\w-]+$/;
/** The only script a Redoc page loads (page-relative, vendored Redoc bundle). */
const REDOC_SCRIPT_SRC = /^(?:\.\.\/)+assets\/lib\/redoc\/redoc\.standalone\.js$/;

/**
 * @typedef {object} HtmlPolicy
 * @property {boolean} allowOnclick `onclick="location.href='…'"` cards (home page only).
 * @property {boolean} allowIframe The YouTube embed.
 * @property {boolean} allowStyle An inline `<style>` element.
 * @property {boolean} allowScript The Redoc bundle `<script>`.
 * @property {Set<string>} customElements Non-HTML elements kept as elements.
 */

/**
 * The policy for one page.
 *
 * @param {string} file Docs-relative path.
 * @param {object|null} frontMatter Converted front matter.
 * @returns {HtmlPolicy} Policy.
 */
export function pagePolicy(file, frontMatter) {
  const home = file === 'index.md';
  const redoc = frontMatter?.wide === true;
  return {
    allowOnclick: home,
    allowIframe: home,
    allowStyle: home,
    allowScript: redoc,
    customElements: new Set(redoc ? ['redoc'] : []),
  };
}

/**
 * Reason an element is rejected under a policy, or null when it is allowed.
 *
 * @param {string} name Lower-case element name.
 * @param {Map<string, string>} attributes Lower-case attribute name -> value.
 * @param {HtmlPolicy} policy Page policy.
 * @returns {string|null} Why it is rejected.
 */
export function elementViolation(name, attributes, policy) {
  if (FORBIDDEN_ELEMENTS.has(name)) {
    return `<${name}> is not allowed in documentation content`;
  }
  if (name === 'script') {
    return policy.allowScript && REDOC_SCRIPT_SRC.test(attributes.get('src') ?? '')
      ? null
      : '<script> is only allowed on Redoc pages, for the vendored Redoc bundle';
  }
  if (name === 'iframe') {
    return policy.allowIframe && IFRAME_SRC.test(attributes.get('src') ?? '') && !attributes.has('srcdoc')
      ? null
      : '<iframe> is only allowed on the home page, for the YouTube embed';
  }
  if (name === 'style') {
    return policy.allowStyle ? null : '<style> is only allowed on the home page';
  }
  return null;
}
