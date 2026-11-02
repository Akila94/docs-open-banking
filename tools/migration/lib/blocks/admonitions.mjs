/**
 * Admonition (`!!!`) and details (`???`) marker recognition and the MkDocs -> Docusaurus type map
 * (spec §3 pass 5).
 */

/** Python `[\w\-]` with Unicode word characters. */
const WORD = '[\\p{L}\\p{N}_\\-]';

/** Python-Markdown 3.2.2 `AdmonitionProcessor.RE`, for one line. */
const ADMONITION_LINE = new RegExp(`^!!! ?(${WORD}+(?: +${WORD}+)*)(?: +"(.*?)")? *$`, 'u');

/** pymdownx 6.3 `DetailsProcessor.START`, for one line. */
const DETAILS_LINE = new RegExp(
  `^\\?{3}(\\+)? ?(?:(${WORD}+(?: +${WORD}+)*?)?(?: +"(.*?)")|(${WORD}+(?: +${WORD}+)*?)) *$`,
  'u',
);

/**
 * MkDocs class -> Docusaurus admonition type plus the title MkDocs shows when none is quoted.
 * `null` default title means Docusaurus's own default title matches MkDocs's.
 */
const TYPE_MAP = new Map([
  ['note', {type: 'note', defaultLabel: null}],
  ['tip', {type: 'tip', defaultLabel: null}],
  ['info', {type: 'info', defaultLabel: null}],
  ['warning', {type: 'warning', defaultLabel: null}],
  ['optional', {type: 'note', defaultLabel: 'Optional'}],
  ['example', {type: 'info', defaultLabel: 'Example'}],
]);

/**
 * Python's `str.capitalize()`.
 *
 * @param {string} text Word.
 * @returns {string} First character upper-cased, the rest lower-cased.
 */
function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

/**
 * Match an `!!!` admonition marker line.
 *
 * @param {string} text Line text.
 * @returns {{className: string, title: string|null}|null} Lower-cased class list and the title MkDocs
 *   renders (`null` when the quoted title is empty, i.e. no title element), or null if no marker.
 */
export function matchAdmonition(text) {
  const match = ADMONITION_LINE.exec(text);
  if (!match) {
    return null;
  }
  const className = match[1].toLowerCase().replace(/ {2,}/g, ' ');
  if (match[2] === undefined) {
    return {className, title: capitalize(className.split(' ')[0]), quoted: false};
  }
  return {className, title: match[2] === '' ? null : match[2], quoted: true};
}

/**
 * Match a `???` details marker line.
 *
 * @param {string} text Line text.
 * @returns {{className: string, title: string, open: boolean, quoted: boolean}|null} Marker data or null.
 */
export function matchDetails(text) {
  const match = DETAILS_LINE.exec(text);
  if (!match) {
    return null;
  }
  const open = match[1] !== undefined;
  if (match[4] !== undefined) {
    const className = match[4].toLowerCase().replace(/ {2,}/g, ' ');
    return {className, title: capitalize(className.split(' ')[0]), open, quoted: false};
  }
  const className = match[2] === undefined ? '' : match[2].toLowerCase().replace(/ {2,}/g, ' ');
  return {className, title: match[3], open, quoted: true};
}

/**
 * Resolve a marker into the Docusaurus type and label.
 *
 * @param {{className: string, title: string|null, quoted: boolean}} marker Result of a matcher.
 * @param {boolean} isDetails Whether this is a `???` block (an untyped one becomes `note`).
 * @returns {{type: string, label: string|null}|{error: string}} The mapping, or an error message.
 */
export function resolveAdmonitionType(marker, isDetails) {
  if (marker.className.includes(' ')) {
    return {error: `admonition class list "${marker.className}" has more than one class`};
  }
  const mapped = TYPE_MAP.get(isDetails && marker.className === '' ? 'note' : marker.className);
  if (!mapped) {
    return {error: `unknown admonition type "${marker.className}"`};
  }
  if (marker.title === null || marker.title === '') {
    return {error: 'admonitions with an empty quoted title are not supported'};
  }
  if (isDetails) {
    return {type: mapped.type, label: marker.title};
  }
  return {type: mapped.type, label: marker.quoted ? marker.title : mapped.defaultLabel};
}

/**
 * Check that a title can be a directive label `[...]` (balanced brackets, single line).
 *
 * @param {string} label Title text.
 * @returns {boolean} True when safe to emit inside `[` `]`.
 */
export function isSafeDirectiveLabel(label) {
  let depth = 0;
  for (let index = 0; index < label.length; index += 1) {
    const char = label[index];
    if (char === '\\') {
      index += 1;
    } else if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    } else if (char === '\n') {
      return false;
    }
  }
  return depth === 0;
}
