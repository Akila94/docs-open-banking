/**
 * Edits to the source of one Markdown text node (spec §3 passes 10 and 14).
 *
 * - Escaping: `{`, `}` and `<` become `\{`, `\}` and `\<`, so MDX shows them as text (this is what
 *   makes `<IS_HOME>`-style placeholders visible). Existing backslash escapes and character
 *   references are kept, so escaping never doubles.
 * - Smartsymbols: a port of pymdownx 6.3 `smartsymbols` (all symbols enabled, as in mkdocs.yml),
 *   applied to the same text Python-Markdown applies it to (text outside code and raw HTML), with
 *   the patterns in registration order. Python's Unicode `\b`/`\d` are written as lookarounds.
 */

const WORD = '[\\p{L}\\p{N}_]';
const symbol = (code) => String.fromCodePoint(code);

/** `[pattern, replace]` in pymdownx registration order (all priority 30). */
const SMART_SYMBOLS = [
  [/\(tm\)/g, () => symbol(0x2122)],
  [/\(c\)/g, () => symbol(0xa9)],
  [/\(r\)/g, () => symbol(0xae)],
  [/\+\/-/g, () => symbol(0xb1)],
  [/<-->|(?<!-)-->|<--(?!-)/g, (match) => ({'-->': symbol(0x2192), '<--': symbol(0x2190), '<-->': symbol(0x2194)})[match]],
  [/=\/=/g, () => symbol(0x2260)],
  [/(?<!\p{Nd})(?:1\/4|1\/2|3\/4|1\/3|2\/3|1\/5|2\/5|3\/5|4\/5|1\/6|5\/6|1\/8|3\/8|5\/8|7\/8)(?!\p{Nd})/gu, (match) => ({
    '1/4': symbol(0xbc), '1/2': symbol(0xbd), '3/4': symbol(0xbe), '1/3': symbol(0x2153), '2/3': symbol(0x2154),
    '1/5': symbol(0x2155), '2/5': symbol(0x2156), '3/5': symbol(0x2157), '4/5': symbol(0x2158), '1/6': symbol(0x2159),
    '5/6': symbol(0x215a), '1/8': symbol(0x215b), '3/8': symbol(0x215c), '5/8': symbol(0x215d), '7/8': symbol(0x215e),
  })[match]],
  [new RegExp(`(?<!${WORD})((?:[1-9][0-9]*)?)((?<=1)(?:1|2|3)th|1st|2nd|3rd|[04-9]th)(?!${WORD})`, 'gu'),
    (match, leading, tail) => ({markup: `${leading}${tail.slice(0, -2)}<sup>${tail.slice(1)}</sup>`})],
  [new RegExp(`(?<!${WORD})c/o(?!${WORD})`, 'gu'), () => symbol(0x2105)],
];

/** A backslash escape of ASCII punctuation, or a character reference: kept as written. */
const PROTECTED = /\\[!-/:-@[-`{-~]|&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g;

/**
 * Split a source slice into literal runs and protected atoms.
 *
 * @param {string} slice Source text.
 * @returns {Array<{text: string, literal: boolean}>} Segments in order.
 */
function segment(slice) {
  const segments = [];
  let last = 0;
  for (const match of slice.matchAll(PROTECTED)) {
    if (match.index > last) {
      segments.push({text: slice.slice(last, match.index), literal: true});
    }
    segments.push({text: match[0], literal: false});
    last = match.index + match[0].length;
  }
  if (last < slice.length) {
    segments.push({text: slice.slice(last), literal: true});
  }
  return segments;
}

/**
 * Apply smartsymbols to a literal run; replaced parts become non-literal segments.
 *
 * @param {Array<{text: string, literal: boolean}>} segments Segments.
 * @param {RegExp} pattern Global pattern.
 * @param {Function} replace Replacement (string, or `{markup}` for JSX).
 * @param {{count: number}} stats Counter.
 * @returns {Array<{text: string, literal: boolean}>} New segments.
 */
function applySymbol(segments, pattern, replace, stats) {
  return segments.flatMap((part) => {
    if (!part.literal) {
      return [part];
    }
    const out = [];
    let last = 0;
    for (const match of part.text.matchAll(pattern)) {
      out.push({text: part.text.slice(last, match.index), literal: true});
      const result = replace(...match);
      out.push({text: typeof result === 'string' ? result : result.markup, literal: false});
      stats.count += 1;
      last = match.index + match[0].length;
    }
    out.push({text: part.text.slice(last), literal: true});
    return out.filter((piece) => piece.text !== '');
  });
}

/**
 * Escape the MDX-significant characters of a literal run.
 *
 * @param {string} text Literal text.
 * @param {{count: number}} stats Counter of escaped `<`.
 * @returns {string} Escaped text.
 */
function escapeLiteral(text, stats) {
  return text.replace(/[{}<]/g, (char) => {
    if (char === '<') {
      stats.count += 1;
    }
    return `\\${char}`;
  });
}

/**
 * Transform the source of one text node.
 *
 * @param {string} slice Source slice of the text node.
 * @param {{smart?: boolean}} [options] `smart`: apply smartsymbols (default true).
 * @returns {{text: string, symbols: number, angles: number}} New source and change counts.
 */
export function transformText(slice, options = {}) {
  let segments = segment(slice);
  const symbols = {count: 0};
  if (options.smart !== false) {
    for (const [pattern, replace] of SMART_SYMBOLS) {
      segments = applySymbol(segments, pattern, replace, symbols);
    }
  }
  const angles = {count: 0};
  const text = segments.map((part) => (part.literal ? escapeLiteral(part.text, angles) : part.text)).join('');
  return {text, symbols: symbols.count, angles: angles.count};
}

/**
 * Escape text for use as Markdown link text (autolink conversion).
 *
 * @param {string} text Literal text.
 * @returns {string} Escaped text.
 */
export function escapeLinkText(text) {
  return text.replace(/[\\`*_[\]<>{}~|]/g, (char) => `\\${char}`);
}
