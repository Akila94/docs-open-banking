/**
 * Emit the parsed tree as CommonMark + MDX (directives, JSX `<Tabs>`/`<details>`, `{/* *\/}`).
 *
 * Layout rules:
 *   - list children are indented 4 spaces per level: a valid CommonMark child column for markers
 *     up to `10. ` and the unit Python-Markdown itself uses, so a second run reads the same tree;
 *   - paragraph, table and heading lines are re-prefixed but otherwise kept byte-for-byte;
 *   - blank lines between blocks follow the source, plus the minimum CommonMark/MDX needs.
 * Every non-blank source line must be emitted; anything else fails the run (no silent drops).
 */
import {ConversionError} from '../errors.mjs';
import {INDENT} from './lines.mjs';
import {isSafeDirectiveLabel} from './admonitions.mjs';
import {tabValues, tabLabel, jsxAttributeValue} from './tabs.mjs';
import {escapeCodePipes} from './tables.mjs';

/** Nodes that need a blank line on both sides. */
const BLOCKISH = new Set(['admonition', 'tabs', 'html', 'comment', 'mdxcomment', 'snippet']);
/** Prose that would change meaning, or show leftover MkDocs syntax, in CommonMark/MDX. */
const PROSE_CHECKS = [
  [/^(?:`{3,}[^`]*|~{3,}.*)$/, 'a fence opener that Python-Markdown treats as text (unclosed or aborted fence); fix it with a fixup'],
  [/^(?:!!!|\?\?\?)/, 'an admonition marker that Python-Markdown renders as literal text; fix it with a fixup'],
  [/\btab=["']/, 'a legacy `tab=` fence option outside a fence; fix it with a fixup'],
  [/--8<--/, 'a `--8<--` snippet marker outside a snippet line'],
  [/<!--/, 'an inline HTML comment in Markdown text is not supported'],
];

/** Paragraph continuation text that CommonMark would read as the start of a block. */
const BLOCK_START = /^(?:#{1,6}(?:\s|$)|>|(?:=+|-+)\s*$|(?:\*\s*){3,}$|(?:-\s*){3,}$|(?:_\s*){3,}$)/;

/**
 * Children that are emitted (the title/summary placeholders only exist for parsing).
 *
 * @param {{children?: object[]}} node Container.
 * @returns {object[]} Real children.
 */
function realChildren(node) {
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
function endsWithBlock(item) {
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
function directiveDepth(node) {
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
function fenceLength(char, minimum, lines) {
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

/**
 * Tree -> MDX text emitter.
 */
export class Emitter {
  /**
   * @param {object} options Emitter inputs.
   * @param {Array<{text: string}>} options.source Normalised source lines (for gaps and raw blocks).
   * @param {Map<number, string>} options.refComments Source line -> `[comment]: <> (…)` text.
   * @param {Set<number>} options.forceBlankBefore Source lines that must follow a blank line.
   * @param {{file: string, lineOffset: number}} options.ctx Conversion context.
   */
  constructor({source, refComments, forceBlankBefore, ctx}) {
    this.source = source;
    this.refComments = refComments;
    this.forceBlankBefore = forceBlankBefore;
    this.ctx = ctx;
    this.out = [];
    this.consumed = new Set();
    /** @type {Set<'Tabs'|'DeprecatedBanner'>} */
    this.imports = new Set();
  }

  /**
   * @param {{no: number}} line Offending line.
   * @param {string} message Explanation.
   * @throws {ConversionError} Always.
   */
  fail(line, message) {
    throw new ConversionError(this.ctx.file, line.no + this.ctx.lineOffset + 1, message);
  }

  /** @param {number} from First line index. @param {number} [to=from] Last line index. */
  consume(from, to = from) {
    for (let index = from; index <= to; index += 1) {
      this.consumed.add(index);
    }
  }

  /**
   * Emit the whole document.
   *
   * @param {{children: object[]}} root Tree root.
   * @returns {string} MDX text ending with a newline (empty for an empty document).
   */
  emitDocument(root) {
    const children = root.children;
    if (children.length > 0) {
      this.emitGap(-1, firstNo(children[0]), 0, '');
      this.emitChildren(children, '', '');
      this.emitGap(lastNo(children[children.length - 1]), this.source.length, 0, '');
    } else {
      this.emitGap(-1, this.source.length, 0, '');
    }
    this.assertCoverage();
    while (this.out.length > 0 && this.out[this.out.length - 1] === '') {
      this.out.pop();
    }
    return this.out.length > 0 ? `${this.out.join('\n')}\n` : '';
  }

  /** Fail when a non-blank source line was not emitted (Python-Markdown dropped it). */
  assertCoverage() {
    this.source.forEach((line, index) => {
      if (line.text !== '' && !this.consumed.has(index)) {
        this.fail({no: index}, 'this line would be lost in conversion; fix the source with a fixup');
      }
    });
  }

  /**
   * Emit blank lines (and `[comment]` comments) between two siblings.
   *
   * @param {number} fromNo Last line index of the previous node (-1 at the start).
   * @param {number} toNo First line index of the next node.
   * @param {number} required Minimum number of blank lines.
   * @param {string} prefix Container prefix.
   */
  emitGap(fromNo, toNo, required, prefix) {
    let blanks = 0;
    const comments = [];
    for (let index = fromNo + 1; index < toNo; index += 1) {
      if (this.refComments.has(index)) {
        comments.push(index);
      } else if (this.source[index].text === '') {
        blanks += 1;
      }
    }
    if (comments.length > 0) {
      for (const index of comments) {
        if (this.out.length > 0) {
          this.out.push('');
        }
        this.out.push(prefix + this.mdxComment(this.refComments.get(index), {no: index}));
        this.consume(index);
      }
      this.out.push('');
      return;
    }
    for (let count = 0; count < Math.max(blanks, required); count += 1) {
      this.out.push('');
    }
  }

  /**
   * Minimum blank lines between two siblings so CommonMark/MDX keeps them apart.
   *
   * @param {object} previous Previous sibling.
   * @param {object} current Next sibling.
   * @returns {number} 0 or 1.
   */
  requiredBlank(previous, current) {
    if (previous.type === 'mdx' || current.type === 'mdx') {
      return 0;
    }
    if (this.forceBlankBefore.has(firstNo(current)) || BLOCKISH.has(previous.type) || BLOCKISH.has(current.type)) {
      return 1;
    }
    if (['list', 'blockquote', 'table'].includes(previous.type)) {
      return 1;
    }
    if (previous.type === 'para') {
      if (['para', 'hr', 'setext', 'table', 'blockquote'].includes(current.type)) {
        return 1;
      }
      if (current.type === 'list' && current.ordered && Number.parseInt(current.children[0].marker, 10) !== 1) {
        return 1;
      }
    }
    return 0;
  }

  /**
   * Emit siblings with the gaps between them.
   *
   * @param {object[]} children Real children.
   * @param {string} prefix Prefix for every line.
   * @param {string} firstPrefix Prefix for the very first line (a list marker).
   */
  emitChildren(children, prefix, firstPrefix) {
    children.forEach((child, index) => {
      if (index > 0) {
        const previous = children[index - 1];
        this.emitGap(lastNo(previous), firstNo(child), this.requiredBlank(previous, child), prefix);
      }
      this.emitNode(child, prefix, index === 0 ? firstPrefix : prefix);
    });
  }

  /**
   * Reject prose that CommonMark/MDX would read differently from Python-Markdown.
   *
   * @param {{no: number, text: string}} line Source line.
   * @param {string} text Text to check.
   */
  checkProse(line, text) {
    const trimmed = text.trim();
    for (const [pattern, message] of PROSE_CHECKS) {
      if (pattern.test(trimmed)) {
        this.fail(line, message);
      }
    }
  }

  /**
   * Emit one node.
   *
   * @param {object} node Tree node.
   * @param {string} prefix Prefix for continuation lines.
   * @param {string} firstPrefix Prefix for the first line.
   */
  emitNode(node, prefix, firstPrefix) {
    switch (node.type) {
      case 'para':
        this.emitParagraph(node, prefix, firstPrefix);
        break;
      case 'heading':
        this.checkProse(node.line, node.text);
        this.out.push(`${firstPrefix}${'#'.repeat(node.level)}${node.text ? ` ${node.text}` : ''}`);
        this.consume(node.line.no);
        break;
      case 'setext':
      case 'hr':
      case 'blockquote':
      case 'table':
        this.emitVerbatimLines(node, prefix, firstPrefix);
        break;
      case 'code':
        this.emitCode(node, prefix, firstPrefix);
        break;
      case 'fence':
        this.emitFence(node.ref, prefix, firstPrefix);
        this.consume(node.line.no, node.line.end);
        break;
      case 'tabs':
        this.emitTabs(node, prefix, firstPrefix);
        break;
      case 'admonition':
        this.emitAdmonition(node, prefix, firstPrefix);
        break;
      case 'list':
        this.emitList(node, prefix, firstPrefix);
        break;
      case 'mdx':
        this.out.push(firstPrefix + node.line.text.trim());
        this.consume(node.line.no);
        break;
      case 'snippet':
        this.out.push(`${firstPrefix}<DeprecatedBanner />`);
        this.imports.add('DeprecatedBanner');
        this.consume(node.line.no);
        break;
      case 'html':
      case 'mdxcomment':
      case 'comment':
        this.emitRaw(node, prefix);
        break;
      default:
        this.fail(firstNo(node) === undefined ? {no: 0} : {no: firstNo(node)}, `unexpected block ${node.type}`);
    }
  }

  /**
   * Paragraph: re-prefixed lines; fence placeholders inside it are emitted as fences.
   *
   * @param {object} node Paragraph.
   * @param {string} prefix Continuation prefix.
   * @param {string} firstPrefix First-line prefix.
   */
  emitParagraph(node, prefix, firstPrefix) {
    node.lines.forEach((line, index) => {
      const linePrefix = index === 0 ? firstPrefix : prefix;
      if (line.ref?.kind === 'fence') {
        this.emitFence(line.ref, prefix, linePrefix);
      } else {
        const text = line.text.trimStart();
        this.checkProse(line, text);
        this.out.push(linePrefix + this.continuationIndent(node.lines[index - 1], text, line) + text);
      }
      this.consume(line.no, line.end);
    });
  }

  /**
   * Extra indentation that keeps a paragraph continuation line from starting a CommonMark block
   * (Python-Markdown keeps `  # x`, `===`, `> x` after the first line as paragraph text).
   *
   * @param {{ref?: object}|undefined} previous Preceding paragraph line (undefined for the first line).
   * @param {string} text Left-trimmed line text.
   * @param {{no: number}} line Source line (for errors).
   * @returns {string} '' or four spaces.
   * @throws {ConversionError} When the line follows a fence, where no indentation can protect it.
   */
  continuationIndent(previous, text, line) {
    if (previous === undefined || !BLOCK_START.test(text)) {
      return '';
    }
    if (previous.ref?.kind === 'fence') {
      this.fail(line, 'paragraph text after a fence would start a new block in CommonMark; fix it with a fixup');
    }
    return INDENT;
  }

  /**
   * Setext headings, rules, blockquotes and tables: lines kept, only the indentation changes.
   *
   * @param {object} node Node with `lines` or `line`.
   * @param {string} prefix Continuation prefix.
   * @param {string} firstPrefix First-line prefix.
   */
  emitVerbatimLines(node, prefix, firstPrefix) {
    const lines = node.lines ?? [node.line];
    lines.forEach((line, index) => {
      if (line.ref !== undefined) {
        this.fail(line, `a fenced block inside a ${node.type} is not supported; separate it with a fixup`);
      }
      this.checkProse(line, line.text);
      const text = node.type === 'table' ? escapeCodePipes(line.text.trim()) : line.text.trim();
      this.out.push((index === 0 ? firstPrefix : prefix) + text);
      this.consume(line.no, line.end);
    });
  }

  /**
   * Indented code -> fenced code with the exact text Python-Markdown renders.
   *
   * @param {object} node Code node.
   * @param {string} prefix Continuation prefix.
   * @param {string} firstPrefix First-line prefix.
   */
  emitCode(node, prefix, firstPrefix) {
    const lines = node.text.replace(/\n+$/, '').split('\n');
    const fence = '`'.repeat(fenceLength('`', 3, lines));
    this.out.push(firstPrefix + fence);
    for (const line of lines) {
      this.out.push(line === '' ? '' : prefix + line);
    }
    this.out.push(prefix + fence);
    for (const line of node.lines) {
      this.consume(line.no, line.end);
    }
  }

  /**
   * A superfences block: content dedented by its own indentation, re-indented to the container.
   *
   * @param {object} fence Stashed fence.
   * @param {string} prefix Continuation prefix.
   * @param {string} firstPrefix First-line prefix.
   */
  emitFence(fence, prefix, firstPrefix) {
    const char = fence.fence[0];
    const marker = char.repeat(fenceLength(char, fence.fence.length, fence.codeLines));
    this.out.push(firstPrefix + marker + fence.lang);
    for (const line of fence.codeLines) {
      this.out.push(line === '' ? '' : prefix + line);
    }
    this.out.push(prefix + marker);
  }

  /**
   * A tab group -> `<Tabs>` with one `<TabItem>` per fence.
   *
   * @param {object} node Tabs node.
   * @param {string} prefix Continuation prefix.
   * @param {string} firstPrefix First-line prefix.
   */
  emitTabs(node, prefix, firstPrefix) {
    const labels = node.fences.map((fence, index) => tabLabel(fence.ref, index));
    const values = tabValues(labels);
    this.out.push(`${firstPrefix}<Tabs>`);
    node.fences.forEach((fence, index) => {
      this.out.push(`${prefix}<TabItem value="${values[index]}" label=${jsxAttributeValue(labels[index])}>`, '');
      this.emitFence(fence.ref, prefix, prefix);
      this.out.push('', `${prefix}</TabItem>`);
      this.consume(fence.line.no, fence.line.end);
    });
    this.out.push(`${prefix}</Tabs>`);
    this.imports.add('Tabs');
  }

  /**
   * `!!!` -> `:::type[label]` directive; `???` -> `<details className=…>` JSX.
   *
   * @param {object} node Admonition node.
   * @param {string} prefix Continuation prefix.
   * @param {string} firstPrefix First-line prefix.
   */
  emitAdmonition(node, prefix, firstPrefix) {
    const children = realChildren(node);
    this.consume(node.markerLine.no);
    if (node.variant === 'details') {
      this.out.push(`${firstPrefix}<details className="ob-details ob-details--${node.kind}"${node.open ? ' open' : ''}>`);
      this.out.push(`${prefix}<summary>${node.label}</summary>`, '');
      this.emitChildren(children, prefix, prefix);
      if (children.length > 0) {
        this.out.push('');
      }
      this.out.push(`${prefix}</details>`);
      return;
    }
    if (node.label !== null && !isSafeDirectiveLabel(node.label)) {
      this.fail(node.markerLine, 'admonition title has unbalanced brackets');
    }
    const colons = ':'.repeat(3 + directiveDepth(node));
    this.out.push(`${firstPrefix}${colons}${node.kind}${node.label === null ? '' : `[${node.label}]`}`);
    if (children.length > 0) {
      this.emitGap(node.markerLine.no, firstNo(children[0]), 0, prefix);
      this.emitChildren(children, prefix, prefix);
    }
    this.out.push(prefix + colons);
  }

  /**
   * A list: source markers (numbers kept; one bullet character per list), children 4 spaces deeper.
   *
   * @param {object} node List node.
   * @param {string} prefix Continuation prefix.
   * @param {string} firstPrefix First-line prefix.
   */
  emitList(node, prefix, firstPrefix) {
    const bullet = node.children[0].marker;
    node.children.forEach((item, index) => {
      const marker = node.ordered ? item.marker : bullet;
      const itemPrefix = index === 0 ? firstPrefix : prefix;
      if (index > 0) {
        const previous = node.children[index - 1];
        this.emitGap(lastNo(previous), firstNo(item), endsWithBlock(previous) ? 1 : 0, prefix);
      }
      this.consume(item.markerLine.no);
      const children = realChildren(item);
      if (children.length === 0) {
        this.out.push(itemPrefix + marker);
        return;
      }
      if (marker.length + 1 > INDENT.length && children.length > 1) {
        // Children sit 4 spaces deeper; a marker such as `100.` has a wider content column.
        this.fail(item.markerLine, `list marker ${marker} is too wide for 4-space child indentation`);
      }
      if (['admonition', 'tabs', 'list', 'html', 'comment', 'mdxcomment', 'snippet'].includes(children[0].type)) {
        this.fail(item.markerLine, `a list item starting with a ${children[0].type} is not supported`);
      }
      this.emitChildren(children, prefix + INDENT, `${itemPrefix}${marker} `);
    });
  }

  /**
   * Raw HTML (verbatim, converted later by the HTML pass) and comments (`{/* … *\/}`).
   *
   * @param {object} node Raw node.
   * @param {string} prefix Container prefix (must be empty: raw blocks are top-level only).
   */
  emitRaw(node, prefix) {
    const {no, end} = node.line;
    if (prefix !== '') {
      this.fail(node.line, 'raw HTML block inside a container');
    }
    const lines = this.source.slice(no, end + 1).map((line) => line.text);
    if (node.type === 'comment') {
      this.out.push(...this.mdxComment(lines.join('\n'), node.line, true).split('\n'));
    } else {
      this.out.push(...lines);
    }
    this.consume(no, end);
  }

  /**
   * Build an MDX comment. `*\/` inside is escaped; braces must balance for MDX's expression scanner.
   *
   * @param {string} text Comment source (`<!-- … -->` when `isHtml`, otherwise any text).
   * @param {{no: number}} line Source line for errors.
   * @param {boolean} [isHtml=false] Whether `text` is an HTML comment to unwrap.
   * @returns {string} `{/* … *\/}`.
   */
  mdxComment(text, line, isHtml = false) {
    let inner = text;
    if (isHtml) {
      const trimmed = text.trimEnd();
      if (!trimmed.startsWith('<!--') || !trimmed.endsWith('-->')) {
        this.fail(line, 'HTML comment block does not end with `-->`');
      }
      inner = trimmed.slice(4, -3);
    } else {
      inner = ` ${text} `;
    }
    const escaped = inner.replaceAll('*/', '*\\/');
    const opens = (escaped.match(/\{/g) ?? []).length;
    const closes = (escaped.match(/\}/g) ?? []).length;
    if (opens !== closes) {
      this.fail(line, 'comment text has unbalanced braces, which MDX cannot parse');
    }
    return `{/*${escaped}*/}`;
  }
}
