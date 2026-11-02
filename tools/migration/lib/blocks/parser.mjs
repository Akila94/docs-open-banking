/**
 * Port of Python-Markdown 3.2.2's `BlockParser` and block processors (with the admonition,
 * pymdownx.details, tables and superfences code-block processors) over `Line` arrays.
 *
 * Instead of etree `text`/`tail`, text always lives in explicit `para` nodes; `tight` marks text
 * that Python-Markdown keeps outside `<p>` (tight list items). Two author-intent deviations are
 * implemented here and counted in `ctx.stats`:
 *   - `nestedList` (lists.mjs): items indented to the previous item's content column nest
 *     (Python-Markdown flattens 2–3-space items into siblings);
 *   - `listNotParagraph`: list lines inside a paragraph that CommonMark would treat as a list
 *     start a real list.
 * Lines the converter itself emits (`:::`, `<Tabs>`, …) are recognised so a second run is a no-op.
 */
import {ConversionError} from '../errors.mjs';
import {INDENT, splitBlocks, detab, withText, indentOf} from './lines.mjs';
import {matchAdmonition, matchDetails, resolveAdmonitionType} from './admonitions.mjs';
import {isTableBlock} from './tables.mjs';
import {lastChild} from './tree.mjs';
import {listProcessorMethods} from './lists.mjs';

