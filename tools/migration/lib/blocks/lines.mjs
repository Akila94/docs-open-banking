/**
 * Line primitives for the Python-Markdown block emulation.
 *
 * Python-Markdown works on strings: it joins lines, splits on "\n\n", detabs and slices. The
 * emulation keeps the same operations but on arrays of `Line` records so every piece of text
 * still knows the source line it came from. A `Line` is immutable:
 *   - `no`   0-based index of the (first) source line in the body,
 *   - `end`  index of the last source line it stands for (placeholders span several lines),
 *   - `text` the current text (after any detabbing),
 *   - `ref`  for placeholder lines, the stashed node (fence, raw HTML, comment, snippet).
 */

/** Python-Markdown's `tab_length`. */
export const TAB_LENGTH = 4;

/** Four spaces: the indentation unit of Python-Markdown containers. */
export const INDENT = ' '.repeat(TAB_LENGTH);

/**
 * Create a line record.
 *
 * @param {number} no 0-based source line index.
 * @param {string} text Line text.
 * @param {object} [ref] Stashed node for placeholder lines.
 * @param {number} [end] Last source line index covered (defaults to `no`).
 * @returns {Readonly<{no: number, end: number, text: string, ref: object|undefined}>} The line.
 */
export function makeLine(no, text, ref = undefined, end = no) {
  return Object.freeze({no, end, text, ref});
}

/**
 * Copy a line with new text (same source position and ref).
 *
 * @param {{no: number, end: number, ref: object|undefined}} line Original line.
 * @param {string} text New text.
 * @returns {Readonly<object>} The new line.
 */
export function withText(line, text) {
  return makeLine(line.no, text, line.ref, line.end);
}

/**
 * Python's `str.expandtabs(tabsize)` for one line: tab stops every `tabSize` columns.
 *
 * @param {string} text A single line (no newline).
 * @param {number} [tabSize=TAB_LENGTH] Tab width.
 * @returns {string} The line with tabs replaced by spaces.
 */
export function expandTabs(text, tabSize = TAB_LENGTH) {
  if (!text.includes('\t')) {
    return text;
  }
  let out = '';
  for (const char of text) {
    if (char === '\t') {
      out += ' '.repeat(tabSize - (out.length % tabSize));
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * Number of leading spaces.
 *
 * @param {string} text Line text.
 * @returns {number} Count of leading space characters.
 */
export function indentOf(text) {
  return text.length - text.replace(/^ +/, '').length;
}

/**
 * Split lines into blocks exactly like Python's `'\n'.join(lines).split('\n\n')`.
 *
 * A separator consumes the newline ending one line plus one empty line, so runs of blank lines
 * yield empty blocks or blocks that start with an empty line, as in Python-Markdown.
 *
 * @param {ReadonlyArray<{text: string}>} lines Lines (blank lines have empty text).
 * @returns {Array<Array<object>>} Blocks, each a non-empty array of lines.
 */
export function splitBlocks(lines) {
  const blocks = [];
  let start = 0;
  for (let index = 0; index < lines.length; index += 1) {
    // "\n\n" = the newline ending line `index` + an empty line that is itself followed by a newline.
    if (index + 1 < lines.length - 1 && lines[index + 1].text === '') {
      blocks.push(lines.slice(start, index + 1));
      start = index + 2;
      index += 1;
    }
  }
  if (start < lines.length) {
    blocks.push(lines.slice(start));
  }
  return blocks;
}

/**
 * Python-Markdown `BlockProcessor.detab`: strip one indent level from leading lines.
 * Blank lines are kept (as empty), and the first non-indented, non-blank line ends the run.
 *
 * @param {ReadonlyArray<object>} lines Block lines.
 * @returns {[Array<object>, Array<object>]} The detabbed lines and the rest.
 */
export function detab(lines) {
  const detabbed = [];
  for (const line of lines) {
    if (line.text.startsWith(INDENT)) {
      detabbed.push(withText(line, line.text.slice(TAB_LENGTH)));
    } else if (line.text.trim() === '') {
      detabbed.push(withText(line, ''));
    } else {
      break;
    }
  }
  return [detabbed, lines.slice(detabbed.length)];
}

/**
 * Python-Markdown `BlockProcessor.looseDetab`: strip `level` indents where present.
 *
 * @param {ReadonlyArray<object>} lines Block lines.
 * @param {number} level Number of indent levels.
 * @returns {Array<object>} The lines.
 */
export function looseDetab(lines, level) {
  const width = TAB_LENGTH * level;
  const prefix = ' '.repeat(width);
  return lines.map((line) => (line.text.startsWith(prefix) ? withText(line, line.text.slice(width)) : line));
}

