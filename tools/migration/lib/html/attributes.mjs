/**
 * HTML attributes -> JSX attributes, with the security checks that apply to every attribute.
 *
 * Names follow React (via `property-information`, as `hast-util-to-jsx-runtime` does): `class` ->
 * `className`, `for` -> `htmlFor`, `colspan` -> `colSpan`, `allowfullscreen` -> `allowFullScreen`;
 * `aria-*`, `data-*` and unknown attributes keep their HTML name. The lower-cased JSX names that
 * parse5 reads back on a re-run (`classname`, `htmlfor`) map to the same names, so the conversion is
 * idempotent. `style` becomes an object (`style-to-js`, React vendor-prefix casing).
 */
import {find, html, hastToReact} from 'property-information';
import styleToJs from 'style-to-js';

import {assertSafeUrl} from '../links.mjs';
import {URL_ATTRIBUTES} from './policy.mjs';

/** CSS that can run script in old engines. */
const UNSAFE_CSS = /javascript:|expression\s*\(|behavior\s*:|-moz-binding/i;
/** A JavaScript identifier usable as an unquoted object key. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Raised for an attribute that must not be converted; the caller adds the location. */
export class AttributeError extends Error {}

/**
 * React property name for an HTML attribute name.
 *
 * @param {string} name Attribute name as parsed (lower case).
 * @returns {{jsxName: string, boolean: boolean, overloadedBoolean: boolean}} Name and value kind.
 */
export function jsxAttributeInfo(name) {
  const info = find(html, name);
  if (info.space !== 'html') {
    return {jsxName: name.toLowerCase(), boolean: false, overloadedBoolean: false};
  }
  return {
    jsxName: hastToReact[info.property] ?? info.property,
    boolean: info.boolean === true,
    overloadedBoolean: info.overloadedBoolean === true,
  };
}

/**
 * Convert a CSS declaration list to a JSX style object expression.
 *
 * @param {string} css `style` attribute value.
 * @returns {string} `{{key: "value", …}}`.
 * @throws {AttributeError} For script-bearing CSS or keys that are not identifiers.
 */
export function styleExpression(css) {
  if (UNSAFE_CSS.test(css)) {
    throw new AttributeError('style attribute contains script-bearing CSS');
  }
  const object = styleToJs(css, {reactCompat: true});
  const entries = Object.entries(object).map(([key, value]) => {
    if (!IDENTIFIER.test(key)) {
      throw new AttributeError(`unsupported CSS property ${JSON.stringify(key)}`);
    }
    return `${key}: ${JSON.stringify(value)}`;
  });
  return `{{${entries.join(', ')}}}`;
}

/**
 * Serialise one JSX attribute value.
 *
 * @param {string} value Decoded value.
 * @returns {string} `"value"` or, when the value has `"` or `&` (JSX strings decode entities), `{"…"}`.
 */
function jsxAttributeValue(value) {
  return /["&]/.test(value) ? `{${JSON.stringify(value)}}` : `"${value}"`;
}

/**
 * Convert a parsed attribute list to JSX attribute strings (each with a leading space).
 *
 * @param {Array<{name: string, value: string}>} attributes Parsed attributes (parse5, decoded).
 * @param {{skip?: Set<string>}} [options] Lower-case attribute names to leave out (handled by the caller).
 * @returns {string} JSX attribute text, e.g. ` className="x" colSpan="2"`.
 * @throws {AttributeError} For event handlers, script URLs, `srcdoc` and unsafe styles.
 */
export function convertAttributes(attributes, options = {}) {
  const skip = options.skip ?? new Set();
  const parts = [];
  for (const {name, value} of attributes) {
    const lower = name.toLowerCase();
    if (skip.has(lower)) {
      continue;
    }
    if (lower.startsWith('on')) {
      throw new AttributeError(`event handler attribute ${lower} is not allowed`);
    }
    if (lower === 'srcdoc') {
      throw new AttributeError('srcdoc is not allowed');
    }
    if (URL_ATTRIBUTES.has(lower)) {
      try {
        assertSafeUrl(value);
      } catch (error) {
        throw new AttributeError(error.message);
      }
    }
    if (lower === 'style') {
      parts.push(` style=${styleExpression(value)}`);
      continue;
    }
    const info = jsxAttributeInfo(lower);
    const bare = value === '' && (info.boolean || info.overloadedBoolean);
    const booleanByName = info.boolean && value.toLowerCase() === lower;
    parts.push(bare || booleanByName ? ` ${info.jsxName}` : ` ${info.jsxName}=${jsxAttributeValue(value)}`);
  }
  return parts.join('');
}

/**
 * Map of lower-case attribute names to values.
 *
 * @param {Array<{name: string, value: string}>} attributes Parsed attributes.
 * @returns {Map<string, string>} Lookup map.
 */
export function attributeMap(attributes) {
  return new Map(attributes.map(({name, value}) => [name.toLowerCase(), value]));
}
