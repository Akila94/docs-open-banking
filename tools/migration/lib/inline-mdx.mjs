/**
 * Inline passes (spec §3 passes 10–14) over the block passes' output, as position-based splices so
 * untouched text stays byte-identical:
 *   10 escaping (`{`, `}`, `<` outside code), autolinks `<url>` -> `[url](url)`, HTML tags inside
 *      Markdown text -> JSX (`convertInlineTag`), author placeholders (`<Error>`) made visible;
 *   11 links and images resolved the way MkDocs emitted them (`resolveMkdocsLink`);
 *   12 MkDocs heading ids (`headings.mjs`), on a second, MDX parse of the result;
 *   13 the page title (`titles.mjs`);
 *   14 smartsymbols (`text-transform.mjs`).
 * Raw HTML blocks and MDX comments (already handled) are masked out of the parse.
 */
import {ConversionError, excerpt} from './errors.mjs';
import {convertInlineTag} from './html-to-jsx.mjs';
import {resolveMkdocsLink} from './links.mjs';
import {maskForParsing, parseMarkdown, parseMdx} from './inline/parse.mjs';
import {transformText, escapeLinkText} from './inline/text-transform.mjs';
import {hasContentTitle, hasMarkdownH1, headingIdEdits, mkdocsHeadingIds} from './inline/headings.mjs';
import {pageTitle} from './titles.mjs';

/** The block passes' own JSX tags (left as they are). */
const COMPONENT_TAG = /^<\/?(?:Tabs|TabItem|DeprecatedBanner|RedocSpec)\b|^<details className="ob-details\b|^<\/details>$|^<\/?summary>$/;
/** Phrasing containers in which inline HTML tags must balance. */
const PHRASING_CONTAINERS = new Set(['paragraph', 'heading', 'tableCell']);

/**
 * @typedef {object} InlineReport
 * @property {Array<{line: number, href: string, out: string}>} brokenLinks Links broken in MkDocs (kept broken).
 * @property {Array<{line: number, src: string}>} missingImages Images whose file does not exist.
 * @property {Array<{line: number, id: string}>} headingIds Explicit ids added.
 * @property {Array<{line: number, count: number}>} smartSymbols Smartsymbols applied.
 * @property {Array<{line: number}>} placeholders `<` escaped so a placeholder shows.
 * @property {Array<{line: number, url: string}>} autolinks `<url>` autolinks rewritten.
 * @property {Array<{line: number, text: string}>} gfmAutolinkLiterals Bare URLs/emails GFM links (MkDocs did not).
 * @property {Array<{line: number, tag: string}>} strayEndTags End tags with no open element, removed.
 */

/**
 * Inline-pass engine for one file.
 */
class InlineConverter {
  /**
   * @param {string} source Text to convert.
   * @param {object} ctx See `convertInline`.
   */
  constructor(source, ctx) {
    this.source = source;
    this.ctx = ctx;
    this.edits = [];
    /** @type {InlineReport} */
    this.report = {
      brokenLinks: [], missingImages: [], headingIds: [], smartSymbols: [], placeholders: [], autolinks: [],
      gfmAutolinkLiterals: [], strayEndTags: [],
    };
  }

  /**
   * Throw a located error (lines are lines of the converted file).
   *
   * @param {{position: {start: {line: number}}}|number} at Node or line.
   * @param {string} message What is wrong.
   * @throws {ConversionError} Always.
   */
  fail(at, message) {
    const line = typeof at === 'number' ? at : at.position.start.line;
    throw new ConversionError(this.ctx.file, line + (this.ctx.lineOffset ?? 0), `${message} (line in the converted file)`);
  }

  /**
   * Line of a node in the converted file.
   *
   * @param {object} node mdast node.
   * @returns {number} 1-based line.
   */
  line(node) {
    return node.position.start.line + (this.ctx.lineOffset ?? 0);
  }

  /**
   * Source slice of a node.
   *
   * @param {object} node mdast node.
   * @returns {string} Slice.
   */
  slice(node) {
    return this.source.slice(node.position.start.offset, node.position.end.offset);
  }

  /** @param {number} start Start offset. @param {number} end End offset. @param {string} text Replacement. */
  edit(start, end, text) {
    if (this.source.slice(start, end) !== text) {
      this.edits.push({start, end, text});
    }
  }

  /**
   * Visit a node and its children.
   *
   * @param {object} node mdast node.
   * @param {object[]} container Inline HTML nodes of the enclosing phrasing container.
   */
  visit(node, container) {
    switch (node.type) {
      case 'code':
      case 'inlineCode':
        return;
      case 'text':
        this.text(node);
        return;
      case 'html':
        container?.push(node);
        return;
      case 'link':
        if (this.link(node)) {
          return;
        }
        break;
      case 'image':
        this.image(node);
        return;
      case 'textDirective':
      case 'leafDirective':
        this.directive(node);
        break;
      case 'definition':
      case 'footnoteDefinition':
      case 'footnoteReference':
        this.fail(node, `unsupported Markdown construct ${node.type}`);
        break;
      default:
        break;
    }
    if (PHRASING_CONTAINERS.has(node.type)) {
      const own = [];
      (node.children ?? []).forEach((child) => this.visit(child, own));
      this.inlineHtml(own, node);
      return;
    }
    (node.children ?? []).forEach((child) => this.visit(child, container));
  }

