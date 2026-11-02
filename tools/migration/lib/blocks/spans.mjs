/**
 * Source-span and shape helpers for the block tree, used by the emitter: which children are
 * emitted, the first/last source line of a node, directive nesting depth and fence lengths.
 */

/** Nodes that need a blank line on both sides. */
export const BLOCKISH = new Set(['admonition', 'tabs', 'html', 'comment', 'mdxcomment', 'snippet']);

/**
 * Children that are emitted (the title/summary placeholders only exist for parsing).
 *
 * @param {{children?: object[]}} node Container.
 * @returns {object[]} Real children.
 */
export function realChildren(node) {
  return (node.children ?? []).filter((child) => child.type !== 'admtitle' && child.type !== 'summary');
}

/**
 * First source line index of a node.
 *
 * @param {object} node Tree node.
 * @returns {number} Line index.
 */
export function firstNo(node) {
  switch (node.type) {
    case 'item':
    case 'admonition':
      return node.markerLine.no;
    case 'list':
      return firstNo(node.children[0]);
    case 'tabs':
      return firstNo(node.fences[0]);
    default:
      return node.lines ? Math.min(...node.lines.map((line) => line.no)) : node.line.no;
  }
}

/**
 * Last source line index of a node.
 *
 * @param {object} node Tree node.
 * @returns {number} Line index.
 */
export function lastNo(node) {
  switch (node.type) {
    case 'item':
    case 'admonition': {
      const children = realChildren(node);
      return Math.max(node.markerLine.end, ...children.map(lastNo));
    }
    case 'list':
      return lastNo(node.children[node.children.length - 1]);
    case 'tabs':
      return lastNo(node.fences[node.fences.length - 1]);
    default:
      return node.lines ? Math.max(...node.lines.map((line) => line.end)) : node.line.end;
  }
}

/**
 * Whether an item's emitted content ends with a block that needs a following blank line.
 *
 * @param {object} item List item.
 * @returns {boolean} True when the last descendant is a container.
 */
export function endsWithBlock(item) {
  const children = realChildren(item);
  const last = children[children.length - 1];
  if (last === undefined) {
    return false;
  }
  return BLOCKISH.has(last.type) || (last.type === 'list' && endsWithBlock(last.children[last.children.length - 1]));
}

/**
 * Nesting depth of directive admonitions below a node (for the outer colon count).
 *
 * @param {object} node Tree node.
 * @returns {number} 0 when no directive admonition is nested inside.
 */
export function directiveDepth(node) {
  const children = node.type === 'tabs' ? node.fences : realChildren(node);
  let depth = 0;
  for (const child of children) {
    const own = child.type === 'admonition' && child.variant === 'admonition' ? 1 : 0;
    depth = Math.max(depth, own + directiveDepth(child));
  }
  return depth;
}

/**
 * Longest fence needed so no content line can close the block early.
 *
 * @param {string} char Fence character.
 * @param {number} minimum Minimum length.
 * @param {string[]} lines Code lines.
 * @returns {number} Fence length.
 */
export function fenceLength(char, minimum, lines) {
  let length = minimum;
  const closer = char === '`' ? /^ {0,3}(`+)[ \t]*$/ : /^ {0,3}(~+)[ \t]*$/;
  for (const line of lines) {
    const match = closer.exec(line);
    if (match && match[1].length >= length) {
      length = match[1].length + 1;
    }
  }
  return length;
}
