/**
 * MkDocs-compatible heading ids (spec §3 pass 12, Ruling 12).
 *
 * MkDocs ids come from Python-Markdown's toc: the heading's rendered text with raw HTML and character
 * references stripped (`stashedHTML2text`), slugified and made unique with `_1`, `_2` in document
 * order. Docusaurus slugs `mdast-util-to-string` of the heading with github-slugger (`-1`, `-2`);
 * headings with an explicit `{#id}` are not registered in its slugger. Wherever the two differ,
 * `\{#mkdocs-id\}` is appended so existing deep links keep working. h1 headings never get one (the
 * Docusaurus page header h1 has no id) but still take part in both de-duplications.
 */
import {toString} from 'mdast-util-to-string';

import {mkdocsSlugify, mkdocsUnique, createDocusaurusSlugger, docusaurusSlug, peekDocusaurusSlug} from '../slug.mjs';

/** Python-Markdown 3.2.2 `ESCAPED_CHARS` (backslash escapes that render as the bare character). */
const PY_ESCAPE = /\\([\\`*_{}[\]()>#+\-.!])/g;
/** Python-Markdown `ENTITY_RE` (character references are stashed, then stripped from toc text). */
const PY_ENTITY = /&(?:#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z0-9]+);/g;
/** Python-Markdown `HTML_RE` (raw inline HTML, stripped from toc text). */
const PY_HTML = /<(?:[a-zA-Z/][^<>]*|!--(?:(?!<!--|-->).)*--)>/g;
/** The converter's explicit id suffix, as written in the source. */
const OWN_ID_SUFFIX = /[ \t]\\\{#([A-Za-z0-9_-]+)\\\}$/;
/** Docusaurus `parseMarkdownHeadingId` (classic syntax). */
const DOCUSAURUS_ID = /\s*\{#(?<id>(?:.(?!\{#|\}))*.)\}$/;

/**
 * Text Python-Markdown's toc sees for a source text run.
 *
 * @param {string} slice Raw source.
 * @returns {string} Text.
 */
function pythonText(slice) {
  return slice.replace(PY_ENTITY, '').replace(PY_ESCAPE, '$1').replace(PY_HTML, '');
}

/**
 * Text Python-Markdown's toc computes for a heading node (before slugify).
 *
 * @param {object} node mdast node (CommonMark parse).
 * @param {string} source Source the positions refer to.
 * @returns {string} Text.
 */
function mkdocsText(node, source) {
  const slice = () => source.slice(node.position.start.offset, node.position.end.offset);
  switch (node.type) {
    case 'text':
    case 'textDirective':
      return pythonText(slice());
    case 'inlineCode':
      return slice().replace(/^(`+)([\s\S]*?)\1$/, '$2').trim();
    case 'html':
    case 'image':
    case 'break':
      return '';
    default:
      return (node.children ?? []).map((child) => mkdocsText(child, source)).join('');
  }
}

/**
 * Collect headings in document order.
 *
 * @param {object} root mdast root.
 * @returns {object[]} Heading nodes.
 */
function headingsOf(root) {
  const found = [];
  const visit = (node) => {
    if (node.type === 'heading') {
      found.push(node);
    }
    (node.children ?? []).forEach(visit);
  };
  visit(root);
  return found;
}

/**
 * The heading text Docusaurus slugs (its `getHeadingText`), without an explicit id.
 *
 * @param {object} heading MDX mdast heading.
 * @returns {string} Text.
 */
function docusaurusText(heading) {
  const children = heading.children.filter(({type}) => type !== 'html' && type !== 'jsx');
  const text = toString(children.length > 0 ? children : heading);
  const match = DOCUSAURUS_ID.exec(text);
  return match ? text.slice(0, match.index) : text;
}

/**
 * MkDocs ids for the headings of the CommonMark parse.
 *
 * @param {object} root mdast root (CommonMark parse of the block passes' output).
 * @param {string} source Source of that parse.
 * @returns {Array<{line: number, depth: number, mkdocsId: string, explicit: string|null}>} In order.
 */
export function mkdocsHeadingIds(root, source) {
  const seen = new Set();
  return headingsOf(root).map((heading) => {
    const {start} = heading.position;
    const last = heading.children[heading.children.length - 1];
    const own = last ? OWN_ID_SUFFIX.exec(source.slice(start.offset, last.position.end.offset)) : null;
    if (own) {
      seen.add(own[1]);
      return {line: start.line, depth: heading.depth, mkdocsId: own[1], explicit: own[1]};
    }
    const id = mkdocsUnique(mkdocsSlugify(mkdocsText(heading, source).trim()), seen);
    return {line: start.line, depth: heading.depth, mkdocsId: id, explicit: null};
  });
}

/**
 * Work out the `\{#id\}` insertions that make Docusaurus ids equal MkDocs ids.
 *
 * @param {object} mdxRoot MDX mdast of the converted text.
 * @param {Array<{line: number, depth: number, mkdocsId: string, explicit: string|null}>} expected MkDocs ids.
 * @returns {{edits: Array<{start: number, end: number, text: string}>, overrides: Array<{line: number, id: string}>,
 *   mismatch: {line: number}|null}} Insertions, their sites, and the first heading the two parses disagree on.
 */
export function headingIdEdits(mdxRoot, expected) {
  const headings = headingsOf(mdxRoot);
  const edits = [];
  const overrides = [];
  const slugger = createDocusaurusSlugger();
  for (let index = 0; index < Math.max(headings.length, expected.length); index += 1) {
    const heading = headings[index];
    const target = expected[index];
    if (!heading || !target || heading.position.start.line !== target.line || heading.depth !== target.depth) {
      return {edits, overrides, mismatch: {line: heading?.position.start.line ?? target?.line ?? 1}};
    }
    if (target.explicit !== null) {
      continue;
    }
    const text = docusaurusText(heading);
    if (heading.depth === 1 || peekDocusaurusSlug(text, slugger) === target.mkdocsId) {
      docusaurusSlug(text, slugger);
      continue;
    }
    const last = heading.children[heading.children.length - 1];
    if (!last) {
      continue;
    }
    edits.push({start: last.position.end.offset, end: last.position.end.offset, text: ` \\{#${target.mkdocsId}\\}`});
    overrides.push({line: target.line, id: target.mkdocsId});
  }
  return {edits, overrides, mismatch: null};
}

/**
 * Whether Docusaurus finds a content title (the first heading, before any thematic break, is an h1).
 *
 * @param {object} mdxRoot MDX mdast.
 * @returns {boolean} True when the page renders its own h1 as the title.
 */
export function hasContentTitle(mdxRoot) {
  let result = null;
  const visit = (node) => {
    if (result !== null) {
      return;
    }
    if (node.type === 'heading') {
      result = node.depth === 1;
      return;
    }
    if (node.type === 'thematicBreak') {
      result = false;
      return;
    }
    (node.children ?? []).forEach(visit);
  };
  visit(mdxRoot);
  return result === true;
}

/**
 * Whether a CommonMark parse has an h1 anywhere (Material then shows no synthetic title).
 *
 * @param {object} root mdast root.
 * @returns {boolean} True when an h1 heading exists.
 */
export function hasMarkdownH1(root) {
  return headingsOf(root).some((heading) => heading.depth === 1);
}
