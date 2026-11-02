/**
 * HTML -> JSX for MDX (spec §3 pass 9), parsed with parse5.
 *
 * Two entry points, matching how Python-Markdown treats HTML:
 *   - `htmlToJsx` converts a whole raw HTML block (Python-Markdown passes it through verbatim, so its
 *     text is never Markdown). Text is written so MDX cannot re-read it: one-line safe text on its
 *     parent's start-tag line stays plain, other text becomes `{"…"}`, `<pre>`/`<style>` content a
 *     template literal. Whitespace between two inline-level neighbours, which renders as a space,
 *     becomes `{" "}` where MDX would drop it; other whitespace only keeps the line layout.
 *   - `convertInlineTag` converts one tag inside Markdown text (Python-Markdown processes the text
 *     around inline HTML as Markdown, and so does MDX), leaving the text to the inline passes.
 * Both fail closed under the page's `HtmlPolicy` and are fixed points on their own output.
 */
import {parseFragment, Token, Tokenizer} from 'parse5';

import {ConversionError, excerpt} from './errors.mjs';
import {mdxCommentText} from './mdx-comment.mjs';
import {assertSafeUrl} from './links.mjs';
import {AttributeError, attributeMap, convertAttributes} from './html/attributes.mjs';
import {findOwnJsxForm, normalizeOwnJsx} from './html/own-jsx.mjs';
import {
  BLOCK_ELEMENTS, HTML_ELEMENTS, RAW_TEXT_ELEMENTS, VOID_ELEMENTS, elementViolation,
} from './html/policy.mjs';
import {
  HTML_SPACE, isSafePlainText, jsonExpression, layoutWhitespace, templateExpression,
} from './html/text.mjs';

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
/** The home-page card handler: `location.href='<url>'` with an optional `;`. */
const CARD_ONCLICK = /^\s*location\.href\s*=\s*'([^'\\]*)'\s*;?\s*$/;
const LEADING_SPACE = /^[ \t\n\f\r]*/;
const TRAILING_SPACE = /[ \t\n\f\r]*$/;

/**
 * @typedef {object} HtmlOptions
 * @property {string} file Docs-relative path (errors).
 * @property {boolean} allowOnclick Home-page cards (`onclick="location.href='…'"` -> `<Link>`).
 * @property {boolean} [allowIframe] The YouTube embed.
 * @property {boolean} [allowStyle] An inline `<style>` block.
 * @property {boolean} [allowScript] The Redoc bundle script.
 * @property {Set<string>} [customElements] Non-HTML elements to keep (`redoc`).
 * @property {number} [line] 1-based file line of the HTML's first line (errors).
 * @property {Set<string>} [imports] Receives `Link` when a card is converted.
 * @property {boolean} [converted] The file was already converted (its front matter has `title:`):
 *   read the converter's own JSX forms back. Otherwise the input is MkDocs source, where those
 *   forms are rejected.
 */

/**
 * Resolve options into a policy and an error helper.
 *
 * @param {HtmlOptions} opts Options.
 * @returns {object} Conversion context.
 */
function createContext(opts) {
  return {
    file: opts.file,
    baseLine: opts.line ?? 1,
    policy: {
      allowOnclick: opts.allowOnclick === true,
      allowIframe: opts.allowIframe === true,
      allowStyle: opts.allowStyle === true,
      allowScript: opts.allowScript === true,
      customElements: opts.customElements ?? new Set(),
    },
    imports: opts.imports ?? new Set(),
  };
}

/**
 * Prepare HTML for parse5: on converted input, map the converter's own JSX forms back to HTML; on
 * MkDocs source, refuse them (they would be real content there, and rewriting it is not allowed).
 *
 * @param {string} html Raw HTML.
 * @param {HtmlOptions} opts Options (`converted`, `file`, `line`).
 * @returns {string} HTML for parse5.
 * @throws {ConversionError} At the line of an own JSX form in source HTML.
 */
function prepareHtml(html, opts) {
  if (opts.converted === true) {
    return normalizeOwnJsx(html);
  }
  const found = findOwnJsxForm(html);
  if (found !== null) {
    const line = (opts.line ?? 1) + (html.slice(0, found.offset).match(/\n/g) ?? []).length;
    throw new ConversionError(opts.file, line,
      `raw HTML contains ${found.form}, which is the converter's own JSX syntax; MkDocs shows it as text, so it cannot be converted safely (fix the source with a fixup)`);
  }
  return html;
}