  /** @param {object} node Text node: escaping and smartsymbols. */
  text(node) {
    const {text, symbols, angles} = transformText(this.slice(node));
    if (symbols > 0) {
      this.report.smartSymbols.push({line: this.line(node), count: symbols});
    }
    if (angles > 0) {
      this.report.placeholders.push({line: this.line(node)});
    }
    this.edit(node.position.start.offset, node.position.end.offset, text);
  }

  /**
   * Links: autolinks become `[url](url)`; destinations are resolved; GFM literals are reported.
   *
   * @param {object} node Link node.
   * @returns {boolean} True when the node was replaced whole (children must not be visited).
   */
  link(node) {
    const raw = this.slice(node);
    const url = this.resolve(node, node.url, false);
    if (raw.startsWith('<')) {
      const label = raw.slice(1, -1);
      this.report.autolinks.push({line: this.line(node), url: node.url});
      this.edit(node.position.start.offset, node.position.end.offset, `[${escapeLinkText(label)}](${destination(url, false)})`);
      return true;
    }
    if (!raw.startsWith('[')) {
      this.report.gfmAutolinkLiterals.push({line: this.line(node), text: raw});
      return false;
    }
    this.replaceDestination(node, url);
    return false;
  }

  /** @param {object} node Image node: resolved src; alt text escaped. */
  image(node) {
    const src = this.resolve(node, node.url, true);
    const dest = node.data?.destination;
    const altEnd = dest ? this.source.lastIndexOf('](', dest.start) : node.position.end.offset - 3;
    const altStart = node.position.start.offset + 2;
    if (altEnd >= altStart) {
      this.edit(altStart, altEnd, transformText(this.source.slice(altStart, altEnd), {smart: false}).text);
    }
    this.replaceDestination(node, src);
  }

  /**
   * Resolve a destination and record broken links and missing images.
   *
   * @param {object} node Link or image.
   * @param {string} href Destination.
   * @param {boolean} image Image semantics.
   * @returns {string} New destination.
   */
  resolve(node, href, image) {
    let resolution;
    try {
      resolution = resolveMkdocsLink(href, this.ctx.file, this.ctx.docsDir, this.ctx.existsFn, {siteUrl: this.ctx.siteUrl, image});
    } catch (error) {
      this.fail(node, error.message);
    }
    if (resolution.kind === 'broken') {
      if (image) {
        this.report.missingImages.push({line: this.line(node), src: href});
      } else {
        this.report.brokenLinks.push({line: this.line(node), href, out: resolution.out});
      }
    }
    return resolution.out;
  }

  /**
   * Splice a new destination into a link or image.
   *
   * @param {object} node Link or image.
   * @param {string} url New destination.
   */
  replaceDestination(node, url) {
    if (url === node.url) {
      return;
    }
    const dest = node.data?.destination;
    if (!dest) {
      this.fail(node, `cannot locate the destination of ${JSON.stringify(excerpt(this.slice(node), 60))}`);
    }
    const angle = this.source[dest.start - 1] === '<';
    this.edit(dest.start, dest.end, destination(url, angle));
  }

  /** @param {object} node A text or leaf directive that is really prose (`a:b[c]`): keep it text. */
  directive(node) {
    const simple = node.children.length === 0 && Object.keys(node.attributes ?? {}).length === 0;
    if (!simple || node.type === 'leafDirective') {
      const colon = this.source.indexOf(':', node.position.start.offset);
      this.edit(colon, colon, '\\');
    }
  }

