/**
 * Read the converter's own JSX output back as HTML, so that converting converted output is a no-op.
 *
 * `htmlToJsx` writes a few JSX-only forms that an HTML parser would misread. This module maps exactly
 * those forms, and nothing else, back to the HTML they came from:
 *   `{"text"}` and `` {`text`} `` -> (escaped) text      `{/* c *\/}` -> `<!-- c -->`
 *   `style={{a: "b"}}`              -> `style="a: b"`     `name={"v"}`  -> `name="v"`
 *   `<Link to="X" …>` … `</Link>`   -> `<div … onclick="location.href='X';">` … `</div>`
 * The reversal is only applied to files the converter already converted. In MkDocs sources these
 * forms are real content (code text, visible text), so `findOwnJsxForm` locates them and the
 * converter refuses such input instead of rewriting it. Neither function parses HTML; parse5 does.
 */
import {decodeTemplateBody, escapeHtmlAttribute, escapeHtmlText} from './text.mjs';
import {mdxCommentContent} from '../mdx-comment.mjs';

/** Elements whose content parse5 reads as raw text (no entity decoding). */
const RAW_TEXT_PARENTS = new Set(['style', 'script']);
const STYLE_OBJECT = /\sstyle=\{\{(.*?)\}\}(?=[\s/>])/s;
const STYLE_ENTRY = /\s*([A-Za-z_$][\w$]*): ("(?:[^"\\]|\\.)*")\s*(?:,|$)/gy;
const JSON_ATTRIBUTE = /\s([A-Za-z_:][\w:.-]*)=\{("(?:[^"\\]|\\.)*")\}/g;
const LINK_START = /^<Link\s+to="([^"]*)"/;

/**
 * Index just after the `}` that closes the brace at `start`, honouring JS string literals.
 *
 * @param {string} text Source.
 * @param {number} start Index of `{`.
 * @returns {number} End index, or -1 when unbalanced.
 */
function skipBraces(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'" || char === '`') {
      index = skipString(text, index);
      if (index === -1) {
        return -1;
      }
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return -1;
}

/**
 * Index of the quote that closes the JS string literal starting at `start`.
 *
 * @param {string} text Source.
 * @param {number} start Index of the opening quote.
 * @returns {number} Index of the closing quote, or -1.
 */
function skipString(text, start) {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
    } else if (text[index] === quote) {
      return index;
    }
  }
  return -1;
}

/**
 * End of the tag starting at `start` (quoted values and `{…}` values are skipped).
 *
 * @param {string} text Source.
 * @param {number} start Index of `<`.
 * @returns {number} Index after `>`, or -1.
 */
function scanTag(text, start) {
  let afterEquals = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (afterEquals && (char === '"' || char === "'")) {
      index = text.indexOf(char, index + 1);
      if (index === -1) {
        return -1;
      }
    } else if (afterEquals && char === '{') {
      const end = skipBraces(text, index);
      if (end === -1) {
        return -1;
      }
      index = end - 1;
    } else if (char === '>') {
      return index + 1;
    }
    if (char === '=') {
      afterEquals = true;
    } else if (!/\s/.test(char)) {
      afterEquals = false;
    }
  }
  return -1;
}

/**
 * React style key -> CSS property name (inverse of `style-to-js` with `reactCompat`).
 *
 * @param {string} key Object key.
 * @returns {string} CSS property.
 */
function cssProperty(key) {
  const prefixed = /^(?:Webkit|Moz|O|ms)[A-Z]/.test(key) ? `-${key[0].toLowerCase()}${key.slice(1)}` : key;
  return prefixed.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

/**
 * Map the converter's JSX attribute forms in one tag back to HTML.
 *
 * @param {string} tag Tag source.
 * @returns {string} HTML tag.
 */
function reverseTag(tag) {
  if (tag === '</Link>') {
    return '</div>';
  }
  let result = tag;
  const link = LINK_START.exec(result);
  if (link) {
    const rest = result.slice(link[0].length);
    const close = rest.endsWith('/>') ? '/>' : '>';
    result = `<div${rest.slice(0, -close.length)} onclick="location.href='${link[1]}';"${close}`;
  }
  result = result.replace(STYLE_OBJECT, (match, body) => {
    const declarations = [];
    STYLE_ENTRY.lastIndex = 0;
    for (let entry = STYLE_ENTRY.exec(body); entry !== null && entry[0] !== ''; entry = STYLE_ENTRY.exec(body)) {
      declarations.push(`${cssProperty(entry[1])}: ${JSON.parse(entry[2])}`);
    }
    return ` style="${escapeHtmlAttribute(declarations.join('; '))}"`;
  });
  return result.replace(JSON_ATTRIBUTE, (match, name, json) => ` ${name}="${escapeHtmlAttribute(JSON.parse(json))}"`);
}

/**
 * Read one of the converter's expression forms at `start`.
 *
 * @param {string} text Source.
 * @param {number} start Index of `{`.
 * @returns {{kind: 'comment'|'text', value: string, end: number}|null} The form, or null.
 */
function readOwnExpression(text, start) {
  if (text.startsWith('{/*', start)) {
    const close = text.indexOf('*/}', start + 3);
    return close === -1 ? null : {kind: 'comment', value: mdxCommentContent(text.slice(start + 3, close)), end: close + 3};
  }
  const opener = text[start + 1];
  if (opener !== '"' && opener !== '`') {
    return null;
  }
  const close = skipString(text, start + 1);
  if (close === -1 || text[close + 1] !== '}') {
    return null;
  }
  try {
    const value = opener === '"' ? JSON.parse(text.slice(start + 1, close + 1)) : decodeTemplateBody(text.slice(start + 2, close));
    return typeof value === 'string' ? {kind: 'text', value, end: close + 2} : null;
  } catch {
    return null;
  }
}

