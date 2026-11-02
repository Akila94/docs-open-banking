/**
 * Document-level preprocessors, in Python-Markdown's order:
 * snippets (pymdownx.snippets) -> whitespace normalisation -> fences (pymdownx.superfences 6.3)
 * -> raw HTML blocks (Python-Markdown 3.2.2 `HtmlBlockPreprocessor`) -> reference definitions.
 *
 * Fences, raw HTML blocks, comments and snippets are replaced by single placeholder lines whose
 * `ref` points at a stashed node, exactly as Python-Markdown stashes them, so the block parser
 * sees the same text Python-Markdown sees.
 */
import {ConversionError, excerpt} from '../errors.mjs';
import {makeLine, withText, expandTabs, splitBlocks} from './lines.mjs';

/** The one snippet the corpus uses, and the component that replaces it. */
export const BANNER_SNIPPET = 'deprecated-banner.md';

/** pymdownx.snippets inline marker: `--8<-- "file"`. */
const SNIPPET_INLINE = /^([ \t]*)-{2,}8<-{2,}[ \t]+("(?:\\"|[^"\n\r])+?"|'(?:\\'|[^'\n\r])+?')(?![ \t])$/;
/** pymdownx.snippets block marker (unsupported here). */
const SNIPPET_BLOCK = /^[ \t]*-{2,}8<-{2,}(?![ \t])$/;

/** superfences `RE_NESTED_FENCE_START`, applied after the whitespace prefix. */
const FENCE_START = /^(~{3,}|`{3,})[ \t]*(?:\{?\.?([\p{L}\p{N}_#.+-]*))?[ \t]*((?:\b[a-zA-Z][a-zA-Z0-9_]*=(?:("|').*?\4)?[ \t]*)*)\}?[ \t]*$/u;
/** superfences `RE_OPTIONS`. */
const FENCE_OPTION = /([a-zA-Z][a-zA-Z0-9_]*)=(?:("|')(.*?)\2)?/g;
/** Characters superfences treats as a fence prefix. */
const PREFIX_CHARS = new Set(['>', ' ', '\t']);

/** Python-Markdown 3.2.2 `BLOCK_LEVEL_ELEMENTS`. */
const BLOCK_LEVEL = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'menu', 'nav', 'ol', 'p',
  'pre', 'section', 'table', 'ul', 'canvas', 'dd', 'dt', 'group', 'iframe', 'li', 'math', 'noscript',
  'output', 'progress', 'script', 'style', 'tbody', 'td', 'th', 'thead', 'tr', 'video',
]);
/** `HtmlBlockPreprocessor.left_tag_pattern` (attribute alternatives inlined). */
const LEFT_TAG = /^<([^> ]+)((?:\s+[^>"'/= ]+=(?:"[^"\n]*?"|'[^'\n]*?')|\s+[^>"'/= ]+=[^> ]+|\s+[^>"'/= ]+)*)\s*\/?>?/;
/** The converter's own `<details>` opening line; never treated as raw HTML (idempotency). */
const OWN_DETAILS = /^<details className="ob-details[^"]*"( open)?>$/;

/** Python-Markdown `ReferencePreprocessor.RE` (DOTALL irrelevant per line). */
const REFERENCE_DEF = /^[ ]{0,3}\[([^\]]*)\]:\s*([^ ]*)[ ]*([ ]*("(.*)"|'(.*)'|\((.*)\))[ ]*)?$/;
/** Python-Markdown footnotes `DEF_RE` (unsupported here). */
const FOOTNOTE_DEF = /^[ ]{0,3}\[\^([^\]]*)\]:\s*(.*)$/;

/**
 * Stash of placeholder targets, mirroring Python-Markdown's `htmlStash`.
 */
export class Stash {
  constructor() {
    /** @type {object[]} */
    this.nodes = [];
  }

  /**
   * Store a node and return its placeholder text.
   *
   * @param {object} node Stashed node (`{kind, ...}`).
   * @returns {string} Placeholder text `\u0002wzxhzdk:N\u0003`.
   */
  add(node) {
    this.nodes.push(node);
    return `\u0002wzxhzdk:${this.nodes.length - 1}\u0003`;
  }
}

/**
 * Normalise a body like Python-Markdown's `NormalizeWhitespace`: LF newlines, no STX/ETX,
 * tabs expanded to 4-column stops, whitespace-only lines emptied.
 *
 * @param {string} body File body.
 * @returns {Array<object>} Lines.
 */
export function normalizeLines(body) {
  const text = body.replace(/\r\n?/g, '\n').replace(/[\u0002\u0003]/g, '');
  const rawLines = text.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }
  return rawLines.map((raw, index) => {
    const expanded = expandTabs(raw);
    return makeLine(index, expanded.trim() === '' ? '' : expanded);
  });
}

/**
 * Replace `--8<-- "deprecated-banner.md"` lines with snippet placeholders.
 *
 * @param {Array<object>} lines Normalised lines.
 * @param {Stash} stash Placeholder stash.
 * @param {{file: string, lineOffset: number}} ctx Conversion context.
 * @returns {Array<object>} Lines.
 * @throws {ConversionError} For block snippets, other files, indented or non-standalone markers.
 */
export function extractSnippets(lines, stash, ctx) {
  return lines.map((line, index) => {
    if (SNIPPET_BLOCK.test(line.text)) {
      throw new ConversionError(ctx.file, line.no + ctx.lineOffset + 1, 'block-style `--8<--` snippets are not supported');
    }
    const match = SNIPPET_INLINE.exec(line.text);
    if (!match) {
      return line;
    }
    const name = match[2].slice(1, -1).trim();
    const fail = (message) => {
      throw new ConversionError(ctx.file, line.no + ctx.lineOffset + 1, message);
    };
    if (name !== BANNER_SNIPPET) {
      fail(`unknown snippet ${excerpt(name)}; only "${BANNER_SNIPPET}" is supported`);
    }
    if (match[1] !== '') {
      fail('indented `--8<--` snippets are not supported');
    }
    if (lines[index + 1] !== undefined && lines[index + 1].text !== '') {
      fail('a `--8<--` snippet must be followed by a blank line');
    }
    const node = {kind: 'snippet', name};
    return makeLine(line.no, stash.add(node), node);
  });
}

/**
 * Scanner state of the superfences preprocessor (`SuperFencesBlockPreprocessor`).
 */
class FenceScanner {
  /**
   * @param {Stash} stash Placeholder stash.
   * @param {{file: string, lineOffset: number}} ctx Conversion context.
   */
  constructor(stash, ctx) {
    this.stash = stash;
    this.ctx = ctx;
    this.stack = [];
    this.clear();
  }

  /** Reset the per-fence state (`clear()` in superfences). */
  clear() {
    this.fence = null;
    this.ws = '';
    this.wsLen = 0;
    this.wsVirtualLen = 0;
    this.lang = '';
    this.tab = null;
    this.code = [];
    this.start = -1;
  }

  /**
   * Run `search_nested` over all lines and splice placeholders in (`reassemble`).
   *
   * @param {Array<object>} lines Normalised lines.
   * @returns {Array<object>} Lines with fences replaced by placeholders.
   */
  run(lines) {
    lines.forEach((line, index) => {
      if (this.fence === null) {
        this.tryStart(line, index);
      } else {
        this.continueFence(lines, line, index);
      }
    });
    let result = lines;
    for (const {placeholder, start, end} of this.stack.reverse()) {
      result = [...result.slice(0, start), placeholder, ...result.slice(end)];
    }
    return result;
  }

  /**
   * Check whether `line` opens a fence (`parse_whitespace` + `RE_NESTED_FENCE_START`).
   *
   * @param {object} line Current line.
   * @param {number} index Line index.
   */
  tryStart(line, index) {
    let wsLen = 0;
    while (wsLen < line.text.length && PREFIX_CHARS.has(line.text[wsLen])) {
      wsLen += 1;
    }
    const match = FENCE_START.exec(line.text.slice(wsLen));
    if (!match) {
      return;
    }
    const ws = line.text.slice(0, wsLen);
    if (ws.includes('>')) {
      throw new ConversionError(this.ctx.file, line.no + this.ctx.lineOffset + 1, 'fences inside blockquotes are not supported');
    }
    this.fence = match[1];
    this.ws = ws;
    this.wsLen = wsLen;
    this.wsVirtualLen = ws.length;
    this.lang = match[2] ?? '';
    this.start = index;
    this.code = [];
    if (!this.parseOptions(match[3] ?? '', line)) {
      this.clear();
    }
  }

  /**
   * `parse_options` + `highlight_validator`: only `tab` (removed first), `hl_lines` and `linenums`.
   *
   * @param {string} optionText Options part of the opening line.
   * @param {object} line Opening line (for errors).
   * @returns {boolean} Whether the fence is accepted.
   */
  parseOptions(optionText, line) {
    const options = new Map();
    for (const match of optionText.matchAll(FENCE_OPTION)) {
      options.set(match[1], match[3] === undefined ? true : match[3]);
    }
    this.tab = null;
    if (options.has('tab')) {
      const value = options.get('tab');
      // `tab` marks a tab fence; an empty/valueless tab is labelled with the language, else "Tab N" ('').
      this.tab = typeof value === 'string' && value !== '' ? value : this.lang;
      options.delete('tab');
    }
    for (const key of options.keys()) {
      if (key === 'hl_lines' || key === 'linenums') {
        throw new ConversionError(this.ctx.file, line.no + this.ctx.lineOffset + 1, `fence option ${key} is not supported`);
      }
      return false;
    }
    return true;
  }

  /**
   * Feed one line to an open fence (`parse_fence_line` + `eval_fence`).
   *
   * @param {Array<object>} lines All lines.
   * @param {object} line Current line.
   * @param {number} index Line index.
   */
  continueFence(lines, line, index) {
    let wsLen = 0;
    while (wsLen < this.wsVirtualLen && wsLen < line.text.length && PREFIX_CHARS.has(line.text[wsLen])) {
      wsLen += 1;
    }
    const ws = line.text.slice(0, wsLen);
    const content = line.text.slice(wsLen);
    if (ws.includes('>')) {
      this.clear();
      return;
    }
    if ((ws + content).trim() === '') {
      this.code.push(line);
    } else if (ws.length !== this.wsVirtualLen && content !== '') {
      this.clear();
    } else if (new RegExp(`^${this.fence}[ \\t]*$`).test(content) && !/^[ \t]/.test(content)) {
      this.store(lines, index);
    } else {
      this.code.push(line);
    }
  }

  /**
   * Close the fence: stash it and remember the placeholder splice (`process_nested_block`).
   *
   * @param {Array<object>} lines All lines.
   * @param {number} end Index of the closing line.
   */
  store(lines, end) {
    const rawLines = lines.slice(this.start, end + 1);
    const node = {
      kind: 'fence',
      fence: this.fence,
      lang: this.lang,
      tab: this.tab,
      wsVirtualLen: this.wsVirtualLen,
      rawLines,
      codeLines: this.code.map((line) => line.text.slice(this.wsVirtualLen)),
    };
    const placeholder = makeLine(rawLines[0].no, this.ws + this.stash.add(node), node, rawLines[rawLines.length - 1].no);
    this.stack.push({placeholder, start: this.start, end: end + 1});
    this.clear();
  }
}

/**
 * Replace superfences fenced blocks (any indentation) with placeholders.
 *
 * @param {Array<object>} lines Normalised lines.
 * @param {Stash} stash Placeholder stash.
 * @param {{file: string, lineOffset: number}} ctx Conversion context.
 * @returns {Array<object>} Lines.
 */
export function extractFences(lines, stash, ctx) {
  return new FenceScanner(stash, ctx).run(lines);
}

/**
 * `_get_left_tag`: tag name and the length of the opening tag.
 *
 * @param {string} text Block text starting with `<`.
 * @returns {{tag: string, leftIndex: number}} Tag and index just past the opening tag.
 */
function getLeftTag(text) {
  const match = LEFT_TAG.exec(text);
  if (match) {
    return {tag: match[1], leftIndex: match[0].length};
  }
  const tag = text.slice(1).split('>', 1)[0].toLowerCase();
  return {tag, leftIndex: tag.length + 2};
}

/**
 * `_recursive_tagfind`: index just past the matching right tag, honouring nested left tags.
 *
 * @param {string} leftTag e.g. `<div`.
 * @param {string} rightTag e.g. `</div>`.
 * @param {number} startIndex Search start.
 * @param {string} text Text to search.
 * @returns {number} Index past the right tag, or -1.
 */
function recursiveTagFind(leftTag, rightTag, startIndex, text) {
  let start = startIndex;
  for (;;) {
    const rightIndex = text.indexOf(rightTag, start);
    if (rightIndex === -1) {
      return -1;
    }
    const leftIndex = text.indexOf(leftTag, start);
    if (leftIndex > rightIndex || leftIndex === -1) {
      return rightIndex + rightTag.length;
    }
    const afterLeft = text.indexOf('>', leftIndex);
    start = recursiveTagFind(leftTag, rightTag, afterLeft + 1, text);
    if (start === -1) {
      return -1;
    }
  }
}

/**
 * `_get_right_tag`: the closing tag found and the index just past it.
 *
 * @param {string} leftTag Tag name from `getLeftTag`.
 * @param {number} leftIndex Index past the opening tag.
 * @param {string} text Text to search.
 * @returns {{tag: string, dataIndex: number}} Right tag name and data index.
 */
function getRightTag(leftTag, leftIndex, text) {
  for (const pattern of [`</${leftTag}>`, `${leftTag}>`]) {
    const index = recursiveTagFind(`<${leftTag}`, pattern, leftIndex, text);
    if (index > 2) {
      return {tag: pattern.replace(/^<+/, '').replace(/>+$/, ''), dataIndex: index};
    }
  }
  const trimmed = text.replace(/\s+$/, '');
  return {tag: trimmed.slice(trimmed.length - leftIndex, -1).toLowerCase(), dataIndex: text.length};
}

/**
 * `_equal_tags`.
 *
 * @param {string} leftTag Opening tag name.
 * @param {string} rightTag Closing tag name.
 * @returns {boolean} Whether they pair up.
 */
function equalTags(leftTag, rightTag) {
  if (['?', '@', '%'].includes(leftTag[0])) {
    return true;
  }
  if (`/${leftTag}` === rightTag || (rightTag === '--' && leftTag === '--')) {
    return true;
  }
  return leftTag === rightTag.slice(1) && rightTag[0] === '/';
}

/**
 * `md.is_block_level`.
 *
 * @param {string} tag Tag name.
 * @returns {boolean} Whether Python-Markdown treats it as a block-level element.
 */
function isBlockLevel(tag) {
  return BLOCK_LEVEL.has(tag.toLowerCase().replace(/\/+$/, ''));
}

/**
 * Split a block at a character index that must fall on a line end.
 *
 * @param {Array<object>} block Block lines.
 * @param {number} dataIndex Character index in `block` joined by `\n`.
 * @param {{file: string, lineOffset: number}} ctx Conversion context.
 * @returns {[Array<object>, Array<object>]} Lines up to the index and the remaining lines.
 * @throws {ConversionError} When text follows the closing tag on the same line.
 */
function splitBlockAt(block, dataIndex, ctx) {
  let offset = 0;
  for (let index = 0; index < block.length; index += 1) {
    const lineEnd = offset + block[index].text.length;
    if (dataIndex <= lineEnd) {
      if (block[index].text.slice(dataIndex - offset).trim() !== '') {
        throw new ConversionError(
          ctx.file,
          block[index].no + ctx.lineOffset + 1,
          'text follows a raw HTML block on the same line; split it with a fixup',
        );
      }
      return [block.slice(0, index + 1), block.slice(index + 1)];
    }
    offset = lineEnd + 1;
  }
  return [block, []];
}

/**
 * Classify a stashed raw block: an HTML comment, an already converted MDX comment, or raw HTML.
 *
 * @param {Array<object>} blockLines All lines of the raw block.
 * @returns {object} Stash node.
 */
function rawNode(blockLines) {
  const text = blockLines.map((line) => line.text).join('\n');
  const kind = text.startsWith('<!--') ? 'comment' : 'html';
  return {kind, lines: blockLines};
}

/**
 * Emulate `HtmlBlockPreprocessor.run`: column-0 blocks starting with a block-level tag or a
 * comment are stashed as raw HTML (until the matching closing tag), everything else is kept.
 * Already converted `{/* … *\/}` comment blocks are stashed verbatim too (idempotency).
 *
 * @param {Array<object>} lines Lines after fence extraction.
 * @param {Stash} stash Placeholder stash.
 * @param {{file: string, lineOffset: number}} ctx Conversion context.
 * @returns {Array<object>} New lines: blocks joined by single blank lines.
 */
export function extractHtmlBlocks(lines, stash, ctx) {
  const pending = splitBlocks(lines);
  const newBlocks = [];
  let items = [];
  let leftTag = '';
  let leftIndex = 0;
  const placeholderFor = (blockLines) => {
    const node = rawNode(blockLines);
    const first = blockLines[0];
    const last = blockLines[blockLines.length - 1];
    return [makeLine(first.no, stash.add(node), node, last.end)];
  };
  while (pending.length > 0) {
    let block = pending.shift();
    for (let strip = 0; strip < 2; strip += 1) {
      if (block.length > 1 && block[0].text === '') {
        block = block.slice(1);
      }
    }
    const text = block.map((line) => line.text).join('\n');
    if (items.length === 0) {
      if (text.startsWith('{/*')) {
        // Converter output: a comment may span blank lines, so take blocks until `*/}`.
        let commentLines = block;
        let commentText = text;
        while (!commentText.includes('*/}') && pending.length > 0) {
          commentLines = [...commentLines, makeLine(commentLines[commentLines.length - 1].end, ''), ...pending.shift()];
          commentText = commentLines.map((line) => line.text).join('\n');
        }
        const close = commentText.indexOf('*/}');
        if (close === -1) {
          throw new ConversionError(ctx.file, block[0].no + ctx.lineOffset + 1, 'unterminated `{/*` comment');
        }
        const [head, rest] = splitBlockAt(commentLines, close + 3, ctx);
        if (rest.length > 0) {
          pending.unshift(rest);
        }
        const node = {kind: 'mdxcomment', lines: head};
        newBlocks.push([makeLine(head[0].no, stash.add(node), node, head[head.length - 1].end)]);
        continue;
      }
      if (!(text.startsWith('<') && text.trim().length > 1) || OWN_DETAILS.test(block[0].text)) {
        newBlocks.push(block);
        continue;
      }
      ({tag: leftTag, leftIndex} = text.slice(1, 4) === '!--' ? {tag: '--', leftIndex: 2} : getLeftTag(text));
      const {tag: rightTag, dataIndex} = getRightTag(leftTag, leftIndex, text);
      const blockLevel = isBlockLevel(leftTag) || leftTag === '--';
      let head = block;
      if (dataIndex < text.length && blockLevel) {
        const [kept, rest] = splitBlockAt(block, dataIndex, ctx);
        head = kept;
        if (rest.length > 0) {
          pending.unshift(rest);
        }
      }
      const headText = head.map((line) => line.text).join('\n');
      if (!(isBlockLevel(leftTag) || ['!', '?', '@', '%'].includes(text[1]))) {
        newBlocks.push(head);
      } else if (leftTag === 'hr' || leftTag === 'hr/') {
        newBlocks.push(head);
      } else if (headText.trimEnd().endsWith('>') && equalTags(leftTag, rightTag)) {
        newBlocks.push(placeholderFor(head));
      } else if (!equalTags(leftTag, rightTag) && blockLevel) {
        items = [{lines: head, text: headText.trim()}];
      } else {
        newBlocks.push(placeholderFor(head));
      }
      continue;
    }
    items.push({lines: block, text});
    const joined = items.map((item) => item.text).join('');
    const right = getRightTag(leftTag, leftIndex, joined);
    const previousLength = items.slice(0, -1).reduce((sum, item) => sum + item.text.length, 0);
    const dataIndex = right.dataIndex - previousLength;
    if (equalTags(leftTag, right.tag)) {
      if (dataIndex < text.length) {
        const [kept, rest] = splitBlockAt(block, dataIndex, ctx);
        items[items.length - 1] = {lines: kept, text};
        if (rest.length > 0) {
          pending.unshift(rest);
        }
      }
      newBlocks.push(placeholderFor(items.flatMap((item) => item.lines)));
      items = [];
    }
  }
  if (items.length > 0) {
    const first = items[0].lines[0];
    throw new ConversionError(
      ctx.file,
      first.no + ctx.lineOffset + 1,
      'raw HTML block is never closed, so MkDocs hides the rest of the page; close it with a fixup',
    );
  }
  const result = [];
  newBlocks.forEach((block, index) => {
    if (index > 0) {
      result.push(makeLine(block[0].no, ''));
    }
    result.push(...block);
  });
  return result;
}

/**
 * Emulate `ReferencePreprocessor`: link reference definitions become blank lines. The
 * `[comment]: <> (…)` idiom is remembered on the blank line so it can be emitted as an MDX comment.
 *
 * @param {Array<object>} lines Lines after raw HTML extraction.
 * @param {{file: string, lineOffset: number}} ctx Conversion context.
 * @returns {Array<object>} Lines.
 * @throws {ConversionError} For footnote definitions, real link definitions or titles on the next line.
 */
export function extractReferences(lines, ctx) {
  return lines.map((line) => {
    if (line.ref !== undefined) {
      return line;
    }
    if (FOOTNOTE_DEF.test(line.text)) {
      throw new ConversionError(ctx.file, line.no + ctx.lineOffset + 1, 'footnote definitions are not supported');
    }
    const match = REFERENCE_DEF.exec(line.text);
    if (!match) {
      return line;
    }
    if (match[1].trim().toLowerCase() !== 'comment' || match[3] === undefined) {
      throw new ConversionError(
        ctx.file,
        line.no + ctx.lineOffset + 1,
        `link reference definition ${excerpt(line.text, 40)} is not supported; only \`[comment]: <> (…)\``,
      );
    }
    return Object.freeze({...withText(line, ''), refComment: line.text});
  });
}
