/**
 * Text encodings used when raw HTML becomes JSX in MDX.
 *
 * - JSON string expressions (`{"…"}`) hold text exactly and are never re-parsed as Markdown.
 * - Template literals (`{`…`}`) hold `<pre>`/`<style>` content exactly and stay readable. MDX strips
 *   up to two leading whitespace characters from every continuation line of an expression
 *   (`micromark-factory-mdx-expression`, `indentSize = 2`), so the first leading whitespace
 *   character of such a line is written as an escape (`\x20` or `\t`).
 * - Plain text is used only where MDX reads it back literally (see `isSafePlainText`).
 */

/** Code point ranges of invisible or ambiguous characters (C1 controls, NBSP, soft hyphen, format and
 * separator characters, BOM). Numeric so the source stays plain ASCII. */
const INVISIBLE_RANGES = [[0x80, 0xa0], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x2000, 0x200f],
  [0x2028, 0x202f], [0x205f, 0x206f], [0xfeff, 0xfeff]];
/** Non-ASCII punctuation with no Markdown meaning (Latin-1 punctuation, general punctuation). */
const SAFE_PUNCTUATION_RANGES = [[0xa1, 0xbf], [0x2010, 0x2027], [0x2030, 0x205e]];
/** Characters with no Markdown/MDX meaning in the middle of a line. */
const SAFE_PLAIN = /^[\p{L}\p{N} .,;:?!'"()/=+%$#-]$/u;
/** Sequences that would still be read as syntax: images, directives, GFM autolink literals. */
const UNSAFE_SEQUENCE = /!\[|:[A-Za-z]|:\/\/|www\./i;
/** HTML whitespace (the parser's definition). */
export const HTML_SPACE = /^[ \t\n\f\r]+$/;

/**
 * Encode text as a JSON string expression.
 *
 * @param {string} text Exact text.
 * @returns {string} `{"…"}`.
 */
export function jsonExpression(text) {
  let json = '';
  for (const char of JSON.stringify(text)) {
    const code = char.codePointAt(0);
    json += inRanges(code, INVISIBLE_RANGES) ? `\\u${code.toString(16).padStart(4, '0')}` : char;
  }
  return `{${json}}`;
}

/**
 * Encode text as a template literal expression that MDX hands to the JSX unchanged.
 *
 * @param {string} text Exact text.
 * @returns {string} `{`…`}`.
 */
export function templateExpression(text) {
  const escaped = text
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('${', '\\${')
    .replace(/\n([ \t])/g, (match, space) => `\n${space === '\t' ? '\\t' : '\\x20'}`);
  return `{\`${escaped}\`}`;
}

/**
 * Decode the body of a template literal produced by `templateExpression`.
 *
 * @param {string} body Text between the backticks.
 * @returns {string} The exact text.
 * @throws {Error} For an escape the converter never writes.
 */
export function decodeTemplateBody(body) {
  return body.replace(/\\(x20|[\s\S])/g, (match, code) => {
    if (code === 'x20') {
      return ' ';
    }
    if (code === 't') {
      return '\t';
    }
    if (code === '\\' || code === '`' || code === '$') {
      return code;
    }
    throw new Error(`unexpected escape ${match} in a template literal`);
  });
}

/**
 * Whether text can be written as plain JSX text on the line of its parent's start tag.
 *
 * @param {string} text Text without leading or trailing whitespace.
 * @returns {boolean} True when MDX reads it back as the same literal text.
 */
export function isSafePlainText(text) {
  if (text === '' || UNSAFE_SEQUENCE.test(text)) {
    return false;
  }
  return [...text].every((char) => SAFE_PLAIN.test(char) || inRanges(char.codePointAt(0), SAFE_PUNCTUATION_RANGES));
}

/**
 * Whether a code point falls in one of the inclusive ranges.
 *
 * @param {number} code Code point.
 * @param {Array<[number, number]>} ranges Inclusive ranges.
 * @returns {boolean} True when inside a range.
 */
function inRanges(code, ranges) {
  return ranges.some(([low, high]) => code >= low && code <= high);
}

/**
 * Escape text for an HTML text position.
 *
 * @param {string} text Raw text.
 * @returns {string} Text with `&`, `<` and `>` escaped.
 */
export function escapeHtmlText(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Escape text for a double-quoted HTML attribute.
 *
 * @param {string} value Raw value.
 * @returns {string} Escaped value.
 */
export function escapeHtmlAttribute(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

/**
 * Layout for whitespace that has no rendered effect: keep the final line break and indentation.
 *
 * @param {string} space Whitespace text.
 * @returns {string} '' or `\n` plus the indentation after the last line break.
 */
export function layoutWhitespace(space) {
  const index = space.lastIndexOf('\n');
  return index === -1 ? '' : space.slice(index);
}
