/**
 * Port of Python-Markdown 3.2.2 `tables` detection, plus the one GFM adjustment the output needs:
 * Python-Markdown ignores pipes inside code spans, GFM splits on them unless escaped.
 */

const RE_CODE_PIPES = /(\\\\)|(\\`+)|(`+)|(\\\|)|(\|)/g;
const RE_END_BORDER = /(?<!\\)(?:\\\\)*\|$/;
const PIPE_LEFT = 1;
const PIPE_RIGHT = 2;

/**
 * Positions of cell-separating pipes and of pipes Python-Markdown treats as code (`_split`).
 *
 * @param {string} row Row text.
 * @returns {{good: number[], inCode: number[]}} Pipe indexes.
 */
function classifyPipes(row) {
  const pipes = [];
  const tics = [];
  const ticPoints = [];
  for (const match of row.matchAll(RE_CODE_PIPES)) {
    if (match[2]) {
      tics.push(match[2].length - 1);
      ticPoints.push([match.index, match.index + match[2].length - 1, 1]);
    } else if (match[3]) {
      tics.push(match[3].length);
      ticPoints.push([match.index, match.index + match[3].length - 1, 0]);
    } else if (match[5]) {
      pipes.push(match.index);
    }
  }
  const regions = [];
  let pos = 0;
  while (pos < tics.length) {
    const ticSize = tics[pos] - ticPoints[pos][2];
    const found = ticSize === 0 ? -1 : tics.slice(pos + 1).indexOf(ticSize);
    if (found === -1) {
      pos += 1;
    } else {
      regions.push([ticPoints[pos][0], ticPoints[pos + found + 1][1]]);
      pos += found + 2;
    }
  }
  const inCode = pipes.filter((pipe) => regions.some(([start, end]) => start <= pipe && pipe <= end));
  return {good: pipes.filter((pipe) => !inCode.includes(pipe)), inCode};
}

/**
 * `_split_row`: cells of a row given the header border flags.
 *
 * @param {string} row Row text (stripped of spaces).
 * @param {number} border PIPE_LEFT/PIPE_RIGHT flags.
 * @returns {string[]} Cells.
 */
function splitRow(row, border) {
  let text = row;
  if (border) {
    if (text.startsWith('|')) {
      text = text.slice(1);
    }
    text = text.replace(RE_END_BORDER, '');
  }
  const cells = [];
  let start = 0;
  for (const pipe of classifyPipes(text).good) {
    cells.push(text.slice(start, pipe));
    start = pipe + 1;
  }
  cells.push(text.slice(start));
  return cells;
}

/**
 * `TableProcessor.test`: is this block a Python-Markdown table?
 *
 * @param {ReadonlyArray<{text: string}>} block Block lines.
 * @returns {boolean} True for a table.
 */
export function isTableBlock(block) {
  const rows = block.map((line) => line.text.replace(/^ +| +$/g, ''));
  if (rows.length < 2) {
    return false;
  }
  const header = rows[0];
  let border = 0;
  if (header.startsWith('|')) {
    border |= PIPE_LEFT;
  }
  if (RE_END_BORDER.test(header)) {
    border |= PIPE_RIGHT;
  }
  const headerLength = splitRow(header, border).length;
  let isTable = headerLength > 1;
  if (!isTable && headerLength === 1 && border) {
    for (const row of rows.slice(1)) {
      isTable = row.startsWith('|') || RE_END_BORDER.test(row);
      if (!isTable) {
        break;
      }
    }
  }
  if (!isTable) {
    return false;
  }
  const separator = splitRow(rows[1], border);
  return separator.length === headerLength && [...separator.join('')].every((char) => '|:- '.includes(char));
}

/**
 * Escape pipes that Python-Markdown kept inside code spans, so GFM does not split the cell there.
 *
 * @param {string} row Row text.
 * @returns {string} Row with those pipes written as `\|`.
 */
export function escapeCodePipes(row) {
  const {inCode} = classifyPipes(row);
  let out = row;
  for (const pipe of [...inCode].reverse()) {
    out = `${out.slice(0, pipe)}\\${out.slice(pipe)}`;
  }
  return out;
}