/** Lines produced by this converter; never present in MkDocs sources. */
const MDX_LINE = new RegExp(
  [
    '^ {0,3}:{3,}[a-z]*(?:\\[.*\\])? *$',
    '^ {0,3}</?Tabs> *$',
    '^ {0,3}<TabItem value=.* label=.*> *$',
    '^ {0,3}</TabItem> *$',
    '^ {0,3}<details className="ob-details[^"]*"(?: open)?> *$',
    '^ {0,3}<summary>.*</summary> *$',
    '^ {0,3}</details> *$',
    '^ {0,3}<DeprecatedBanner /> *$',
  ].join('|'),
);
const BULLET_IN_PARAGRAPH = /^ *[*+-][ ]+\S/;
const ORDERED_IN_PARAGRAPH = /^ *(\d+)\.[ ]+\S/;
const HASH_HEADER = /^(#{1,6})(.*?)#*$/;
const SETEXT_UNDERLINE = /^[=-]+[ ]*$/;
const HR = /^[ ]{0,3}((-+[ ]{0,2}){3,}|(_+[ ]{0,2}){3,}|(\*+[ ]{0,2}){3,})[ ]*/;
const BLOCKQUOTE = /^[ ]{0,3}>[ ]?(.*)/;
const DEFINITION = /^[ ]{0,3}:[ ]{1,3}(.*?)$/;
const FENCE_PLACEHOLDER = /^([> ]*)\u0002wzxhzdk:\d+\u0003$/;

/**
 * Python `str.rstrip()` on joined block text.
 *
 * @param {string} text Text.
 * @returns {string} Text without trailing whitespace.
 */
function rstrip(text) {
  return text.replace(/\s+$/u, '');
}

/**
 * Python-Markdown block parser emulation producing the converter's tree.
 */
export class BlockParser {
  /**
   * @param {{file: string, lineOffset: number, stats: object}} ctx Conversion context.
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.state = [];
    this.processors = [
      this.mdxLine, this.admonition, this.details, this.empty, this.listIndent, this.code, this.table,
      this.hashHeader, this.setextHeader, this.hr, this.orderedList, this.unorderedList, this.definitionList,
      this.blockquote, this.paragraph,
    ].map((processor) => processor.call(this));
  }

  /**
   * Raise a ConversionError for a source line.
   *
   * @param {{no: number}} line Offending line.
   * @param {string} message Explanation.
   * @throws {ConversionError} Always.
   */
  fail(line, message) {
    throw new ConversionError(this.ctx.file, line.no + this.ctx.lineOffset + 1, message);
  }

  /**
   * Count an author-intent deviation from Python-Markdown and remember where it happened.
   *
   * @param {'nestedList'|'listNotParagraph'} rule Rule name (matches the verification allowlist).
   * @param {{no: number}} line Source line.
   */
  recordIntent(rule, line) {
    this.ctx.stats[rule] += 1;
    this.ctx.stats.sites?.push({rule, file: this.ctx.file, line: line.no + this.ctx.lineOffset + 1});
  }

  /** @param {string} name State name. @returns {boolean} Whether it is the current state. */
  isState(name) {
    return this.state.length > 0 && this.state[this.state.length - 1] === name;
  }

  /**
   * Parse a whole document.
   *
   * @param {Array<object>} lines Preprocessed lines.
   * @returns {{type: 'root', children: object[]}} Tree.
   */
  parseDocument(lines) {
    const root = {type: 'root', children: []};
    this.parseChunk(root, lines);
    return root;
  }

  /** @param {object} parent Container. @param {Array<object>} lines Lines to split into blocks. */
  parseChunk(parent, lines) {
    this.parseBlocks(parent, splitBlocks(lines));
  }

  /**
   * `BlockParser.parseBlocks`: run the first processor whose test passes on each block.
   *
   * @param {object} parent Container node.
   * @param {Array<Array<object>>} blocks Pending blocks (consumed).
   */
  parseBlocks(parent, blocks) {
    while (blocks.length > 0) {
      for (const processor of this.processors) {
        if (processor.test(parent, blocks[0]) && processor.run(parent, blocks) !== false) {
          break;
        }
      }
    }
  }

  /** Converter-emitted MDX lines become verbatim `mdx` leaves (idempotency only). */
  mdxLine() {
    const find = (block) => block.findIndex((line) => MDX_LINE.test(line.text));
    return {
      test: (_parent, block) => find(block) !== -1,
      run: (parent, blocks) => {
        const block = blocks.shift();
        const index = find(block);
        if (index > 0) {
          this.parseBlocks(parent, [block.slice(0, index)]);
        }
        parent.children.push({type: 'mdx', line: block[index]});
        if (index + 1 < block.length) {
          blocks.unshift(block.slice(index + 1));
        }
      },
    };
  }

  /**
   * Shared run logic for `!!!` admonitions and `???` details.
   *
   * @param {'admonition'|'details'} variant Which marker family.
   * @param {(text: string) => object|null} matcher Marker line matcher.
   * @param {(sibling: object|null) => boolean} continues Whether an indented block continues the sibling.
   * @returns {{test: Function, run: Function}} Processor.
   */
  containerProcessor(variant, matcher, continues) {
    const find = (block) => block.findIndex((line) => matcher(line.text) !== null);
    return {
      test: (parent, block) => find(block) !== -1 || (block[0].text.startsWith(INDENT) && continues(lastChild(parent))),
      run: (parent, blocks) => {
        const sibling = lastChild(parent);
        let block = blocks.shift();
        const index = find(block);
        let container;
        if (index !== -1) {
          if (index > 0) {
            this.fail(block[0], `Python-Markdown drops this text because an admonition marker follows in the same block (line ${
              block[index].no + this.ctx.lineOffset + 1}); separate them with a fixup`);
          }
          const markerLine = block[index];
          container = this.createContainer(variant, matcher(markerLine.text), markerLine);
          parent.children.push(container);
          block = block.slice(index + 1);
        } else {
          if (sibling.type === 'admtitle') {
            this.fail(block[0], 'Python-Markdown nests this indented block into the admonition title; re-indent it with a fixup');
          }
          container = sibling;
        }
        const [body, rest] = detab(block);
        this.parseChunk(container, body);
        if (rest.length > 0) {
          blocks.unshift(rest);
        }
      },
    };
  }

  /**
   * Create an admonition/details node with the child Python-Markdown puts first (title/summary).
   *
   * @param {'admonition'|'details'} variant Marker family.
   * @param {object} marker Matcher result.
   * @param {object} markerLine Marker line.
   * @returns {object} Container node.
   */
  createContainer(variant, marker, markerLine) {
    const resolved = resolveAdmonitionType(marker, variant === 'details');
    if (resolved.error) {
      this.fail(markerLine, resolved.error);
    }
    const node = {
      type: 'admonition',
      variant,
      kind: resolved.type,
      label: resolved.label,
      open: Boolean(marker.open),
      markerLine,
      children: [],
    };
    if (variant === 'details') {
      node.children.push({type: 'summary'});
    } else if (marker.title !== null) {
      node.children.push({type: 'admtitle'});
    }
    return node;
  }

  /** `AdmonitionProcessor` (priority 105). */
  admonition() {
    return this.containerProcessor('admonition', matchAdmonition, (sibling) =>
      sibling !== null && ((sibling.type === 'admonition' && sibling.variant === 'admonition') || sibling.type === 'admtitle'));
  }

  /** pymdownx `DetailsProcessor` (priority 105). */
  details() {
    return this.containerProcessor('details', matchDetails, (sibling) =>
      sibling !== null && sibling.type === 'admonition' && sibling.variant === 'details');
  }

  /** `EmptyBlockProcessor` (priority 100): blank lines, padding preceding indented code. */
  empty() {
    return {
      test: (_parent, block) => block[0].text === '' ,
      run: (parent, blocks) => {
        const block = blocks.shift();
        const filler = block.length > 1 ? '\n' : '\n\n';
        if (block.length > 1) {
          blocks.unshift(block.slice(1));
        }
        const sibling = lastChild(parent);
        if (sibling !== null && sibling.type === 'code') {
          sibling.text += filler;
        }
      },
    };
  }

  /** pymdownx `SuperFencesCodeBlockProcessor` (priority 80): indented code, reverting greedy fences. */
  code() {
    return {
      test: () => true,
      run: (parent, blocks) => {
        if (!blocks[0][0].text.startsWith(INDENT)) {
          return false;
        }
        const block = this.revertFences(blocks.shift());
        const sibling = lastChild(parent);
        const [body, rest] = detab(block);
        const text = rstrip(body.map((line) => line.text).join('\n'));
        if (sibling !== null && sibling.type === 'code') {
          sibling.text = `${sibling.text}\n${text}\n`;
          sibling.lines.push(...body);
        } else {
          parent.children.push({type: 'code', text: `${text}\n`, lines: body});
        }
        if (rest.length > 0) {
          blocks.unshift(rest);
        }
        return true;
      },
    };
  }

  /**
   * `revert_greedy_fences`: fences inside indented code are literal text again.
   *
   * @param {Array<object>} block Block lines.
   * @returns {Array<object>} Lines with fence placeholders expanded to their source lines.
   */
  revertFences(block) {
    return block.flatMap((line) => {
      const match = FENCE_PLACEHOLDER.exec(line.text);
      if (!match || line.ref?.kind !== 'fence') {
        return [line];
      }
      const cut = line.ref.wsVirtualLen - match[1].length;
      return line.ref.rawLines.map((raw) => withText(raw, raw.text.slice(cut)));
    });
  }

  /** `TableProcessor` (priority 75). */
  table() {
    return {
      test: (_parent, block) => isTableBlock(block),
      run: (parent, blocks) => {
        parent.children.push({type: 'table', lines: blocks.shift()});
      },
    };
  }

  /** `HashHeaderProcessor` (priority 70): a `#` line anywhere in the block. */
  hashHeader() {
    const find = (block) => block.findIndex((line) => line.text.startsWith('#'));
    return {
      test: (_parent, block) => find(block) !== -1,
      run: (parent, blocks) => {
        const block = blocks.shift();
        const index = find(block);
        const line = block[index];
        if (/(^|[^\\])(\\\\)*\\$/.test(line.text)) {
          this.fail(line, 'heading ending with a backslash continues onto the next line in Python-Markdown');
        }
        if (index > 0) {
          this.parseBlocks(parent, [block.slice(0, index)]);
        }
        const match = HASH_HEADER.exec(line.text);
        parent.children.push({type: 'heading', line, level: match[1].length, text: match[2].trim()});
        if (index + 1 < block.length) {
          blocks.unshift(block.slice(index + 1));
        }
      },
    };
  }

  /** `SetextHeaderProcessor` (priority 60). */
  setextHeader() {
    return {
      test: (_parent, block) => block.length >= 2 && SETEXT_UNDERLINE.test(block[1].text),
      run: (parent, blocks) => {
        const block = blocks.shift();
        parent.children.push({type: 'setext', lines: block.slice(0, 2)});
        if (block.length > 2) {
          blocks.unshift(block.slice(2));
        }
      },
    };
  }

  /** `HRProcessor` (priority 50): only the first candidate line is considered, as in Python. */
  hr() {
    const find = (block) => {
      const index = block.findIndex((line) => HR.test(line.text));
      return index !== -1 && HR.exec(block[index].text)[0].length === block[index].text.length ? index : -1;
    };
    return {
      test: (_parent, block) => find(block) !== -1,
      run: (parent, blocks) => {
        const block = blocks.shift();
        const index = find(block);
        if (index > 0) {
          this.parseBlocks(parent, [block.slice(0, index)]);
        }
        parent.children.push({type: 'hr', line: block[index]});
        if (index + 1 < block.length) {
          blocks.unshift(block.slice(index + 1));
        }
      },
    };
  }

  /** def_list `DefListProcessor` (priority 25): not used by the corpus, so unsupported. */
  definitionList() {
    return {
      test: (_parent, block) => block.some((line) => DEFINITION.test(line.text)),
      run: (_parent, blocks) => {
        this.fail(blocks[0].find((line) => DEFINITION.test(line.text)), 'definition lists are not supported');
      },
    };
  }

  /** `BlockQuoteProcessor` (priority 20); the quote is kept as a verbatim leaf. */
  blockquote() {
    const find = (block) => block.findIndex((line) => BLOCKQUOTE.test(line.text));
    return {
      test: (_parent, block) => find(block) !== -1,
      run: (parent, blocks) => {
        const block = blocks.shift();
        const index = find(block);
        if (index > 0) {
          this.parseBlocks(parent, [block.slice(0, index)]);
        }
        parent.children.push({type: 'blockquote', lines: block.slice(index)});
      },
    };
  }

  /**
   * Whether a paragraph line would start a list in CommonMark (where Python-Markdown keeps it as
   * paragraph text): any bullet, an ordered item after a fence, or an ordered item numbered 1,
   * at any indentation (the emitter left-trims paragraph lines).
   *
   * @param {{text: string}} line Candidate line.
   * @param {{ref?: object}} previous Preceding line of the paragraph.
   * @returns {boolean} True when the author meant a list here.
   */
  startsListInCommonMark(line, previous) {
    if (BULLET_IN_PARAGRAPH.test(line.text)) {
      return true;
    }
    const ordered = ORDERED_IN_PARAGRAPH.exec(line.text);
    return ordered !== null && (previous.ref?.kind === 'fence' || ordered[1] === '1');
  }

  /** `ParagraphProcessor` (priority 10), with the list-not-paragraph author-intent split. */
  paragraph() {
    return {
      test: () => true,
      run: (parent, blocks) => {
        let block = blocks.shift();
        const split = block.findIndex((line, index) => index > 0 && this.startsListInCommonMark(line, block[index - 1]));
        if (split > 0) {
          this.recordIntent('listNotParagraph', block[split]);
          this.ctx.forceBlankBefore.add(block[split].no);
          const cut = indentOf(block[split].text);
          blocks.unshift(block.slice(split).map((line) => withText(line, line.text.slice(Math.min(cut, indentOf(line.text))))));
          block = block.slice(0, split);
        }
        if (block.every((line) => line.text.trim() === '')) {
          return;
        }
        const sibling = lastChild(parent);
        if (this.isState('list') && sibling !== null && sibling.type === 'para' && sibling.tight) {
          sibling.lines.push(...block);
        } else {
          parent.children.push({type: 'para', lines: [...block], tight: this.isState('list')});
        }
      },
    };
  }
}

// List processors (`ListIndentProcessor`, `OListProcessor`, `UListProcessor`) live in lists.mjs.
Object.assign(BlockParser.prototype, listProcessorMethods);
