/**
 * Post-parse pass, mirroring Python-Markdown's postprocessors:
 *   - a paragraph holding only a stashed placeholder becomes that node (raw HTML, comment,
 *     snippet, fence), as `RawHtmlPostprocessor` unwraps `<p>placeholder</p>`;
 *   - adjacent `<p>`-wrapped tab fences become one tab group, as `SuperFencesTabPostProcessor`
 *     groups consecutive `<p><superfences>` paragraphs.
 */
import {ConversionError} from '../errors.mjs';

/**
 * The last child of a node, or null (`BlockProcessor.lastChild`).
 *
 * @param {{children: object[]}} parent Container node.
 * @returns {object|null} Last child.
 */
export function lastChild(parent) {
  return parent.children.length > 0 ? parent.children[parent.children.length - 1] : null;
}

const STANDALONE_KINDS = new Set(['html', 'comment', 'mdxcomment', 'snippet']);

/**
 * Convert one paragraph into the node(s) that replace it.
 *
 * @param {object} para Paragraph node.
 * @param {(line: object, message: string) => never} fail Error helper.
 * @returns {object[]} Replacement nodes.
 */
function replaceParagraph(para, fail) {
  const placeholders = para.lines.filter((line) => line.ref !== undefined);
  if (placeholders.length === 0) {
    return [para];
  }
  for (const line of placeholders) {
    if (line.ref.kind === 'fence' && line.ref.tab !== null && placeholders.length !== para.lines.length) {
      fail(line, 'MkDocs does not group a tab fence that shares a paragraph with text; separate it with a fixup');
    }
    if (line.ref.kind !== 'fence' && para.lines.length !== 1) {
      fail(line, `a stashed ${line.ref.kind} block shares a paragraph with other content`);
    }
  }
  if (placeholders.length !== para.lines.length) {
    return [para];
  }
  if (STANDALONE_KINDS.has(placeholders[0].ref.kind)) {
    return [{type: placeholders[0].ref.kind, line: placeholders[0], ref: placeholders[0].ref}];
  }
  return placeholders.map((line) => ({type: 'fence', line, ref: line.ref, tight: para.tight}));
}

/**
 * Group runs of adjacent tab fences into `tabs` nodes.
 *
 * @param {object[]} children Sibling nodes.
 * @param {(line: object, message: string) => never} fail Error helper.
 * @returns {object[]} Siblings with tab groups.
 */
function groupTabs(children, fail) {
  const grouped = [];
  for (const child of children) {
    const isTab = child.type === 'fence' && child.ref.tab !== null;
    if (!isTab) {
      grouped.push(child);
      continue;
    }
    if (child.tight) {
      fail(child.line, 'MkDocs does not group a tab fence in a tight list item; add a blank line with a fixup');
    }
    const previous = grouped[grouped.length - 1];
    if (previous !== undefined && previous.type === 'tabs') {
      previous.fences.push(child);
    } else {
      grouped.push({type: 'tabs', fences: [child]});
    }
  }
  return grouped;
}

/**
 * Normalise the tree in place.
 *
 * @param {{children: object[]}} node Root or container node.
 * @param {{file: string, lineOffset: number}} ctx Conversion context.
 */
export function normalizeTree(node, ctx) {
  const fail = (line, message) => {
    throw new ConversionError(ctx.file, line.no + ctx.lineOffset + 1, message);
  };
  const replaced = node.children.flatMap((child) => (child.type === 'para' ? replaceParagraph(child, fail) : [child]));
  node.children = groupTabs(replaced, fail);
  for (const child of node.children) {
    if (child.children) {
      normalizeTree(child, ctx);
    }
  }
}

/**
 * Normalise code text the way the verification harness compares it: right-trimmed lines,
 * no leading or trailing blank lines.
 *
 * @param {string[]} lines Code lines.
 * @returns {string} Normalised text.
 */
function normalizeCode(lines) {
  const trimmed = lines.map((line) => line.trimEnd());
  while (trimmed.length > 0 && trimmed[0] === '') {
    trimmed.shift();
  }
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') {
    trimmed.pop();
  }
  return trimmed.join('\n');
}

/**
 * Every code block of a (normalised or raw) tree, keyed by its first source line: indented code
 * as Python-Markdown's text, fences as their dedented content. Fence placeholders still inside
 * paragraphs are included, so the raw tree of a second parse can be compared too.
 *
 * @param {{children: object[]}} root Tree root.
 * @returns {Map<number, {text: string, lines: number[]}>} Source line -> code text and the source
 *   lines the block spans.
 */
export function collectCodeTexts(root) {
  const codes = new Map();
  const addFence = (line) => {
    const span = [];
    for (let no = line.no; no <= line.end; no += 1) {
      span.push(no);
    }
    codes.set(line.no, {text: normalizeCode(line.ref.codeLines), lines: span});
  };
  const visit = (node) => {
    if (node.type === 'code') {
      codes.set(node.lines[0].no, {text: normalizeCode(node.text.split('\n')), lines: node.lines.map((line) => line.no)});
    } else if (node.type === 'fence') {
      addFence(node.line);
    } else if (node.type === 'tabs') {
      node.fences.forEach((fence) => addFence(fence.line));
    } else if (node.type === 'para') {
      node.lines.filter((line) => line.ref?.kind === 'fence').forEach(addFence);
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(root);
  return codes;
}