  /**
   * HTML tags inside one phrasing container: convert, show placeholders, drop stray end tags, and
   * require the rest to balance (MDX needs every JSX element closed in the same paragraph).
   *
   * @param {object[]} nodes `html` nodes in order.
   * @param {object} container The paragraph/heading/cell.
   */
  inlineHtml(nodes, container) {
    const open = [];
    for (const node of nodes) {
      const value = this.slice(node);
      if (COMPONENT_TAG.test(value)) {
        continue;
      }
      if (value.startsWith('<!--')) {
        this.fail(node, 'an HTML comment inside Markdown text is not supported');
      }
      const tag = convertInlineTag(value, {...this.ctx.policy, converted: this.ctx.converted === true, file: this.ctx.file, line: this.line(node)});
      if (tag.kind === 'placeholder') {
        this.report.placeholders.push({line: this.line(node)});
        this.edit(node.position.start.offset, node.position.start.offset, '\\');
      } else if (tag.kind === 'start') {
        if (!tag.void) {
          open.push(tag.name);
        }
        this.edit(node.position.start.offset, node.position.end.offset, tag.text);
      } else if (open[open.length - 1] === tag.name) {
        open.pop();
        this.edit(node.position.start.offset, node.position.end.offset, tag.text);
      } else if (!open.includes(tag.name)) {
        this.report.strayEndTags.push({line: this.line(node), tag: value});
        this.edit(node.position.start.offset, node.position.end.offset, '');
      } else {
        this.fail(node, `</${tag.name}> closes an element opened before <${open[open.length - 1]}>`);
      }
    }
    if (open.length > 0) {
      this.fail(container, `<${open[open.length - 1]}> is not closed in the same paragraph, which MDX requires`);
    }
  }

  /**
   * Apply the collected edits.
   *
   * @param {string} text Source.
   * @param {Array<{start: number, end: number, text: string}>} edits Non-overlapping edits.
   * @returns {string} Edited text.
   */
  apply(text, edits) {
    const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
    let out = '';
    let last = 0;
    for (const {start, end, text: replacement} of ordered) {
      if (start < last) {
        throw new Error(`${this.ctx.file}: overlapping inline edits at offset ${start}`);
      }
      out += text.slice(last, start) + replacement;
      last = end;
    }
    return out + text.slice(last);
  }
}

/**
 * Write a link destination.
 *
 * @param {string} url Destination.
 * @param {boolean} angle Whether the source used `<…>`.
 * @returns {string} Destination text.
 */
function destination(url, angle) {
  if (angle) {
    return url.replace(/[<>\n]/g, (char) => encodeURIComponent(char));
  }
  let depth = 0;
  let balanced = true;
  for (const char of url) {
    depth += char === '(' ? 1 : char === ')' ? -1 : 0;
    balanced &&= depth >= 0;
  }
  const escaped = balanced && depth === 0 ? url : url.replace(/[()]/g, (char) => `\\${char}`);
  return /\s/.test(escaped) ? `<${escaped}>` : escaped;
}

/**
 * Run passes 10–14 on one file body.
 *
 * @param {string} markdown Body after the block passes and raw HTML conversion.
 * @param {object} ctx Context.
 * @param {string} ctx.file Docs-relative path.
 * @param {string} ctx.docsDir Docs directory.
 * @param {(relative: string) => boolean} ctx.existsFn Whether a docs-relative file exists.
 * @param {Map<string, string>} ctx.titles Nav labels (empty labels kept).
 * @param {string} ctx.siteName MkDocs `site_name`.
 * @param {string} ctx.siteUrl MkDocs `site_url`.
 * @param {Array<{start: number, end: number}>} [ctx.masks] Character ranges already converted.
 * @param {object} [ctx.policy] HTML policy for the page.
 * @param {boolean} [ctx.converted] The file was already converted (see `HtmlOptions.converted`).
 * @param {string} [ctx.originalBody] The MkDocs source body (for the title).
 * @param {boolean} [ctx.mkdocsShowsTitle] Whether Material would render a synthetic h1.
 * @param {number} [ctx.lineOffset] Lines before the body in the converted file.
 * @returns {{text: string, report: InlineReport, title: string, hideTitle: boolean}} Result.
 * @throws {ConversionError} For unconvertible or unsafe input.
 */
export function convertInline(markdown, ctx) {
  const converter = new InlineConverter(markdown, ctx);
  const tree = parseMarkdown(maskForParsing(markdown, ctx.masks ?? []));
  converter.visit(tree, null);
  const expectedIds = mkdocsHeadingIds(tree, markdown);
  const edited = converter.apply(markdown, converter.edits);

  let mdxTree;
  try {
    mdxTree = parseMdx(edited);
  } catch (error) {
    converter.fail(error.line ?? 1, `the converted text is not valid MDX: ${excerpt(error.reason ?? error.message, 160)}`);
  }
  const {edits, overrides, mismatch} = headingIdEdits(mdxTree, expectedIds);
  if (mismatch !== null) {
    converter.fail(mismatch.line, 'CommonMark and MDX disagree about the headings here; fix the source with a fixup');
  }
  converter.report.headingIds = overrides.map(({line, id}) => ({line: line + (ctx.lineOffset ?? 0), id}));
  const text = converter.apply(edited, edits);

  const mkdocsShowsTitle = ctx.mkdocsShowsTitle !== false && !hasMarkdownH1(tree);
  return {
    text,
    report: converter.report,
    title: pageTitle(ctx.file, ctx.originalBody ?? markdown, {titles: ctx.titles, siteName: ctx.siteName}),
    hideTitle: !mkdocsShowsTitle && !hasContentTitle(mdxTree),
  };
}