/**
 * Throw a located conversion error.
 *
 * @param {object} context Conversion context.
 * @param {object|undefined} node parse5 node (for its line).
 * @param {string} message What is wrong.
 * @throws {ConversionError} Always.
 */
function fail(context, node, message) {
  const line = context.baseLine + (node?.sourceCodeLocation?.startLine ?? 1) - 1;
  throw new ConversionError(context.file, line, message);
}

/**
 * Whether a node is an element.
 *
 * @param {object} node parse5 node.
 * @returns {boolean} True for elements.
 */
function isElement(node) {
  return typeof node.tagName === 'string';
}

/**
 * Turn author placeholders such as `<IS_HOME>` (unknown tags with no end tag, which browsers hide)
 * into text, hoisting the content parse5 nested inside them, then merge adjacent text nodes.
 *
 * @param {object} parent parse5 parent node (mutated).
 * @param {string} source Parsed source (for the original tag text).
 * @param {object} context Conversion context.
 */
function hoistPlaceholders(parent, source, context) {
  const children = [];
  for (const child of parent.childNodes) {
    if (!isElement(child)) {
      children.push(child);
      continue;
    }
    hoistPlaceholders(child, source, context);
    const known = HTML_ELEMENTS.has(child.tagName) || context.policy.customElements.has(child.tagName);
    if (known) {
      children.push(child);
    } else if (child.sourceCodeLocation && !child.sourceCodeLocation.endTag) {
      const {startOffset, endOffset} = child.sourceCodeLocation.startTag;
      children.push({nodeName: '#text', value: source.slice(startOffset, endOffset), parentNode: parent});
      children.push(...child.childNodes);
    } else {
      fail(context, child, `unknown element <${child.tagName}>; only HTML elements are converted`);
    }
  }
  parent.childNodes = children.reduce((merged, node) => {
    const previous = merged[merged.length - 1];
    if (node.nodeName === '#text' && previous?.nodeName === '#text') {
      merged[merged.length - 1] = {...previous, value: previous.value + node.value};
    } else {
      merged.push({...node, parentNode: parent});
    }
    return merged;
  }, []);
}

/**
 * Whitespace display class of a node for the "renders as a space" test. Parent boundaries are
 * `edge` (inline parent) or `block`.
 *
 * @param {object} node parse5 node.
 * @returns {'inline'|'block'} Class.
 */
function displayOf(node) {
  if (node.nodeName === '#text') {
    return 'inline';
  }
  return isElement(node) && !BLOCK_ELEMENTS.has(node.tagName) ? 'inline' : 'block';
}

/**
 * Serialises a parse5 tree as JSX for MDX.
 */
class JsxSerializer {
  /**
   * @param {object} context Conversion context.
   */
  constructor(context) {
    this.context = context;
  }

  /**
   * Serialise the children of a node.
   *
   * @param {object} parent parse5 node.
   * @param {{raw: boolean, inline: boolean, onStartLine: boolean}} state `raw`: inside pre/style;
   *   `inline`: the parent is inline-level; `onStartLine`: output is on the parent's start-tag line.
   * @returns {string} JSX.
   */
  children(parent, state) {
    let out = '';
    let onStartLine = state.onStartLine;
    const nodes = parent.childNodes;
    const boundary = state.inline ? 'edge' : 'block';
    nodes.forEach((node, index) => {
      let piece;
      if (node.nodeName === '#text') {
        piece = state.raw
          ? this.rawText(node.value)
          : this.text(node.value, index > 0 ? displayOf(nodes[index - 1]) : boundary,
            index < nodes.length - 1 ? displayOf(nodes[index + 1]) : boundary, onStartLine);
      } else if (node.nodeName === '#comment') {
        piece = this.comment(node);
      } else if (isElement(node)) {
        piece = this.element(node, state.raw);
      } else {
        fail(this.context, node, `unsupported HTML node ${node.nodeName}`);
      }
      out += piece;
      if (piece.includes('\n')) {
        onStartLine = false;
      }
    });
    return out;
  }

  /**
   * Text inside `<pre>`/`<style>`: exact.
   *
   * @param {string} value Text.
   * @returns {string} Expression.
   */
  rawText(value) {
    return HTML_SPACE.test(value) ? jsonExpression(value) : templateExpression(value);
  }

