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
import {normalizeTree, collectCodeTexts} from './blocks/tree.mjs';
import {Emitter} from './blocks/emit.mjs';
import {ConversionError} from './errors.mjs';

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
 * @param {{file: string, lineOffset?: number, stats?: BlockStats, fixupLines?: Set<number>}} ctx
 *   `file` is the docs-relative path used in errors; `lineOffset` is the number of lines before the
 *   body (front matter); `stats`, when given, receives author-intent counters; `fixupLines` are the
 *   1-based file lines a fixup produced (code there may deliberately differ from Python-Markdown).
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
    fixupLines: ctx.fixupLines ?? new Set(),
  };
  const source = normalizeLines(body);
  const stash = new Stash();
  let lines = extractSnippets(source, stash, context);
  lines = extractFences(lines, stash, context);
  lines = extractHtmlBlocks(lines, stash, context);
  lines = extractReferences(lines, context);
  const refComments = new Map(lines.filter((line) => line.refComment !== undefined).map((line) => [line.no, line.refComment]));
  const nestedBefore = context.stats.nestedList;
  const tree = new BlockParser(context).parseDocument(lines);
  normalizeTree(tree, context);
  if (context.stats.nestedList > nestedBefore) {
    assertCodeUnchangedByNesting(tree, lines, context);
  }
  const emitter = new Emitter({source, refComments, forceBlankBefore: context.forceBlankBefore, ctx: context});
  const text = emitter.emitDocument(tree);
  return {text, imports: emitter.imports};
}

/**
 * Find the code block (from `collectCodeTexts`) that covers a source line.
 *
 * @param {Map<number, {text: string, lines: number[]}>} codes Code blocks.
 * @param {number} no 0-based source line.
 * @returns {{text: string, lines: number[]}|undefined} The block, if any.
 */
function codeAt(codes, no) {
  return codes.get(no) ?? [...codes.values()].find((code) => code.lines.includes(no));
}

/**
 * The nested-list author-intent rule moves items one level deeper than Python-Markdown does,
 * which shifts the indentation (or the fence/indented-code reading) of code detabbed through them.
 * Re-parse with the rule off (pure Python-Markdown) and require identical code text, unless a
 * fixup produced those lines to compensate.
 *
 * @param {{children: object[]}} tree Converted tree (normalised).
 * @param {Array<object>} lines Preprocessed lines.
 * @param {{file: string, lineOffset: number, fixupLines: Set<number>}} context Conversion context.
 * @throws {ConversionError} At the first code block whose text the rule changes.
 */
function assertCodeUnchangedByNesting(tree, lines, context) {
  const pureContext = {...context, nestedListRule: false, stats: {nestedList: 0, listNotParagraph: 0}, forceBlankBefore: new Set()};
  const pureCodes = collectCodeTexts(new BlockParser(pureContext).parseDocument(lines));
  const codes = collectCodeTexts(tree);
  const starts = [...new Set([...codes.keys(), ...pureCodes.keys()])].sort((a, b) => a - b);
  for (const no of starts) {
    const converted = codeAt(codes, no);
    const python = codeAt(pureCodes, no);
    if (converted !== undefined && python !== undefined && converted.text === python.text) {
      continue;
    }
    const span = (converted ?? python).lines;
    if (!span.some((line) => context.fixupLines.has(line + context.lineOffset + 1))) {
      throw new ConversionError(
        context.file,
        no + context.lineOffset + 1,
        'the nested-list rule changes this code block\'s text compared with MkDocs; compensate its indentation with a fixup',
      );
    }
  }
}
