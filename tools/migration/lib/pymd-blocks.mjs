/**
 * Block passes (spec §3 passes 2–8): Python-Markdown / pymdownx block syntax -> CommonMark + MDX.
 *
 * The work is split by construct under `lib/blocks/`:
 *   preprocess.mjs  snippets, superfences fences, raw HTML blocks, reference definitions
 *   parser.mjs      Python-Markdown block parser emulation (lists, admonitions, code, headings…)
 *   tree.mjs        placeholder unwrapping and tab grouping
 *   emit.mjs        MDX output (directives, <Tabs>, <details>, fences, comments)
 */
import {Stash, normalizeLines, extractSnippets, extractFences, extractHtmlBlocks, extractReferences} from './blocks/preprocess.mjs';
import {BlockParser} from './blocks/parser.mjs';
import {normalizeTree} from './blocks/tree.mjs';
import {Emitter} from './blocks/emit.mjs';

/**
 * @typedef {object} BlockStats
 * @property {number} nestedList Items nested by the 2–3-space author-intent rule.
 * @property {number} listNotParagraph Bullet runs split out of paragraphs.
 * @property {Array<{rule: string, file: string, line: number}>} [sites] Where each rule applied.
 */

/**
 * Convert the block syntax of one Markdown body.
 *
 * @param {string} body File body (front matter already removed).
 * @param {{file: string, lineOffset?: number, stats?: BlockStats}} ctx `file` is the docs-relative
 *   path used in errors; `lineOffset` is the number of lines before the body (front matter);
 *   `stats`, when given, receives author-intent counters.
 * @returns {{text: string, imports: Set<'Tabs'|'DeprecatedBanner'>}} Converted body and the
 *   components it uses.
 * @throws {import('./errors.mjs').ConversionError} With `file:line` for input that cannot be
 *   classified or would convert lossily.
 */
export function convertBlocks(body, ctx) {
  const context = {
    file: ctx.file,
    lineOffset: ctx.lineOffset ?? 0,
    stats: ctx.stats ?? {nestedList: 0, listNotParagraph: 0},
    forceBlankBefore: new Set(),
  };
  const source = normalizeLines(body);
  const stash = new Stash();
  let lines = extractSnippets(source, stash, context);
  lines = extractFences(lines, stash, context);
  lines = extractHtmlBlocks(lines, stash, context);
  lines = extractReferences(lines, context);
  const refComments = new Map(lines.filter((line) => line.refComment !== undefined).map((line) => [line.no, line.refComment]));
  const tree = new BlockParser(context).parseDocument(lines);
  normalizeTree(tree, context);
  const emitter = new Emitter({source, refComments, forceBlankBefore: context.forceBlankBefore, ctx: context});
  const text = emitter.emitDocument(tree);
  return {text, imports: emitter.imports};
}