  /**
   * Normal-flow text: plain when safe, otherwise a JSON string; edges as whitespace.
   *
   * @param {string} value Text.
   * @param {'inline'|'block'|'edge'} before Display class before it.
   * @param {'inline'|'block'|'edge'} after Display class after it.
   * @param {boolean} onStartLine Whether it sits on the parent's start-tag line.
   * @returns {string} JSX.
   */
  text(value, before, after, onStartLine) {
    const lead = LEADING_SPACE.exec(value)[0];
    if (lead.length === value.length) {
      return this.space(value, before, after, onStartLine);
    }
    const trail = TRAILING_SPACE.exec(value)[0];
    const core = value.slice(lead.length, value.length - trail.length);
    if (onStartLine && !value.includes('\n') && isSafePlainText(core)) {
      return value;
    }
    const coreOnStartLine = onStartLine && !lead.includes('\n');
    const plain = coreOnStartLine && !core.includes('\n') && isSafePlainText(core);
    return this.space(lead, before, 'inline', onStartLine)
      + (plain ? core : jsonExpression(core))
      + this.space(trail, 'inline', after, coreOnStartLine && !core.includes('\n'));
  }

  /**
   * Whitespace: `{" "}` where it renders as a space and MDX would drop it, layout otherwise.
   *
   * @param {string} space Whitespace.
   * @param {'inline'|'block'|'edge'} before Display class before it (`edge`: start of an inline parent).
   * @param {'inline'|'block'|'edge'} after Display class after it (`edge`: end of an inline parent).
   * @param {boolean} onStartLine Whether it sits on the parent's start-tag line.
   * @returns {string} JSX.
   */
  space(space, before, after, onStartLine) {
    if (space === '') {
      return '';
    }
    // A line break at the edge of an element is layout (the converter adds such breaks itself).
    const atEdgeWithBreak = (before === 'edge' || after === 'edge') && space.includes('\n');
    if (atEdgeWithBreak || before === 'block' || after === 'block') {
      return layoutWhitespace(space);
    }
    return onStartLine && !space.includes('\n') ? space : `{" "}${layoutWhitespace(space)}`;
  }

  /**
   * An HTML comment as an MDX comment (content verbatim).
   *
   * @param {object} node parse5 comment.
   * @returns {string} `{/* … *\/}`.
   */
  comment(node) {
    try {
      return mdxCommentText(node.data);
    } catch (error) {
      return fail(this.context, node, error.message);
    }
  }

  /**
   * One element.
   *
   * @param {object} node parse5 element.
   * @param {boolean} raw Whether an ancestor is a raw-text element.
   * @returns {string} JSX.
   */
  element(node, raw) {
    const name = node.tagName;
    if (node.namespaceURI !== HTML_NAMESPACE) {
      fail(this.context, node, `<${name}> (SVG/MathML) is not supported`);
    }
    const attributes = attributeMap(node.attrs);
    const violation = elementViolation(name, attributes, this.context.policy);
    if (violation !== null) {
      fail(this.context, node, violation);
    }
    const card = attributes.has('onclick') ? this.cardTarget(node, attributes.get('onclick')) : null;
    const tag = card === null ? name : 'Link';
    let attributeText;
    try {
      attributeText = (card === null ? '' : ` to="${card}"`)
        + convertAttributes(node.attrs, {skip: new Set(card === null ? [] : ['onclick'])});
    } catch (error) {
      if (error instanceof AttributeError) {
        fail(this.context, node, `<${name}>: ${error.message}`);
      }
      throw error;
    }
    if (VOID_ELEMENTS.has(name)) {
      return `<${tag}${attributeText} />`;
    }
    const state = {raw: raw || RAW_TEXT_ELEMENTS.has(name), inline: !BLOCK_ELEMENTS.has(name), onStartLine: true};
    let inner = this.children(node, state);
    if (!state.raw && inner.includes('\n') && !inner.startsWith('\n')) {
      // Content on the start-tag line would make this a text element of a Markdown paragraph, which
      // a later line holding only tags would interrupt. Start the content on its own line instead.
      const indent = /\n([ \t]*)/.exec(inner)[1];
      inner = `\n${indent}${this.children(node, {...state, onStartLine: false})}`;
    }
    return `<${tag}${attributeText}>${inner}</${tag}>`;
  }