/**
 * Map the converter's own JSX forms in an HTML/JSX block back to HTML (identity on plain HTML).
 *
 * @param {string} text Raw block.
 * @returns {string} HTML for parse5.
 */
export function normalizeOwnJsx(text) {
  let out = '';
  let rawParent = null;
  let index = 0;
  while (index < text.length) {
    if (text.startsWith('<!--', index)) {
      const close = text.indexOf('-->', index + 4);
      const end = close === -1 ? text.length : close + 3;
      out += text.slice(index, end);
      index = end;
      rawParent = null;
      continue;
    }
    const char = text[index];
    if (char === '<' && /[A-Za-z/]/.test(text[index + 1] ?? '')) {
      const end = scanTag(text, index);
      if (end !== -1) {
        const tag = text.slice(index, end);
        out += reverseTag(tag);
        const name = /^<([A-Za-z][\w-]*)/.exec(tag)?.[1]?.toLowerCase();
        rawParent = RAW_TEXT_PARENTS.has(name) ? name : null;
        index = end;
        continue;
      }
    }
    if (char === '{') {
      const expression = readOwnExpression(text, index);
      if (expression !== null) {
        if (expression.kind === 'comment') {
          out += `<!--${expression.value}-->`;
        } else {
          out += rawParent === null ? escapeHtmlText(expression.value) : expression.value;
        }
        index = expression.end;
        rawParent = null;
        continue;
      }
    }
    out += char;
    rawParent = null;
    index += 1;
  }
  return out;
}

/**
 * Locate the first of the converter's own JSX forms in MkDocs source HTML.
 *
 * @param {string} text Raw HTML block or tag from a source that has not been converted.
 * @returns {{offset: number, form: string}|null} Where it is and which form, or null.
 */
export function findOwnJsxForm(text) {
  let index = 0;
  while (index < text.length) {
    if (text.startsWith('<!--', index)) {
      const close = text.indexOf('-->', index + 4);
      index = close === -1 ? text.length : close + 3;
      continue;
    }
    const char = text[index];
    if (char === '<' && /[A-Za-z/]/.test(text[index + 1] ?? '')) {
      const end = scanTag(text, index);
      if (end !== -1) {
        const tag = text.slice(index, end);
        const style = STYLE_OBJECT.exec(tag);
        JSON_ATTRIBUTE.lastIndex = 0;
        const attribute = JSON_ATTRIBUTE.exec(tag);
        const found = [style, attribute].filter(Boolean).sort((a, b) => a.index - b.index)[0];
        if (found) {
          return {offset: index + found.index + 1, form: found === style ? 'style={{…}}' : 'attribute={"…"}'};
        }
        index = end;
        continue;
      }
    }
    if (char === '{') {
      const expression = readOwnExpression(text, index);
      if (expression !== null) {
        const form = text.startsWith('{/*', index) ? '{/* … */}' : `{${text[index + 1]}…${text[index + 1]}}`;
        return {offset: index, form};
      }
    }
    index += 1;
  }
  return null;
}