  /**
   * The target of a home-page card (`<div onclick="location.href='…'">` -> `<Link to="…">`).
   *
   * @param {object} node parse5 element.
   * @param {string} handler `onclick` value.
   * @returns {string} The `to` value (the page-relative href, unchanged).
   */
  cardTarget(node, handler) {
    const match = CARD_ONCLICK.exec(handler);
    if (!this.context.policy.allowOnclick || node.tagName !== 'div' || match === null) {
      fail(this.context, node, `event handler onclick=${JSON.stringify(excerpt(handler, 40))} is not allowed`);
    }
    try {
      assertSafeUrl(match[1]);
    } catch (error) {
      fail(this.context, node, error.message);
    }
    if (/["{}]/.test(match[1])) {
      fail(this.context, node, 'card link target contains characters that cannot be written in a JSX string');
    }
    this.context.imports.add('Link');
    return match[1];
  }
}

/**
 * Convert a raw HTML block to JSX for MDX.
 *
 * @param {string} html The block (as emitted by the block passes; may already be converted).
 * @param {HtmlOptions} opts Policy, location and import collection.
 * @returns {string} JSX with the same rendered content.
 * @throws {ConversionError} With `file:line` for disallowed or unconvertible HTML.
 */
export function htmlToJsx(html, opts) {
  const context = createContext(opts);
  const source = prepareHtml(html, opts);
  const fragment = parseFragment(source, {sourceCodeLocationInfo: true});
  hoistPlaceholders(fragment, source, context);
  return new JsxSerializer(context).children(fragment, {raw: false, inline: false, onStartLine: false});
}

/**
 * Tokenise one tag with the parse5 tokenizer.
 *
 * @param {string} source Tag source.
 * @returns {object[]} Tokens (start/end tags, characters, comments).
 */
function tokenize(source) {
  const tokens = [];
  const push = (token) => tokens.push(token);
  const tokenizer = new Tokenizer({sourceCodeLocationInfo: false}, {
    onComment: push, onDoctype: push, onStartTag: push, onEndTag: push, onEof() {},
    onCharacter: push, onNullCharacter: push, onWhitespaceCharacter: push,
  });
  tokenizer.write(source, true);
  return tokens;
}

/**
 * @typedef {object} InlineTag
 * @property {'start'|'end'|'placeholder'} kind A tag, or an author placeholder to show as text.
 * @property {string} name Lower-case tag name.
 * @property {boolean} void Whether it is a void (self-closed) element.
 * @property {string} text The JSX tag.
 */

/**
 * Convert one HTML tag that appears inside Markdown text.
 *
 * @param {string} value Tag source (an mdast `html` node value).
 * @param {HtmlOptions} opts Policy and location.
 * @returns {InlineTag} The converted tag.
 * @throws {ConversionError} With `file:line` for disallowed tags or attributes.
 */
export function convertInlineTag(value, opts) {
  const context = createContext(opts);
  const tokens = tokenize(prepareHtml(value, opts));
  const tag = tokens.length === 1 ? tokens[0] : null;
  const isTag = tag !== null && (tag.type === Token.TokenType.START_TAG || tag.type === Token.TokenType.END_TAG);
  if (!isTag) {
    return fail(context, undefined, `unsupported inline HTML ${JSON.stringify(excerpt(value, 60))}`);
  }
  const name = tag.tagName;
  if (!HTML_ELEMENTS.has(name) && !context.policy.customElements.has(name)) {
    return {kind: 'placeholder', name, void: false, text: value};
  }
  if (tag.type === Token.TokenType.END_TAG) {
    // Browsers parse `</br>` as `<br>`.
    return name === 'br'
      ? {kind: 'start', name, void: true, text: '<br />'}
      : {kind: 'end', name, void: VOID_ELEMENTS.has(name), text: `</${name}>`};
  }
  const attributes = attributeMap(tag.attrs);
  const violation = elementViolation(name, attributes, context.policy);
  if (violation !== null) {
    fail(context, undefined, violation);
  }
  let attributeText;
  try {
    attributeText = convertAttributes(tag.attrs);
  } catch (error) {
    if (error instanceof AttributeError) {
      fail(context, undefined, `<${name}>: ${error.message}`);
    }
    throw error;
  }
  const isVoid = VOID_ELEMENTS.has(name);
  return {kind: 'start', name, void: isVoid, text: isVoid ? `<${name}${attributeText} />` : `<${name}${attributeText}>`};
}
